import { randomUUID } from "crypto";
import { createServiceClient } from "@/lib/supabase-server";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import { logger } from "@/lib/logger";

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
 * O divergencia_id da mov é um randomUUID por evento (satisfaz o índice
 * uniq_movs_inventario_divergencia sem colidir entre contagens repetidas).
 */
export async function registrarContagemInline(
  input: ContagemInlineInput,
): Promise<ContagemInlineResult> {
  const sb = createServiceClient();
  const sessaoId = await getOrCreateSessaoOperacional(sb, input.galpao_id, input.contada_por);

  const { data: estoqueRow } = await sb
    .from("siso_estoque")
    .select("saldo")
    .eq("produto_id", input.produto_id)
    .eq("galpao_id", input.galpao_id)
    .eq("localizacao_id", input.localizacao_id)
    .maybeSingle();
  const saldo = Number((estoqueRow as { saldo?: number } | null)?.saldo ?? 0);
  const delta = input.qty_contada - saldo;

  let movId: string | null = null;
  if (delta !== 0) {
    const mov = await inserirMovimentacao({
      tripla: {
        produto_id: input.produto_id,
        galpao_id: input.galpao_id,
        localizacao_id: input.localizacao_id,
      },
      tipo: delta > 0 ? "E" : "S",
      qty: Math.abs(delta),
      origem_tipo: delta > 0 ? "inventario_ganho" : "inventario_perda",
      origem_id: sessaoId,
      origem_detalhes: {
        divergencia_id: randomUUID(),
        contexto: "acerto_pick",
        sku: input.sku,
        pedido_id: input.pedido_id,
      },
      motivo: "Acerto de prateleira no pick",
      usuario_id: input.contada_por,
    });
    movId = mov.id;
  }

  // loc como membro da sessão (metrica_localizacao lê daqui). UNIQUE(sessao,loc) existe.
  await sb
    .from("siso_inventario_localizacoes")
    .upsert(
      { sessao_id: sessaoId, localizacao_id: input.localizacao_id, status: "contada", motivo: "manual" },
      { onConflict: "sessao_id,localizacao_id" },
    );

  // contagem oficial — sem unique disponível → INSERT por evento
  const { data: contagem, error: cErr } = await sb
    .from("siso_inventario_contagens")
    .insert({
      sessao_id: sessaoId,
      localizacao_id: input.localizacao_id,
      produto_id: input.produto_id,
      qty_contada: input.qty_contada,
      contada_por: input.contada_por,
    })
    .select("id")
    .single();
  if (cErr) throw new Error(`registrarContagemInline contagem: ${cErr.message}`);

  // divergência aplicada — UNIQUE 3D (sessao, loc, produto)
  const { data: div, error: dErr } = await sb
    .from("siso_inventario_divergencias")
    .upsert(
      {
        sessao_id: sessaoId,
        localizacao_id: input.localizacao_id,
        produto_id: input.produto_id,
        saldo_sistema: saldo,
        qty_contada_final: input.qty_contada,
        status: "aplicada",
        mov_aplicada_id: movId,
        resolucao_por: input.contada_por,
        resolucao_em: new Date().toISOString(),
      },
      { onConflict: "sessao_id,localizacao_id,produto_id" },
    )
    .select("id")
    .single();
  if (dErr) throw new Error(`registrarContagemInline divergencia: ${dErr.message}`);

  // última contagem (explícito — não depende do trigger AFTER INSERT)
  await sb
    .from("siso_localizacoes")
    .update({ ultima_contagem_em: new Date().toISOString() })
    .eq("id", input.localizacao_id);

  logger.info("contagem-inline", "acerto de prateleira registrado", {
    sessao_id: sessaoId,
    produto_id: input.produto_id,
    loc_id: input.localizacao_id,
    saldo_anterior: saldo,
    contado: input.qty_contada,
    delta,
    mov_id: movId,
  });

  return {
    sessao_id: sessaoId,
    contagem_id: (contagem as { id: string }).id,
    divergencia_id: (div as { id: string }).id,
    mov_reconciliacao_id: movId,
    saldo_anterior: saldo,
    delta,
  };
}
