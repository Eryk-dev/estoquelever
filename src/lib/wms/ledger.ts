import type { TipoMov, OrigemTipo, Quadrupla, Movimentacao } from "./types";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

interface CalcInput {
  tipo: TipoMov;
  qty: number;
  saldoAnterior: number;
  reservadoAnterior: number;
}

export function calcularPosteriores(input: CalcInput): {
  saldo_posterior: number;
  reservado_posterior: number;
} {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  switch (tipo) {
    case "E":
      return { saldo_posterior: saldoAnterior + qty, reservado_posterior: reservadoAnterior };
    case "S":
      return { saldo_posterior: saldoAnterior - qty, reservado_posterior: reservadoAnterior };
    case "R":
      return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior + qty };
    case "L":
      return { saldo_posterior: saldoAnterior, reservado_posterior: reservadoAnterior - qty };
  }
}

export function validarCoerencia(input: CalcInput): void {
  const { tipo, qty, saldoAnterior, reservadoAnterior } = input;
  if (qty <= 0) throw new Error("qty deve ser > 0");

  const { saldo_posterior, reservado_posterior } = calcularPosteriores(input);

  if (saldo_posterior < 0) {
    throw new Error(`saldo insuficiente: anterior=${saldoAnterior} qty=${qty} tipo=${tipo}`);
  }
  if (reservado_posterior < 0) {
    throw new Error(
      `não pode liberar mais do que está reservado: reservado=${reservadoAnterior} qty=${qty}`,
    );
  }
  if (reservado_posterior > saldo_posterior) {
    throw new Error(
      `reservado (${reservado_posterior}) excederia saldo (${saldo_posterior})`,
    );
  }
}

interface InserirMovInput {
  quadrupla: Quadrupla;
  tipo: TipoMov;
  qty: number;
  origem_tipo: OrigemTipo;
  origem_id?: string;
  origem_detalhes?: Record<string, unknown>;
  emprestimo_devedora_id?: string;
  expira_em?: string;
  nota_fiscal_id?: number;
  custo_unitario?: number;
  usuario_id?: string;
  observacoes?: string;
  estorno_de?: string;
}

/**
 * Insere uma movimentação no ledger E atualiza siso_estoque, atomicamente,
 * com lock pessimista via RPC (SELECT FOR UPDATE no Postgres).
 *
 * Toda escrita no ledger DEVE passar por aqui — garante chain verificável
 * e protege contra race conditions entre operações concorrentes.
 */
export async function inserirMovimentacao(input: InserirMovInput): Promise<Movimentacao> {
  const sb = createServiceClient();
  const { quadrupla, tipo, qty } = input;

  // Validação client-side (early fail; RPC valida de novo no DB com FOR UPDATE)
  const { data: estoqueAtual } = await sb
    .from("siso_estoque")
    .select("saldo, reservado")
    .match(quadrupla)
    .maybeSingle();
  validarCoerencia({
    tipo,
    qty,
    saldoAnterior: Number(estoqueAtual?.saldo ?? 0),
    reservadoAnterior: Number(estoqueAtual?.reservado ?? 0),
  });

  const { data: mov, error } = await sb.rpc("wms_inserir_movimentacao", {
    p_produto: quadrupla.produto_id,
    p_dona: quadrupla.empresa_dona_id,
    p_galpao: quadrupla.galpao_id,
    p_localizacao: quadrupla.localizacao_id,
    p_tipo: tipo,
    p_qty: qty,
    p_origem_tipo: input.origem_tipo,
    p_origem_id: input.origem_id ?? null,
    p_origem_detalhes: input.origem_detalhes ?? {},
    p_emprestimo_devedora: input.emprestimo_devedora_id ?? null,
    p_expira_em: input.expira_em ?? null,
    p_nota_fiscal_id: input.nota_fiscal_id ?? null,
    p_custo_unitario: input.custo_unitario ?? null,
    p_usuario: input.usuario_id ?? null,
    p_observacoes: input.observacoes ?? null,
    p_estorno_de: input.estorno_de ?? null,
  });
  if (error) {
    logger.error("wms.ledger", "falha ao inserir mov", { error, input });
    throw error;
  }
  return mov as unknown as Movimentacao;
}
