import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getCompraQuantidadeSolicitada } from "@/lib/compras-utils";

const ALLOWED_CARGOS = ["admin", "comprador"];

/**
 * POST /api/compras/ordens
 *
 * Creates an ordem de compra and links all aguardando items for that fornecedor.
 * Items from ALL empresas are included (grouped by fornecedor only).
 * Body: { fornecedor, galpao_id, observacao?, usuario_id, cargo, item_ids? }
 */
export async function POST(request: NextRequest) {
  let body: {
    fornecedor?: string;
    galpao_id?: string;
    empresa_id?: string; // legacy — ignored if galpao_id is present
    observacao?: string;
    usuario_id?: string;
    cargo?: string;
    item_ids?: string[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { fornecedor, observacao, usuario_id, cargo, item_ids } = body;
  const galpaoId = body.galpao_id ?? null;

  // Auth check
  if (cargo && !ALLOWED_CARGOS.includes(cargo)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  // Validate required fields
  if (!fornecedor || !galpaoId || !usuario_id) {
    return NextResponse.json(
      { error: "fornecedor, galpao_id e usuario_id são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Resolve the first active empresa in the chosen galpão (for backwards compat empresa_id)
    // Use deterministic ordering to always pick the same empresa
    const { data: empresaGalpao, error: empresaError } = await supabase
      .from("siso_empresas")
      .select("id")
      .eq("galpao_id", galpaoId)
      .eq("ativo", true)
      .order("criado_em", { ascending: true })
      .limit(1)
      .single();

    if (empresaError || !empresaGalpao) {
      return NextResponse.json(
        { error: "Nenhuma empresa ativa encontrada no galpão selecionado" },
        { status: 400 },
      );
    }

    const empresaId = empresaGalpao.id;

    // Find items: all empresas for this fornecedor (no empresa_origem_id filter)
    let query = supabase
      .from("siso_pedido_itens")
      .select(
        "id, ordem_compra_id, fornecedor_oc, quantidade_pedida, compra_quantidade_solicitada, siso_pedidos!inner(empresa_origem_id)",
      )
      .eq("fornecedor_oc", fornecedor)
      .eq("compra_status", "aguardando_compra");

    const selectedItemIds = Array.isArray(item_ids)
      ? [...new Set(item_ids.map((value) => value.trim()).filter(Boolean))]
      : [];
    if (selectedItemIds.length > 0) {
      query = query.in("id", selectedItemIds);
    }

    // Find only the items that belong to this purchase round.
    // This allows the buyer to split one supplier queue into multiple OCs.
    const { data: aguardandoItems, error: fetchError } = await query;

    if (fetchError) throw new Error(`Erro ao buscar itens: ${fetchError.message}`);

    if (!aguardandoItems || aguardandoItems.length === 0) {
      return NextResponse.json(
        { error: `Nenhum item aguardando compra para fornecedor '${fornecedor}'` },
        { status: 400 },
      );
    }

    if (selectedItemIds.length > 0 && aguardandoItems.length !== selectedItemIds.length) {
      return NextResponse.json(
        {
          error:
            "Alguns itens selecionados nao estao mais aguardando compra para este fornecedor",
        },
        { status: 409 },
      );
    }

    const allItemIds = aguardandoItems.map((i) => i.id);
    const quantidadeTotal = aguardandoItems.reduce(
      (sum, item) => sum + getCompraQuantidadeSolicitada(item),
      0,
    );
    const now = new Date().toISOString();

    // If this round already belongs to one auto-created draft OC, reuse it.
    const existingDraftOcIds = [
      ...new Set(aguardandoItems.map((item) => item.ordem_compra_id).filter(Boolean)),
    ];
    if (existingDraftOcIds.length > 1) {
      return NextResponse.json(
        {
          error:
            "Os itens selecionados pertencem a mais de um rascunho de OC. Separe a compra por rascunho antes de confirmar.",
        },
        { status: 409 },
      );
    }

    const existingOcId = existingDraftOcIds[0] ?? null;
    let ocId: string;

    if (existingOcId) {
      // Update existing auto-created OC to 'comprado' and set galpao
      const { error: updateOcError } = await supabase
        .from("siso_ordens_compra")
        .update({
          status: "comprado",
          galpao_id: galpaoId,
          empresa_id: empresaId,
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
      // Create new OC with galpao_id
      const { data: oc, error: insertError } = await supabase
        .from("siso_ordens_compra")
        .insert({
          fornecedor,
          galpao_id: galpaoId,
          empresa_id: empresaId,
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
      .select("id, fornecedor, galpao_id, empresa_id, status, observacao, comprado_por, comprado_em, created_at")
      .eq("id", ocId)
      .single();

    logger.info("compras-ordens", "OC criada/atualizada", {
      ocId,
      fornecedor,
      galpaoId,
      empresaId,
      itensVinculados: linkedCount,
      selecionados: selectedItemIds.length > 0,
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
      galpaoId,
    });
    return NextResponse.json(
      { error: "Erro interno ao criar ordem de compra" },
      { status: 500 },
    );
  }
}
