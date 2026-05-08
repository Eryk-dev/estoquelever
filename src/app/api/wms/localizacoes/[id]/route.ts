import { NextRequest, NextResponse } from "next/server";
import { atualizarLocalizacao, desativarLocalizacao } from "@/lib/wms/localizacoes";
import { requireAdmin } from "@/lib/wms/auth";
import type { Localizacao, TipoLocalizacao } from "@/lib/wms/types";

const TIPOS_VALIDOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
];

function pickPatchFields(body: unknown): Partial<Localizacao> {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: Partial<Localizacao> = {};
  if (typeof b.codigo === "string") out.codigo = b.codigo;
  if (b.descricao === null || typeof b.descricao === "string") {
    out.descricao = b.descricao as string | null;
  }
  if (
    typeof b.tipo === "string" &&
    TIPOS_VALIDOS.includes(b.tipo as TipoLocalizacao)
  ) {
    out.tipo = b.tipo as TipoLocalizacao;
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
    return NextResponse.json(await atualizarLocalizacao(id, allowed));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  try {
    await desativarLocalizacao(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
