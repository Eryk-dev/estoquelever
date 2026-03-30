import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { registrarEventos } from "@/lib/historico-service";
import { preCriarAgrupamentosEmLote } from "@/lib/agrupamento-service";
import { kickWorker } from "@/lib/execution-worker";

const LOG_SOURCE = "separacao-concluir-oc";

/**
 * POST /api/separacao/concluir-oc
 *
 * Complete OC separation: auto-resolve compra items, resolve decisao,
 * enqueue execution, and transition directly to 'separado' with tag 'pick oc'.
 *
 * Body: { pedido_ids: string[], operador_id?: string }
 * Returns: { separados: string[], pendentes: string[] }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (
    !body?.pedido_ids ||
    !Array.isArray(body.pedido_ids) ||
    body.pedido_ids.length === 0 ||
    !body.pedido_ids.every((id: unknown) => typeof id === "string")
  ) {
    return NextResponse.json(
      { error: "'pedido_ids' (string[]) é obrigatório" },
      { status: 400 },
    );
  }

  const { pedido_ids, operador_id } = body as {
    pedido_ids: string[];
    operador_id?: string;
  };
  const supabase = createServiceClient();

  try {
    // ── 1. Check all items are marked ──
    const { data: allItems, error: fetchError } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, separacao_marcado, compra_status, compra_quantidade_solicitada, ordem_compra_id",
      )
      .in("pedido_id", pedido_ids);

    if (fetchError) {
      logger.logError({
        error: fetchError,
        source: LOG_SOURCE,
        message: "Failed to fetch items",
        category: "database",
        errorCode: fetchError.code,
        requestPath: "/api/separacao/concluir-oc",
        requestMethod: "POST",
        metadata: { pedido_ids },
      });
      return NextResponse.json(
        { error: fetchError.message },
        { status: 500 },
      );
    }

    // Group items by pedido_id
    const itemsByPedido = new Map<
      string,
      Array<{
        id: string;
        separacao_marcado: boolean;
        compra_status: string | null;
        compra_quantidade_solicitada: number | null;
        ordem_compra_id: string | null;
      }>
    >();
    for (const item of allItems ?? []) {
      const list = itemsByPedido.get(item.pedido_id) ?? [];
      list.push(item);
      itemsByPedido.set(item.pedido_id, list);
    }

    const separados: string[] = [];
    const pendentes: string[] = [];

    for (const pid of pedido_ids) {
      const items = itemsByPedido.get(pid);
      if (items && items.length > 0 && items.every((i) => i.separacao_marcado === true)) {
        separados.push(pid);
      } else {
        pendentes.push(pid);
      }
    }

    // Return incomplete pedidos to aguardando_compra
    if (pendentes.length > 0) {
      await supabase
        .from("siso_pedido_itens")
        .update({ separacao_marcado: false, separacao_marcado_em: null })
        .in("pedido_id", pendentes);

      await supabase
        .from("siso_pedidos")
        .update({
          status_separacao: "aguardando_compra",
          separacao_operador_id: null,
          separacao_iniciada_em: null,
        })
        .in("id", pendentes);
    }

    if (separados.length === 0) {
      return NextResponse.json({ separados, pendentes });
    }

    // ── 2. Auto-resolve OC items: mark as recebido ──
    const ocItemIds: string[] = [];
    for (const pid of separados) {
      const items = itemsByPedido.get(pid) ?? [];
      for (const item of items) {
        if (
          item.compra_status &&
          item.compra_status !== "recebido" &&
          item.compra_status !== "cancelado"
        ) {
          ocItemIds.push(item.id);
        }
      }
    }

    if (ocItemIds.length > 0) {
      // We need to update each item with its own compra_quantidade_solicitada as recebida
      // Batch update all at once — set compra_status='recebido'
      // For compra_quantidade_recebida, we set it equal to compra_quantidade_solicitada per item
      for (const pid of separados) {
        const items = itemsByPedido.get(pid) ?? [];
        for (const item of items) {
          if (
            item.compra_status &&
            item.compra_status !== "recebido" &&
            item.compra_status !== "cancelado"
          ) {
            await supabase
              .from("siso_pedido_itens")
              .update({
                compra_status: "recebido",
                compra_quantidade_recebida: item.compra_quantidade_solicitada ?? 0,
              })
              .eq("id", item.id);
          }
        }
      }
    }

    // ── 3. Resolve decisao per pedido and update ──
    // Fetch pedido info
    const { data: pedidos } = await supabase
      .from("siso_pedidos")
      .select("id, empresa_origem_id, separacao_tags")
      .in("id", separados);

    if (!pedidos || pedidos.length === 0) {
      return NextResponse.json(
        { error: "Pedidos não encontrados" },
        { status: 404 },
      );
    }

    // Collect all unique OC IDs across all separado pedidos
    const allOcIds = new Set<string>();
    for (const pid of separados) {
      for (const item of itemsByPedido.get(pid) ?? []) {
        if (item.ordem_compra_id) allOcIds.add(item.ordem_compra_id);
      }
    }

    // Fetch OC galpao info in batch
    const ocGalpaoMap = new Map<string, string | null>();
    if (allOcIds.size > 0) {
      const { data: ocs } = await supabase
        .from("siso_ordens_compra")
        .select("id, galpao_id")
        .in("id", [...allOcIds]);
      for (const oc of ocs ?? []) {
        ocGalpaoMap.set(oc.id, oc.galpao_id);
      }
    }

    // Fetch empresa galpao info in batch
    const empresaIds = [...new Set(pedidos.map((p) => p.empresa_origem_id).filter(Boolean))];
    const empresaGalpaoMap = new Map<string, string>();
    if (empresaIds.length > 0) {
      const { data: empresas } = await supabase
        .from("siso_empresas")
        .select("id, galpao_id")
        .in("id", empresaIds);
      for (const emp of empresas ?? []) {
        if (emp.galpao_id) empresaGalpaoMap.set(emp.id, emp.galpao_id);
      }
    }

    // Process each pedido
    for (const pedido of pedidos) {
      const pedidoItems = itemsByPedido.get(pedido.id) ?? [];
      const pedidoGalpaoId = pedido.empresa_origem_id
        ? empresaGalpaoMap.get(pedido.empresa_origem_id) ?? null
        : null;

      // Resolve OC galpao from items
      const itemOcGalpaoIds = pedidoItems
        .map((i) => (i.ordem_compra_id ? ocGalpaoMap.get(i.ordem_compra_id) : null))
        .filter(Boolean) as string[];
      const uniqueOcGalpaoIds = [...new Set(itemOcGalpaoIds)];
      const ocGalpaoId = uniqueOcGalpaoIds[0] ?? null;

      // Resolve decisao
      let decisao: "propria" | "transferencia";
      let separacaoGalpaoId: string | null;
      let empresaExecId = pedido.empresa_origem_id;

      if (!ocGalpaoId || !pedidoGalpaoId || ocGalpaoId === pedidoGalpaoId) {
        // Same galpao or no OC linked → propria
        decisao = "propria";
        separacaoGalpaoId = pedidoGalpaoId;
      } else {
        // Different galpao → transferencia
        decisao = "transferencia";
        separacaoGalpaoId = ocGalpaoId;

        // Find first active empresa in OC galpao for execution
        const { data: empresaOcGalpao } = await supabase
          .from("siso_empresas")
          .select("id")
          .eq("galpao_id", ocGalpaoId)
          .eq("ativo", true)
          .order("criado_em", { ascending: true })
          .limit(1)
          .single();
        if (empresaOcGalpao) {
          empresaExecId = empresaOcGalpao.id;
        }
      }

      // Append 'pick oc' tag
      const currentTags: string[] = pedido.separacao_tags ?? [];
      const newTags = currentTags.includes("pick oc")
        ? currentTags
        : [...currentTags, "pick oc"];

      // Update pedido
      const { error: updateError } = await supabase
        .from("siso_pedidos")
        .update({
          decisao_final: decisao,
          status: "executando",
          status_separacao: "separado",
          separacao_concluida_em: new Date().toISOString(),
          separacao_galpao_id: separacaoGalpaoId,
          separacao_tags: newTags,
        })
        .eq("id", pedido.id);

      if (updateError) {
        logger.logError({
          error: updateError,
          source: LOG_SOURCE,
          message: "Failed to update pedido",
          category: "database",
          errorCode: updateError.code,
          requestPath: "/api/separacao/concluir-oc",
          requestMethod: "POST",
          metadata: { pedidoId: pedido.id },
        });
        continue;
      }

      // Insert execution queue job
      const { error: queueError } = await supabase
        .from("siso_fila_execucao")
        .insert({
          pedido_id: pedido.id,
          tipo: "lancar_estoque",
          empresa_id: empresaExecId,
          decisao,
          tentativas: 0,
          status: "pendente",
        });

      if (queueError) {
        logger.error(LOG_SOURCE, "Erro ao enfileirar job", {
          pedidoId: pedido.id,
          error: queueError.message,
        });
      }
    }

    // ── 4. Fire-and-forget: kick worker, agrupamentos, history ──
    kickWorker().catch((err) => {
      logger.error(LOG_SOURCE, "Worker kick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    preCriarAgrupamentosEmLote(separados).catch((err) => {
      logger.error(LOG_SOURCE, "Falha ao pré-criar agrupamentos", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const operadorNome = operador_id ? undefined : session.nome;
    registrarEventos(
      separados.map((pid) => ({
        pedidoId: pid,
        evento: "separacao_oc_concluida" as const,
        usuarioId: operador_id ?? session.id,
        usuarioNome: operadorNome ?? null,
        detalhes: {
          operador: operador_id ?? session.id,
          modo: "pick-oc",
        },
      })),
    ).catch(() => {});

    logger.info(LOG_SOURCE, "Separação OC concluída", { separados, pendentes });

    return NextResponse.json({ separados, pendentes });
  } catch (err) {
    logger.logError({
      error: err,
      source: LOG_SOURCE,
      message: "Unexpected error in concluir-oc",
      category: "unknown",
      requestPath: "/api/separacao/concluir-oc",
      requestMethod: "POST",
      metadata: { pedido_ids },
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
