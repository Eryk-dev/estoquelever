import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao, estornarMovimentacao } from "./ledger";
import { upsertNotaFiscal } from "@/lib/nf-webhook-handler";
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
  /** Empresa **receptora física** da NF de devolução (quem recebeu a peça
   *  de volta no galpão). NÃO confundir com empresa vendedora da venda
   *  original — essa última é a `empresa_referencia_id` derivada da mov S
   *  da venda em `classificarDevolucao` via `resolverEmpresaReferencia`. */
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
  // [#P6-6.15] Fallback: nota_fiscal_id pode não estar populado em movs
  // antigas, mas chave_acesso_nf cobre os mesmos casos. Busca pela chave
  // se o lookup primário falhou.
  if (!pedidoOrigemMovId && input.chave_acesso_nf) {
    const { data: mov } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("chave_acesso_nf", input.chave_acesso_nf)
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

  // P052: claim atômico de status (compare-and-set). Fecha a janela
  // concorrente: só uma chamada reivindica a devolução; a 2ª leva 0 rows e
  // rejeita. O status segue 'aguardando_classificacao' (a CHECK proíbe
  // 'classificando') — usamos o lease classificacao_em_andamento_por.
  const { data: claimed } = await sb
    .from("siso_devolucoes_pendentes")
    .update({ classificacao_em_andamento_por: input.usuario_id })
    .eq("id", input.devolucao_id)
    .eq("status", "aguardando_classificacao")
    .is("classificacao_em_andamento_por", null)
    .select("id");
  if (!claimed || claimed.length === 0) {
    throw new Error("já classificada ou em classificação por outro operador");
  }

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
    chave_acesso_nf: string | null;
    empresa_id: string | null;
    payload_webhook: unknown;
  };
  const d = dev as DevRow;

  try {

  // [#P6-6.17] origem_id compartilhado entre todas as movs do mesmo
  // classify (Classe B = par S+E quarentena; Classe C = E + S fornecedor).
  // Permite agrupar movs do mesmo evento no ledger pra auditoria/relatórios.
  const origemCompartilhado = randomUUID();

  // Fix-Final A T6 (R5): garante uuid em siso_notas_fiscais antes de chamar
  // inserirMovimentacao — a migration T5 adicionou FK e o ledger valida
  // assertUuidLike(nota_fiscal_id). Sem upsert, devolução com NF Tiny crash.
  let notaFiscalUuid: string | null = null;
  if (d.nota_fiscal_id != null || d.chave_acesso_nf) {
    notaFiscalUuid = await upsertNotaFiscal({
      tiny_nota_fiscal_id: d.nota_fiscal_id,
      chave_acesso: d.chave_acesso_nf,
      empresa_id: d.empresa_id,
      tipo: "entrada",
      raw: d.payload_webhook,
    });
  }

  // empresa_referencia_id = vendedora da venda ORIGINAL (mov S nf_venda).
  // NUNCA confundir com siso_devolucoes_pendentes.empresa_id (que é receptora
  // física da devolução — pode ser empresa diferente da que vendeu).
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
  // [#P6-6.14] Fallback: se ainda null, busca empresa_origem_id do pedido
  // que originou a NF. Cobre casos onde a mov de saída original não tem
  // empresa_vendedora_id setada (legado pre-cutover) mas o pedido tem
  // empresa_origem_id válido.
  if (!empresaReferenciaId && d.nota_fiscal_id) {
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("empresa_origem_id")
      .eq("nota_fiscal_id", d.nota_fiscal_id)
      .maybeSingle();
    empresaReferenciaId =
      (ped as { empresa_origem_id: string } | null)?.empresa_origem_id ?? null;
  }

  // Custo unitário da venda original (alimenta recálculo do custo médio em
  // toda Classe — A, B, C, D). Sem custo herdado, devoluções B/C/D entrariam
  // com cu=null e o ledger calcularia custo médio sobre uma base errada
  // (ignorando o valor real do item que está voltando).
  let custoUnitarioOriginal: number | null = null;
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

  // [P051] resolve+valida quarentena ANTES (guard TS); a RPC re-valida
  // (backstop sob lock). Remove o ajuste_manual silencioso que fazia o item
  // sumir quando o galpão não tinha quarentena.
  let locQuarentenaId: string | null = null;
  if (input.classificacao === "avariado") {
    const { data: quarentena } = await sb
      .from("siso_localizacoes")
      .select("id")
      .match({ galpao_id: input.galpao_id, tipo: "quarentena", ativo: true })
      .order("codigo", { ascending: true }) // determinístico
      .limit(1)
      .maybeSingle();
    locQuarentenaId = (quarentena as { id: string } | null)?.id ?? null;
    if (!locQuarentenaId) {
      throw new Error(
        `quarentena inexistente no galpão ${input.galpao_id} — crie uma localização tipo 'quarentena' antes de classificar avariado`,
      );
    }
  }
  if (input.classificacao === "garantia" && !input.fornecedor_id) {
    throw new Error(
      "classificacao='garantia' exige fornecedor_id (Classe C — devolução pro fornecedor)",
    );
  }

  // [P049/P050/P054] Movs + UPDATE de status numa única tx, serializado por
  // FOR UPDATE na devolução. A RPC resolve a atomicidade que o caminho
  // sequencial (N inserirMovimentacao + UPDATE depois) não tinha.
  const { data: rpcRes, error: rpcErr } = await sb.rpc(
    "wms_classificar_devolucao",
    {
      p_devolucao_id: input.devolucao_id,
      p_classificacao: input.classificacao,
      p_produto_id: input.produto_id,
      p_galpao_id: input.galpao_id,
      p_localizacao_id: input.localizacao_id,
      p_qty: input.qty,
      p_loc_quarentena_id: locQuarentenaId,
      p_usuario_id: input.usuario_id,
      p_origem_compartilhado: origemCompartilhado,
      p_nota_fiscal_id: notaFiscalUuid,
      p_empresa_referencia_id: empresaReferenciaId,
      p_fornecedor_id: input.fornecedor_id ?? null,
      p_custo_unitario: custoUnitarioOriginal,
      p_observacoes: input.observacoes ?? null,
    },
  );
  if (rpcErr) throw new Error(rpcErr.message);

  logger.info("wms.devolucoes", "classificada", {
    devolucao_id: input.devolucao_id,
    classificacao: input.classificacao,
    ja_classificada:
      (rpcRes as { ja_classificada?: boolean } | null)?.ja_classificada ?? false,
  });

  } catch (e) {
    // P052 sad-path: libera o lease pra a devolução não ficar presa. Só limpa
    // se ainda formos o dono (proteção contra interleavings).
    await sb
      .from("siso_devolucoes_pendentes")
      .update({ classificacao_em_andamento_por: null })
      .eq("id", input.devolucao_id)
      .eq("classificacao_em_andamento_por", input.usuario_id);
    throw e;
  }
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
  /** Empresa **receptora física** da NF de devolução (FK `empresa_id`).
   *  NÃO confundir com `empresa_referencia_id` (vendedora original) — essa
   *  só é resolvida no `classificarDevolucao` via mov S da venda original.
   *  Em 3D não há mais "dona destino"; saldo entra na (produto, galpão, loc). */
  empresa_receptora: { nome: string } | null;
  criado_em: string;
}

/**
 * P3 #6.3 (fix-final-B T11): reverte uma devolução classificada — estorna
 * todas as movs geradas e volta status='aguardando_classificacao'.
 *
 * Lookup determinístico via FK `siso_movimentacoes.devolucao_id`:
 * `classificarDevolucao` (pós-T4.2) chama a RPC `wms_classificar_devolucao`, que
 * back-fila essa coluna nas movs criadas via `UPDATE ... SET devolucao_id = p_devolucao_id
 * WHERE id = ANY(v_mov_ids)`. Resultado idêntico ao antigo populado por-mov: as movs
 * carregam `devolucao_id`, então a busca direta por `devolucao_id = input.devolucao_id`
 * funciona — substitui o match por janela temporal (±1min) anterior.
 *
 * Nota: devoluções classificadas antes deste commit não terão `devolucao_id`
 * nas movs (coluna era NULL), portanto `desclassificar` retornará 0 movs
 * estornadas nesses casos históricos. Esses registros já estão resolvidos
 * operacionalmente — sem impacto.
 */
export async function desclassificarDevolucao(input: {
  devolucao_id: string;
  usuario_id: string;
  motivo: string;
}): Promise<{ movsEstornadas: number }> {
  if (!input.motivo || input.motivo.trim().length < 3) {
    throw new Error("motivo da desclassificação é obrigatório (≥3 caracteres)");
  }
  const sb = createServiceClient();
  const { data: dev } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*")
    .eq("id", input.devolucao_id)
    .maybeSingle();
  if (!dev) throw new Error("devolução não encontrada");
  const d = dev as {
    id: string;
    status: string;
    classificacao: string | null;
    classificada_em: string | null;
    classificada_por: string | null;
  };
  if (d.status !== "classificada") {
    throw new Error(
      `devolução em status ${d.status} — apenas 'classificada' pode ser desclassificada`,
    );
  }
  if (!d.classificada_em) {
    throw new Error("devolução sem timestamp classificada_em — auditoria quebrada");
  }

  // Lookup determinístico via FK devolucao_id (fix-final-B T11).
  // Busca apenas movs originais (estorno_de IS NULL) pra não tentar
  // estornar estornos já existentes.
  const { data: movs } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("devolucao_id", input.devolucao_id)
    .is("estorno_de", null);

  let movsEstornadas = 0;
  for (const m of (movs ?? []) as Array<{ id: string }>) {
    try {
      await estornarMovimentacao({
        mov_id: m.id,
        usuario_id: input.usuario_id,
        motivo: `Desclassifica devolução ${input.devolucao_id}: ${input.motivo}`,
      });
      movsEstornadas++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/já foi estornada|já é um estorno/.test(msg)) continue;
      throw err;
    }
  }

  await sb
    .from("siso_devolucoes_pendentes")
    .update({
      status: "aguardando_classificacao",
      classificacao: null,
      classificada_por: null,
      classificada_em: null,
    })
    .eq("id", input.devolucao_id);

  logger.info("wms.devolucoes", "desclassificada", {
    devolucao_id: input.devolucao_id,
    movs_estornadas: movsEstornadas,
  });

  return { movsEstornadas };
}

export async function listarDevolucoesPendentes(): Promise<DevolucaoPendenteRow[]> {
  const sb = createServiceClient();
  // O JOIN é em `empresa_id` (FK receptora física) — alias `empresa_receptora`
  // pra deixar explícito que NÃO é a vendedora original (`empresa_referencia_id`).
  const { data, error } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*, empresa_receptora:siso_empresas!empresa_id(nome)")
    .eq("status", "aguardando_classificacao")
    .order("criado_em", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as DevolucaoPendenteRow[];
}

/**
 * Devoluções já classificadas (status='classificada'), pra UI de
 * desclassificar (reverter classificação). Idempotência: rows com
 * `classificada_em` IS NULL ficam fora — sem timestamp, desclassificar
 * dispararia erro de auditoria.
 */
export async function listarDevolucoesClassificadas(): Promise<DevolucaoPendenteRow[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_devolucoes_pendentes")
    .select("*, empresa_receptora:siso_empresas!empresa_id(nome)")
    .eq("status", "classificada")
    .not("classificada_em", "is", null)
    .order("classificada_em", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as DevolucaoPendenteRow[];
}
