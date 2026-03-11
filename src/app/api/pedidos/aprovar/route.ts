import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getEmpresaById } from "@/lib/empresa-lookup";
import { getEmpresasDoGrupo } from "@/lib/grupo-resolver";
import { processQueue } from "@/lib/execution-worker";
import { logger } from "@/lib/logger";
import { registrarEvento } from "@/lib/historico-service";

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

  // Fetch the order (include empresa_origem_id for queue job)
  const { data: pedido, error: fetchError } = await supabase
    .from("siso_pedidos")
    .select("id, filial_origem, empresa_origem_id, status")
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

  if (!pedido.empresa_origem_id) {
    return NextResponse.json(
      { error: "Pedido sem empresa_origem_id — reprocessar webhook" },
      { status: 422 },
    );
  }

  // Resolve empresa and galpão info
  const empresaOrigem = await getEmpresaById(pedido.empresa_origem_id);
  if (!empresaOrigem) {
    return NextResponse.json(
      { error: "Empresa de origem não encontrada" },
      { status: 404 },
    );
  }

  const filialOrigem = empresaOrigem.galpaoNome;

  // Determine empresa_id, filialExecucao, and separacao galpao based on decisao
  let empresaExecucaoId: string;
  let filialExecucao: string;
  let separacaoGalpaoId: string;

  if (decisao === "propria" || decisao === "oc") {
    empresaExecucaoId = pedido.empresa_origem_id;
    filialExecucao = filialOrigem;
    separacaoGalpaoId = empresaOrigem.galpaoId;
  } else {
    // transferencia: find a support empresa in another galpão
    const empresasDoGrupo = empresaOrigem.grupoId
      ? await getEmpresasDoGrupo(empresaOrigem.grupoId)
      : [];

    const empresaSuporte = empresasDoGrupo.find(
      (e) => e.galpaoId !== empresaOrigem.galpaoId,
    );

    if (empresaSuporte) {
      empresaExecucaoId = empresaSuporte.empresaId;
      filialExecucao = empresaSuporte.galpaoNome;
      separacaoGalpaoId = empresaSuporte.galpaoId;
    } else {
      // Fallback: use origin (worker will handle gracefully)
      empresaExecucaoId = pedido.empresa_origem_id;
      filialExecucao = filialOrigem;
      separacaoGalpaoId = empresaOrigem.galpaoId;
      logger.warn("aprovar", "Transferência sem empresa suporte — fallback para origem", {
        pedidoId,
        empresaOrigemId: pedido.empresa_origem_id,
      });
    }
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
      separacao_galpao_id: separacaoGalpaoId,
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

  // Enqueue execution job (with empresa_id for worker)
  const { error: queueError } = await supabase
    .from("siso_fila_execucao")
    .insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      filial_execucao: filialExecucao,
      empresa_id: empresaExecucaoId,
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

  registrarEvento({
    pedidoId,
    evento: "aprovado",
    usuarioId: operadorId,
    usuarioNome: operadorNome,
    detalhes: { decisao, filialExecucao, empresaExecucaoId },
  }).catch(() => {});

  logger.info("aprovar", "Pedido aprovado", {
    pedidoId,
    decisao,
    filialExecucao,
    empresaExecucaoId,
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
    empresaExecucaoId,
    status: "executando",
  });
}
