import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

interface PatchRegraBody {
  limite_max_por_produto?: number | null;
  limites_por_produto?: Record<string, number>;
  ativo?: boolean;
}

function pickPatchFields(body: unknown): PatchRegraBody {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: PatchRegraBody = {};
  if (b.limite_max_por_produto === null || typeof b.limite_max_por_produto === "number") {
    out.limite_max_por_produto = b.limite_max_por_produto as number | null;
  }
  if (b.limites_por_produto && typeof b.limites_por_produto === "object") {
    out.limites_por_produto = b.limites_por_produto as Record<string, number>;
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
  const { data, error } = await sb
    .from("siso_emprestimo_regras")
    .update({ ...allowed, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return wmsErrorResponse({
      source: "wms.emprestimo-regras.patch",
      error,
      requestPath: `/api/wms/emprestimo-regras/${id}`,
      requestMethod: "PATCH",
      metadata: { regra_id: id },
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
  await sb.from("siso_emprestimo_regras").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
