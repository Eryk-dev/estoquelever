import type { SupabaseClient } from "@supabase/supabase-js";

export type LiveStockEntry = {
  saldo: number;
  reservado: number;
  disponivel: number;
  /** Loc com maior saldo no galpão (pra exibir como sugestão) */
  localizacaoTop: string | null;
};

type EstoqueRow = {
  saldo: number | string | null;
  reservado: number | string | null;
  disponivel: number | string | null;
  siso_produtos: { sku: string } | null;
  siso_galpoes: { nome: string } | null;
  siso_localizacoes: { codigo: string } | null;
};

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v) || 0;
};

/**
 * Agrega saldo live de siso_estoque (3D) por (sku, galpão).
 *
 * Retorna Map<sku, Map<galpaoNome, LiveStockEntry>>. SKUs sem nenhum
 * estoque positivo simplesmente não aparecem no resultado (o caller
 * trata como ausência de cobertura).
 */
export async function aggregateLiveStockBySku(
  supabase: SupabaseClient,
  skus: string[],
): Promise<Map<string, Map<string, LiveStockEntry>>> {
  const out = new Map<string, Map<string, LiveStockEntry>>();
  if (skus.length === 0) return out;

  const { data, error } = await supabase
    .from("siso_estoque")
    .select(
      "saldo, reservado, disponivel, " +
        "siso_produtos!inner(sku), " +
        "siso_galpoes!inner(nome), " +
        "siso_localizacoes!inner(codigo)",
    )
    .in("siso_produtos.sku", skus);

  if (error || !data) return out;

  // Tracking pra escolher loc com maior saldo por (sku, galpão).
  const topLocSaldo = new Map<string, number>();

  for (const row of data as unknown as EstoqueRow[]) {
    const sku = row.siso_produtos?.sku;
    const galpao = row.siso_galpoes?.nome;
    const loc = row.siso_localizacoes?.codigo ?? null;
    if (!sku || !galpao) continue;

    const saldo = num(row.saldo);
    const reservado = num(row.reservado);
    const disponivel = num(row.disponivel);

    let porGalpao = out.get(sku);
    if (!porGalpao) {
      porGalpao = new Map();
      out.set(sku, porGalpao);
    }

    const existing = porGalpao.get(galpao);
    if (existing) {
      existing.saldo += saldo;
      existing.reservado += reservado;
      existing.disponivel += disponivel;
    } else {
      porGalpao.set(galpao, {
        saldo,
        reservado,
        disponivel,
        localizacaoTop: loc,
      });
    }

    // Mantém a loc com maior saldo individual como "top"
    const key = `${sku}::${galpao}`;
    const currentTop = topLocSaldo.get(key) ?? -Infinity;
    if (saldo > currentTop) {
      topLocSaldo.set(key, saldo);
      porGalpao.get(galpao)!.localizacaoTop = loc;
    }
  }

  return out;
}
