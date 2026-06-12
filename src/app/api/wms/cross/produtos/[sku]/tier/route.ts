import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

const TIERS_VALIDOS = ["original", "primeira_linha", "segunda_linha"] as const;

/**
 * POST /api/wms/cross/produtos/:sku/tier
 *
 * Classifica a qualidade do produto WMS (escala única ordenada — plano D5).
 * tier=null limpa a classificação. Atualiza siso_produtos.tier_qualidade.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json(
      { error: "Sem permissão pra classificar produtos" },
      { status: 403 },
    );
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  if (!sku) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const tierRaw = body.tier;
  if (
    tierRaw !== null &&
    !TIERS_VALIDOS.includes(tierRaw as (typeof TIERS_VALIDOS)[number])
  ) {
    return NextResponse.json(
      { error: "Tier inválido (original | primeira_linha | segunda_linha | null)" },
      { status: 400 },
    );
  }
  const tier = (tierRaw ?? null) as (typeof TIERS_VALIDOS)[number] | null;

  const supabase = createServiceClient();

  const { data: atualizado, error: upErr } = await supabase
    .from("siso_produtos")
    .update({ tier_qualidade: tier })
    .eq("sku", sku)
    .select("id")
    .maybeSingle();

  if (upErr) {
    logger.error("cross-tier-update", "Erro ao classificar produto", {
      sku,
      tier,
      error: upErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
  if (!atualizado) {
    return NextResponse.json(
      { error: "SKU não está no catálogo WMS" },
      { status: 404 },
    );
  }

  logger.info("cross-tier-update", "Produto classificado", {
    usuario: session.id,
    sku,
    tier,
  });

  return NextResponse.json({ ok: true, sku, tier_qualidade: tier });
}
