import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { processQueue } from "@/lib/execution-worker";
import { logger } from "@/lib/logger";

type Filial = "CWB" | "SP";
type Decisao = "propria" | "transferencia" | "oc";

/**
 * POST /api/pedidos/aprovar
 *
 * Operator approves a pending order with a decision.
 * Saves the decision, enqueues a stock-posting job, and kicks the worker.
 *
 * Body: { pedidoId, decisao, operadorId?, operadorNome? }
 */
export async function POST(request: NextRequest) {
  let body: {
    pedidoId?: string;
    decisao?: Decisao;
    operadorId?: string;
    operadorNome?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedidoId, decisao, operadorId, operadorNome } = body;

  if (!pedidoId || !decisao) {
    return NextResponse.json(
      { error: "pedidoId e decisao são obrigatórios" },
      { status: 400 },
    );
  }

  const validDecisoes: Decisao[] = ["propria", "transferencia", "oc"];
  if (!validDecisoes.includes(decisao)) {
    return NextResponse.json(
      { error: `Decisão inválida. Use: ${validDecisoes.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Fetch the order
  const { data: pedido, error: fetchError } = await supabase
    .from("siso_pedidos")
    .select("id, filial_origem, status")
    .eq("id", pedidoId)
    .single();

  if (fetchError || !pedido) {
    return NextResponse.json(
      { error: "Pedido não encontrado" },
      { status: 404 },
    );
  }

  if (pedido.status !== "pendente") {
    return NextResponse.json(
      { error: `Pedido não está pendente (status: ${pedido.status})` },
      { status: 409 },
    );
  }

  const filialOrigem: Filial = pedido.filial_origem;

  // Determine which branch executes stock posting
  let filialExecucao: Filial;
  if (decisao === "propria") {
    filialExecucao = filialOrigem;
  } else if (decisao === "transferencia") {
    // Stock is in support branch, but order lives in origin.
    // Worker will mark as done without API call (manual handling).
    filialExecucao = filialOrigem === "CWB" ? "SP" : "CWB";
  } else {
    // OC — use origin as placeholder (worker skips API call)
    filialExecucao = filialOrigem;
  }

  // Build markers
  const marcadores: string[] =
    decisao === "oc" ? ["OC", filialOrigem] : [filialExecucao];

  // Update order to "executando"
  const { error: updateError } = await supabase
    .from("siso_pedidos")
    .update({
      status: "executando",
      decisao_final: decisao,
      operador_id: operadorId ?? null,
      operador_nome: operadorNome ?? null,
      tipo_resolucao: "manual",
      marcadores,
    })
    .eq("id", pedidoId);

  if (updateError) {
    logger.error("aprovar", "Failed to update order", {
      pedidoId,
      supabaseError: updateError.message,
    });
    return NextResponse.json(
      { error: updateError.message },
      { status: 500 },
    );
  }

  // Enqueue execution job
  const { error: queueError } = await supabase
    .from("siso_fila_execucao")
    .insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      filial_execucao: filialExecucao,
      decisao,
      operador_id: operadorId ?? null,
      operador_nome: operadorNome ?? null,
    });

  if (queueError) {
    logger.error("aprovar", "Failed to enqueue job", {
      pedidoId,
      decisao,
      supabaseError: queueError.message,
    });
    // Don't fail — the order status is already updated
  }

  logger.info("aprovar", "Pedido aprovado", {
    pedidoId,
    decisao,
    filialExecucao,
    operador: operadorNome,
  });

  // Kick the worker immediately (fire-and-forget)
  processQueue(1).catch((err) => {
    logger.error("aprovar", "Worker kick failed", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return NextResponse.json({
    ok: true,
    pedidoId,
    decisao,
    filialExecucao,
    status: "executando",
  });
}
