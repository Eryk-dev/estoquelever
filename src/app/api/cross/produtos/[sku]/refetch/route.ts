import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import {
  fetchAndPersistProduto,
  TinyOfflineError,
  ProdutoNaoEncontradoError,
} from "@/lib/cross/produto-fetcher";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

async function getEmpresaOrigemId(sessionUserId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data: user } = await supabase
    .from("siso_usuarios")
    .select("galpao_id")
    .eq("id", sessionUserId)
    .single();
  if (!user?.galpao_id) {
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("id")
      .eq("ativo", true)
      .limit(1)
      .single();
    return empresa?.id ?? null;
  }
  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select("id")
    .eq("galpao_id", user.galpao_id)
    .eq("ativo", true)
    .limit(1)
    .single();
  return empresa?.id ?? null;
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

  const empresaOrigemId = await getEmpresaOrigemId(session.id);
  if (!empresaOrigemId) {
    return NextResponse.json(
      { error: "Nenhuma empresa Tiny configurada" },
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
