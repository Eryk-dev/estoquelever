import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { criarMarcadoresPedido } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";

const LOG_SOURCE = "admin-backfill-lvr";

/**
 * POST /api/admin/backfill-lvr
 *
 * One-time backfill: insere o marcador "LVR" no Tiny em todos os pedidos
 * que estão em status "pendente" (aguardando decisão do operador SISO) e
 * atualiza a coluna `marcadores` no DB para incluir "LVR".
 *
 * Admin-only. Sequencial com delay entre chamadas para respeitar rate limit do Tiny.
 *
 * Query params:
 *   - limit: máx de pedidos por execução (default 50, max 500)
 *   - dryrun: "true" → lista sem modificar
 *
 * Retorna: { total, processed, skipped, errors, pedidos }
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
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 500);
  const dryrun = url.searchParams.get("dryrun") === "true";

  const supabase = createServiceClient();

  const { data: pedidos, error } = await supabase
    .from("siso_pedidos")
    .select("id, numero, marcadores, empresa_origem_id")
    .eq("status", "pendente")
    .not("empresa_origem_id", "is", null)
    .order("criado_em", { ascending: true })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({ total: 0, message: "Nenhum pedido pendente elegível" });
  }

  if (dryrun) {
    return NextResponse.json({
      dryrun: true,
      total: pedidos.length,
      pedidos: pedidos.map((p) => ({
        id: p.id,
        numero: p.numero,
        marcadores: p.marcadores ?? [],
        jaTemLvr: (p.marcadores ?? []).includes("LVR"),
      })),
    });
  }

  logger.info(LOG_SOURCE, "Iniciando backfill LVR", {
    total: pedidos.length,
    usuario: session.nome,
  });

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const results: Array<{ id: string; numero: string; status: string; erro?: string }> = [];

  for (const pedido of pedidos) {
    try {
      const marcadoresAtuais: string[] = pedido.marcadores ?? [];
      const jaTemLvr = marcadoresAtuais.includes("LVR");

      if (!pedido.empresa_origem_id) {
        skipped++;
        results.push({ id: pedido.id, numero: pedido.numero, status: "skip-sem-empresa" });
        continue;
      }

      const { token } = await getValidTokenByEmpresa(pedido.empresa_origem_id);

      try {
        await runWithEmpresa(pedido.empresa_origem_id, () =>
          criarMarcadoresPedido(token, pedido.id, ["LVR"]),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("400")) throw err;
        logger.info(LOG_SOURCE, "LVR já existe no Tiny (idempotente)", { pedidoId: pedido.id });
      }

      if (!jaTemLvr) {
        await supabase
          .from("siso_pedidos")
          .update({ marcadores: [...marcadoresAtuais, "LVR"] })
          .eq("id", pedido.id);
      }

      processed++;
      results.push({
        id: pedido.id,
        numero: pedido.numero,
        status: jaTemLvr ? "tiny-ok-db-ok" : "tiny-ok-db-atualizado",
      });
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: pedido.id, numero: pedido.numero, status: "erro", erro: msg });
      logger.error(LOG_SOURCE, "Erro no backfill LVR", {
        pedidoId: pedido.id,
        numero: pedido.numero,
        error: msg,
      });
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  logger.info(LOG_SOURCE, "Backfill LVR concluído", {
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
