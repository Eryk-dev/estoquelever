import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "./ledger";
import { logger } from "@/lib/logger";

export type Classificacao = "integro" | "avariado" | "garantia" | "troca_sku";

export interface MovOrigemVenda {
  origem_tipo: string;
  empresa_dona_id: string;
  emprestimo_devedora_id: string | null;
}

export function resolverDonaDestino(mov: MovOrigemVenda): {
  dona_id: string;
  quita_emprestimo: boolean;
} {
  const quita = mov.origem_tipo === "emprestimo";
  return { dona_id: mov.empresa_dona_id, quita_emprestimo: quita };
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
  empresa_dona_destino_id?: string;
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

  let donaId = input.empresa_dona_destino_id;
  if (!donaId && d.pedido_origem_mov_id) {
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("origem_tipo, empresa_dona_id, emprestimo_devedora_id")
      .eq("id", d.pedido_origem_mov_id)
      .single();
    if (mov) donaId = resolverDonaDestino(mov as MovOrigemVenda).dona_id;
  }
  if (!donaId) {
    throw new Error(
      "não foi possível resolver dona destino; informe empresa_dona_destino_id",
    );
  }

  const quadrupla = {
    produto_id: input.produto_id,
    empresa_dona_id: donaId,
    galpao_id: input.galpao_id,
    localizacao_id: input.localizacao_id,
  };

  switch (input.classificacao) {
    case "integro": {
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
        quadrupla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        nota_fiscal_id: d.nota_fiscal_id ?? undefined,
        custo_unitario: custoUnitarioOriginal,
        usuario_id: input.usuario_id,
        observacoes: input.observacoes,
      });
      if (custoUnitarioOriginal !== undefined) {
        const { recalcularCustoMedio } = await import("./movimentacoes");
        await recalcularCustoMedio(quadrupla, input.qty, custoUnitarioOriginal);
      }
      break;
    }
    case "avariado": {
      await inserirMovimentacao({
        quadrupla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "nf_devolucao_avariada",
        nota_fiscal_id: d.nota_fiscal_id ?? undefined,
        usuario_id: input.usuario_id,
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
      const locDestinoQuarentena =
        (quarentena as { id: string } | null)?.id ?? input.localizacao_id;
      if (quarentena) {
        await inserirMovimentacao({
          quadrupla,
          tipo: "S",
          qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
          observacoes: `avaria → quarentena: ${input.observacoes ?? ""}`,
        });
        await inserirMovimentacao({
          quadrupla: { ...quadrupla, localizacao_id: locDestinoQuarentena },
          tipo: "E",
          qty: input.qty,
          origem_tipo: "transferencia_localizacao",
          usuario_id: input.usuario_id,
        });
      } else {
        await inserirMovimentacao({
          quadrupla,
          tipo: "S",
          qty: input.qty,
          origem_tipo: "ajuste_manual",
          origem_detalhes: { motivo: "avaria_devolucao_sem_quarentena" },
          usuario_id: input.usuario_id,
        });
      }
      break;
    }
    case "garantia":
      await inserirMovimentacao({
        quadrupla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        usuario_id: input.usuario_id,
      });
      await inserirMovimentacao({
        quadrupla,
        tipo: "S",
        qty: input.qty,
        origem_tipo: "nf_devolucao_fornecedor",
        usuario_id: input.usuario_id,
        observacoes: `garantia: ${input.observacoes ?? ""}`,
      });
      break;
    case "troca_sku":
      await inserirMovimentacao({
        quadrupla,
        tipo: "E",
        qty: input.qty,
        origem_tipo: "nf_devolucao_cliente",
        usuario_id: input.usuario_id,
        observacoes: `troca SKU: ${input.observacoes ?? ""}`,
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
