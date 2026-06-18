import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

interface PatchFornecedorBody {
  nome?: string;
  cnpj?: string | null;
  prefixo_sku?: string | null;
  ativo?: boolean;
  galpao_id?: string | null;
  lead_time_dias_min?: number | null;
  lead_time_dias_medio?: number | null;
  lead_time_dias_max?: number | null;
}

function parseLeadTime(v: unknown): number | null {
  if (v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  throw new Error("lead_time: valor inválido");
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
  if (b.galpao_id === null || typeof b.galpao_id === "string") {
    out.galpao_id = b.galpao_id === "" ? null : (b.galpao_id as string | null);
  }
  if ("lead_time_dias_min" in b) out.lead_time_dias_min = parseLeadTime(b.lead_time_dias_min);
  if ("lead_time_dias_medio" in b) out.lead_time_dias_medio = parseLeadTime(b.lead_time_dias_medio);
  if ("lead_time_dias_max" in b) out.lead_time_dias_max = parseLeadTime(b.lead_time_dias_max);
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
  let allowed: PatchFornecedorBody;
  try {
    allowed = pickPatchFields(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "campo inválido" },
      { status: 400 },
    );
  }
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json(
      { error: "nenhum campo válido pra atualizar" },
      { status: 400 },
    );
  }
  const sb = createServiceClient();

  // Pré-validação amigável da ordenação (DB também enforce via CHECK).
  if (
    "lead_time_dias_min" in allowed ||
    "lead_time_dias_medio" in allowed ||
    "lead_time_dias_max" in allowed
  ) {
    const { data: atual } = await sb
      .from("siso_fornecedores")
      .select("lead_time_dias_min, lead_time_dias_medio, lead_time_dias_max")
      .eq("id", id)
      .single();
    const a = (atual ?? {}) as Record<string, number | null>;
    const min = "lead_time_dias_min" in allowed ? allowed.lead_time_dias_min : a.lead_time_dias_min;
    const medio = "lead_time_dias_medio" in allowed ? allowed.lead_time_dias_medio : a.lead_time_dias_medio;
    const max = "lead_time_dias_max" in allowed ? allowed.lead_time_dias_max : a.lead_time_dias_max;
    if (min != null && medio != null && min > medio) {
      return NextResponse.json({ error: "min não pode ser maior que médio" }, { status: 400 });
    }
    if (medio != null && max != null && medio > max) {
      return NextResponse.json({ error: "médio não pode ser maior que máximo" }, { status: 400 });
    }
  }
  const { data, error } = await sb
    .from("siso_fornecedores")
    .update({ ...allowed, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    return wmsErrorResponse({
      source: "wms.fornecedores.patch",
      error,
      requestPath: `/api/wms/fornecedores/${id}`,
      requestMethod: "PATCH",
      metadata: { fornecedor_id: id },
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
  await sb.from("siso_fornecedores").update({ ativo: false }).eq("id", id);
  return NextResponse.json({ ok: true });
}
