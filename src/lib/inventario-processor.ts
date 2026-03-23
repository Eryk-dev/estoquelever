/**
 * Inventory processor — consolidates scanned items and sends updates to Tiny ERP.
 *
 * consolidarItens: groups by SKU (case-insensitive), sums quantities,
 *   merges unique locations with "; ".
 *
 * processarInventario: fire-and-forget async function.
 *   For each consolidated item (within runWithEmpresa for rate limiting):
 *   1. getProdutoDetalhe → detect Kit (K)
 *   2. getEstoque → save localizacao_antiga_tiny + saldo_anterior_tiny
 *   3. movimentarEstoque (if loc_estoque and NOT Kit)
 *   4. atualizarLocalizacaoProduto (with merge if manter_localizacao_antiga)
 *   5. Update item rows status (sucesso/erro)
 *
 * reverterInventario: undoes processed changes (sucesso items only).
 *   1. Restore localizacao_antiga_tiny via atualizarLocalizacaoProduto
 *   2. Reverse stock: B→B(saldo_anterior), E→S(same qty), S→E(same qty)
 *   3. Reset item status to pendente
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import {
  getProdutoDetalhe,
  getEstoque,
  movimentarEstoque,
  atualizarLocalizacaoProduto,
} from "./tiny-api";
import type {
  InventarioItem,
  InventarioItemConsolidado,
  InventarioItemStatus,
  TipoEstoque,
} from "@/types";

// ── Consolidation ────────────────────────────────────────────────────────────

/**
 * Groups inventory items by SKU (case-insensitive), sums quantities,
 * and merges unique locations sorted naturally with "; " separator.
 */
export function consolidarItens(
  itens: InventarioItem[],
): InventarioItemConsolidado[] {
  const groups = new Map<
    string,
    {
      sku: string;
      nome_produto: string | null;
      produto_id_tiny: number | null;
      ean: string | null;
      quantidade_total: number;
      localizacoes: Set<string>;
      itens_ids: string[];
      status: InventarioItemStatus;
      erro_msg: string | null;
    }
  >();

  for (const item of itens) {
    const key = item.sku.toUpperCase();
    const existing = groups.get(key);
    if (existing) {
      existing.quantidade_total += item.quantidade;
      if (item.localizacao) existing.localizacoes.add(item.localizacao);
      existing.itens_ids.push(item.id);
    } else {
      groups.set(key, {
        sku: item.sku,
        nome_produto: item.nome_produto,
        produto_id_tiny: item.produto_id_tiny,
        ean: item.ean,
        quantidade_total: item.quantidade,
        localizacoes: new Set(item.localizacao ? [item.localizacao] : []),
        itens_ids: [item.id],
        status: item.status,
        erro_msg: item.erro_msg,
      });
    }
  }

  return Array.from(groups.values()).map((g) => ({
    sku: g.sku,
    nome_produto: g.nome_produto,
    produto_id_tiny: g.produto_id_tiny,
    ean: g.ean,
    quantidade_total: g.quantidade_total,
    localizacoes: Array.from(g.localizacoes).sort().join("; "),
    itens_ids: g.itens_ids,
    status: g.status,
    erro_msg: g.erro_msg,
  }));
}

// ── Processing ───────────────────────────────────────────────────────────────

export async function processarInventario(
  inventarioId: string,
): Promise<void> {
  const supabase = createServiceClient();

  // 1. Set status → processando
  await supabase
    .from("siso_inventarios")
    .update({
      status: "processando",
      processado_em: new Date().toISOString(),
    })
    .eq("id", inventarioId);

  // 2. Fetch inventario with joins
  const { data: inventario } = await supabase
    .from("siso_inventarios")
    .select("*, empresa:siso_empresas(nome), usuario:siso_usuarios(nome)")
    .eq("id", inventarioId)
    .single();

  if (!inventario) {
    logger.logError({
      error: new Error("Inventário não encontrado"),
      source: "inventario",
      message: `Inventário ${inventarioId} não encontrado`,
      category: "database",
    });
    return;
  }

  // 3. Fetch only pendente items (supports checkpoint/resume)
  const { data: itens } = await supabase
    .from("siso_inventario_itens")
    .select("*")
    .eq("inventario_id", inventarioId)
    .eq("status", "pendente");

  if (!itens || itens.length === 0) {
    await supabase
      .from("siso_inventarios")
      .update({
        status: "concluido",
        concluido_em: new Date().toISOString(),
      })
      .eq("id", inventarioId);
    return;
  }

  // 4. Consolidate items by SKU
  const consolidados = consolidarItens(itens as InventarioItem[]);

  // 5. Build observacao string for stock movements
  const dataStr = new Date().toISOString().split("T")[0];
  const operadorNome =
    (inventario.usuario as { nome: string } | null)?.nome ?? "Desconhecido";
  const obsStr = inventario.observacoes
    ? ` - ${inventario.observacoes}`
    : "";
  const movimentacaoObs = `Inventário SISO - ${dataStr} - ${operadorNome}${obsStr}`;

  // 6. Process each consolidated item
  let anySuccess = false;

  for (const consolidado of consolidados) {
    if (!consolidado.produto_id_tiny) {
      await supabase
        .from("siso_inventario_itens")
        .update({
          status: "erro" as const,
          erro_msg: "produto_id_tiny não encontrado",
        })
        .in("id", consolidado.itens_ids);
      continue;
    }

    try {
      // Get fresh token (handles expiry during long processing runs)
      const { token } = await getValidTokenByEmpresa(inventario.empresa_id);

      await runWithEmpresa(inventario.empresa_id, async () => {
        const produtoId = consolidado.produto_id_tiny!;

        // a. Detect Kit type
        const detalhe = await getProdutoDetalhe(token, produtoId);
        const isKit = detalhe.tipo === "K";

        // b. Get current stock/location (for saldo_anterior + localizacao_antiga)
        const estoque = await getEstoque(token, produtoId);
        const localizacaoAntigaTiny = estoque.localizacao ?? null;

        // Save localizacao_antiga_tiny on all item rows
        await supabase
          .from("siso_inventario_itens")
          .update({ localizacao_antiga_tiny: localizacaoAntigaTiny })
          .in("id", consolidado.itens_ids);

        // c. Stock movement (if loc_estoque and NOT Kit)
        if (inventario.modo === "loc_estoque" && !isKit) {
          const deposito = estoque.depositos.find(
            (d) => d.id === inventario.deposito_id,
          );
          const saldoAnterior = deposito?.saldo ?? 0;

          // Save saldo_anterior_tiny (for Balanço reversal)
          await supabase
            .from("siso_inventario_itens")
            .update({ saldo_anterior_tiny: saldoAnterior })
            .in("id", consolidado.itens_ids);

          await movimentarEstoque(token, produtoId, {
            tipo: inventario.tipo_estoque as "B" | "E" | "S",
            quantidade: consolidado.quantidade_total,
            deposito: inventario.deposito_id
              ? { id: inventario.deposito_id }
              : undefined,
            observacoes: movimentacaoObs,
          });
        }

        // d. Compute final location
        let localizacaoFinal = consolidado.localizacoes;

        if (inventario.manter_localizacao_antiga && localizacaoAntigaTiny) {
          // Merge: split both → merge arrays → deduplicate → sort → join
          const locsAntigas = localizacaoAntigaTiny
            .split("; ")
            .map((s) => s.trim())
            .filter(Boolean);
          const locsNovas = consolidado.localizacoes
            .split("; ")
            .map((s) => s.trim())
            .filter(Boolean);
          const merged = [
            ...new Set([...locsAntigas, ...locsNovas]),
          ].sort();
          localizacaoFinal = merged.join("; ");
        }

        // e. Update location in Tiny
        await atualizarLocalizacaoProduto(
          token,
          produtoId,
          localizacaoFinal,
        );
      });

      // Mark all item rows as sucesso
      await supabase
        .from("siso_inventario_itens")
        .update({ status: "sucesso" as const })
        .in("id", consolidado.itens_ids);

      anySuccess = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await supabase
        .from("siso_inventario_itens")
        .update({ status: "erro" as const, erro_msg: errorMsg })
        .in("id", consolidado.itens_ids);

      logger.logError({
        error: err,
        source: "inventario",
        message: `Erro processando SKU ${consolidado.sku}`,
        category: "external_api",
        metadata: { inventarioId, sku: consolidado.sku },
      });
    }
  }

  // 7. Final status — concluido if any success, erro if ALL failed
  const finalStatus = anySuccess ? "concluido" : "erro";
  await supabase
    .from("siso_inventarios")
    .update({
      status: finalStatus,
      concluido_em: new Date().toISOString(),
    })
    .eq("id", inventarioId);
}

// ── Reversal ─────────────────────────────────────────────────────────────────

/**
 * Reverts a completed inventory session — undoes processed changes in Tiny ERP.
 * For each sucesso item: restores original location and reverses stock movement.
 * Fire-and-forget: called without await by the API route.
 */
export async function reverterInventario(
  inventarioId: string,
): Promise<void> {
  const supabase = createServiceClient();

  // 1. Set status → revertendo
  await supabase
    .from("siso_inventarios")
    .update({ status: "revertendo" })
    .eq("id", inventarioId);

  // 2. Fetch inventario
  const { data: inventario } = await supabase
    .from("siso_inventarios")
    .select("*, usuario:siso_usuarios(nome)")
    .eq("id", inventarioId)
    .single();

  if (!inventario) {
    logger.logError({
      error: new Error("Inventário não encontrado para reversão"),
      source: "inventario",
      message: `Inventário ${inventarioId} não encontrado para reversão`,
      category: "database",
    });
    return;
  }

  // 3. Fetch only sucesso items (only these were applied to Tiny)
  const { data: itens } = await supabase
    .from("siso_inventario_itens")
    .select("*")
    .eq("inventario_id", inventarioId)
    .eq("status", "sucesso");

  if (!itens || itens.length === 0) {
    await supabase
      .from("siso_inventarios")
      .update({
        status: "revertido",
        concluido_em: new Date().toISOString(),
      })
      .eq("id", inventarioId);
    return;
  }

  // 4. Consolidate sucesso items by SKU (same grouping as processamento)
  const consolidados = consolidarItens(itens as InventarioItem[]);

  // 5. Build reversal observacao
  const dataStr = new Date().toISOString().split("T")[0];
  const operadorNome =
    (inventario.usuario as { nome: string } | null)?.nome ?? "Desconhecido";
  const movimentacaoObs = `Reversão Inventário SISO - ${dataStr} - ${operadorNome}`;

  // 6. Reverse each consolidated item
  let anyReverted = false;

  for (const consolidado of consolidados) {
    if (!consolidado.produto_id_tiny) {
      await supabase
        .from("siso_inventario_itens")
        .update({ status: "erro" as const, erro_msg: "produto_id_tiny ausente" })
        .in("id", consolidado.itens_ids);
      continue;
    }

    try {
      const { token } = await getValidTokenByEmpresa(inventario.empresa_id);

      await runWithEmpresa(inventario.empresa_id, async () => {
        const produtoId = consolidado.produto_id_tiny!;

        // a. Restore original location
        // Pick localizacao_antiga_tiny from the first item (all rows for same SKU have the same value)
        const firstItem = itens.find(
          (i) => consolidado.itens_ids.includes(i.id),
        );
        const locAnterior = firstItem?.localizacao_antiga_tiny ?? "";

        await atualizarLocalizacaoProduto(token, produtoId, locAnterior);

        // b. Reverse stock if loc_estoque AND NOT Kit (same check as processamento)
        if (inventario.modo === "loc_estoque") {
          const detalhe = await getProdutoDetalhe(token, produtoId);
          const isKit = detalhe.tipo === "K";

          if (!isKit) {
            const tipoOriginal = inventario.tipo_estoque as TipoEstoque;

            if (tipoOriginal === "B") {
              // Balanço reversal: set Balanço back to saldo_anterior_tiny
              const saldoAnterior = firstItem?.saldo_anterior_tiny ?? 0;
              await movimentarEstoque(token, produtoId, {
                tipo: "B",
                quantidade: saldoAnterior,
                deposito: inventario.deposito_id
                  ? { id: inventario.deposito_id }
                  : undefined,
                observacoes: movimentacaoObs,
              });
            } else if (tipoOriginal === "E") {
              // Entrada reversal: do Saída with same qty
              await movimentarEstoque(token, produtoId, {
                tipo: "S",
                quantidade: consolidado.quantidade_total,
                deposito: inventario.deposito_id
                  ? { id: inventario.deposito_id }
                  : undefined,
                observacoes: movimentacaoObs,
              });
            } else if (tipoOriginal === "S") {
              // Saída reversal: do Entrada with same qty
              await movimentarEstoque(token, produtoId, {
                tipo: "E",
                quantidade: consolidado.quantidade_total,
                deposito: inventario.deposito_id
                  ? { id: inventario.deposito_id }
                  : undefined,
                observacoes: movimentacaoObs,
              });
            }
          }
        }
      });

      // Mark items back to pendente (reverted successfully)
      await supabase
        .from("siso_inventario_itens")
        .update({ status: "pendente" as const, erro_msg: null })
        .in("id", consolidado.itens_ids);

      anyReverted = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await supabase
        .from("siso_inventario_itens")
        .update({ status: "erro" as const, erro_msg: errorMsg })
        .in("id", consolidado.itens_ids);

      logger.logError({
        error: err,
        source: "inventario",
        message: `Erro revertendo SKU ${consolidado.sku}`,
        category: "external_api",
        metadata: { inventarioId, sku: consolidado.sku },
      });
    }
  }

  // 7. Final status — revertido if any success, erro if ALL failed
  const finalStatus = anyReverted ? "revertido" : "erro";
  await supabase
    .from("siso_inventarios")
    .update({
      status: finalStatus,
      concluido_em: new Date().toISOString(),
    })
    .eq("id", inventarioId);
}
