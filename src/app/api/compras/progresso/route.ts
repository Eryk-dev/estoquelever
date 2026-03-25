import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { hasComprasAccess } from "@/lib/compras-utils";

/**
 * GET /api/compras/progresso?pedidos=id1,id2,id3
 *
 * Returns processing status for each pedido after receiving.
 * Used for polling (every 2-3s) to show progress bar.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }
  if (!hasComprasAccess(session.cargos)) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const pedidosParam = searchParams.get("pedidos");
  if (!pedidosParam) {
    return NextResponse.json(
      { error: "Parâmetro pedidos obrigatório" },
      { status: 400 },
    );
  }

  const pedidoIds = pedidosParam.split(",").filter(Boolean);
  if (pedidoIds.length === 0) {
    return NextResponse.json({ concluido: true, pedidos: [] });
  }

  const supabase = createServiceClient();

  // Fetch pedidos status
  const { data: pedidos } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status, status_separacao, etiqueta_status")
    .in("id", pedidoIds);

  // Fetch queue status for these pedidos
  const { data: filaJobs } = await supabase
    .from("siso_fila_execucao")
    .select("pedido_id, status, tipo")
    .in("pedido_id", pedidoIds)
    .order("criado_em", { ascending: false });

  const result = pedidoIds.map((pedidoId) => {
    const pedido = pedidos?.find((p) => p.id === pedidoId);
    const jobs = filaJobs?.filter((j) => j.pedido_id === pedidoId) ?? [];
    const latestJob = jobs[0];

    if (!pedido) {
      return { pedido_id: pedidoId, numero: "?", status: "erro" as const, etapa: "Pedido não encontrado" };
    }

    // If pedido moved past compra flow (aguardando_separacao or beyond), it's done
    if (
      pedido.status_separacao === "aguardando_separacao" ||
      pedido.status_separacao === "em_separacao" ||
      pedido.status_separacao === "separado" ||
      pedido.status_separacao === "embalado"
    ) {
      return {
        pedido_id: pedidoId,
        numero: pedido.numero,
        status: "pronto" as const,
        etapa: "Pronto para embalagem",
      };
    }

    // If job failed
    if (latestJob?.status === "erro" || latestJob?.status === "falhou") {
      return {
        pedido_id: pedidoId,
        numero: pedido.numero,
        status: "erro" as const,
        etapa: "Falha no processamento",
      };
    }

    // Still processing
    let etapa = "Na fila...";
    if (latestJob?.status === "executando") {
      etapa = "Processando...";
    }
    if (pedido.status_separacao === "aguardando_nf") {
      etapa = "Aguardando NF...";
    }

    return {
      pedido_id: pedidoId,
      numero: pedido.numero,
      status: "processando" as const,
      etapa,
    };
  });

  const concluido = result.every(
    (r) => r.status === "pronto" || r.status === "erro",
  );

  return NextResponse.json({
    concluido,
    pedidos: result,
    prontos: result.filter((r) => r.status === "pronto").map((r) => r.pedido_id),
    erros: result.filter((r) => r.status === "erro").map((r) => r.pedido_id),
  });
}
