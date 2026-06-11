/**
 * execution-worker-wms — caminho WMS_AS_SOURCE da dedução de estoque
 * pós-NF (Plano 2).
 *
 * Substitui `lancarEstoqueNota` (Tiny) e `movimentarEstoque` (Tiny) por:
 *   1. Pra cada reserva do pedido (mov tipo='R', origem_tipo='reserva_pedido'):
 *      - inserirMovimentacao(L) — libera a reserva
 *      - inserirMovimentacao(S) — lança saída (origem_tipo='nf_venda')
 *   2. Marca pedido.estoque_lancado=true e nf_estoque_lancado=true
 *   3. Transita status_separacao aguardando_nf → aguardando_separacao
 *      (em WMS_AS_SOURCE não existe NF webhook real pra disparar essa transição)
 *
 * Fase 5 (ledger 3D): chave da mov é (produto, galpão, localização). A
 * empresa vendedora vira tag em `empresa_vendedora_id`. Sem ordem por tier,
 * sem empréstimo — quem cobre o pedido é a linha de estoque do galpão da
 * reserva, fungivelmente.
 *
 * Idempotente: se pedido.estoque_lancado já é true, retorna sem alterar nada.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { inserirMovimentacao, estornarMovimentacao } from "./wms/ledger";
import { isForwardStatus } from "./wms/cutover";
import { upsertNotaFiscal } from "./nf-webhook-handler";
import { criarAgrupamentoFase1 } from "./agrupamento-service";
import { registrarEvento } from "./historico-service";

interface ReservaRow {
  id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  quantidade: number;
}

/** Usuário "Sistema (automação)" — uuid-zero seedado em 20260611m_system_user.
 *  Carimba o actor de estornos automáticos (FK siso_movimentacoes.usuario_id). */
const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

export async function executarEstoquePosNfWms(job: {
  pedido_id: string;
  empresa_id: string;
  decisao: string;
}): Promise<void> {
  const sb = createServiceClient();

  const { data: pedido, error: pedidoErr } = await sb
    .from("siso_pedidos")
    .select("id, status, status_separacao, estoque_lancado, nota_fiscal_id, chave_acesso_nf, empresa_origem_id")
    .eq("id", job.pedido_id)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error(`Pedido ${job.pedido_id} não encontrado`);
  }

  if (pedido.estoque_lancado) {
    logger.info("worker.wms", "estoque já lançado (idempotente)", { pedidoId: job.pedido_id });
    return;
  }

  // Gate de status (SEP-07b): o job pos_nf só nasce via dispararCutoverSePronto
  // com o pedido em status forward (separado/embalado/expedido); aguardando_nf
  // cobre o caminho legado pós-NF (transição própria no passo 4 abaixo). Se o
  // pedido regrediu (voltar-etapa/desmarcar → aguardando_separacao,
  // em_separacao, pendente_realocacao, ...) ou foi cancelado entre o enqueue e
  // a execução, converter R viva em L+S aqui criaria saída fantasma — o
  // re-pick emitiria OUTRA S depois (baixa dupla). No-op: retorna sem tocar o
  // ledger e o worker marca o job como concluído (mesmo padrão dos early
  // returns idempotentes acima).
  const statusSep = pedido.status_separacao as string | null;
  if (pedido.status === "cancelado" || (statusSep !== "aguardando_nf" && !isForwardStatus(statusSep))) {
    logger.warn("worker.wms", "job pos_nf stale — pedido fora de status lançável (no-op)", {
      pedidoId: job.pedido_id,
      status: pedido.status,
      statusSeparacao: statusSep,
      decisao: job.decisao,
    });
    return;
  }

  // Empresa vendedora = origem do pedido (tag, não chave).
  const empresaVendedoraId = pedido.empresa_origem_id ?? job.empresa_id;

  // Fix-Final A T7 (R5): resolve uuid de NF saída (tipo='saida') a partir do
  // bigint do Tiny + chave de acesso. Sem isso, a inserção de mov S falha
  // em assertUuidLike (pedido.nota_fiscal_id é bigint, não uuid).
  let notaFiscalUuid: string | null = null;
  if (pedido.nota_fiscal_id != null || pedido.chave_acesso_nf) {
    try {
      notaFiscalUuid = await upsertNotaFiscal({
        tiny_nota_fiscal_id: pedido.nota_fiscal_id as number | null,
        chave_acesso: pedido.chave_acesso_nf as string | null,
        empresa_id: empresaVendedoraId,
        tipo: "saida",
      });
    } catch (e) {
      logger.warn("worker.wms", "upsertNotaFiscal falhou — mov S sem nota_fiscal_id", {
        pedidoId: job.pedido_id,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 1. Buscar reservas ativas do pedido
  const { data: reservasRaw, error: reservasErr } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("origem_id", job.pedido_id)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R");

  if (reservasErr) {
    throw new Error(`Erro ao buscar reservas: ${reservasErr.message}`);
  }

  const reservas = (reservasRaw ?? []) as ReservaRow[];
  if (reservas.length === 0) {
    logger.warn("worker.wms", "nenhuma reserva encontrada — pedido sem rastro de reserva", {
      pedidoId: job.pedido_id,
      decisao: job.decisao,
    });
    // Mesmo sem reservas, marca como lançado pra não ficar travado
    await sb.from("siso_pedidos").update({ estoque_lancado: true }).eq("id", job.pedido_id);
    return;
  }

  // 2. Filtra reservas já convertidas (idempotência POR reserva via estorno_de=R.id).
  //    Importante: NÃO usar o origem_id do pedido aqui — pode haver L's antigos
  //    de re-execuções com IDs reusados (staging seed). estorno_de aponta direto
  //    pro mov R que está sendo liberado, é o único critério à prova de re-run.
  const reservaIds = reservas.map((r) => r.id);
  const { data: jaConvertidas } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", reservaIds)
    .eq("tipo", "L");

  const convertidasSet = new Set<string>(
    (jaConvertidas ?? []).map((j) => j.estorno_de as string).filter(Boolean),
  );

  const reservasPendentes = reservas.filter((r) => !convertidasSet.has(r.id));

  if (reservasPendentes.length === 0) {
    logger.info("worker.wms", "todas as reservas já foram convertidas (skip)", {
      pedidoId: job.pedido_id,
      total: reservas.length,
    });
    await sb
      .from("siso_pedidos")
      .update({ estoque_lancado: true, nf_estoque_lancado: true })
      .eq("id", job.pedido_id);
    return;
  }

  // 3. Pra cada reserva pendente: L (com estorno_de=R.id) + S
  let convertidas = 0;
  const erros: Array<{ reservaId: string; err: string }> = [];
  // P2-CST-05: rastreia as S criadas NESTA execução pra estorno se o pedido
  // for cancelado no meio (cancel chega após o gate de status do início).
  const saidasCriadas: string[] = [];

  for (const r of reservasPendentes) {
    try {
      const tripla = {
        produto_id: r.produto_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
      };

      // L — libera a reserva (estorno_de=R.id marca idempotência)
      await inserirMovimentacao({
        tripla,
        tipo: "L",
        qty: Number(r.quantidade),
        origem_tipo: "liberacao_reserva",
        origem_id: job.pedido_id,
        origem_detalhes: { motivo: "convertida_em_saida" },
        estorno_de: r.id,
        pedido_id: job.pedido_id,
        motivo: "Conversão reserva→saída (NF emitida)",
      });

      // S — lança saída (nf_venda). Empresa vendedora vira tag.
      const movS = await inserirMovimentacao({
        tripla,
        tipo: "S",
        qty: Number(r.quantidade),
        origem_tipo: "nf_venda",
        origem_id: job.pedido_id,
        origem_detalhes: { reserva_origem: r.id, decisao: job.decisao },
        empresa_vendedora_id: empresaVendedoraId,
        pedido_id: job.pedido_id,
        nota_fiscal_id: notaFiscalUuid,
        motivo: "Saída via WMS (cutover Plano 2)",
      });
      saidasCriadas.push((movS as { id: string }).id);
      convertidas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      erros.push({ reservaId: r.id, err: msg });
      logger.error("worker.wms", "falha ao converter reserva→saída", {
        pedidoId: job.pedido_id,
        reservaId: r.id,
        err: msg,
      });
    }
  }

  if (erros.length > 0) {
    throw new Error(
      `Falha ao converter ${erros.length}/${reservas.length} reservas: ${erros[0]?.err}`,
    );
  }

  // P2-CST-05: o gate de status no início roda ANTES da conversão; um cancel
  // (webhook/polling Tiny) que chega DURANTE o loop não é visto lá. Re-checa o
  // status agora: se o pedido virou cancelado, as S que acabamos de lançar são
  // saída fantasma (a peça não vai ser expedida) — estornamos e garantimos
  // estoque_lancado=false. Caminho feliz (não-cancelado) segue intacto.
  if (saidasCriadas.length > 0) {
    const { data: pedidoPos } = await sb
      .from("siso_pedidos")
      .select("status")
      .eq("id", job.pedido_id)
      .single();
    if (pedidoPos?.status === "cancelado") {
      for (const movId of saidasCriadas) {
        try {
          await estornarMovimentacao({
            mov_id: movId,
            // Usuário sistema (automação) — uuid-zero seedado em 20260611m.
            usuario_id: SYSTEM_USER_ID,
            motivo: "Cancelamento durante lançamento — S estornada (P2-CST-05)",
          });
        } catch (err) {
          logger.logError({
            error: err,
            source: "worker.wms",
            message: `Falha ao estornar S ${movId} de pedido cancelado durante lançamento`,
            category: "business_logic",
            metadata: { pedidoId: job.pedido_id, movId },
          });
        }
      }
      // Garante estoque_lancado=false (reverte se algum caminho concorrente
      // já tinha setado true). O cancel-handler mantém o pedido cancelado.
      await sb
        .from("siso_pedidos")
        .update({ estoque_lancado: false, nf_estoque_lancado: false })
        .eq("id", job.pedido_id);
      void registrarEvento({
        pedidoId: job.pedido_id,
        evento: "cancelado",
        detalhes: {
          motivo: "cancelamento durante lançamento — S estornadas",
          saidas_estornadas: saidasCriadas.length,
        },
      });
      logger.warn("worker.wms", "pedido cancelado durante lançamento — S estornadas", {
        pedidoId: job.pedido_id,
        saidasEstornadas: saidasCriadas.length,
      });
      return;
    }
  }

  // 4. Marca pedido como estoque lançado + transita pra aguardando_separacao
  // (em WMS mode não há NF webhook pra fazer essa transição; fazemos aqui)
  const novoStatusSeparacao =
    pedido.status_separacao === "aguardando_nf"
      ? "aguardando_separacao"
      : pedido.status_separacao;

  await sb
    .from("siso_pedidos")
    .update({
      estoque_lancado: true,
      nf_estoque_lancado: true,
      status_separacao: novoStatusSeparacao,
    })
    .eq("id", job.pedido_id);

  // 5. Fase-1 agrupamento (fire-and-forget)
  criarAgrupamentoFase1(job.pedido_id).catch(() => {});

  logger.info("worker.wms", "estoque lançado via WMS (cutover)", {
    pedidoId: job.pedido_id,
    decisao: job.decisao,
    reservasConvertidas: convertidas,
    novoStatusSeparacao,
  });
}
