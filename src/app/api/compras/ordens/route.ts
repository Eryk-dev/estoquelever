import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getCompraQuantidadeSolicitada } from "@/lib/compras-utils";

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * POST /api/compras/ordens
 *
 * Creates an ordem de compra and links all aguardando items for that fornecedor.
 * Body: { fornecedor, empresa_id, observacao?, usuario_id, cargo }
 */
export async function POST(request: NextRequest) {
  let body: {
    fornecedor?: string;
    empresa_id?: string;
    observacao?: string;
    usuario_id?: string;
    cargo?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { fornecedor, empresa_id, observacao, usuario_id, cargo } = body;

  // Auth check
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  // Validate required fields
  if (!fornecedor || !empresa_id || !usuario_id) {
    return NextResponse.json(
      { error: "fornecedor, empresa_id e usuario_id são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Find all aguardando items for this fornecedor in the selected empresa.
    // This prevents one OC from mixing demands from different empresas.
    const { data: aguardandoItems, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select("id, ordem_compra_id, quantidade_pedida, compra_quantidade_solicitada, siso_pedidos!inner(empresa_origem_id)")
      .eq("fornecedor_oc", fornecedor)
      .eq("compra_status", "aguardando_compra")
      .eq("siso_pedidos.empresa_origem_id", empresa_id);

    if (fetchError) throw new Error(`Erro ao buscar itens: ${fetchError.message}`);

    if (!aguardandoItems || aguardandoItems.length === 0) {
      return NextResponse.json(
        { error: `Nenhum item aguardando compra para fornecedor '${fornecedor}'` },
        { status: 400 },
      );
    }

    const allItemIds = aguardandoItems.map((i) => i.id);
    const quantidadeTotal = aguardandoItems.reduce(
      (sum, item) => sum + getCompraQuantidadeSolicitada(item),
      0,
    );
    const now = new Date().toISOString();

    // Check if items already have an auto-created OC
    const existingOcId = aguardandoItems.find((i) => i.ordem_compra_id)?.ordem_compra_id;
    let ocId: string;

    if (existingOcId) {
      // Update existing auto-created OC to 'comprado'
      const { error: updateOcError } = await supabase
        .from("siso_ordens_compra")
        .update({
          status: "comprado",
          observacao: observacao ?? undefined,
          comprado_por: usuario_id,
          comprado_em: now,
        })
        .eq("id", existingOcId);

      if (updateOcError) {
        throw new Error(`Erro ao atualizar OC: ${updateOcError.message}`);
      }
      ocId = existingOcId;
    } else {
      // Create new OC
      const { data: oc, error: insertError } = await supabase
        .from("siso_ordens_compra")
        .insert({
          fornecedor,
          empresa_id,
          status: "comprado",
          observacao: observacao ?? null,
          comprado_por: usuario_id,
          comprado_em: now,
        })
        .select("id")
        .single();

      if (insertError || !oc) {
        throw new Error(`Erro ao criar OC: ${insertError?.message ?? "no data"}`);
      }
      ocId = oc.id;
    }

    // Link all items to the OC and mark as comprado
    const { data: updatedItems, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        ordem_compra_id: ocId,
        compra_status: "comprado",
        comprado_em: now,
        comprado_por: usuario_id,
      })
      .in("id", allItemIds)
      .select("id");

    if (updateError) {
      throw new Error(`Erro ao vincular itens: ${updateError.message}`);
    }

    const linkedCount = updatedItems?.length ?? 0;

    // Fetch the full OC for response
    const { data: fullOc } = await supabase
      .from("siso_ordens_compra")
      .select("id, fornecedor, empresa_id, status, observacao, comprado_por, comprado_em, created_at")
      .eq("id", ocId)
      .single();

    logger.info("compras-ordens", "OC criada/atualizada", {
      ocId,
      fornecedor,
      empresaId: empresa_id,
      itensVinculados: linkedCount,
      usuarioId: usuario_id,
      reuseExisting: !!existingOcId,
    });

    return NextResponse.json({
      ok: true,
      ordem_compra: fullOc,
      itens_vinculados: linkedCount,
      quantidade_total: quantidadeTotal,
    });
  } catch (err) {
    logger.error("compras-ordens", "Erro ao criar OC", {
      error: err instanceof Error ? err.message : String(err),
      fornecedor,
      empresaId: empresa_id,
    });
    return NextResponse.json(
      { error: "Erro interno ao criar ordem de compra" },
      { status: 500 },
    );
  }
}
