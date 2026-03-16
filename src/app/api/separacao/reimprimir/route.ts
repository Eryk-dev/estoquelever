import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { enviarImpressaoZpl, resolverImpressora } from "@/lib/printnode";
import { getConfig } from "@/lib/config";
import { buscarEImprimirEtiqueta } from "@/lib/etiqueta-service";
import { splitZplLabels } from "@/lib/etiqueta-download";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "separacao-reimprimir";

/**
 * POST /api/separacao/reimprimir
 *
 * Print/reprint a shipping label.
 * Fast path: uses cached ZPL (instant).
 * Fallback: if no cache, delegates to buscarEImprimirEtiqueta which
 * creates agrupamento in Tiny, fetches ZPL, and prints.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.pedido_id || typeof body.pedido_id !== "string") {
    return NextResponse.json(
      { error: "campo 'pedido_id' é obrigatório" },
      { status: 400 },
    );
  }

  const pedidoId: string = body.pedido_id;
  const supabase = createServiceClient();

  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, numero, separacao_galpao_id, etiqueta_zpl, status_separacao, separacao_operador_id",
    )
    .eq("id", pedidoId)
    .single();

  if (fetchErr || !pedido) {
    return NextResponse.json({ error: "pedido_nao_encontrado" }, { status: 404 });
  }

  if (!session.cargos.includes("admin") && pedido.separacao_galpao_id !== session.galpaoId) {
    return NextResponse.json({ error: "acesso_negado" }, { status: 403 });
  }

  if (pedido.status_separacao !== "embalado") {
    return NextResponse.json(
      { error: "pedido_nao_embalado", status_separacao: pedido.status_separacao },
      { status: 400 },
    );
  }

  // No cached ZPL — use full flow (create agrupamento + fetch from Tiny)
  if (!pedido.etiqueta_zpl) {
    logger.info(LOG_SOURCE, "ZPL não cacheado, usando fluxo completo", { pedidoId });
    await buscarEImprimirEtiqueta(pedidoId);

    // Check if print succeeded (etiqueta_zpl gets cached on success)
    const { data: check } = await supabase
      .from("siso_pedidos")
      .select("etiqueta_zpl")
      .eq("id", pedidoId)
      .single();

    return NextResponse.json({ status: check?.etiqueta_zpl ? "impresso" : "falhou" });
  }

  const galpaoId = pedido.separacao_galpao_id;
  if (!galpaoId) {
    return NextResponse.json({ status: "falhou", error: "galpao_nao_definido" }, { status: 400 });
  }

  // Resolve API key + printer in parallel
  const [printNodeApiKey, printer] = await Promise.all([
    getConfig("PRINTNODE_API_KEY"),
    resolverImpressora(pedido.separacao_operador_id ?? session.id, galpaoId),
  ]);

  if (!printNodeApiKey) {
    logger.error(LOG_SOURCE, "PRINTNODE_API_KEY não configurada");
    return NextResponse.json({ status: "falhou", error: "impressora_nao_configurada" }, { status: 500 });
  }

  if (!printer) {
    logger.warn(LOG_SOURCE, "Nenhuma impressora configurada", { pedidoId, galpaoId });
    return NextResponse.json({ status: "falhou", error: "impressora_nao_encontrada" }, { status: 400 });
  }

  try {
    // Safety: ensure we only print one label even if multiple were cached
    const singleLabel = splitZplLabels(pedido.etiqueta_zpl)[0] ?? pedido.etiqueta_zpl;

    const { jobId } = await enviarImpressaoZpl({
      apiKey: printNodeApiKey,
      printerId: printer.printerId,
      zpl: singleLabel,
      titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId} (reimpressão)`,
    });

    // Fire-and-forget status update — operator already got the print
    supabase.rpc("siso_set_etiqueta_status", {
      p_pedido_id: pedidoId,
      p_status: "impresso",
    }).then(() => {}, () => {});

    logger.info(LOG_SOURCE, "Reimpressão via cache", { pedidoId, jobId: String(jobId) });
    return NextResponse.json({ status: "impresso", jobId });
  } catch (err) {
    // Fire-and-forget status update on error
    supabase.rpc("siso_set_etiqueta_status", {
      p_pedido_id: pedidoId,
      p_status: "falhou",
    }).then(() => {}, () => {});

    logger.error(LOG_SOURCE, "Erro ao reimprimir", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ status: "falhou", error: "erro_interno" }, { status: 500 });
  }
}
