/**
 * Saldo vivo por galpão (Fase 1.4/1.5) — fonte: siso_estoque (cache materializado
 * do ledger), NÃO o snapshot estale siso_pedido_item_estoques.
 *
 * Usado quando o cascade do parcial esgota a cobertura no galpão atual: antes de
 * mandar o item pra Compras, checamos se há saldo disponível em OUTRO galpão —
 * nesse caso o operador deve poder ENCAMINHAR em vez de comprar (Mudança 1).
 */

import { createServiceClient } from "@/lib/supabase-server";

export interface GalpaoComSaldo {
  galpao_id: string;
  galpao_nome: string;
  disponivel: number;
}

/**
 * Lista galpões com `disponivel > 0` pra um produto WMS, opcionalmente excluindo
 * o galpão atual. Agrega por galpão (soma das locs). Ordena por disponível desc.
 */
export async function galpoesComSaldo(
  produtoWmsId: string,
  excluirGalpaoId?: string | null,
): Promise<GalpaoComSaldo[]> {
  const sb = createServiceClient();
  let query = sb
    .from("siso_estoque")
    .select("galpao_id, disponivel")
    .eq("produto_id", produtoWmsId)
    .gt("disponivel", 0);
  if (excluirGalpaoId) {
    query = query.neq("galpao_id", excluirGalpaoId);
  }
  const { data } = await query;

  const disponivelPorGalpao = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ galpao_id: string; disponivel: number }>) {
    disponivelPorGalpao.set(
      row.galpao_id,
      (disponivelPorGalpao.get(row.galpao_id) ?? 0) + Number(row.disponivel ?? 0),
    );
  }

  if (disponivelPorGalpao.size === 0) return [];

  const { data: galpoes } = await sb
    .from("siso_galpoes")
    .select("id, nome")
    .in("id", [...disponivelPorGalpao.keys()]);

  const nomePorId = new Map<string, string>(
    ((galpoes ?? []) as Array<{ id: string; nome: string }>).map((g) => [g.id, g.nome]),
  );

  return [...disponivelPorGalpao.entries()]
    .map(([galpao_id, disponivel]) => ({
      galpao_id,
      galpao_nome: nomePorId.get(galpao_id) ?? "",
      disponivel,
    }))
    .sort((a, b) => b.disponivel - a.disponivel);
}
