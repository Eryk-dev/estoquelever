import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
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

/**
 * POST /api/wms/cross/produtos/:sku/cross-ref
 * Body: { sku_alvo: string }
 *
 * Adiciona manualmente um SKU como cross-reference do produto e JÁ aprova o par.
 * Faz tudo numa chamada (evita estado parcial link-sem-curadoria):
 *   1. sinca o SKU alvo no catálogo cross se ainda não estiver (lazy fetch Tiny);
 *   2. cria link manual (siso_produto_links) — equivalência sem precisar de OEM;
 *   3. marca o par como 'verificado' (siso_equivalencias_verificadas).
 *
 * Só curadoria: NÃO mexe na regra de tier da troca — a troca automática numa
 * venda continua exigindo tiers iguais (regraTroca).
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

  if (!sku || !skuAlvo) {
    return NextResponse.json({ error: "sku_alvo obrigatório" }, { status: 400 });
  }
  if (sku === skuAlvo) {
    return NextResponse.json(
      { error: "Não dá para linkar um SKU a ele mesmo" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // 1. Garante que ambos SKUs existem no catálogo cross; sinca os que faltam.
  const { data: existentes } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku")
    .in("sku", [sku, skuAlvo]);
  const presentes = new Set((existentes ?? []).map((r) => r.sku));

  const faltando = [sku, skuAlvo].filter((s) => !presentes.has(s));
  if (faltando.length > 0) {
    const empresaOrigemId = await getEmpresaOrigemId(session);
    if (!empresaOrigemId) {
      return NextResponse.json(
        { error: "Nenhuma empresa Tiny configurada para o seu galpão" },
        { status: 500 },
      );
    }
    for (const s of faltando) {
      try {
        await fetchAndPersistProduto(s, empresaOrigemId);
      } catch (err) {
        if (err instanceof ProdutoNaoEncontradoError) {
          return NextResponse.json(
            { error: `Produto "${s}" não encontrado no Tiny` },
            { status: 404 },
          );
        }
        if (err instanceof TinyOfflineError) {
          return NextResponse.json({ error: err.message }, { status: 503 });
        }
        logger.error("cross-ref-add", "Erro no lazy fetch do SKU", {
          sku: s,
          error: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json({ error: "Erro interno" }, { status: 500 });
      }
    }
  }

  // Par normalizado lexicográfico (sku_a < sku_b — convenção de links/curadoria).
  const [sku_a, sku_b] = sku < skuAlvo ? [sku, skuAlvo] : [skuAlvo, sku];

  // 2. Cria o link manual. Se já existe (23505), segue — o objetivo é o par aprovado.
  const { error: linkErr } = await supabase.from("siso_produto_links").insert({
    sku_a,
    sku_b,
    motivo: "cross-ref manual",
    adicionado_por: session.id,
  });
  if (linkErr && linkErr.code !== "23505") {
    logger.error("cross-ref-add", "Erro ao criar link", {
      sku_a,
      sku_b,
      error: linkErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  // 3. Marca o par como verificado (aprovado).
  const { error: upErr } = await supabase
    .from("siso_equivalencias_verificadas")
    .upsert(
      {
        sku_a,
        sku_b,
        status: "verificado",
        verificado_por: session.id,
        verificado_em: new Date().toISOString(),
      },
      { onConflict: "sku_a,sku_b" },
    );
  if (upErr) {
    logger.error("cross-ref-add", "Erro ao marcar par verificado", {
      sku_a,
      sku_b,
      error: upErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-ref-add", "Cross-ref manual criado e aprovado", {
    usuario: session.id,
    sku_a,
    sku_b,
  });

  return NextResponse.json({ ok: true, sku_a, sku_b });
}
