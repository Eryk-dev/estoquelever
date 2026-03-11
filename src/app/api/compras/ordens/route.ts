import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

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
    // Check if there are items to link
    const { count, error: countError } = await supabase
      .from("siso_pedido_itens")
      .select("id", { count: "exact", head: true })
      .eq("fornecedor_oc", fornecedor)
      .eq("compra_status", "aguardando_compra")
      .is("ordem_compra_id", null);

    if (countError) throw new Error(`Erro ao contar itens: ${countError.message}`);

    if (!count || count === 0) {
      return NextResponse.json(
        { error: `Nenhum item aguardando compra para fornecedor '${fornecedor}'` },
        { status: 400 },
      );
    }

    // Create the ordem de compra
    const { data: oc, error: insertError } = await supabase
      .from("siso_ordens_compra")
      .insert({
        fornecedor,
        empresa_id,
        status: "comprado",
        observacao: observacao ?? null,
        comprado_por: usuario_id,
        comprado_em: new Date().toISOString(),
      })
      .select("id, fornecedor, empresa_id, status, observacao, comprado_por, comprado_em, created_at")
      .single();

    if (insertError || !oc) {
      throw new Error(`Erro ao criar OC: ${insertError?.message ?? "no data"}`);
    }

    // Link all aguardando items for this fornecedor to the new OC
    const { data: updatedItems, error: updateError } = await supabase
      .from("siso_pedido_itens")
      .update({
        ordem_compra_id: oc.id,
        compra_status: "comprado",
        comprado_em: new Date().toISOString(),
        comprado_por: usuario_id,
      })
      .eq("fornecedor_oc", fornecedor)
      .eq("compra_status", "aguardando_compra")
      .is("ordem_compra_id", null)
      .select("id");

    if (updateError) {
      throw new Error(`Erro ao vincular itens: ${updateError.message}`);
    }

    const linkedCount = updatedItems?.length ?? 0;

    logger.info("compras-ordens", "OC criada", {
      ocId: oc.id,
      fornecedor,
      empresaId: empresa_id,
      itensVinculados: linkedCount,
      usuarioId: usuario_id,
    });

    return NextResponse.json({
      ok: true,
      ordem_compra: oc,
      itens_vinculados: linkedCount,
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
