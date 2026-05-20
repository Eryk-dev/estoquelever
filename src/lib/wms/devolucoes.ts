import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import { logger } from "@/lib/logger";

// Modelo 3D (Fase 5 Batch C):
// - Não há mais "dona destino" — saldo entra na (produto, galpão, loc) e ponto.
// - Empresa associada à NF original (vendedora) vira **tag** via
//   `empresa_referencia_id`, não chave física.
// - Fornecedor (devolução fornecedor) vira tag via `fornecedor_id`.

export type Classificacao = "integro" | "avariado" | "garantia" | "troca_sku";

/** Tag de empresa extraída da mov original da venda, pra anexar como
 *  `empresa_referencia_id` no movimento de devolução. */
export interface MovOrigemVenda {
  origem_tipo: string;
  empresa_vendedora_id: string | null;
}

/** Resolve empresa de referência destino. Retorna a vendedora original
 *  (do pedido) ou null se a mov não tiver tag. */
export function resolverEmpresaReferencia(mov: MovOrigemVenda): string | null {
  return mov.empresa_vendedora_id ?? null;
}

export interface RegistrarDevolucaoInput {
  nota_fiscal_id?: number;
  chave_acesso_nf?: string;
  pedido_origem_id?: string;
  empresa_id?: string;
  payload_webhook: unknown;
}

export async function registrarDevolucaoPendente(
  input: RegistrarDevolucaoInput,
): Promise<string> {
  const sb = createServiceClient();

  let pedidoOrigemMovId: string | null = null;
  if (input.nota_fiscal_id) {
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("nota_fiscal_id", input.nota_fiscal_id)
      .eq("tipo", "S")
      .maybeSingle();
    pedidoOrigemMovId = (mov as { id: string } | null)?.id ?? null;
  }

  const { data, error } = await sb
    .from("siso_devolucoes_pendentes")
    .insert({
      nota_fiscal_id: input.nota_fiscal_id,
      chave_acesso_nf: input.chave_acesso_nf,
      pedido_origem_id: input.pedido_origem_id,
      pedido_origem_mov_id: pedidoOrigemMovId,
      empresa_id: input.empresa_id,
      payload_webhook: input.payload_webhook,
    })
    .select()
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export interface ClassificarInput {
  devolucao_id: string;
  classificacao: Classificacao;
  galpao_id: string;
  localizacao_id: string;
  produto_id: string;
  /** Empresa vendedora da NF original (tag em empresa_referencia_id).
   *  Auto-resolvido da mov de saída original quando omitido. */
  empresa_referencia_id?: string;
  /** Fornecedor pra devoluções de garantia (Classe C). Obrigatório quando
   *  classificacao='garantia'. */
  fornecedor_id?: string;
  qty: number;
  observacoes?: string;
  usuario_id: string;
}

export async function classificarDevolucao(input: ClassificarInput): Promise<void> {
  const sb = createServiceClient();
  const { data: dev, error } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*")
    .eq("id", input.devolucao_id)
    .single();
  if (error || !dev) throw new Error("devolução não encontrada");
  type DevRow = {
    status: string;
    pedido_origem_mov_id: string | null;
    nota_fiscal_id: number | null;
  };
  const d = dev as DevRow;
  if (d.status !== "aguardando_classificacao") throw new Error("já classificada");

  let empresaReferenciaId = input.empresa_referencia_id ?? null;
  if (!empresaReferenciaId && d.pedido_origem_mov_id) {
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("origem_tipo, empresa_vendedora_id")
      .eq("id", d.pedido_origem_mov_id)
      .single();
    if (mov) {
      empresaReferenciaId = resolverEmpresaReferencia(mov as MovOrigemVenda);
    }
  }

  const tripla = {
    produto_id: input.produto_id,
    galpao_id: input.galpao_id,
    localizacao_id: input.localizacao_id,
  };

  switch (input.classificacao) {
    case "integro": {
      // Classe A — íntegra do cliente. Custo unitário herdado da venda
      // original ativa o recálculo de custo médio global.
      let custoUnitarioOriginal: number | undefined;
      if (d.pedido_origem_mov_id) {
        const { data: movOriginal } = await sb
          .from("siso_movimentacoes")
          .select("custo_unitario")
          .eq("id", d.pedido_origem_mov_id)
          .single();
        const cu = (movOriginal as { custo_unitario: number | null } | null)
          ?.custo_unitario;
        if (cu) custoUnitarioOriginal = Number(cu);
      }
      await inserirMovimentacao({
        tripla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "devolucao_cliente_integra",
        nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
        empresa_referencia_id: empresaReferenciaId,
        custo_unitario: custoUnitarioOriginal,
        usuario_id: input.usuario_id,
        motivo: input.observacoes,
      });
      break;
    }
    case "avariado": {
      // Classe B — avariada do cliente. Entra na loc indicada, transfere
      // imediatamente pra quarentena (par S+E no físico).
      await inserirMovimentacao({
        tripla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "devolucao_cliente_avariada",
        nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
        empresa_referencia_id: empresaReferenciaId,
        usuario_id: input.usuario_id,
        motivo: input.observacoes,
      });
      const { data: quarentena } = await sb
        .from("siso_localizacoes")
        .select("id")
        .match({
          galpao_id: input.galpao_id,
          tipo: "quarentena",
          ativo: true,
        })
        .limit(1)
        .maybeSingle();
      const locDestinoQuarentena = (quarentena as { id: string } | null)?.id;
      if (locDestinoQuarentena) {
        await inserirMovimentacao({
          tripla,
          tipo: "S",
          qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
          motivo: `avaria → quarentena: ${input.observacoes ?? ""}`,
        });
        await inserirMovimentacao({
          tripla: { ...tripla, localizacao_id: locDestinoQuarentena },
          tipo: "E",
          qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
        });
      } else {
        // Sem quarentena no galpão — ajuste manual pra remover saldo
        // (entra avariado e some no mesmo evento — preserva trilha).
        await inserirMovimentacao({
          tripla,
          tipo: "S",
          qty: input.qty,
          origem_tipo: "ajuste_manual",
          origem_detalhes: { motivo: "avaria_devolucao_sem_quarentena" },
          usuario_id: input.usuario_id,
        });
      }
      break;
    }
    case "garantia": {
      // Classes A+C combo: entra do cliente, sai pro fornecedor (garantia).
      if (!input.fornecedor_id) {
        throw new Error(
          "classificacao='garantia' exige fornecedor_id (Classe C — devolução pro fornecedor)",
        );
      }
      await inserirMovimentacao({
        tripla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "devolucao_cliente_integra",
        nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
        empresa_referencia_id: empresaReferenciaId,
        usuario_id: input.usuario_id,
      });
      await inserirMovimentacao({
        tripla,
        tipo: "S",
        qty: input.qty,
        origem_tipo: "devolucao_fornecedor_enviada",
        fornecedor_id: input.fornecedor_id,
        usuario_id: input.usuario_id,
        motivo: `garantia: ${input.observacoes ?? ""}`,
      });
      break;
    }
    case "troca_sku":
      // Classe A — apenas entra. Troca de SKU vira fluxo separado em
      // separacao (já existe `compras-equivalencia`). Aqui só reintegra.
      await inserirMovimentacao({
        tripla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "devolucao_cliente_integra",
        nota_fiscal_id: d.nota_fiscal_id?.toString() ?? undefined,
        empresa_referencia_id: empresaReferenciaId,
        usuario_id: input.usuario_id,
        motivo: `troca SKU: ${input.observacoes ?? ""}`,
      });
      break;
  }

  await sb
    .from("siso_devolucoes_pendentes")
    .update({
      status: "classificada",
      classificacao: input.classificacao,
      classificada_por: input.usuario_id,
      classificada_em: new Date().toISOString(),
      observacoes: input.observacoes,
    })
    .eq("id", input.devolucao_id);

  logger.info("wms.devolucoes", "classificada", {
    devolucao_id: input.devolucao_id,
    classificacao: input.classificacao,
  });
}

/**
 * Devolução pro fornecedor SEM passar por venda anterior (Classe C standalone).
 * Ex: lote defeituoso, troca direta com fornecedor.
 */
export async function devolverParaFornecedor(input: {
  tripla: { produto_id: string; galpao_id: string; localizacao_id: string };
  qty: number;
  fornecedor_id: string;
  motivo?: string;
  usuario_id: string;
}): Promise<void> {
  await inserirMovimentacao({
    tripla: input.tripla,
    tipo: "S",
    qty: input.qty,
    origem_tipo: "devolucao_fornecedor_enviada",
    fornecedor_id: input.fornecedor_id,
    usuario_id: input.usuario_id,
    motivo: input.motivo,
  });
}

/**
 * Entrada de devolução vinda do fornecedor (Classe D — produto que enviamos
 * pro fornecedor volta pra nossa prateleira). Ex: fornecedor recusou conserto.
 */
export async function receberDevolucaoFornecedor(input: {
  tripla: { produto_id: string; galpao_id: string; localizacao_id: string };
  qty: number;
  fornecedor_id: string;
  custo_unitario?: number;
  motivo?: string;
  usuario_id: string;
}): Promise<void> {
  await inserirMovimentacao({
    tripla: input.tripla,
    tipo: "E",
    qty: input.qty,
    origem_tipo: "devolucao_fornecedor_recebida",
    fornecedor_id: input.fornecedor_id,
    custo_unitario: input.custo_unitario,
    usuario_id: input.usuario_id,
    motivo: input.motivo,
  });
}

interface DevolucaoPendenteRow {
  id: string;
  nota_fiscal_id: number | null;
  empresa: { nome: string } | null;
  criado_em: string;
}

export async function listarDevolucoesPendentes(): Promise<DevolucaoPendenteRow[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*, empresa:siso_empresas(nome)")
    .eq("status", "aguardando_classificacao")
    .order("criado_em", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as DevolucaoPendenteRow[];
}
