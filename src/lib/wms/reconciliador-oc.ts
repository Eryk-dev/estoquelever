// ──────────────────────────────────────────────────────────────────
// Reconciliador de saldo OC — quando entra estoque, devolve ao picking
// os pedidos parados por falta (FIFO, mais antigo primeiro), usando só
// saldo LIVRE. Disparado pelo gancho de mov E em ledger.ts.

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { reservarAtomico } from "@/lib/wms/reservas";
import { buscarLocComMaiorSaldoNoGalpao } from "@/lib/separacao/wms-mapping";
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

// ──────────────────────────────────────────────────────────────────
// IO Orchestrator — reconcilia pedidos OC pendentes quando entra
// estoque novo no galpão (disparado por mov E em ledger.ts).

const STATUS_PEDIDO_OC = ["validacao_oc", "aguardando_compra"] as const;
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

  // 3. desconta partes já picadas (parcial + realocações) — igual qtyEfetiva
  const itemIds = rows.map((r) => r.id as string);
  const { data: realocs } = await supabase
    .from("siso_pedido_item_realocacoes")
    .select("pedido_item_id, qty_picada")
    .in("pedido_item_id", itemIds)
    .eq("status", "picado");
  const picadoPorItem = new Map<string, number>();
  for (const r of realocs ?? []) {
    const k = r.pedido_item_id as string;
    picadoPorItem.set(k, (picadoPorItem.get(k) ?? 0) + Number(r.qty_picada ?? 0));
  }

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
        Number(r.quantidade_pedida ?? 0) -
          Number(r.quantidade_pega ?? 0) -
          (picadoPorItem.get(r.id as string) ?? 0),
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

  // 4. saldo LIVRE do produto no galpão
  const { data: est } = await supabase
    .from("siso_estoque")
    .select("disponivel")
    .eq("produto_id", produtoId)
    .eq("galpao_id", galpaoId)
    .gt("disponivel", 0);
  const saldoLivre = (est ?? []).reduce(
    (acc, row) => acc + Number(row.disponivel ?? 0),
    0,
  );
  if (saldoLivre <= 0) return;

  // 5. seleção FIFO estrita (função pura já no arquivo)
  const selecao = selecionarLiberaveisFifo(pendentes, saldoLivre);

  // 6. liberar: reserva atômica → desvincula OC → limpa campos
  const pedidosAfetados = new Set<string>();
  for (const linha of selecao) {
    if (!linha.libera) continue;
    const locId = await buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoId);
    if (!locId) continue;
    try {
      await reservarAtomico({
        tripla: { produto_id: produtoId, galpao_id: galpaoId, localizacao_id: locId },
        qty: linha.outstanding,
        pedido_id: linha.pedido_id,
        ttl_horas: 24 * 30,
      });
    } catch (err) {
      logger.warn("reconciliador-oc", "reserva falhou; item segue na compra", {
        item_id: linha.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const { error: updErr } = await supabase
      .from("siso_pedido_itens")
      .update({
        compra_status: null,
        ordem_compra_id: null,
        compra_quantidade_solicitada: 0,
        compra_solicitada_em: null,
        fornecedor_oc: null,
      })
      .eq("id", linha.id);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "reconciliador-oc",
        message: `Falha ao limpar campos de compra do item ${linha.id}`,
        category: "database",
      });
      continue;
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
    await transicionarPedidoSeReconciliado(supabase, pedidoId);
  }
}

async function transicionarPedidoSeReconciliado(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
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

  if (pedido.status_separacao === "em_separacao") {
    // Operador já está separando (NF já passou) — só rotula como própria,
    // sem reenfileirar lancar_estoque nem regredir o status.
    const { error: updErr } = await supabase
      .from("siso_pedidos")
      .update({ decisao_final: "propria" })
      .eq("id", pedidoId);
    if (updErr) {
      logger.logError({
        error: updErr,
        source: "reconciliador-oc",
        message: `Falha ao marcar pedido ${pedidoId} como própria (em_separacao)`,
        category: "database",
      });
    }
    return;
  }

  const { error: pedidoUpdErr } = await supabase
    .from("siso_pedidos")
    .update({
      decisao_final: "propria",
      status: "executando",
      status_separacao: "aguardando_nf",
    })
    .eq("id", pedidoId);
  // Se o pedido não transicionou, NÃO enfileira o job — evita lancar_estoque
  // órfão pra um pedido ainda preso em validacao_oc/aguardando_compra.
  if (pedidoUpdErr) {
    logger.logError({
      error: pedidoUpdErr,
      source: "reconciliador-oc",
      message: `Falha ao transicionar pedido ${pedidoId} para própria/aguardando_nf`,
      category: "database",
    });
    return;
  }

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
  logger.info("reconciliador-oc", "pedido OC devolvido ao fluxo próprio por saldo", {
    pedidoId,
  });
}
