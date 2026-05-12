import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { sincronizarProduto } from "@/lib/wms/sync-tiny";
import { logger } from "@/lib/logger";

/**
 * Backfill em batch das imagens dos produtos via Tiny.
 *
 * Processa N produtos por chamada (rate limit per-empresa é tratado pelo
 * tiny-queue). Idempotente: pula produtos que já tem imagens.length > 0.
 * Worker-secret pra evitar uso acidental.
 *
 * Query params:
 *  - limit: quantos produtos processar nesta chamada (default 20, max 100)
 *  - force: "true" pra re-sincar produtos que já tem imagens
 *  - dry: "true" pra só listar quem seria processado
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-worker-secret");
  if (auth !== process.env.WORKER_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(
    Math.max(parseInt(sp.get("limit") ?? "20", 10) || 20, 1),
    100,
  );
  const force = sp.get("force") === "true";
  const dry = sp.get("dry") === "true";

  const sb = createServiceClient();

  // Filtro: produtos ATIVOS que tem mapeamento Tiny ativo + ainda não
  // tem imagens (ou force=true)
  let q = sb
    .from("siso_produtos")
    .select("id, sku, imagens")
    .eq("ativo", true)
    .order("sku", { ascending: true })
    .limit(limit);
  if (!force) {
    q = q.eq("imagens", "{}");
  }
  const { data: produtos, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const list = (produtos ?? []) as Array<{
    id: string;
    sku: string;
    imagens: string[] | null;
  }>;

  if (dry) {
    return NextResponse.json({
      dryRun: true,
      total: list.length,
      skus: list.map((p) => p.sku),
    });
  }

  const results: Array<{
    sku: string;
    ok: boolean;
    imagens?: number;
    error?: string;
  }> = [];

  for (const p of list) {
    try {
      await sincronizarProduto(p.id);
      // Lê de volta pra reportar quantas imagens vieram
      const { data: depois } = await sb
        .from("siso_produtos")
        .select("imagens")
        .eq("id", p.id)
        .maybeSingle();
      const n =
        ((depois as { imagens?: string[] } | null)?.imagens ?? []).length;
      results.push({ sku: p.sku, ok: true, imagens: n });
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn("wms.backfill-imagens", "falha sync produto", {
        sku: p.sku,
        error: msg,
      });
      results.push({ sku: p.sku, ok: false, error: msg });
    }
  }

  const totalImagens = results.reduce((s, r) => s + (r.imagens ?? 0), 0);
  return NextResponse.json({
    processados: results.length,
    sucesso: results.filter((r) => r.ok).length,
    falhas: results.filter((r) => !r.ok).length,
    totalImagensSomadas: totalImagens,
    results,
  });
}
