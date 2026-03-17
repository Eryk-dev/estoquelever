import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { buscarEImprimirEtiqueta, imprimirEtiquetaDireta } from "@/lib/etiqueta-service";
import { registrarEvento } from "@/lib/historico-service";
import type { BipEmbalagemResult } from "@/types";

/**
 * POST /api/separacao/bipar-embalagem
 *
 * Process a barcode scan during packing. Calls the PL/pgSQL function
 * siso_processar_bip_embalagem which finds the oldest separado-status
 * order with the scanned SKU and updates quantities atomically.
 *
 * Body: { sku: string, galpao_id: string, quantidade?: number }
 * Returns: BipEmbalagemResult
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.sku || typeof body.sku !== "string") {
    return NextResponse.json(
      { error: "'sku' (string) é obrigatório" },
      { status: 400 },
    );
  }
  if (!body?.galpao_id || typeof body.galpao_id !== "string") {
    return NextResponse.json(
      { error: "'galpao_id' (string) é obrigatório" },
      { status: 400 },
    );
  }

  const sku: string = body.sku.trim();
  const galpao_id: string = body.galpao_id;
  const quantidade: number =
    typeof body.quantidade === "number" && body.quantidade > 0
      ? body.quantidade
      : 1;

  const supabase = createServiceClient();

  try {
    const { data, error } = await supabase.rpc(
      "siso_processar_bip_embalagem",
      {
        p_sku: sku,
        p_galpao_id: galpao_id,
        p_quantidade: quantidade,
      },
    );

    if (error) {
      logger.error("bipar-embalagem", "RPC error", {
        error: error.message,
        sku,
        galpao_id,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // TABLE-returning functions return empty array when no match found
    if (!data || (Array.isArray(data) && data.length === 0)) {
      return NextResponse.json(
        { error: "Nenhum pedido com este SKU pendente de embalagem" },
        { status: 404 },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    const result: BipEmbalagemResult = {
      pedido_id: row.pedido_id,
      produto_id: row.produto_id,
      quantidade_bipada: row.quantidade_bipada,
      bipado_completo: row.bipado_completo,
      pedido_completo: row.pedido_completo,
    };

    logger.info("bipar-embalagem", "Bip processado", {
      sku,
      galpao_id,
      ...result,
    });

    // Record event and await label print when packing is complete
    if (result.pedido_completo) {
      registrarEvento({
        pedidoId: result.pedido_id,
        evento: "embalagem_concluida",
        detalhes: { sku, galpao_id },
      }).catch(() => {});

      // Fast path: bip RPC already claimed the etiqueta and returned print fields
      // Slow path: claim wasn't included (already claimed elsewhere) → fall back to full flow
      const etiqueta = row.etiqueta_empresa_origem_id && row.etiqueta_galpao_id
        ? await imprimirEtiquetaDireta({
            pedidoId: result.pedido_id,
            numero: row.etiqueta_numero ?? result.pedido_id,
            empresaOrigemId: row.etiqueta_empresa_origem_id,
            agrupamentoExpedicaoId: row.etiqueta_agrupamento_id ?? null,
            etiquetaZpl: row.etiqueta_zpl ?? null,
            etiquetaUrl: row.etiqueta_url ?? null,
            separacaoGalpaoId: row.etiqueta_galpao_id,
            separacaoOperadorId: row.etiqueta_operador_id ?? null,
          })
        : await buscarEImprimirEtiqueta(result.pedido_id);

      return NextResponse.json({
        ...result,
        etiqueta_status: etiqueta.success ? "impresso" : "falhou",
        etiqueta_erro: etiqueta.error ?? null,
      });
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error("bipar-embalagem", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
