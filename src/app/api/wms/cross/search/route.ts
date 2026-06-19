import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * GET /api/wms/cross/search?q=...
 * Busca em siso_produtos (sku/descrição) e deriva o status do cross a partir do
 * caderno (siso_cross_equivalencias): confirmado > sugestao > sem_cross.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ resultados: [] });
  // Sanitiza pro filtro PostgREST .or (vírgula/parênteses quebram o parser).
  const termo = q.replace(/[%,()]/g, " ").trim();
  if (termo.length < 2) return NextResponse.json({ resultados: [] });

  try {
    const sb = createServiceClient();
    const { data: prods } = await sb
      .from("siso_produtos")
      .select("sku, descricao, imagem_url")
      .or(`sku.ilike.%${termo}%,descricao.ilike.%${termo}%`)
      .eq("ativo", true)
      .limit(60);
    const lista = prods ?? [];
    const skus = lista.map((p) => p.sku as string);

    // Status do cross por SKU. confirmado vence sugestao; bloqueado não vira selo.
    const melhor = new Map<string, "confirmado" | "sugestao">();
    if (skus.length > 0) {
      const [ra, rb] = await Promise.all([
        sb.from("siso_cross_equivalencias").select("sku_a, sku_b, status").in("sku_a", skus),
        sb.from("siso_cross_equivalencias").select("sku_a, sku_b, status").in("sku_b", skus),
      ]);
      const alvo = new Set(skus);
      for (const par of [...(ra.data ?? []), ...(rb.data ?? [])]) {
        for (const s of [par.sku_a as string, par.sku_b as string]) {
          if (!alvo.has(s)) continue;
          if (par.status === "confirmado") melhor.set(s, "confirmado");
          else if (par.status === "sugestao" && !melhor.has(s)) melhor.set(s, "sugestao");
        }
      }
    }

    const resultados = lista.map((p) => ({
      sku: p.sku as string,
      descricao: (p.descricao as string | null) ?? null,
      imagem_url: (p.imagem_url as string | null) ?? null,
      status_cross: melhor.get(p.sku as string) ?? "sem_cross",
    }));

    // Telemetria fire-and-forget (não crítica).
    void (async () => {
      try {
        await sb.from("siso_cross_logs").insert({
          query_tipo: "auto",
          query_texto: q,
          resultado_count: resultados.length,
          usuario_id: session.id,
        });
      } catch (err) {
        logger.warn("cross-search", "Falha ao logar busca (não crítico)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return NextResponse.json({ resultados });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.search", error, message: "erro na busca" });
  }
}
