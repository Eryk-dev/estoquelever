import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverCustoEntrada } from "@/lib/wms/custo-fallback";
import { logger } from "@/lib/logger";

export type StatusCompraManual = "comprado" | "parcial" | "recebido" | "cancelado";

export interface CompraManualItemInput {
  produto_id: string;
  qty_comprada: number;
  custo_unitario?: number | null;
}

export interface CriarCompraManualInput {
  fornecedor_id: string;
  empresa_compradora_id: string;
  galpao_id: string;
  observacao?: string | null;
  itens: CompraManualItemInput[];
  criado_por: string;
}

/**
 * Status do cabeçalho derivado das quantidades dos itens.
 * Pura — não toca DB. (cancelado é setado explicitamente, nunca derivado aqui.)
 */
export function computeStatusCompra(
  itens: { qty_comprada: number; qty_recebida: number }[],
): "comprado" | "parcial" | "recebido" {
  if (itens.length === 0) return "comprado";
  const algoRecebido = itens.some((i) => Number(i.qty_recebida) > 0);
  const tudoRecebido = itens.every(
    (i) => Number(i.qty_recebida) >= Number(i.qty_comprada),
  );
  if (tudoRecebido) return "recebido";
  if (algoRecebido) return "parcial";
  return "comprado";
}

export interface CriarCompraManualResult {
  compra_id: string;
  itens_criados: number;
}

/**
 * Cria o cabeçalho + itens de uma compra manual. Status inicial 'comprado'.
 * Valida fornecedor/empresa/galpão e produtos antes de inserir.
 */
export async function criarCompraManual(
  input: CriarCompraManualInput,
): Promise<CriarCompraManualResult> {
  const sb = createServiceClient();

  if (!input.itens || input.itens.length === 0) {
    throw new Error("envie ao menos 1 item");
  }
  for (const it of input.itens) {
    if (!it.produto_id) throw new Error("item sem produto_id");
    if (!(Number(it.qty_comprada) > 0)) {
      throw new Error("qty_comprada deve ser > 0");
    }
  }

  // Valida FKs com mensagens claras (em vez de erro cru de constraint).
  const { data: forn } = await sb
    .from("siso_fornecedores")
    .select("id")
    .eq("id", input.fornecedor_id)
    .maybeSingle();
  if (!forn) throw new Error(`fornecedor ${input.fornecedor_id} não encontrado`);

  const { data: emp } = await sb
    .from("siso_empresas")
    .select("id")
    .eq("id", input.empresa_compradora_id)
    .maybeSingle();
  if (!emp) throw new Error(`empresa ${input.empresa_compradora_id} não encontrada`);

  const { data: galp } = await sb
    .from("siso_galpoes")
    .select("id")
    .eq("id", input.galpao_id)
    .maybeSingle();
  if (!galp) throw new Error(`galpão ${input.galpao_id} não encontrado`);

  const { data: header, error: headerErr } = await sb
    .from("siso_compras_manuais")
    .insert({
      fornecedor_id: input.fornecedor_id,
      empresa_compradora_id: input.empresa_compradora_id,
      galpao_id: input.galpao_id,
      observacao: input.observacao ?? null,
      status: "comprado",
      criado_por: input.criado_por,
    })
    .select("id")
    .single();
  if (headerErr || !header) {
    throw new Error(`falha ao criar compra: ${headerErr?.message ?? "sem id"}`);
  }
  const compraId = (header as { id: string }).id;

  const linhas = input.itens.map((it) => ({
    compra_id: compraId,
    produto_id: it.produto_id,
    qty_comprada: Number(it.qty_comprada),
    qty_recebida: 0,
    custo_unitario:
      it.custo_unitario != null ? Number(it.custo_unitario) : null,
  }));
  const { error: itensErr } = await sb
    .from("siso_compras_manuais_itens")
    .insert(linhas);
  if (itensErr) {
    // Rollback best-effort do cabeçalho órfão.
    await sb.from("siso_compras_manuais").delete().eq("id", compraId);
    throw new Error(`falha ao criar itens: ${itensErr.message}`);
  }

  return { compra_id: compraId, itens_criados: linhas.length };
}

export interface CompraManualListItem {
  id: string;
  status: StatusCompraManual;
  observacao: string | null;
  criado_em: string;
  recebido_em: string | null;
  galpao_id: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: Array<{
    id: string;
    produto_id: string;
    sku: string;
    descricao: string;
    qty_comprada: number;
    qty_recebida: number;
    custo_unitario: number | null;
  }>;
}

/** filtro: 'pendentes' = comprado+parcial; 'recebido'; 'cancelado'. */
export async function listarComprasManuais(
  filtro: "pendentes" | "recebido" | "cancelado",
): Promise<CompraManualListItem[]> {
  const sb = createServiceClient();
  let query = sb
    .from("siso_compras_manuais")
    .select(
      `id, status, observacao, criado_em, recebido_em, galpao_id,
       fornecedor:siso_fornecedores(id, nome),
       empresa:siso_empresas(id, nome),
       itens:siso_compras_manuais_itens(
         id, produto_id, qty_comprada, qty_recebida, custo_unitario,
         produto:siso_produtos(sku, descricao)
       )`,
    )
    .order("criado_em", { ascending: false });

  if (filtro === "pendentes") {
    query = query.in("status", ["comprado", "parcial"]);
  } else {
    query = query.eq("status", filtro);
  }

  const { data, error } = await query;
  if (error) throw error;

  type Row = {
    id: string;
    status: StatusCompraManual;
    observacao: string | null;
    criado_em: string;
    recebido_em: string | null;
    galpao_id: string;
    fornecedor: { id: string; nome: string } | null;
    empresa: { id: string; nome: string } | null;
    itens: Array<{
      id: string;
      produto_id: string;
      qty_comprada: number;
      qty_recebida: number;
      custo_unitario: number | null;
      produto: { sku: string; descricao: string } | null;
    }>;
  };

  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    status: r.status,
    observacao: r.observacao,
    criado_em: r.criado_em,
    recebido_em: r.recebido_em,
    galpao_id: r.galpao_id,
    fornecedor: r.fornecedor,
    empresa: r.empresa,
    itens: (r.itens ?? []).map((it) => ({
      id: it.id,
      produto_id: it.produto_id,
      sku: it.produto?.sku ?? "",
      descricao: it.produto?.descricao ?? "",
      qty_comprada: Number(it.qty_comprada),
      qty_recebida: Number(it.qty_recebida),
      custo_unitario: it.custo_unitario != null ? Number(it.custo_unitario) : null,
    })),
  }));
}
