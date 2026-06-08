import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * Enfileira uma localização para contagem futura na sessão operacional contínua
 * do galpão. Idempotente via UNIQUE(sessao_id, localizacao_id).
 * Falha silenciosa — o caller deve fazer .catch() pra não bloquear o pick.
 */
export async function enfileirarLocParaContagem(
  sb: ReturnType<typeof createServiceClient>,
  galpao_id: string,
  localizacao_id: string,
  solicitada_por: string,
): Promise<void> {
  const sessao_id = await getOrCreateSessaoOperacional(sb, galpao_id, solicitada_por);
  // Idempotência clique-duplo via UNIQUE(sessao_id, localizacao_id)
  await sb
    .from("siso_inventario_localizacoes")
    .upsert(
      { sessao_id, localizacao_id, status: "pendente", motivo: "solicitada_pick" },
      { onConflict: "sessao_id,localizacao_id", ignoreDuplicates: true },
    );
}

const NOME_SESSAO_OPERACIONAL = "Contagens operacionais";

export interface ContagemInlineInput {
  produto_id: string; // uuid WMS (já resolvido via resolverProdutoWms)
  galpao_id: string;
  localizacao_id: string;
  qty_contada: number; // N — total contado na loc para o SKU
  contada_por: string; // operador
  sku?: string;
  pedido_id?: string;
}

export interface ContagemInlineResult {
  sessao_id: string;
  contagem_id: string;
  divergencia_id: string;
  mov_reconciliacao_id: string | null;
  saldo_anterior: number;
  delta: number;
}

// TODO(v2): a sessão contínua acumula contagens/locs indefinidamente. Volume
// atual é baixo (só itens OC encontrados) e as métricas filtram 30d, mas
// considerar arquivamento/rotação se crescer.
async function getOrCreateSessaoOperacional(
  sb: ReturnType<typeof createServiceClient>,
  galpao_id: string,
  criada_por: string,
): Promise<string> {
  const { data: existente } = await sb
    .from("siso_inventario_sessoes")
    .select("id")
    .eq("galpao_id", galpao_id)
    .eq("continua", true)
    .maybeSingle();
  if (existente) return (existente as { id: string }).id;

  const { data, error } = await sb
    .from("siso_inventario_sessoes")
    .insert({
      tipo: "cycle_count",
      galpao_id,
      modo_contagem: "aberto",
      nome: NOME_SESSAO_OPERACIONAL,
      status: "em_andamento",
      continua: true,
      criada_por,
      iniciada_em: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // corrida: outro request criou no intervalo (índice único parcial) — re-busca
    const { data: again } = await sb
      .from("siso_inventario_sessoes")
      .select("id")
      .eq("galpao_id", galpao_id)
      .eq("continua", true)
      .maybeSingle();
    if (again) return (again as { id: string }).id;
    throw new Error(`getOrCreateSessaoOperacional: ${error.message}`);
  }
  return (data as { id: string }).id;
}

/**
 * Registra a contagem do operador (na frente da prateleira) como contagem
 * OFICIAL, aplicada na hora: reconcilia o saldo no ledger (inventario_ganho/perda),
 * grava 1 linha em siso_inventario_contagens (acuracidade), faz upsert da
 * divergência (status='aplicada'), garante a loc na sessão e atualiza
 * ultima_contagem_em. NÃO faz o pick (responsabilidade do caller).
 *
 * Schema é 3D: tabelas de inventário NÃO têm empresa_dona_id.
 *
 * [P057] Tudo-ou-nada: a mov de reconciliação + os inserts de contagem/
 * divergência rodam numa única transação via RPC wms_contagem_inline_atomica.
 * Esta função vira um wrapper fino (resolve a sessão contínua + delega à RPC).
 */
export async function registrarContagemInline(
  input: ContagemInlineInput,
): Promise<ContagemInlineResult> {
  const sb = createServiceClient();
  const sessaoId = await getOrCreateSessaoOperacional(sb, input.galpao_id, input.contada_por);

  const { data, error } = await sb.rpc("wms_contagem_inline_atomica", {
    p_produto_id: input.produto_id,
    p_galpao_id: input.galpao_id,
    p_localizacao_id: input.localizacao_id,
    p_qty_contada: input.qty_contada,
    p_contada_por: input.contada_por,
    p_sessao_id: sessaoId,
    p_sku: input.sku ?? null,
    p_pedido_id: input.pedido_id ?? null,
  });
  if (error) throw new Error(`registrarContagemInline: ${error.message}`);

  const r = data as {
    contagem_id: string;
    divergencia_id: string;
    mov_reconciliacao_id: string | null;
    saldo_anterior: number;
    delta: number;
  };

  logger.info("contagem-inline", "acerto de prateleira registrado", {
    sessao_id: sessaoId,
    produto_id: input.produto_id,
    loc_id: input.localizacao_id,
    saldo_anterior: r.saldo_anterior,
    contado: input.qty_contada,
    delta: r.delta,
    mov_id: r.mov_reconciliacao_id,
  });

  return {
    sessao_id: sessaoId,
    contagem_id: r.contagem_id,
    divergencia_id: r.divergencia_id,
    mov_reconciliacao_id: r.mov_reconciliacao_id,
    saldo_anterior: Number(r.saldo_anterior),
    delta: Number(r.delta),
  };
}
