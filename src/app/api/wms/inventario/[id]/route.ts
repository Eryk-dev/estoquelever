import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const [sessao, areas, locs, contagens, divergencias] = await Promise.all([
    sb.from("siso_inventario_sessoes").select("*").eq("id", id).single(),
    sb
      .from("siso_inventario_areas")
      .select("*, operador:siso_usuarios(nome)")
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_localizacoes")
      .select("*, localizacao:siso_localizacoes(codigo, tipo)")
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_contagens")
      .select(
        "*, contada_por_user:siso_usuarios(nome), produto:siso_produtos(sku)",
      )
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_divergencias")
      .select(
        "*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)",
      )
      .eq("sessao_id", id),
  ]);
  return NextResponse.json({
    sessao: sessao.data,
    areas: areas.data,
    localizacoes: locs.data,
    contagens: contagens.data,
    divergencias: divergencias.data,
  });
}

// Allowlist explícito de campos que o cliente pode editar.
// Sem isso, body-spread direto permitia user pular workflow
// inteiro com PATCH { status: 'aplicada' }.
interface PatchSessaoBody {
  modo_contagem?: "aberto" | "blind" | "duplo_blind";
  tolerancia_pct?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
}

function pickPatchFields(body: unknown): PatchSessaoBody {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: PatchSessaoBody = {};
  if (
    b.modo_contagem === "aberto" ||
    b.modo_contagem === "blind" ||
    b.modo_contagem === "duplo_blind"
  ) {
    out.modo_contagem = b.modo_contagem;
  }
  if (typeof b.tolerancia_pct === "number") out.tolerancia_pct = b.tolerancia_pct;
  if (typeof b.exige_aprovacao_acima_valor === "number") {
    out.exige_aprovacao_acima_valor = b.exige_aprovacao_acima_valor;
  }
  if (typeof b.observacoes === "string") out.observacoes = b.observacoes;
  return out;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
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
  const { error } = await sb
    .from("siso_inventario_sessoes")
    .update(allowed)
    .eq("id", id);
  if (error) return NextResponse.json({ error: String(error) }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", id);
  const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => l.localizacao_id,
  );
  if (locIds.length > 0) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locIds)
      .is("finalizado_em", null);
  }
  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "cancelada" })
    .eq("id", id);
  return NextResponse.json({ ok: true });
}
