import { NextRequest, NextResponse } from "next/server";
import { listarFornecedores, criarFornecedor } from "@/lib/wms/fornecedores";
import { requireAuth, requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  // Galpões ativos pra alimentar o seletor de galpão de recebimento na tela
  // (evita gate de compras.ver / sistema.galpoes da rota de contexto).
  const { data: galpoes } = await createServiceClient()
    .from("siso_galpoes")
    .select("id, nome")
    .eq("ativo", true)
    .order("nome");
  return NextResponse.json({
    rows: await listarFornecedores(),
    galpoes: galpoes ?? [],
  });
}

function parseLeadTime(b: Record<string, unknown>, key: string): number | null | undefined {
  if (!(key in b)) return undefined;
  const v = b[key];
  if (v === null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  throw new Error(`${key}: valor inválido`);
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  if (!body.nome) {
    return NextResponse.json({ error: "nome obrigatório" }, { status: 400 });
  }
  try {
    const b = body as Record<string, unknown>;
    const min = parseLeadTime(b, "lead_time_dias_min");
    const medio = parseLeadTime(b, "lead_time_dias_medio");
    const max = parseLeadTime(b, "lead_time_dias_max");
    if (min != null && medio != null && min > medio) {
      return NextResponse.json({ error: "min não pode ser maior que médio" }, { status: 400 });
    }
    if (medio != null && max != null && medio > max) {
      return NextResponse.json({ error: "médio não pode ser maior que máximo" }, { status: 400 });
    }
    const galpaoId =
      typeof body.galpao_id === "string" && body.galpao_id.length > 0
        ? body.galpao_id
        : body.galpao_id === null
          ? null
          : undefined;
    return NextResponse.json(
      await criarFornecedor({
        nome: body.nome,
        cnpj: body.cnpj,
        prefixo_sku: body.prefixo_sku,
        observacoes: body.observacoes,
        ...(galpaoId !== undefined ? { galpao_id: galpaoId } : {}),
        ...(min !== undefined ? { lead_time_dias_min: min } : {}),
        ...(medio !== undefined ? { lead_time_dias_medio: medio } : {}),
        ...(max !== undefined ? { lead_time_dias_max: max } : {}),
      }),
      { status: 201 },
    );
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.fornecedores.criar",
      error: e,
      requestPath: "/api/wms/fornecedores",
      requestMethod: "POST",
      metadata: { nome: body.nome, cnpj: body.cnpj },
    });
  }
}
