import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { getEmpresaOrigemId } from "@/lib/cross/empresa-origem";
import {
  fetchAndPersistProduto,
  TinyOfflineError,
  ProdutoNaoEncontradoError,
} from "@/lib/cross/produto-fetcher";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
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
    await fetchAndPersistProduto(sku, empresaOrigemId);
    logger.info("cross-refetch", "Produto atualizado", {
      usuario: session.id,
      sku,
    });
    return NextResponse.json({ ok: true, sku });
  } catch (err) {
    if (err instanceof ProdutoNaoEncontradoError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof TinyOfflineError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    logger.error("cross-refetch", "Erro inesperado", {
      sku,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
