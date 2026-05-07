import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { getProdutoDetalheCompleto } from "@/lib/cross/catalogo-queries";
import { getEmpresaOrigemId } from "@/lib/cross/empresa-origem";
import {
  fetchAndPersistProduto,
  TinyOfflineError,
  ProdutoNaoEncontradoError,
} from "@/lib/cross/produto-fetcher";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

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
  const isAdmin = (session.cargos ?? [session.cargo]).includes("admin");

  const empresaOrigemId = await getEmpresaOrigemId(session);
  if (!empresaOrigemId) {
    return NextResponse.json(
      { error: "Nenhuma empresa Tiny configurada para o seu galpão" },
      { status: 500 },
    );
  }

  const supabase = createServiceClient();
  const { data: existe } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku")
    .eq("sku", sku)
    .maybeSingle();

  // Lazy fetch se não existe
  if (!existe) {
    try {
      await fetchAndPersistProduto(sku, empresaOrigemId);
    } catch (err) {
      if (err instanceof ProdutoNaoEncontradoError) {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof TinyOfflineError) {
        return NextResponse.json({ error: err.message }, { status: 503 });
      }
      logger.error("cross-produto-detalhe", "Erro inesperado no lazy fetch", {
        sku,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "Erro interno" }, { status: 500 });
    }
  }

  const detalhe = await getProdutoDetalheCompleto({
    sku,
    sessionUserId: session.id,
    isAdmin,
    empresaOrigemId,
  });

  if (!detalhe) {
    return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });
  }

  return NextResponse.json(detalhe);
}
