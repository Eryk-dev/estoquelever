import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

interface PatchProdutoFornecedorBody {
  preferencial?: boolean;
  lead_time_dias_min?: number;
  lead_time_dias_medio?: number;
  lead_time_dias_max?: number;
  custo_unitario?: number | null;
  qty_minima_pedido?: number | null;
  multiplo_compra?: number | null;
  codigo_fornecedor?: string | null;
  ativo?: boolean;
}

function pickPatchFields(body: unknown): PatchProdutoFornecedorBody {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: PatchProdutoFornecedorBody = {};
  if (typeof b.preferencial === "boolean") out.preferencial = b.preferencial;
  if (typeof b.lead_time_dias_min === "number") {
    out.lead_time_dias_min = b.lead_time_dias_min;
  }
  if (typeof b.lead_time_dias_medio === "number") {
    out.lead_time_dias_medio = b.lead_time_dias_medio;
  }
  if (typeof b.lead_time_dias_max === "number") {
    out.lead_time_dias_max = b.lead_time_dias_max;
  }
  if (b.custo_unitario === null || typeof b.custo_unitario === "number") {
    out.custo_unitario = b.custo_unitario as number | null;
  }
  if (b.qty_minima_pedido === null || typeof b.qty_minima_pedido === "number") {
    out.qty_minima_pedido = b.qty_minima_pedido as number | null;
  }
  if (b.multiplo_compra === null || typeof b.multiplo_compra === "number") {
    out.multiplo_compra = b.multiplo_compra as number | null;
  }
  if (b.codigo_fornecedor === null || typeof b.codigo_fornecedor === "string") {
    out.codigo_fornecedor = b.codigo_fornecedor as string | null;
  }
  if (typeof b.ativo === "boolean") out.ativo = b.ativo;
  return out;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  const allowed = pickPatchFields(body);
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json(
      { error: "nenhum campo válido pra atualizar" },
      { status: 400 },
    );
  }
  const sb = createServiceClient();
  // Se marcou preferencial=true, despromove os outros do mesmo produto
  if (allowed.preferencial === true) {
    const { data: pf } = await sb
      .from("siso_produto_fornecedores")
      .select("produto_id")
      .eq("id", id)
      .single();
    if (pf) {
      await sb
        .from("siso_produto_fornecedores")
        .update({ preferencial: false })
        .eq("produto_id", pf.produto_id);
    }
  }
  const { data, error } = await sb
    .from("siso_produto_fornecedores")
    .update({ ...allowed, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    // P125: violação do UNIQUE parcial idx_pf_preferencial (2 cliques marcando
    // preferenciais diferentes em corrida) → 409 amigável em vez de 500 genérico.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "Já existe outro fornecedor preferencial ativo para este produto. Recarregue e tente de novo." },
        { status: 409 },
      );
    }
    return wmsErrorResponse({
      source: "wms.produto-fornecedores.patch",
      error,
      requestPath: `/api/wms/produto-fornecedores/${id}`,
      requestMethod: "PATCH",
      metadata: { id },
    });
  }
  return NextResponse.json(data);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  await sb.from("siso_produto_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
