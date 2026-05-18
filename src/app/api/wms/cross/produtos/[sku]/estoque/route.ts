import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { getEstoquePorGalpaoParaSku } from "@/lib/cross/catalogo-queries";
import { getEmpresaOrigemId } from "@/lib/cross/empresa-origem";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

/**
 * GET /api/cross/produtos/:sku/estoque
 *
 * Retorna apenas o estoque por galpão (Tiny ao vivo). Disparado em paralelo
 * pela UI do detalhe depois que o shell já está renderizado, pra não
 * bloquear o load inicial enquanto chama Tiny pra cada empresa.
 *
 * Resposta: { estoque_por_galpao: Record<string, EstoqueGalpao> }
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();
  if (!sku) {
    return NextResponse.json({ error: "SKU obrigatório" }, { status: 400 });
  }

  const empresaOrigemId = await getEmpresaOrigemId(session);
  if (!empresaOrigemId) {
    return NextResponse.json(
      { error: "Nenhuma empresa Tiny configurada para o seu galpão" },
      { status: 500 },
    );
  }

  try {
    const estoque_por_galpao = await getEstoquePorGalpaoParaSku(sku, empresaOrigemId);
    return NextResponse.json({ estoque_por_galpao });
  } catch (err) {
    logger.error("cross-estoque", "Erro ao consultar estoque", {
      sku,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro ao consultar Tiny" }, { status: 500 });
  }
}
