// Service do módulo Kits no WMS.
//
// Kit é um SKU virtual cuja composição vive em siso_produto_kits. Não tem
// estoque próprio — disponível é derivado dos componentes pela função
// `wms_kit_disponivel` no Postgres.

import { createServiceClient } from "@/lib/supabase-server";
import type { ProdutoKitComposicao } from "@/lib/wms/types";

export interface KitDisponivel {
  kit_id: string;
  disponivel: number;
  /** Componente que limita o cálculo (gargalo). */
  gargalo_produto_id: string | null;
  gargalo_sku: string | null;
  gargalo_disponivel: number | null;
}

/** Lista a composição do kit, com dados do componente. */
export async function listarComposicaoKit(
  kitProdutoId: string,
): Promise<ProdutoKitComposicao[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produto_kits")
    .select(
      `id, kit_produto_id, componente_produto_id, quantidade, criado_em,
       componente:siso_produtos!siso_produto_kits_componente_produto_id_fkey
         (id, sku, descricao, imagem_url, ativo)`,
    )
    .eq("kit_produto_id", kitProdutoId)
    .order("criado_em", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ProdutoKitComposicao[];
}

/** Lista produtos que contêm este produto como componente (kits onde ele participa). */
export async function listarKitsComEsseComponente(
  componenteProdutoId: string,
): Promise<Array<{ kit_id: string; quantidade: number; kit_sku: string }>> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produto_kits")
    .select(
      `kit_produto_id, quantidade,
       kit:siso_produtos!siso_produto_kits_kit_produto_id_fkey (sku)`,
    )
    .eq("componente_produto_id", componenteProdutoId);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const k = (r as { kit?: { sku?: string } | null }).kit;
    return {
      kit_id: (r as { kit_produto_id: string }).kit_produto_id,
      quantidade: Number((r as { quantidade: number }).quantidade),
      kit_sku: k?.sku ?? "",
    };
  });
}

/** Adiciona/atualiza um componente no kit. Marca o produto como eh_kit=true. */
export async function upsertComponente(input: {
  kit_produto_id: string;
  componente_produto_id: string;
  quantidade: number;
}): Promise<void> {
  if (input.kit_produto_id === input.componente_produto_id) {
    throw new Error("Kit não pode ser componente de si mesmo");
  }
  if (input.quantidade <= 0) {
    throw new Error("Quantidade deve ser maior que zero");
  }
  const sb = createServiceClient();

  // Trigger no DB rejeita componente que é kit, mas valida cedo pra erro
  // mais legível.
  const { data: comp } = await sb
    .from("siso_produtos")
    .select("eh_kit, ativo")
    .eq("id", input.componente_produto_id)
    .maybeSingle();
  if (!comp) throw new Error("Componente não encontrado");
  if (comp.eh_kit) {
    throw new Error("Não é possível usar um kit como componente de outro kit");
  }

  const { error: errKit } = await sb
    .from("siso_produtos")
    .update({ eh_kit: true })
    .eq("id", input.kit_produto_id);
  if (errKit) throw errKit;

  const { error } = await sb.from("siso_produto_kits").upsert(
    {
      kit_produto_id: input.kit_produto_id,
      componente_produto_id: input.componente_produto_id,
      quantidade: input.quantidade,
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: "kit_produto_id,componente_produto_id" },
  );
  if (error) throw error;
}

/** Remove um componente do kit. Se for o último, desmarca eh_kit. */
export async function removerComponente(input: {
  kit_produto_id: string;
  componente_produto_id: string;
}): Promise<void> {
  const sb = createServiceClient();
  const { error } = await sb
    .from("siso_produto_kits")
    .delete()
    .eq("kit_produto_id", input.kit_produto_id)
    .eq("componente_produto_id", input.componente_produto_id);
  if (error) throw error;

  // Se sobrou 0 componentes, desmarca como kit.
  const { count } = await sb
    .from("siso_produto_kits")
    .select("id", { count: "exact", head: true })
    .eq("kit_produto_id", input.kit_produto_id);
  if ((count ?? 0) === 0) {
    await sb
      .from("siso_produtos")
      .update({ eh_kit: false })
      .eq("id", input.kit_produto_id);
  }
}

/** Calcula disponível derivado do kit + identifica gargalo. */
export async function calcularDisponivel(
  kitProdutoId: string,
  filtros: { empresa_dona_id?: string; galpao_id?: string } = {},
): Promise<KitDisponivel> {
  const sb = createServiceClient();
  const { data: dispData, error: errRpc } = await sb.rpc(
    "wms_kit_disponivel",
    {
      p_kit_id: kitProdutoId,
      p_empresa_dona_id: filtros.empresa_dona_id ?? null,
      p_galpao_id: filtros.galpao_id ?? null,
    },
  );
  if (errRpc) throw errRpc;
  const disponivel = Number(dispData ?? 0);

  // Identifica gargalo: componente com menor disp/qty.
  const composicao = await listarComposicaoKit(kitProdutoId);
  if (composicao.length === 0) {
    return {
      kit_id: kitProdutoId,
      disponivel: 0,
      gargalo_produto_id: null,
      gargalo_sku: null,
      gargalo_disponivel: null,
    };
  }

  // Soma disponível agregado por componente (com mesmos filtros).
  let queryEst = sb
    .from("siso_estoque")
    .select("produto_id, disponivel")
    .in(
      "produto_id",
      composicao.map((c) => c.componente_produto_id),
    );
  if (filtros.empresa_dona_id) {
    queryEst = queryEst.eq("empresa_dona_id", filtros.empresa_dona_id);
  }
  if (filtros.galpao_id) {
    queryEst = queryEst.eq("galpao_id", filtros.galpao_id);
  }
  const { data: estData, error: errEst } = await queryEst;
  if (errEst) throw errEst;

  const dispPorProd = new Map<string, number>();
  for (const e of estData ?? []) {
    const id = (e as { produto_id: string }).produto_id;
    dispPorProd.set(
      id,
      (dispPorProd.get(id) ?? 0) +
        Number((e as { disponivel: number }).disponivel ?? 0),
    );
  }

  let gargalo = composicao[0];
  let menorKits = Number.MAX_SAFE_INTEGER;
  for (const c of composicao) {
    const dispComp = dispPorProd.get(c.componente_produto_id) ?? 0;
    const kitsPossiveis = Math.floor(dispComp / Number(c.quantidade));
    if (kitsPossiveis < menorKits) {
      menorKits = kitsPossiveis;
      gargalo = c;
    }
  }

  return {
    kit_id: kitProdutoId,
    disponivel,
    gargalo_produto_id: gargalo.componente_produto_id,
    gargalo_sku: gargalo.componente.sku,
    gargalo_disponivel: dispPorProd.get(gargalo.componente_produto_id) ?? 0,
  };
}

/**
 * Explode 1 unidade de kit em N unidades de cada componente.
 * Retorna lista [{ produto_id, quantidade }] pra ser registrada como
 * movimentações de saída separadas no ledger.
 */
export async function explodirKit(
  kitProdutoId: string,
  qtyKits: number,
): Promise<Array<{ produto_id: string; quantidade: number }>> {
  if (qtyKits <= 0) return [];
  const composicao = await listarComposicaoKit(kitProdutoId);
  return composicao.map((c) => ({
    produto_id: c.componente_produto_id,
    quantidade: Number(c.quantidade) * qtyKits,
  }));
}
