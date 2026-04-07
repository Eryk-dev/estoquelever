import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { estornarEstoque, movimentarEstoque } from "@/lib/tiny-api";
import { registrarEvento } from "@/lib/historico-service";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "encaminhar";

/**
 * POST /api/separacao/encaminhar
 *
 * Forward one or more orders to another galpão.
 * Reverses any stock execution, resets pedido to pendente with
 * sugestao="transferencia" so the destination galpão sees it.
 *
 * Reroute contract (early-agrupamento safe):
 *  - NF fields PRESERVED: nota_fiscal_id, chave_acesso_nf, url_danfe
 *    → The NF belongs to the pedido regardless of destination galpão.
 *  - Shipping artifacts CLEARED: agrupamento_expedicao_id, expedicao_id,
 *    etiqueta_url, etiqueta_zpl, etiqueta_status
 *    → These are destination-specific and must be recreated after reroute.
 *  - After reset the pedido is eligible for a new fase-1 agrupamento via
 *    any second-chance entrypoint (approval worker, webhook, forcar-pendente).
 *
 * Body: { pedido_ids: string[], galpao_destino_id: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  let body: { pedido_ids?: unknown; galpao_destino_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, galpao_destino_id } = body;

  if (
    !Array.isArray(pedido_ids) ||
    pedido_ids.length === 0 ||
    !pedido_ids.every((id) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "pedido_ids deve ser um array de strings não vazio" },
      { status: 400 },
    );
  }

  if (typeof galpao_destino_id !== "string" || !galpao_destino_id) {
    return NextResponse.json(
      { error: "galpao_destino_id obrigatório" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Validate destination galpão
  const { data: galpaoDestino } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("id", galpao_destino_id)
    .eq("ativo", true)
    .single();

  if (!galpaoDestino) {
    return NextResponse.json(
      { error: "Galpão destino não encontrado ou inativo" },
      { status: 400 },
    );
  }

  const encaminhados: string[] = [];
  const falhas: Array<{ id: string; erro: string }> = [];

  for (const pedidoId of pedido_ids as string[]) {
    try {
      await encaminharPedido(
        supabase,
        pedidoId,
        galpaoDestino,
        session,
      );
      encaminhados.push(pedidoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      falhas.push({ id: pedidoId, erro: msg });
      logger.warn(LOG_SOURCE, `Falha ao encaminhar pedido ${pedidoId}`, {
        error: msg,
        galpaoDestino: galpaoDestino.nome,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    encaminhados,
    falhas,
    galpao_destino_nome: galpaoDestino.nome,
  });
}

// ─── Core logic per pedido ──────────────────────────────────────────────────

async function encaminharPedido(
  supabase: ReturnType<typeof createServiceClient>,
  pedidoId: string,
  galpaoDestino: { id: string; nome: string },
  session: { id: string; nome: string },
): Promise<void> {
  // B1. Fetch + validate
  const { data: pedido, error: pedidoErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, status, status_separacao, decisao_final, empresa_origem_id, filial_origem, estoque_lancado, nota_fiscal_id, numero, separacao_galpao_id",
    )
    .eq("id", pedidoId)
    .single();

  if (pedidoErr || !pedido) {
    throw new Error("Pedido não encontrado");
  }

  if (
    pedido.status_separacao !== "aguardando_separacao" &&
    pedido.status_separacao !== "em_separacao"
  ) {
    throw new Error(
      `Status inválido para encaminhar: ${pedido.status_separacao ?? "null"}`,
    );
  }

  // Resolve the actual galpão currently handling this order.
  // separacao_galpao_id is set when separation starts; fallback to the execution queue.
  const galpaoAtual = await resolveGalpaoAtual(supabase, pedido, pedidoId);

  if (galpaoAtual.id === galpaoDestino.id) {
    throw new Error("Não é possível encaminhar para o mesmo galpão");
  }

  // B2. Reverse stock execution
  await reverseStockExecution(supabase, pedido);

  // B3. Reset pedido to pendente
  // NF fields (nota_fiscal_id, chave_acesso_nf, url_danfe) are intentionally
  // NOT cleared — the NF belongs to the pedido regardless of destination.
  // Shipping artifacts (agrupamento, expedicao, etiqueta ZPL/URL) are PRESERVED —
  // they are tied to the NF, not the galpão. Only etiqueta_status is reset
  // so the label can be reprinted at the new destination.
  //
  // sugestao is set dynamically so the galpão filter shows the order in the
  // correct destination: "propria" if dest == filial_origem, else "transferencia".
  const sugestao = galpaoDestino.nome === pedido.filial_origem ? "propria" : "transferencia";

  const { error: updateErr } = await supabase
    .from("siso_pedidos")
    .update({
      status: "pendente",
      sugestao,
      encaminhado_de: galpaoAtual.nome,
      decisao_final: null,
      operador_id: null,
      operador_nome: null,
      tipo_resolucao: null,
      processado_em: null,
      estoque_lancado: false,
      status_separacao: null,
      separacao_galpao_id: null,
      separacao_operador_id: null,
      separacao_iniciada_em: null,
      separacao_concluida_em: null,
      embalagem_concluida_em: null,
      // etiqueta_status reset so label can be reprinted at new galpão
      etiqueta_status: null,
    })
    .eq("id", pedidoId);

  if (updateErr) {
    throw new Error(`Falha ao resetar pedido: ${updateErr.message}`);
  }

  // Reset item-level separation state
  await supabase
    .from("siso_pedido_itens")
    .update({
      separacao_marcado: false,
      separacao_marcado_em: null,
      quantidade_bipada: 0,
      bipado_completo: false,
      estoque_saida_lancada: false,
      empresa_deducao_id: null,
    })
    .eq("pedido_id", pedidoId);

  // B4. Audit event
  registrarEvento({
    pedidoId,
    evento: "encaminhado",
    usuarioId: session.id,
    usuarioNome: session.nome,
    detalhes: {
      origem: galpaoAtual.nome,
      destino: galpaoDestino.nome,
      decisao_anterior: pedido.decisao_final,
    },
  });

  logger.info(LOG_SOURCE, `Pedido ${pedido.numero} encaminhado de ${galpaoAtual.nome} para ${galpaoDestino.nome}`, {
    pedidoId,
    origem: galpaoAtual.nome,
    destino: galpaoDestino.nome,
    decisaoAnterior: pedido.decisao_final,
    operador: session.nome,
    nfPreservada: !!pedido.nota_fiscal_id,
    sugestao,
  });
}

// ─── Resolve current galpão ─────────────────────────────────────────────────

async function resolveGalpaoAtual(
  supabase: ReturnType<typeof createServiceClient>,
  pedido: { separacao_galpao_id: string | null; filial_origem: string },
  pedidoId: string,
): Promise<{ id: string; nome: string }> {
  // 1. If separacao already started, the galpão is assigned
  if (pedido.separacao_galpao_id) {
    const { data } = await supabase
      .from("siso_galpoes")
      .select("id, nome")
      .eq("id", pedido.separacao_galpao_id)
      .single();
    if (data) return data;
  }

  // 2. Fallback: resolve from the most recent execution queue entry
  const { data: job } = await supabase
    .from("siso_fila_execucao")
    .select("empresa_id")
    .eq("pedido_id", pedidoId)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (job) {
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("galpao_id")
      .eq("id", job.empresa_id)
      .single();

    if (empresa) {
      const { data: galpao } = await supabase
        .from("siso_galpoes")
        .select("id, nome")
        .eq("id", empresa.galpao_id)
        .single();
      if (galpao) return galpao;
    }
  }

  // 3. Last resort: use filial_origem as galpão name lookup
  const { data: galpaoByNome } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("nome", pedido.filial_origem)
    .single();

  if (galpaoByNome) return galpaoByNome;

  // Should never reach here — return a safe fallback
  return { id: "", nome: pedido.filial_origem };
}

// ─── Stock reversal ─────────────────────────────────────────────────────────

interface PedidoForReversal {
  id: string;
  decisao_final: string | null;
  empresa_origem_id: string | null;
  estoque_lancado: boolean | null;
  numero: string;
}

async function reverseStockExecution(
  supabase: ReturnType<typeof createServiceClient>,
  pedido: PedidoForReversal,
): Promise<void> {
  if (!pedido.estoque_lancado) {
    // No stock was posted — nothing to reverse
    return;
  }

  if (pedido.decisao_final === "propria" && pedido.empresa_origem_id) {
    // Propria: use Tiny's estornarEstoque on the origin empresa
    const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
    await runWithEmpresa(pedido.empresa_origem_id, () =>
      estornarEstoque(token, pedido.id),
    );

    logger.info(LOG_SOURCE, `Estoque estornado (propria) para pedido ${pedido.numero}`, {
      pedidoId: pedido.id,
      empresaId: pedido.empresa_origem_id,
    });
    return;
  }

  if (pedido.decisao_final === "transferencia") {
    // Transferencia: reverse movimentarEstoque for each deducted item
    await reverseTransferenciaStock(supabase, pedido);
    return;
  }

  // OC or null decisao — no stock to reverse
}

async function reverseTransferenciaStock(
  supabase: ReturnType<typeof createServiceClient>,
  pedido: PedidoForReversal,
): Promise<void> {
  // Get items that had stock deducted
  const { data: itens } = await supabase
    .from("siso_pedido_itens")
    .select("produto_id, sku, quantidade_pedida, estoque_saida_lancada, empresa_deducao_id")
    .eq("pedido_id", pedido.id)
    .eq("estoque_saida_lancada", true);

  if (!itens?.length) return;

  // Get produto_id_na_empresa from enrichment data
  const { data: estoques } = await supabase
    .from("siso_pedido_item_estoques")
    .select("produto_id, empresa_id, produto_id_na_empresa")
    .eq("pedido_id", pedido.id);

  // Group items by empresa_deducao_id for efficient token reuse
  const byEmpresa = new Map<string, typeof itens>();
  for (const item of itens) {
    if (!item.empresa_deducao_id) continue;
    const list = byEmpresa.get(item.empresa_deducao_id) ?? [];
    list.push(item);
    byEmpresa.set(item.empresa_deducao_id, list);
  }

  for (const [empresaId, empresaItens] of byEmpresa) {
    const { token } = await getValidTokenByEmpresa(empresaId);

    // Get deposito for this empresa
    const { data: conn } = await supabase
      .from("siso_tiny_connections")
      .select("deposito_id")
      .eq("empresa_id", empresaId)
      .eq("ativo", true)
      .single();

    const depositoId = conn?.deposito_id ?? null;

    for (const item of empresaItens) {
      // Find the product ID in the deducting empresa
      const cachedEst = estoques?.find(
        (e) => e.empresa_id === empresaId && e.produto_id === item.produto_id,
      );
      const produtoIdNaEmpresa = cachedEst?.produto_id_na_empresa as number | null;

      if (!produtoIdNaEmpresa) {
        throw new Error(
          `Produto ${item.sku} sem ID na empresa ${empresaId} — não é possível reverter`,
        );
      }

      // Reverse: entry instead of exit
      await runWithEmpresa(empresaId, () =>
        movimentarEstoque(token, produtoIdNaEmpresa, {
          tipo: "E",
          quantidade: item.quantidade_pedida as number,
          deposito: depositoId ? { id: depositoId } : undefined,
          observacoes: `Estorno encaminhar pedido ${pedido.numero}`,
        }),
      );

      logger.info(LOG_SOURCE, `Estoque revertido: ${item.sku} x${item.quantidade_pedida}`, {
        pedidoId: pedido.id,
        empresaId,
        sku: item.sku,
      });
    }
  }
}
