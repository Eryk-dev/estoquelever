import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { criarAgrupamentoFase1 } from "@/lib/agrupamento-service";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "admin-backfill-agrupamentos";

/**
 * POST /api/admin/backfill-agrupamentos
 *
 * One-time backfill: create fase-1 agrupamentos for pedidos that already
 * have NF (nota_fiscal_id + chave_acesso_nf) but no agrupamento yet.
 *
 * Admin-only. Processes sequentially with a delay between each to respect
 * Tiny API rate limits.
 *
 * Query params:
 *   - limit: max pedidos to process (default 20)
 *   - dryrun: if "true", only list eligible pedidos without creating agrupamentos
 *
 * Returns: { total, processed, skipped, errors, pedidos }
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 200);
  const dryrun = url.searchParams.get("dryrun") === "true";

  const supabase = createServiceClient();

  // Find eligible pedidos: have NF, no agrupamento, pre-embalado
  const { data: pedidos, error } = await supabase
    .from("siso_pedidos")
    .select("id, numero, status_separacao, empresa_origem_id")
    .not("nota_fiscal_id", "is", null)
    .not("chave_acesso_nf", "is", null)
    .or("agrupamento_expedicao_id.is.null,agrupamento_expedicao_id.eq.pending")
    .in("status_separacao", [
      "aguardando_compra",
      "validacao_oc",
      "aguardando_nf",
      "aguardando_separacao",
      "em_separacao",
      "separado",
    ])
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({ total: 0, message: "Nenhum pedido elegível" });
  }

  if (dryrun) {
    return NextResponse.json({
      dryrun: true,
      total: pedidos.length,
      pedidos: pedidos.map((p) => ({
        id: p.id,
        numero: p.numero,
        status_separacao: p.status_separacao,
      })),
    });
  }

  logger.info(LOG_SOURCE, "Iniciando backfill de agrupamentos", {
    total: pedidos.length,
    usuario: session.nome,
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const results: Array<{ id: string; numero: string; status: string }> = [];

  for (const pedido of pedidos) {
    try {
      await criarAgrupamentoFase1(pedido.id);

      // Check if agrupamento was actually created
      const { data: check } = await supabase
        .from("siso_pedidos")
        .select("agrupamento_expedicao_id")
        .eq("id", pedido.id)
        .single();

      const created =
        check?.agrupamento_expedicao_id &&
        check.agrupamento_expedicao_id !== "pending";

      if (created) {
        processed++;
        results.push({ id: pedido.id, numero: pedido.numero, status: "criado" });
      } else {
        skipped++;
        results.push({ id: pedido.id, numero: pedido.numero, status: "skip" });
      }
    } catch (err) {
      errors++;
      results.push({ id: pedido.id, numero: pedido.numero, status: "erro" });
      logger.error(LOG_SOURCE, "Erro no backfill", {
        pedidoId: pedido.id,
        numero: pedido.numero,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Rate limit: 2s between each to respect Tiny API limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  logger.info(LOG_SOURCE, "Backfill concluído", {
    total: pedidos.length,
    processed,
    skipped,
    errors,
    usuario: session.nome,
  });

  return NextResponse.json({
    total: pedidos.length,
    processed,
    skipped,
    errors,
    pedidos: results,
  });
}
