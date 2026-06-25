/**
 * tiny-polling-futura — descobre vendas ML com etiqueta segurada (buffered) e
 * as carrega na pista de separação futura.
 *
 * Problema: uma venda paga cuja etiqueta o ML segura pra data futura fica presa
 * no Tiny em situacao "em aberto" e NÃO dispara o webhook (o Tiny só dispara
 * quando o pedido avança). O app fica cego pra ela até a etiqueta liberar —
 * tarde demais pra comprar com lead time.
 *
 * Solução: varre os pedidos ABERTOS do Tiny (fallback, igual ao poll de
 * aprovados), e pra cada pedido ML lê o `shipment.substatus` no ML
 * (getMlShipmentStatus). `buffered` → carrega como futura (processWebhook com
 * separacaoFutura=true): reserva estoque, separa, compra — SEM gerar NF.
 *
 * Cadência separada do poll normal (ML-heavy) — via /api/wms/tiny/polling-futura
 * (pg_cron ~30min). Dedup por siso_pedidos (futura já carregada) + dedup_key do
 * webhook log (tiny_id:polling_futura:buffered).
 */

import { createServiceClient } from "./supabase-server";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { listarPedidos, type TinyPedidoListItem } from "./tiny-api";
import { getEmpresaByCnpj, type EmpresaInfo } from "./empresa-lookup";
import { processWebhook } from "./webhook-processor";
import { getActiveMlConnectionForEmpresa, getMlShipmentStatus } from "./ml-api";
import { isMercadoLivre } from "./domain-helpers";
import {
  SUBSTATUS_FUTURA,
  classificarPromocaoFutura,
} from "./wms/separacao-futura";
import { promoverPedidoFutura } from "./webhook-processor-wms";
import { chunk, listarTodasPaginas } from "./tiny-polling";
import { logger } from "./logger";

const LOG_SOURCE = "tiny-polling-futura";
// Tiny situacao "Em aberto" — pedido pago mas ainda não avançado (etiqueta
// segurada). ⚠ CONFIRMAR o código exato no build (observado buffered=0). A
// VERDADE da classificação futura×agora é o ML substatus; o situacao do Tiny é
// só o filtro grosso da listagem.
const SITUACAO_PEDIDO_ABERTA = 0;
const PAGE_LIMIT = 100;
const DIAS_JANELA = 7;
// Cap de lookups ML por empresa por run: protege o rate-limit do ML. Open
// orders ML NÃO-buffered não viram pedido (não há onde dedup-ar) → seriam
// re-checados a cada run; o cap bordeia isso e o backlog drena em runs
// sucessivos. Truncamento é logado (sem corte silencioso).
const FUTURA_ML_CHECK_MAX = 50;

function dataInicialJanela(dias: number): string {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export interface FuturaPollResumoEmpresa {
  empresa_id: string;
  empresa_nome: string;
  cnpj: string;
  abertos_vistos: number;
  ml_consultados: number;
  buffered_detectados: number;
  futura_processados: number;
  truncado: boolean;
  erros: string[];
}

export interface FuturaPollResult {
  janela_dias: number;
  empresas: FuturaPollResumoEmpresa[];
  executado_em: string;
}

async function sweepFuturaEmpresa(
  token: string,
  empresa: EmpresaInfo,
  cnpj: string,
  dataInicial: string,
  resumo: FuturaPollResumoEmpresa,
): Promise<void> {
  const sb = createServiceClient();

  const connId = await getActiveMlConnectionForEmpresa(empresa.empresaId);
  if (!connId) return; // empresa sem conexão ML → não há buffered a classificar

  const abertos = await listarTodasPaginas<TinyPedidoListItem>((offset) =>
    listarPedidos(token, {
      situacao: SITUACAO_PEDIDO_ABERTA,
      dataInicial,
      limit: PAGE_LIMIT,
      offset,
    }),
  );
  resumo.abertos_vistos = abertos.length;
  if (abertos.length === 0) return;

  // Só pedidos ML com order/pack id (o classificador precisa dele).
  const porId = new Map<string, TinyPedidoListItem>();
  for (const p of abertos) {
    if (
      p?.id != null &&
      isMercadoLivre(p.ecommerce?.nome) &&
      p.ecommerce?.numeroPedidoEcommerce
    ) {
      porId.set(String(p.id), p);
    }
  }
  const ids = [...porId.keys()];
  if (ids.length === 0) return;

  // Dedup: pula o que já existe em siso_pedidos (qualquer estado — inclui futura
  // já carregada). A re-detecção no intake (processWebhookWms 4b-futura) é a 2ª
  // rede; aqui evitamos a chamada ML pra pedidos já conhecidos.
  const existentes = new Set<string>();
  for (const lote of chunk(ids, 200)) {
    const { data } = await sb.from("siso_pedidos").select("id").in("id", lote);
    for (const r of (data ?? []) as Array<{ id: string }>) existentes.add(r.id);
  }
  const candidatos = ids.filter((id) => !existentes.has(id));
  if (candidatos.length === 0) return;

  let consultados = 0;
  for (const tinyId of candidatos) {
    if (consultados >= FUTURA_ML_CHECK_MAX) {
      resumo.truncado = true;
      logger.warn(LOG_SOURCE, "cap de lookups ML atingido — restante drena no próximo run", {
        empresaId: empresa.empresaId,
        restantes: candidatos.length - consultados,
      });
      break;
    }
    const item = porId.get(tinyId)!;
    const mlOrderId = item.ecommerce!.numeroPedidoEcommerce!;
    try {
      consultados++;
      const st = await getMlShipmentStatus(connId, mlOrderId);
      // Só buffered entra na pista futura. ready_to_print/outros: o fluxo normal
      // pega quando o pedido aprovar (poll de aprovados / webhook).
      if (st?.substatus !== SUBSTATUS_FUTURA) continue;
      resumo.buffered_detectados++;

      const { data: logEntry, error: insErr } = await sb
        .from("siso_webhook_logs")
        .insert({
          tiny_pedido_id: tinyId,
          cnpj,
          tipo: "polling_futura",
          codigo_situacao: "buffered",
          filial: empresa.galpaoNome,
          empresa_id: empresa.empresaId,
          payload: {
            origem: "polling_futura",
            substatus: st.substatus,
            shipmentId: st.shipmentId,
            dados: item,
          },
        })
        .select("id")
        .single();

      if (insErr) {
        // 23505 = dedup_key (tiny_id:polling_futura:buffered) já existe → já
        // processado/em voo num run anterior. Idempotente, pula.
        if (insErr.code === "23505") continue;
        resumo.erros.push(`pedido ${tinyId}: ${insErr.message}`);
        continue;
      }

      await processWebhook(
        logEntry.id,
        tinyId,
        empresa.empresaId,
        empresa.galpaoId,
        empresa.grupoId,
        true, // separacaoFutura
      );
      resumo.futura_processados++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(`pedido ${tinyId}: ${msg}`);
      logger.warn(LOG_SOURCE, "Falha processando futura via polling (segue)", {
        tinyId,
        empresaId: empresa.empresaId,
        error: msg,
      });
    }
  }
  resumo.ml_consultados = consultados;
}

/**
 * Varre as contas Tiny conectadas atrás de vendas ML buffered e as carrega na
 * pista futura. Erros isolados por empresa e por pedido.
 */
export async function pollTinyFutura(): Promise<FuturaPollResult> {
  const sb = createServiceClient();
  const dataInicial = dataInicialJanela(DIAS_JANELA);

  const { data: connections, error } = await sb
    .from("siso_tiny_connections")
    .select("cnpj, empresa_id")
    .eq("ativo", true)
    .not("empresa_id", "is", null)
    .not("access_token", "is", null);
  if (error) throw new Error(`Falha listando conexões Tiny: ${error.message}`);

  const { data: empresasAtivas, error: empErr } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("ativo", true);
  if (empErr) throw new Error(`Falha listando empresas ativas: ${empErr.message}`);
  const ativasSet = new Set(
    (empresasAtivas ?? []).map((e) => (e as { id: string }).id),
  );

  const conns = ((connections ?? []) as Array<{ cnpj: string; empresa_id: string }>).filter(
    (c) => ativasSet.has(c.empresa_id),
  );

  const result: FuturaPollResult = {
    janela_dias: DIAS_JANELA,
    empresas: [],
    executado_em: new Date().toISOString(),
  };

  for (const conn of conns) {
    const resumo: FuturaPollResumoEmpresa = {
      empresa_id: conn.empresa_id,
      empresa_nome: "",
      cnpj: conn.cnpj,
      abertos_vistos: 0,
      ml_consultados: 0,
      buffered_detectados: 0,
      futura_processados: 0,
      truncado: false,
      erros: [],
    };
    result.empresas.push(resumo);

    try {
      const empresa = await getEmpresaByCnpj(conn.cnpj);
      if (!empresa) {
        resumo.erros.push("empresa não encontrada/inativa pra esse CNPJ");
        continue;
      }
      resumo.empresa_nome = empresa.empresaNome;

      const { token } = await getValidTokenByEmpresa(empresa.empresaId);
      await runWithEmpresa(empresa.empresaId, () =>
        sweepFuturaEmpresa(token, empresa, conn.cnpj, dataInicial, resumo),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resumo.erros.push(msg);
      logger.logError({
        error: err,
        source: LOG_SOURCE,
        message: `Polling futura falhou pra empresa ${conn.empresa_id}`,
        category: "external_api",
        empresaId: conn.empresa_id,
        metadata: { cnpj: conn.cnpj },
      });
    }
  }

  logger.info(LOG_SOURCE, "Polling futura concluído", {
    empresas: result.empresas.length,
    futura_processados: result.empresas.reduce((s, e) => s + e.futura_processados, 0),
  });
  return result;
}

// ─── Promoção: re-checa o substatus das futura JÁ carregadas ────────────────
//
// O intake (acima) só CARREGA buffered novos e faz dedup de quem já está em
// siso_pedidos — ou seja, NUNCA re-olha uma futura que já existe. A promoção
// (futura → fluxo normal) dependia 100% do webhook do Tiny disparar no flip
// buffered→ready, o que não acontece de forma confiável → a futura ficava presa
// pra sempre (bug SEP-FUTURA-PROMO: 25/06, 13 pedidos de envio-hoje invisíveis).
//
// Este sweep fecha o buraco: varre as futura vivas, lê o substatus ATUAL no ML
// e promove TODAS as que a etiqueta liberou (substatus != buffered) — IGUAL ao
// fluxo normal: gera NF + agrupamento, inclusive OC. Pro OC, a promoção enfileira
// lancar_estoque (decisao=oc) → o worker emite a NF + agrupamento e segue a
// compra; estoque é problema de fulfillment, não trava a promoção.

const PROMO_ML_CHECK_MAX = 120; // por run; o resto drena nos runs seguintes

export interface FuturaPromoResumo {
  candidatos: number;
  ml_consultados: number;
  promovidos: number;
  mantidos_buffered: number;
  ignorados: number;
  truncado: boolean;
  erros: string[];
}

export interface FuturaPromoResult {
  total: FuturaPromoResumo;
  executado_em: string;
}

export async function promoverFuturasLiberadas(): Promise<FuturaPromoResult> {
  const sb = createServiceClient();
  const resumo: FuturaPromoResumo = {
    candidatos: 0,
    ml_consultados: 0,
    promovidos: 0,
    mantidos_buffered: 0,
    ignorados: 0,
    truncado: false,
    erros: [],
  };
  const result: FuturaPromoResult = {
    total: resumo,
    executado_em: new Date().toISOString(),
  };

  // 1. Pedidos ainda na pista futura (exclui cancelados), só ML com order id.
  // decisao_final IS NOT NULL: pula futura aguardando aprovação humana (troca
  //   pendente) — promover geraria NF de venda não-aprovada.
  // order by prazo_envio: ship-soonest 1º — com o cap por run, evita starvar os
  //   urgentes atrás de buffered de data distante.
  const { data: futuras, error } = await sb
    .from("siso_pedidos")
    .select(
      "id, decisao_final, empresa_origem_id, separacao_galpao_id, id_pedido_ecommerce, nome_ecommerce, prazo_envio",
    )
    .eq("separacao_futura", true)
    .neq("status", "cancelado")
    .not("decisao_final", "is", null)
    .order("prazo_envio", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`Falha listando futuras: ${error.message}`);

  type FuturaRow = {
    id: string;
    decisao_final: string | null;
    empresa_origem_id: string | null;
    separacao_galpao_id: string | null;
    id_pedido_ecommerce: string | null;
    nome_ecommerce: string | null;
    prazo_envio: string | null;
  };
  const candidatos = ((futuras ?? []) as FuturaRow[]).filter(
    (p) => isMercadoLivre(p.nome_ecommerce) && p.id_pedido_ecommerce && p.empresa_origem_id,
  );
  resumo.candidatos = candidatos.length;
  if (candidatos.length === 0) return result;

  // 2. Nome do galpão (filial_execucao do job de lancar_estoque quando promove).
  const { data: galpoes } = await sb.from("siso_galpoes").select("id, nome");
  const nomeGalpao = new Map(
    ((galpoes ?? []) as Array<{ id: string; nome: string }>).map((g) => [g.id, g.nome]),
  );

  // 3. Agrupa por empresa (1 connId ML por empresa) e re-checa o substatus.
  const porEmpresa = new Map<string, FuturaRow[]>();
  for (const p of candidatos) {
    const arr = porEmpresa.get(p.empresa_origem_id!) ?? [];
    arr.push(p);
    porEmpresa.set(p.empresa_origem_id!, arr);
  }

  let consultados = 0;
  for (const [empresaId, peds] of porEmpresa) {
    if (resumo.truncado) break;
    let connId: string | null = null;
    try {
      connId = await getActiveMlConnectionForEmpresa(empresaId);
    } catch (e) {
      resumo.erros.push(`empresa ${empresaId}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!connId) continue; // empresa sem ML → não dá pra classificar
    const conn = connId;

    await runWithEmpresa(empresaId, async () => {
      for (const p of peds) {
        if (consultados >= PROMO_ML_CHECK_MAX) {
          resumo.truncado = true;
          break;
        }
        consultados++;
        let substatus: string | null = null;
        let mlStatus: string | null = null;
        try {
          const st = await getMlShipmentStatus(conn, String(p.id_pedido_ecommerce));
          substatus = st?.substatus ?? null;
          mlStatus = st?.status ?? null;
        } catch (e) {
          resumo.erros.push(`pedido ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Etiqueta liberou (substatus != buffered, shipment ativo) → PROMOVE,
        // igual fluxo normal (gera NF + agrupamento, inclusive OC — estoque é
        // fulfillment, não trava). Shipment cancelado/buffered/sem leitura → não.
        const acao = classificarPromocaoFutura(substatus, mlStatus);

        if (acao === "promover") {
          try {
            await promoverPedidoFutura(sb, {
              pedidoId: p.id,
              decisaoFinal: p.decisao_final,
              galpaoNome: p.separacao_galpao_id ? nomeGalpao.get(p.separacao_galpao_id) ?? null : null,
              empresaId,
            });
            resumo.promovidos++;
          } catch (e) {
            resumo.erros.push(`promover ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if (acao === "manter") {
          resumo.mantidos_buffered++;
        } else {
          resumo.ignorados++;
        }
      }
    });
  }

  resumo.ml_consultados = consultados;
  if (resumo.truncado) {
    logger.warn(LOG_SOURCE, "cap de promoção ML atingido — restante drena no próximo run", {
      consultados,
      candidatos: resumo.candidatos,
    });
  }
  logger.info(LOG_SOURCE, "Promoção de futuras concluída", { ...resumo });
  return result;
}
