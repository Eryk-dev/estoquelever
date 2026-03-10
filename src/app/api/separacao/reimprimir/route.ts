import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { obterEtiquetasAgrupamento } from "@/lib/tiny-api";
import { enviarImpressao, resolverImpressora } from "@/lib/printnode";
import { buscarEImprimirEtiqueta } from "@/lib/etiqueta-service";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "separacao-reimprimir";

/**
 * POST /api/separacao/reimprimir
 *
 * Reprint a shipping label for a packed order.
 *
 * Headers: X-Session-Id
 * Body: { pedido_id: string }
 *
 * Flow:
 *   1. If etiqueta_url cached → try print directly
 *   2. If print fails (URL expired) → refetch via agrupamento_expedicao_id
 *   3. If no agrupamento_expedicao_id → full flow via buscarEImprimirEtiqueta
 */
export async function POST(request: NextRequest) {
  // 1. Validate session
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  // 2. Parse body
  const body = await request.json().catch(() => null);
  if (!body?.pedido_id || typeof body.pedido_id !== "string") {
    return NextResponse.json(
      { error: "campo 'pedido_id' é obrigatório" },
      { status: 400 },
    );
  }

  const pedidoId: string = body.pedido_id;
  const supabase = createServiceClient();

  // 3. Fetch pedido
  const { data: pedido, error: fetchErr } = await supabase
    .from("siso_pedidos")
    .select(
      "id, numero, empresa_origem_id, separacao_galpao_id, agrupamento_expedicao_id, etiqueta_url, etiqueta_status, status_separacao, separacao_operador_id",
    )
    .eq("id", pedidoId)
    .single();

  if (fetchErr || !pedido) {
    return NextResponse.json({ error: "pedido_nao_encontrado" }, { status: 404 });
  }

  // 4. Validate pedido belongs to operator's galpão
  if (session.cargo !== "admin" && pedido.separacao_galpao_id !== session.galpaoId) {
    return NextResponse.json({ error: "acesso_negado" }, { status: 403 });
  }

  // 5. Validate status_separacao
  if (pedido.status_separacao !== "embalado") {
    return NextResponse.json(
      { error: "pedido_nao_embalado", status_separacao: pedido.status_separacao },
      { status: 400 },
    );
  }

  // 6. Resolve printer
  const printNodeApiKey = process.env.PRINTNODE_API_KEY;
  if (!printNodeApiKey) {
    logger.error(LOG_SOURCE, "PRINTNODE_API_KEY não configurada");
    return NextResponse.json({ status: "falhou", error: "impressora_nao_configurada" }, { status: 500 });
  }

  const galpaoId = pedido.separacao_galpao_id;
  if (!galpaoId) {
    return NextResponse.json({ status: "falhou", error: "galpao_nao_definido" }, { status: 400 });
  }

  const printer = await resolverImpressora(pedido.separacao_operador_id ?? session.id, galpaoId);
  if (!printer) {
    await setStatus(supabase, pedidoId, "falhou");
    logger.warn(LOG_SOURCE, "Nenhuma impressora configurada", { pedidoId, galpaoId });
    return NextResponse.json({ status: "falhou", error: "impressora_nao_encontrada" }, { status: 400 });
  }

  try {
    // 7. Attempt to print using cached URL
    if (pedido.etiqueta_url) {
      try {
        const { jobId } = await enviarImpressao({
          apiKey: printNodeApiKey,
          printerId: printer.printerId,
          pdfUrl: pedido.etiqueta_url,
          titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId} (reimpressão)`,
        });

        await setStatus(supabase, pedidoId, "impresso");
        logger.info(LOG_SOURCE, "Reimpressão com URL cacheada", { pedidoId, jobId: String(jobId) });
        return NextResponse.json({ status: "impresso", jobId });
      } catch {
        // URL may have expired — try to refetch below
        logger.warn(LOG_SOURCE, "URL cacheada falhou, tentando refetch", { pedidoId });
      }
    }

    // 8. Refetch label URL via agrupamento_expedicao_id
    if (pedido.agrupamento_expedicao_id && pedido.empresa_origem_id) {
      try {
        const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);
        const etiquetas = await obterEtiquetasAgrupamento(token, parseInt(pedido.agrupamento_expedicao_id, 10));

        if (etiquetas.urls && etiquetas.urls.length > 0) {
          const newUrl = etiquetas.urls[0];

          // Update cached URL
          await supabase
            .from("siso_pedidos")
            .update({ etiqueta_url: newUrl })
            .eq("id", pedidoId);

          const { jobId } = await enviarImpressao({
            apiKey: printNodeApiKey,
            printerId: printer.printerId,
            pdfUrl: newUrl,
            titulo: `Etiqueta Pedido #${pedido.numero ?? pedidoId} (reimpressão)`,
          });

          await setStatus(supabase, pedidoId, "impresso");
          logger.info(LOG_SOURCE, "Reimpressão com URL refetchada", { pedidoId, jobId: String(jobId) });
          return NextResponse.json({ status: "impresso", jobId });
        }
      } catch (err) {
        logger.warn(LOG_SOURCE, "Refetch via agrupamento falhou", {
          pedidoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 9. Full flow fallback via buscarEImprimirEtiqueta
    await buscarEImprimirEtiqueta(pedidoId);

    // Check if it succeeded
    const { data: updated } = await supabase
      .from("siso_pedidos")
      .select("etiqueta_status")
      .eq("id", pedidoId)
      .single();

    if (updated?.etiqueta_status === "impresso") {
      logger.info(LOG_SOURCE, "Reimpressão via fluxo completo", { pedidoId });
      return NextResponse.json({ status: "impresso" });
    }

    await setStatus(supabase, pedidoId, "falhou");
    return NextResponse.json({ status: "falhou", error: "etiqueta_nao_disponivel" }, { status: 500 });
  } catch (err) {
    await setStatus(supabase, pedidoId, "falhou");
    logger.error(LOG_SOURCE, "Erro ao reimprimir", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ status: "falhou", error: "erro_interno" }, { status: 500 });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof createServiceClient>;

async function setStatus(
  supabase: SupabaseClient,
  pedidoId: string,
  status: "impresso" | "falhou",
): Promise<void> {
  await supabase
    .from("siso_pedidos")
    .update({ etiqueta_status: status })
    .eq("id", pedidoId);
}
