import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/** Por que um produto apareceu na busca (quando não é óbvio pelo sku/descrição). */
interface MatchMotivo {
  tipo: "codigo_fornecedor" | "oem";
  valor: string;
  fornecedor?: string | null;
}

interface ResultadoBusca {
  sku: string;
  descricao: string | null;
  imagem_url: string | null;
  status_cross: "confirmado" | "sugestao" | "sem_cross";
  match?: MatchMotivo;
}

/**
 * GET /api/wms/cross/search?q=...
 * Casa em siso_produtos (sku/descrição), em siso_produto_fornecedores
 * (codigo_fornecedor — ex.: "RI.700.821" acha A143605) e em siso_produtos.oem.
 * Deriva o status do cross do caderno (confirmado > sugestao > sem_cross).
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

    // 1. Match direto por sku/descrição.
    const { data: prods } = await sb
      .from("siso_produtos")
      .select("id, sku, descricao, imagem_url")
      .or(`sku.ilike.%${termo}%,descricao.ilike.%${termo}%`)
      .eq("ativo", true)
      .limit(60);

    // 2. Match por código do fornecedor (dado já sincronizado do Tiny).
    const { data: pfRows } = await sb
      .from("siso_produto_fornecedores")
      .select("produto_id, codigo_fornecedor, fornecedor:siso_fornecedores(nome)")
      .ilike("codigo_fornecedor", `%${termo}%`)
      .eq("ativo", true)
      .limit(60);

    // 3. Match por OEM (elemento exato do array; case-insensitive via variantes).
    const { data: oemRows } = await sb
      .from("siso_produtos")
      .select("id, sku, descricao, imagem_url")
      .overlaps("oem", [q.trim(), q.trim().toUpperCase(), q.trim().toLowerCase()])
      .eq("ativo", true)
      .limit(60);

    // Resolve os produtos achados via código de fornecedor.
    type Prod = { id: string; sku: string; descricao: string | null; imagem_url: string | null };
    const codigoPorProduto = new Map<string, MatchMotivo>();
    for (const r of (pfRows ?? []) as Array<{
      produto_id: string;
      codigo_fornecedor: string | null;
      fornecedor: { nome: string } | { nome: string }[] | null;
    }>) {
      if (!r.codigo_fornecedor) continue;
      const forn = Array.isArray(r.fornecedor) ? r.fornecedor[0] : r.fornecedor;
      if (!codigoPorProduto.has(r.produto_id)) {
        codigoPorProduto.set(r.produto_id, {
          tipo: "codigo_fornecedor",
          valor: r.codigo_fornecedor,
          fornecedor: forn?.nome ?? null,
        });
      }
    }
    let prodsPorCodigo: Prod[] = [];
    if (codigoPorProduto.size > 0) {
      const { data } = await sb
        .from("siso_produtos")
        .select("id, sku, descricao, imagem_url")
        .in("id", [...codigoPorProduto.keys()])
        .eq("ativo", true);
      prodsPorCodigo = (data ?? []) as Prod[];
    }

    // Merge por sku: match direto vence; código/oem entram com o motivo do match.
    const porSku = new Map<string, ResultadoBusca>();
    for (const p of (prods ?? []) as Prod[]) {
      porSku.set(p.sku, {
        sku: p.sku,
        descricao: p.descricao,
        imagem_url: p.imagem_url,
        status_cross: "sem_cross",
      });
    }
    for (const p of prodsPorCodigo) {
      if (porSku.has(p.sku)) continue;
      porSku.set(p.sku, {
        sku: p.sku,
        descricao: p.descricao,
        imagem_url: p.imagem_url,
        status_cross: "sem_cross",
        match: codigoPorProduto.get(p.id),
      });
    }
    for (const p of (oemRows ?? []) as Prod[]) {
      if (porSku.has(p.sku)) continue;
      porSku.set(p.sku, {
        sku: p.sku,
        descricao: p.descricao,
        imagem_url: p.imagem_url,
        status_cross: "sem_cross",
        match: { tipo: "oem", valor: q.trim() },
      });
    }

    const resultados = [...porSku.values()].slice(0, 60);
    const skus = resultados.map((r) => r.sku);

    // Status do cross por SKU. confirmado vence sugestao; bloqueado não vira selo.
    if (skus.length > 0) {
      const [ra, rb] = await Promise.all([
        sb.from("siso_cross_equivalencias").select("sku_a, sku_b, status").in("sku_a", skus),
        sb.from("siso_cross_equivalencias").select("sku_a, sku_b, status").in("sku_b", skus),
      ]);
      const alvo = new Set(skus);
      const melhor = new Map<string, "confirmado" | "sugestao">();
      for (const par of [...(ra.data ?? []), ...(rb.data ?? [])]) {
        for (const s of [par.sku_a as string, par.sku_b as string]) {
          if (!alvo.has(s)) continue;
          if (par.status === "confirmado") melhor.set(s, "confirmado");
          else if (par.status === "sugestao" && !melhor.has(s)) melhor.set(s, "sugestao");
        }
      }
      for (const r of resultados) r.status_cross = melhor.get(r.sku) ?? "sem_cross";
    }

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
