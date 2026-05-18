import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * POST /api/cross/produtos/:sku/links
 * Body: { sku_alvo: string, motivo?: string }
 *
 * Cria um link manual entre 2 SKUs (equivalência sem precisar de OEM).
 * Pares são armazenados ordenados (sku_a < sku_b) — esse handler
 * normaliza antes de inserir.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  const body = await request.json().catch(() => ({}));
  const skuAlvoRaw = (body.sku_alvo ?? "").toString().trim();
  const motivo = body.motivo ? String(body.motivo).trim() : null;

  if (!skuAlvoRaw) {
    return NextResponse.json(
      { error: "sku_alvo obrigatório" },
      { status: 400 },
    );
  }

  if (skuAlvoRaw === sku) {
    return NextResponse.json(
      { error: "Não dá para linkar um SKU a ele mesmo" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Confirma que ambos SKUs existem no catálogo
  const { data: existentes } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku")
    .in("sku", [sku, skuAlvoRaw]);

  const skusEncontrados = new Set((existentes ?? []).map((r) => r.sku));
  if (!skusEncontrados.has(sku)) {
    return NextResponse.json(
      { error: `Produto "${sku}" não encontrado` },
      { status: 404 },
    );
  }
  if (!skusEncontrados.has(skuAlvoRaw)) {
    return NextResponse.json(
      { error: `Produto alvo "${skuAlvoRaw}" não encontrado no catálogo` },
      { status: 404 },
    );
  }

  // Normaliza ordem (sku_a < sku_b)
  const [sku_a, sku_b] = sku < skuAlvoRaw ? [sku, skuAlvoRaw] : [skuAlvoRaw, sku];

  const { error: insErr } = await supabase.from("siso_produto_links").insert({
    sku_a,
    sku_b,
    motivo,
    adicionado_por: session.id,
  });

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json(
        { error: "Esses produtos já estão linkados" },
        { status: 409 },
      );
    }
    logger.error("cross-link-add", "Erro ao criar link", {
      sku,
      sku_alvo: skuAlvoRaw,
      error: insErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-link-add", "Link criado", {
    usuario: session.id,
    sku_a,
    sku_b,
  });

  return NextResponse.json({ ok: true, sku_a, sku_b });
}
