import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import type { Quadrupla, Movimentacao } from "./types";
import { logger } from "@/lib/logger";

interface ItemRecebimento {
  produto_id: string;
  qty: number;
  custo_unitario?: number;
  localizacao_id: string;
}

export interface ReceberInput {
  empresa_dona_id: string;
  galpao_id: string;
  itens: ItemRecebimento[];
  nf_referencia?: string;
  usuario_id: string;
}

export async function receberEstoque(input: ReceberInput): Promise<void> {
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_dona_id,
        galpao_id: input.galpao_id,
        localizacao_id: item.localizacao_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "compra_manual",
      origem_detalhes: { nf_referencia: input.nf_referencia },
      custo_unitario: item.custo_unitario,
      usuario_id: input.usuario_id,
      observacoes: input.nf_referencia
        ? `recebimento NF ${input.nf_referencia}`
        : "recebimento sem NF",
    });
    if (item.custo_unitario !== undefined) {
      await recalcularCustoMedio(
        {
          produto_id: item.produto_id,
          empresa_dona_id: input.empresa_dona_id,
          galpao_id: input.galpao_id,
          localizacao_id: item.localizacao_id,
        },
        item.qty,
        item.custo_unitario,
      );
    }
  }
}

/**
 * Recalcula custo médio (média ponderada) ao adicionar uma entrada com custo conhecido.
 * Exportado pra uso em outros fluxos (ex: devolução íntegra recalcula custo no Plano 5).
 *
 * Trade-off conhecido: leitura+escrita em duas chamadas (sem lock). Aceitável pra v1
 * porque custo_medio é informativo e racing entre 2 entradas simultâneas pra mesma
 * quádrupla é raro na operação real.
 */
export async function recalcularCustoMedio(
  q: Quadrupla,
  qtyEntrada: number,
  custoNovo: number,
): Promise<void> {
  const sb = createServiceClient();
  const { data: e } = await sb
    .from("siso_estoque")
    .select("saldo, custo_medio")
    .match(q)
    .single();
  if (!e) return;
  const saldoAnterior = Number(e.saldo) - qtyEntrada;
  if (saldoAnterior < 0) return;
  const custoAnterior = Number(e.custo_medio);
  const novoCusto =
    saldoAnterior > 0
      ? (saldoAnterior * custoAnterior + qtyEntrada * custoNovo) /
        (saldoAnterior + qtyEntrada)
      : custoNovo;
  await sb.from("siso_estoque").update({ custo_medio: novoCusto }).match(q);
}

export interface TransferirGalpaoInput {
  empresa_id: string;
  galpao_origem_id: string;
  localizacao_origem_id: string;
  galpao_destino_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
  observacoes?: string;
}

export async function transferirInterGalpao(
  input: TransferirGalpaoInput,
): Promise<{ origem_id: string }> {
  if (input.galpao_origem_id === input.galpao_destino_id) {
    throw new Error(
      "transferência inter-galpão exige galpões diferentes (use replenishment)",
    );
  }
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_origem_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_destino_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_galpao",
      origem_id,
      usuario_id: input.usuario_id,
      observacoes: input.observacoes,
    });
  }
  return { origem_id };
}

export interface ReplenishmentInput {
  empresa_id: string;
  galpao_id: string;
  localizacao_origem_id: string;
  localizacao_destino_id: string;
  itens: { produto_id: string; qty: number }[];
  usuario_id: string;
}

export function validarTransferenciaIntraGalpao(input: {
  localizacao_origem_id: string;
  localizacao_destino_id: string;
}): void {
  if (input.localizacao_origem_id === input.localizacao_destino_id) {
    throw new Error("origem e destino não podem ser a mesma localização");
  }
}

export async function replenishmentIntraGalpao(
  input: ReplenishmentInput,
): Promise<{ origem_id: string }> {
  validarTransferenciaIntraGalpao(input);
  const origem_id = crypto.randomUUID();
  for (const item of input.itens) {
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_origem_id,
      },
      tipo: "S",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
    await inserirMovimentacao({
      quadrupla: {
        produto_id: item.produto_id,
        empresa_dona_id: input.empresa_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_destino_id,
      },
      tipo: "E",
      qty: item.qty,
      origem_tipo: "transferencia_localizacao",
      origem_id,
      usuario_id: input.usuario_id,
    });
  }
  return { origem_id };
}

export interface AjusteManualInput {
  quadrupla: Quadrupla;
  qty: number;
  motivo: string;
  direcao: "entrada" | "saida";
  usuario_id: string;
}

export async function ajustarEstoque(input: AjusteManualInput): Promise<void> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo do ajuste é obrigatório (≥3 caracteres)");
  }
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: input.direcao === "entrada" ? "E" : "S",
    qty: input.qty,
    origem_tipo: "ajuste_manual",
    origem_detalhes: { motivo: input.motivo, direcao: input.direcao },
    usuario_id: input.usuario_id,
    observacoes: input.motivo,
  });
}

export interface LancamentoRetroativoInput {
  quadrupla: Quadrupla;
  qty: number;
  fornecedor_id?: string;
  pedido_id?: string;
  motivo: string;
  usuario_id: string;
}

export async function lancarRetroativo(
  input: LancamentoRetroativoInput,
): Promise<void> {
  await inserirMovimentacao({
    quadrupla: input.quadrupla,
    tipo: "E",
    qty: input.qty,
    origem_tipo: "lancamento_retroativo",
    origem_id: input.pedido_id,
    origem_detalhes: { motivo: input.motivo, fornecedor_id: input.fornecedor_id },
    usuario_id: input.usuario_id,
    observacoes: `emergência: ${input.motivo}`,
  });
}

interface RetroativoPendente {
  id: string;
  criado_em: string;
  quantidade: number;
  observacoes: string | null;
  origem_detalhes: Record<string, unknown>;
  produto: { sku: string; descricao: string } | null;
  empresa: { nome: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
}

export async function listarRetroativosPendentes(): Promise<RetroativoPendente[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select(
      `
        id, criado_em, quantidade, observacoes, origem_detalhes,
        produto:siso_produtos(sku, descricao),
        empresa:siso_empresas!empresa_dona_id(nome),
        galpao:siso_galpoes(nome),
        localizacao:siso_localizacoes(codigo)
      `,
    )
    .eq("origem_tipo", "lancamento_retroativo")
    .order("criado_em", { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as unknown as RetroativoPendente[];
  if (rows.length === 0) return [];
  const ids = rows.map((d) => d.id);
  const { data: estornos } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", ids);
  const estornados = new Set(
    (estornos ?? [])
      .map((e) => (e as { estorno_de: string | null }).estorno_de)
      .filter((x): x is string => !!x),
  );
  return rows.filter((d) => !estornados.has(d.id));
}

export interface ReconciliarRetroativoInput {
  retroativo_mov_id: string;
  compra_mov_id: string;
  usuario_id: string;
}

export async function reconciliarRetroativo(
  input: ReconciliarRetroativoInput,
): Promise<void> {
  const sb = createServiceClient();
  const { data: retro, error } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", input.retroativo_mov_id)
    .single();
  if (error || !retro) throw new Error("lançamento retroativo não encontrado");
  const m = retro as Movimentacao;
  if (m.origem_tipo !== "lancamento_retroativo") {
    throw new Error("mov não é um lançamento retroativo");
  }
  await inserirMovimentacao({
    quadrupla: {
      produto_id: m.produto_id,
      empresa_dona_id: m.empresa_dona_id,
      galpao_id: m.galpao_id,
      localizacao_id: m.localizacao_id,
    },
    tipo: "S",
    qty: Number(m.quantidade),
    origem_tipo: "estorno",
    estorno_de: m.id,
    usuario_id: input.usuario_id,
    observacoes: `reconciliado com mov ${input.compra_mov_id}`,
  });
  logger.info("wms.movs", "lançamento retroativo reconciliado", {
    retro: m.id,
    compra: input.compra_mov_id,
  });
}
