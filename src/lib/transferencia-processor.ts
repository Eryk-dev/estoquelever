/**
 * Transfer processor — moves stock between empresas (origin → destination).
 *
 * processarTransferencia: fire-and-forget async function.
 *   For each pendente item:
 *   1. runWithEmpresa(destino) → buscarProdutoPorSku to find product in destination
 *   2. If not found → clone: get full product from origin, create in destination
 *   3. runWithEmpresa(origem) → movimentarEstoque tipo:'S' (exit from origin)
 *   4. runWithEmpresa(destino) → movimentarEstoque tipo:'E' (entry to destination)
 *   5. Update item with produto_id_tiny_destino + status
 *
 * reverterTransferencia: undoes processed changes (sucesso items only).
 *   For each sucesso item: Entrada on origin + Saída on destination (reverse).
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import {
  buscarProdutoPorSku,
  criarProduto,
  movimentarEstoque,
  getProdutoCompleto,
} from "./tiny-api";

// ── Processing ───────────────────────────────────────────────────────────────

export async function processarTransferencia(
  transferenciaId: string,
): Promise<void> {
  const supabase = createServiceClient();

  // 1. Set status → processando
  await supabase
    .from("siso_transferencias")
    .update({
      status: "processando",
      processado_em: new Date().toISOString(),
    })
    .eq("id", transferenciaId);

  // 2. Fetch transferencia with joins
  const { data: transferencia } = await supabase
    .from("siso_transferencias")
    .select(
      "*, galpao_origem:siso_galpoes!galpao_origem_id(nome), galpao_destino:siso_galpoes!galpao_destino_id(nome), usuario:siso_usuarios(nome)",
    )
    .eq("id", transferenciaId)
    .single();

  if (!transferencia) {
    logger.logError({
      error: new Error("Transferência não encontrada"),
      source: "transferencia",
      message: `Transferência ${transferenciaId} não encontrada`,
      category: "database",
    });
    return;
  }

  // 3. Fetch only pendente items (supports checkpoint/resume)
  const { data: itens } = await supabase
    .from("siso_transferencia_itens")
    .select("*")
    .eq("transferencia_id", transferenciaId)
    .eq("status", "pendente");

  if (!itens || itens.length === 0) {
    await supabase
      .from("siso_transferencias")
      .update({
        status: "concluido",
        concluido_em: new Date().toISOString(),
      })
      .eq("id", transferenciaId);
    return;
  }

  // 4. Build observation strings
  const dataStr = new Date().toISOString().split("T")[0];
  const operadorNome =
    (transferencia.usuario as { nome: string } | null)?.nome ?? "Desconhecido";
  const galpaoDestinoNome =
    (transferencia.galpao_destino as { nome: string } | null)?.nome ??
    "Destino";
  const galpaoOrigemNome =
    (transferencia.galpao_origem as { nome: string } | null)?.nome ?? "Origem";

  const obsSaida = `Transferência SISO para ${galpaoDestinoNome} - ${dataStr} - ${operadorNome}`;
  const obsEntrada = `Transferência SISO de ${galpaoOrigemNome} - ${dataStr} - ${operadorNome}`;

  // 5. Process each item
  let anySuccess = false;

  for (const item of itens) {
    try {
      let produtoIdDestino: number | null = null;
      let clonado = false;

      // a. Search for product in destination by SKU
      const { token: tokenDestino } = await getValidTokenByEmpresa(
        transferencia.empresa_destino_id,
      );
      const found = await runWithEmpresa(
        transferencia.empresa_destino_id,
        async () => buscarProdutoPorSku(tokenDestino, item.sku),
      );

      if (found) {
        produtoIdDestino = found.id;
      } else {
        // b. Clone: get full product from origin, create in destination
        const { token: tokenOrigem } = await getValidTokenByEmpresa(
          transferencia.empresa_origem_id,
        );
        const produtoOrigem = await runWithEmpresa(
          transferencia.empresa_origem_id,
          async () =>
            getProdutoCompleto(tokenOrigem, item.produto_id_tiny_origem),
        );

        const { token: tokenDestino2 } = await getValidTokenByEmpresa(
          transferencia.empresa_destino_id,
        );
        const novoProduto = await runWithEmpresa(
          transferencia.empresa_destino_id,
          async () =>
            criarProduto(tokenDestino2, {
              nome: produtoOrigem.descricao,
              preco: produtoOrigem.preco || 0.01,
              codigo: produtoOrigem.sku,
              gtin: produtoOrigem.gtin || undefined,
              unidade: produtoOrigem.unidade,
              ncm: produtoOrigem.ncm,
              origem: produtoOrigem.origem,
            }),
        );

        produtoIdDestino = novoProduto.id;
        clonado = true;
      }

      // c. Exit stock from origin (Saída)
      const { token: tokenOrigem3 } = await getValidTokenByEmpresa(
        transferencia.empresa_origem_id,
      );
      await runWithEmpresa(transferencia.empresa_origem_id, async () => {
        await movimentarEstoque(tokenOrigem3, item.produto_id_tiny_origem, {
          tipo: "S",
          quantidade: item.quantidade,
          deposito: transferencia.deposito_origem_id
            ? { id: transferencia.deposito_origem_id }
            : undefined,
          observacoes: obsSaida,
        });
      });

      // d. Entry stock to destination (Entrada)
      const { token: tokenDestino3 } = await getValidTokenByEmpresa(
        transferencia.empresa_destino_id,
      );
      await runWithEmpresa(transferencia.empresa_destino_id, async () => {
        await movimentarEstoque(tokenDestino3, produtoIdDestino!, {
          tipo: "E",
          quantidade: item.quantidade,
          deposito: transferencia.deposito_destino_id
            ? { id: transferencia.deposito_destino_id }
            : undefined,
          observacoes: obsEntrada,
        });
      });

      // e. Update item as sucesso
      await supabase
        .from("siso_transferencia_itens")
        .update({
          produto_id_tiny_destino: produtoIdDestino,
          clonado,
          status: "sucesso" as const,
        })
        .eq("id", item.id);

      anySuccess = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await supabase
        .from("siso_transferencia_itens")
        .update({ status: "erro" as const, erro_msg: errorMsg })
        .eq("id", item.id);

      logger.logError({
        error: err,
        source: "transferencia",
        message: `Erro processando SKU ${item.sku}`,
        category: "external_api",
        metadata: { transferenciaId, sku: item.sku },
      });
    }
  }

  // 6. Final status — concluido if any success, erro if ALL failed
  const finalStatus = anySuccess ? "concluido" : "erro";
  await supabase
    .from("siso_transferencias")
    .update({
      status: finalStatus,
      concluido_em: new Date().toISOString(),
    })
    .eq("id", transferenciaId);
}

// ── Reversal ─────────────────────────────────────────────────────────────────

/**
 * Reverts a completed transfer — undoes stock movements in both empresas.
 * For each sucesso item: Entrada on origin + Saída on destination (reverse).
 * Fire-and-forget: called without await by the API route.
 */
export async function reverterTransferencia(
  transferenciaId: string,
): Promise<void> {
  const supabase = createServiceClient();

  // 1. Set status → revertendo
  await supabase
    .from("siso_transferencias")
    .update({ status: "revertendo" })
    .eq("id", transferenciaId);

  // 2. Fetch transferencia
  const { data: transferencia } = await supabase
    .from("siso_transferencias")
    .select("*, usuario:siso_usuarios(nome)")
    .eq("id", transferenciaId)
    .single();

  if (!transferencia) {
    logger.logError({
      error: new Error("Transferência não encontrada para reversão"),
      source: "transferencia",
      message: `Transferência ${transferenciaId} não encontrada para reversão`,
      category: "database",
    });
    return;
  }

  // 3. Fetch only sucesso items (only these were applied)
  const { data: itens } = await supabase
    .from("siso_transferencia_itens")
    .select("*")
    .eq("transferencia_id", transferenciaId)
    .eq("status", "sucesso");

  if (!itens || itens.length === 0) {
    await supabase
      .from("siso_transferencias")
      .update({
        status: "revertido",
        concluido_em: new Date().toISOString(),
      })
      .eq("id", transferenciaId);
    return;
  }

  // 4. Build reversal observation
  const dataStr = new Date().toISOString().split("T")[0];
  const operadorNome =
    (transferencia.usuario as { nome: string } | null)?.nome ?? "Desconhecido";
  const obsReversao = `Reversão Transferência SISO - ${dataStr} - ${operadorNome}`;

  // 5. Reverse each item
  for (const item of itens) {
    if (!item.produto_id_tiny_destino) {
      await supabase
        .from("siso_transferencia_itens")
        .update({
          status: "erro" as const,
          erro_msg: "produto_id_tiny_destino ausente",
        })
        .eq("id", item.id);
      continue;
    }

    try {
      // a. Re-enter stock in origin (was Saída, now Entrada)
      const { token: tokenOrigem } = await getValidTokenByEmpresa(
        transferencia.empresa_origem_id,
      );
      await runWithEmpresa(transferencia.empresa_origem_id, async () => {
        await movimentarEstoque(tokenOrigem, item.produto_id_tiny_origem, {
          tipo: "E",
          quantidade: item.quantidade,
          deposito: transferencia.deposito_origem_id
            ? { id: transferencia.deposito_origem_id }
            : undefined,
          observacoes: obsReversao,
        });
      });

      // b. Re-exit stock from destination (was Entrada, now Saída)
      const { token: tokenDestino } = await getValidTokenByEmpresa(
        transferencia.empresa_destino_id,
      );
      await runWithEmpresa(transferencia.empresa_destino_id, async () => {
        await movimentarEstoque(tokenDestino, item.produto_id_tiny_destino!, {
          tipo: "S",
          quantidade: item.quantidade,
          deposito: transferencia.deposito_destino_id
            ? { id: transferencia.deposito_destino_id }
            : undefined,
          observacoes: obsReversao,
        });
      });

      // Mark item back to pendente (reverted successfully)
      await supabase
        .from("siso_transferencia_itens")
        .update({ status: "pendente" as const, erro_msg: null })
        .eq("id", item.id);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await supabase
        .from("siso_transferencia_itens")
        .update({ status: "erro" as const, erro_msg: errorMsg })
        .eq("id", item.id);

      logger.logError({
        error: err,
        source: "transferencia",
        message: `Erro revertendo SKU ${item.sku}`,
        category: "external_api",
        metadata: { transferenciaId, sku: item.sku },
      });
    }
  }

  // 6. Final status → revertido
  await supabase
    .from("siso_transferencias")
    .update({
      status: "revertido",
      concluido_em: new Date().toISOString(),
    })
    .eq("id", transferenciaId);
}
