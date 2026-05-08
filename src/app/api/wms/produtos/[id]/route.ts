import { NextRequest, NextResponse } from "next/server";
import { getProduto, atualizarProduto } from "@/lib/wms/produtos";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import type { Produto } from "@/lib/wms/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const p = await getProduto(id);
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(p);
}

function pickPatchFields(body: unknown): Partial<Produto> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: Partial<Produto> = {};
  if (typeof b.descricao === "string") out.descricao = b.descricao;
  if (b.gtin === null || typeof b.gtin === "string") {
    out.gtin = b.gtin as string | null;
  }
  if (b.imagem_url === null || typeof b.imagem_url === "string") {
    out.imagem_url = b.imagem_url as string | null;
  }
  if (typeof b.unidade === "string") out.unidade = b.unidade;
  if (b.ncm === null || typeof b.ncm === "string") {
    out.ncm = b.ncm as string | null;
  }
  if (b.cest === null || typeof b.cest === "string") {
    out.cest = b.cest as string | null;
  }
  if (b.origem_fiscal === null || typeof b.origem_fiscal === "number") {
    out.origem_fiscal = b.origem_fiscal as number | null;
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
  try {
    const p = await atualizarProduto(id, allowed);
    return NextResponse.json(p);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
