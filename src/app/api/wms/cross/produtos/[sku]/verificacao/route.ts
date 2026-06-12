import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * POST /api/wms/cross/produtos/:sku/verificacao
 *
 * Curadoria de pares de equivalência (plano 2026-06-12-cross-troca-equivalencia,
 * D9). Marca o par (sku, sku_alvo) como 'verificado' (auto-troca liberada quando
 * tier igual) ou 'bloqueado' (override "nunca trocar"). Upsert no par normalizado
 * lexicográfico (sku_a < sku_b).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json(
      { error: "Sem permissão pra curar equivalências" },
      { status: 403 },
    );
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  const body = await request.json().catch(() => ({}));
  const skuAlvo = (body.sku_alvo ?? "").toString().trim();
  const status = (body.status ?? "").toString().trim();
  const observacao =
    typeof body.observacao === "string" && body.observacao.trim()
      ? body.observacao.trim()
      : null;

  if (!sku || !skuAlvo) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }
  if (sku === skuAlvo) {
    return NextResponse.json(
      { error: "SKU alvo não pode ser o próprio SKU" },
      { status: 400 },
    );
  }
  if (status !== "verificado" && status !== "bloqueado") {
    return NextResponse.json(
      { error: "Status inválido (verificado | bloqueado)" },
      { status: 400 },
    );
  }

  // Par normalizado lexicográfico (sku_a < sku_b — mesma convenção de links).
  const [sku_a, sku_b] = sku < skuAlvo ? [sku, skuAlvo] : [skuAlvo, sku];

  const supabase = createServiceClient();

  const { error: upErr } = await supabase
    .from("siso_equivalencias_verificadas")
    .upsert(
      {
        sku_a,
        sku_b,
        status,
        observacao,
        verificado_por: session.id,
        verificado_em: new Date().toISOString(),
      },
      { onConflict: "sku_a,sku_b" },
    );

  if (upErr) {
    // FK aponta pra siso_produtos_catalogo(sku) — SKU fora do catálogo cross.
    if (upErr.code === "23503") {
      return NextResponse.json(
        {
          error:
            "SKU não está no catálogo cross — abra a página dele primeiro pra sincronizar",
        },
        { status: 404 },
      );
    }
    logger.error("cross-verificacao-upsert", "Erro ao curar par", {
      sku_a,
      sku_b,
      status,
      error: upErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-verificacao-upsert", "Par de equivalência curado", {
    usuario: session.id,
    sku_a,
    sku_b,
    status,
  });

  return NextResponse.json({ ok: true, sku_a, sku_b, status });
}
