// ──────────────────────────────────────────────────────────────────
// Reconciliador de saldo OC — quando entra estoque, devolve ao picking
// os pedidos parados por falta (FIFO, mais antigo primeiro), usando só
// saldo LIVRE. Disparado pelo gancho de mov E em ledger.ts.

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { reservarAtomico } from "@/lib/wms/reservas";
import { cancelOcIfEmpty } from "@/lib/compras-utils";
import { registrarEvento } from "@/lib/historico-service";

/**
 * FIFO estrito: percorre os pendentes (já ordenados por antiguidade) e marca
 * `libera=true` enquanto o saldo livre cobre o `outstanding` de cada um. Ao
 * encontrar o primeiro que não cabe, bloqueia o resto (não fura a fila).
 */
export function selecionarLiberaveisFifo<T extends { outstanding: number }>(
  pendentesOrdenados: T[],
  saldoLivre: number,
): Array<T & { libera: boolean }> {
  let restante = Math.max(0, saldoLivre);
  let bloqueado = false;
  return pendentesOrdenados.map((item) => {
    const need = Math.max(0, item.outstanding);
    if (!bloqueado && need > 0 && need <= restante) {
      restante -= need;
      return { ...item, libera: true };
    }
    if (need > 0) bloqueado = true;
    return { ...item, libera: false };
  });
}

/**
 * A partir de itens OC (com sku + galpão) e um mapa sku→produto_uuid, devolve
 * os pares (produtoId, galpaoId) ÚNICOS que precisam ser reconciliados. Ignora
 * itens sem uuid mapeado ou sem galpão. Pura — testável sem IO. Usada pelo
 * clique SEPARAR (separacao/iniciar) pra disparar a reconciliação dos itens OC.
 */
export function paresProdutoGalpao(
  itens: Array<{ sku: string | null; galpao_id: string | null }>,
  skuToUuid: Map<string, string>,
): Array<{ produtoId: string; galpaoId: string }> {
  const vistos = new Set<string>();
  const out: Array<{ produtoId: string; galpaoId: string }> = [];
  for (const it of itens) {
    if (!it.sku || !it.galpao_id) continue;
    const produtoId = skuToUuid.get(it.sku);
    if (!produtoId) continue;
    const chave = `${produtoId}|${it.galpao_id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({ produtoId, galpaoId: it.galpao_id });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────
// IO Orchestrator — reconcilia pedidos OC pendentes quando entra
// estoque novo no galpão (disparado por mov E em ledger.ts).

// Inclui em_separacao: se o saldo aparece DEPOIS do pedido já estar na wave
// (operador abriu o checklist → promovido a em_separacao), o item OC tem que
// poder ser rebaixado a normal mesmo assim. transicionarPedidoSeReconciliado
// (branch de estado avançado) já trata: só marca decisao_final='propria', não
// regride status. A NF sai depois, na embalagem (confirmar-item-embalagem /
// bipar-embalagem-oc enfileiram lancar_estoque).
const STATUS_PEDIDO_OC = ["validacao_oc", "aguardando_compra", "em_separacao"] as const;
const COMPRA_PENDENTE = ["oc_pendente", "aguardando_compra"] as const;

/**
 * Quando chega estoque novo (mov E), verifica pedidos parados em OC para
 * esse produto+galpão e, usando saldo livre + FIFO, cria reservas e
 * devolve os pedidos ao fluxo próprio.
 */
export async function reconciliarEntradaEstoque(args: {
  produtoId: string; // uuid WMS (siso_produtos.id)
  galpaoId: string;
}): Promise<void> {
  const { produtoId, galpaoId } = args;
  const supabase = createServiceClient();

  // 1. produto uuid → sku
  const { data: prod } = await supabase
    .from("siso_produtos")
    .select("sku")
    .eq("id", produtoId)
    .maybeSingle();
  const sku = prod?.sku as string | undefined;
  if (!sku) return;

  // 2. itens OC pendentes desse sku, em pedidos desse galpão em estado OC
  const { data: rows } = await supabase
    .from("siso_pedido_itens")
    .select(
      "id, pedido_id, quantidade_pedida, quantidade_pega, compra_status, ordem_compra_id, siso_pedidos!inner(id, criado_em, status_separacao, separacao_galpao_id)",
    )
    .eq("sku", sku)
    .in("compra_status", COMPRA_PENDENTE as unknown as string[])
    .eq("siso_pedidos.separacao_galpao_id", galpaoId)
    .in("siso_pedidos.status_separacao", STATUS_PEDIDO_OC as unknown as string[]);
  if (!rows || rows.length === 0) return;

  // 3. outstanding = pedida − já pega. (Picks via realocação JÁ incrementam
  //    quantidade_pega — não há coluna/subtração extra a fazer aqui.)
  type Linha = {
    id: string;
    pedido_id: string;
    ordem_compra_id: string | null;
    criado_em: string;
    outstanding: number;
  };
  const pendentes: Linha[] = rows
    .map((r) => {
      // siso_pedidos!inner may be typed as array by the Supabase client — normalise
      const pedRaw = r.siso_pedidos as unknown;
      const ped: { id: string; criado_em?: string } | null = Array.isArray(pedRaw)
        ? (pedRaw[0] as { id: string; criado_em?: string } | undefined) ?? null
        : (pedRaw as { id: string; criado_em?: string } | null);
      const outstanding = Math.max(
        0,
        Number(r.quantidade_pedida ?? 0) - Number(r.quantidade_pega ?? 0),
      );
      return {
        id: r.id as string,
        pedido_id: r.pedido_id as string,
        ordem_compra_id: (r.ordem_compra_id as string | null) ?? null,
        criado_em: ped?.criado_em ?? "",
        outstanding,
      };
    })
    .filter((l) => l.outstanding > 0)
    // FIFO por criado_em; desempate estável por pedido_id (criado_em pode
    // empatar quando vários pedidos entram no mesmo lote de webhook).
    .sort(
      (a, b) =>
        a.criado_em.localeCompare(b.criado_em) ||
        a.pedido_id.localeCompare(b.pedido_id),
    );
  if (pendentes.length === 0) return;

  // 4. saldo LIVRE em locs de PICKING. Estoque recém-chegado fica em
  //    RECEBIMENTO (e há quarentena/packing/expedição) — NÃO é pickável.
  //    Reservar fora do picking quebraria a guarda reservado<=saldo quando o
  //    put-away tira o estoque dali (tipo S). Filtramos por loc tipo='picking'
  //    via JOIN embedded (o galpão tem centenas de locs picking; um .in() com
  //    todos os ids estoura o tamanho da URL do PostgREST → Bad Request).
  const { data: est } = await supabase
    .from("siso_estoque")
    .select("disponivel, siso_localizacoes!inner(tipo)")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .eq("siso_localizacoes.tipo", "picking")
    .gt("disponivel", 0);
  const saldoLivre = (est ?? []).reduce(
    (acc, row) => acc + Number(row.disponivel ?? 0),
    0,
  );
  if (saldoLivre <= 0) return;

  // Escolhe a loc de PICKING com maior disponível pra colocar a reserva.
  // Re-consultado a cada item (o disponível cai conforme reservamos).
  // P3-26: exclui locs com lock ativo (sendo inventariadas) — criar R numa loc
  // travada conflita com a contagem em curso. Mesmo filtro de
  // roteamento.ts/sugestao-dinamica.ts (siso_localizacao_locks, finalizado_em IS NULL).
  async function melhorLocPicking(): Promise<string | null> {
    const [estoqueRes, locksRes] = await Promise.all([
      supabase
        .from("siso_estoque")
        .select("localizacao_id, siso_localizacoes!inner(tipo)")
        .eq("produto_id", produtoId)
        .eq("galpao_id", galpaoId)
        .eq("siso_localizacoes.tipo", "picking")
        .gt("disponivel", 0)
        .order("disponivel", { ascending: false })
        .limit(20),
      supabase
        .from("siso_localizacao_locks")
        .select("localizacao_id")
        .is("finalizado_em", null),
    ]);
    const blocked = new Set(
      (locksRes.data ?? []).map(
        (l) => (l as { localizacao_id: string }).localizacao_id,
      ),
    );
    const livre = (estoqueRes.data ?? []).find(
      (row) => !blocked.has((row as { localizacao_id: string }).localizacao_id),
    );
    return (livre as { localizacao_id?: string } | undefined)?.localizacao_id ?? null;
  }

  // 5. seleção FIFO estrita (função pura já no arquivo)
  const selecao = selecionarLiberaveisFifo(pendentes, saldoLivre);

  // 6. liberar cada item: CLAIM atômico → reserva em loc de picking → desvincula OC
  const pedidosAfetados = new Set<string>();
  for (const linha of selecao) {
    if (!linha.libera) continue;

    // CLAIM atômico (compare-and-swap): limpa os campos de compra SÓ se o item
    // ainda está pendente. Se uma varredura concorrente já reconciliou, o
    // filtro não casa e voltam 0 linhas → pula. Garante 1 reserva por item
    // (sem reserva dupla / oversell sob entradas E concorrentes).
    const { data: claimed, error: claimErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: null,
        ordem_compra_id: null,
        compra_quantidade_solicitada: 0,
        compra_solicitada_em: null,
        fornecedor_oc: null,
      })
      .eq("id", linha.id)
      .in("compra_status", COMPRA_PENDENTE as unknown as string[])
      .select("id");
    if (claimErr) {
      logger.logError({
        error: claimErr,
        source: "reconciliador-oc",
        message: `Falha ao reivindicar item ${linha.id}`,
        category: "database",
      });
      continue;
    }
    if (!claimed || claimed.length === 0) continue; // perdeu a corrida

    // Reserva o outstanding numa loc de PICKING (nunca recebimento).
    const locId = await melhorLocPicking();
    if (locId) {
      try {
        await reservarAtomico({
          tripla: { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId },
          qty: linha.outstanding,
          pedido_id: linha.pedido_id,
          ttl_horas: 24 * 30,
        });
      } catch (err) {
        // Loc esgotou na corrida — o item já voltou ao picking e será pego do
        // saldo vivo no pick (atômico, anti-oversell). Fica sem R, sem travar.
        logger.warn("reconciliador-oc", "reserva falhou pós-claim; item sem R", {
          item_id: linha.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await cancelOcIfEmpty(supabase, linha.ordem_compra_id, "reconciliador-oc");
    pedidosAfetados.add(linha.pedido_id);
    void registrarEvento({
      pedidoId: linha.pedido_id,
      evento: "oc_item_saldo_reconciliado",
      detalhes: { item_id: linha.id, sku, qty: linha.outstanding, galpao_id: galpaoId },
    });
  }

  // 7. recomputa status dos pedidos afetados
  for (const pedidoId of pedidosAfetados) {
    await transicionarPedidoSeReconciliado(supabase, pedidoId, { produtoId, galpaoId });
  }
}

async function transicionarPedidoSeReconciliado(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  // P082/P149: produto/galpão da entrada que disparou a reconciliação — usados
  // pra enfileirar um retry durável se a transição falhar (transitório de banco).
  ctx: { produtoId: string; galpaoId: string },
): Promise<void> {
  const { data: allItems } = await supabase
    .from("siso_pedido_itens")
    .select("compra_status")
    .eq("pedido_id", pedidoId);
  if (!allItems) return;
  const aindaEmCompra = allItems.some(
    (i) =>
      i.compra_status === "oc_pendente" ||
      i.compra_status === "aguardando_compra" ||
      i.compra_status === "comprado",
  );
  if (aindaEmCompra) return;

  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("id, status_separacao, empresa_origem_id")
    .eq("id", pedidoId)
    .maybeSingle();
  if (!pedido) return;

  // I2: só os estados OC reentram no portão de NF. Qualquer estado mais
  // avançado (em_separacao/aguardando_separacao/separado/embalado/expedido)
  // NÃO regride — só rotula decisao=propria (operador pode já estar separando
  // ou o pedido pode ter avançado numa corrida entre o SELECT e aqui).
  if (
    pedido.status_separacao !== "validacao_oc" &&
    pedido.status_separacao !== "aguardando_compra"
  ) {
    const { error: updErr } = await supabase
      .from("siso_pedidos")
      .update({ decisao_final: "propria" })
      .eq("id", pedidoId);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "reconciliador-oc",
        message: `Falha ao marcar pedido ${pedidoId} como própria (estado avançado)`,
        category: "database",
      });
    }
    return;
  }

  // validacao_oc / aguardando_compra → vira própria e reentra no portão de NF.
  // O filtro .in(status_separacao) torna a transição condicional: se uma
  // corrida já avançou o pedido, voltam 0 linhas e NÃO enfileiramos o job
  // (evita lancar_estoque órfão / regressão).
  const { data: transRows, error: pedidoUpdErr } = await supabase
    .from("siso_pedidos")
    .update({
      decisao_final: "propria",
      status: "executando",
      status_separacao: "aguardando_nf",
    })
    .eq("id", pedidoId)
    .in("status_separacao", ["validacao_oc", "aguardando_compra"])
    .select("id");
  if (pedidoUpdErr) {
    // P082/P149: antes só logava e desistia — pedido OC ficava preso pra sempre.
    // Agora enfileira um retry durável (backoff 30s/5min/10min no worker) e
    // registra um evento 'erro' visível (alerta) pra ninguém ficar no escuro.
    logger.logError({
      error: pedidoUpdErr,
      source: "reconciliador-oc",
      message: `Falha ao transicionar pedido ${pedidoId} — enfileirando retry durável`,
      category: "database",
    });
    const { enfileirarJobManutencao } = await import("./jobs-manutencao");
    await enfileirarJobManutencao({
      tipo: "reconciliar_oc_retry",
      pedido_id: pedidoId,
      payload: { produto_id: ctx.produtoId, galpao_id: ctx.galpaoId },
    });
    void registrarEvento({
      pedidoId,
      evento: "erro",
      detalhes: { motivo: "reconciliacao_oc_falhou", retry_enfileirado: true },
    });
    return;
  }
  if (!transRows || transRows.length === 0) return; // corrida: já avançou

  const { data: jobExistente } = await supabase
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque")
    .in("status", ["pendente", "executando"])
    .maybeSingle();
  if (!jobExistente) {
    const { error: insErr } = await supabase.from("siso_fila_execucao").insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      empresa_id: pedido.empresa_origem_id,
      decisao: "propria",
    });
    // 23505 = corrida com outro caminho que já criou o job (índice único
    // uq_fila_release_pedido) — idempotente, ignora.
    if (insErr && insErr.code !== "23505") {
      logger.logError({
        error: insErr,
        source: "reconciliador-oc",
        message: `Falha ao enfileirar lancar_estoque para pedido ${pedidoId}`,
        category: "database",
      });
    }
  }

  // Acorda o worker pra processar o lancar_estoque. Diferente do worker (que já
  // está no loop de drenagem), o reconciliador roda fora dele — sem o kick, o
  // job ficaria pendente pra sempre (não há cron drenando a fila). Lazy import
  // pra evitar cycle (reconciliador-oc é carregado lazy pelos callers).
  try {
    const { kickWorker } = await import("@/lib/execution-worker");
    void kickWorker().catch((err) => {
      logger.warn("reconciliador-oc", "kickWorker falhou (não-fatal)", {
        pedidoId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.warn("reconciliador-oc", "import kickWorker falhou (não-fatal)", {
      pedidoId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info("reconciliador-oc", "pedido OC devolvido ao fluxo próprio por saldo", {
    pedidoId,
  });
}
