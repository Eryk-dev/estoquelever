import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";

interface PatchFornecedorBody {
  nome?: string;
  cnpj?: string | null;
  prefixo_sku?: string | null;
  ativo?: boolean;
}

function pickPatchFields(body: unknown): PatchFornecedorBody {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: PatchFornecedorBody = {};
  if (typeof b.nome === "string") out.nome = b.nome;
  if (b.cnpj === null || typeof b.cnpj === "string") out.cnpj = b.cnpj;
  if (b.prefixo_sku === null || typeof b.prefixo_sku === "string") {
    out.prefixo_sku = b.prefixo_sku;
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
    .from("siso_fornecedores")
    .update({ ...allowed, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
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
  await sb.from("siso_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
