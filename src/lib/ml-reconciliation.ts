import { randomUUID } from "node:crypto";
import { createServiceClient } from "./supabase-server";
import { getMlReconciliationEvidence } from "./ml-reconciliation-api";
import { classifyMlReconciliation, isBellator, type ReconciliationSnapshot } from "./ml-reconciliation-policy";
import { logger } from "./logger";

const SOURCE = "ml-reconciliation";
const BUDGET_MS = 180_000;
type Connection = { id: string; empresa_id: string; ml_user_id: number | string };

export async function reconcileMlOrders(options: {
  runId?: string; dryRun?: boolean; limitPerLane?: number;
} = {}) {
  const sb = createServiceClient();
  const runId = options.runId ?? randomUUID();
  const deadline = Date.now() + BUDGET_MS;
  const limit = Math.max(1, Math.min(options.limitPerLane ?? 60, 100));
  const { data: companies, error: companyError } = await sb
    .from("siso_empresas").select("id,nome").eq("ativo", true).eq("ml_reconciliacao_ativa", true);
  if (companyError) throw new Error(companyError.message);
  const allowed = (companies ?? []).filter(e => !isBellator(e.nome));
  const ids = allowed.map(e => e.id);
  if (!ids.length) return { runId, companies: [] };
  const { data: connections, error: connectionError } = await sb
    .from("siso_ml_connections").select("id,empresa_id,ml_user_id")
    .eq("ativo", true).in("empresa_id", ids);
  if (connectionError) throw new Error(connectionError.message);
  // More than one active credential for a company is ambiguous; fail closed.
  const unique = (connections as Connection[] ?? []).filter(c =>
    connections!.filter(other => other.empresa_id === c.empresa_id).length === 1);

  const summaries = await Promise.all(unique.map(async connection => {
    const summary = {
      empresa_id: connection.empresa_id,
      empresa: allowed.find(e => e.id === connection.empresa_id)?.nome,
      checked: 0, changed: 0, conflicts: 0, errors: 0, deferred: 0,
      targets: {} as Record<string, number>,
    };
    const claimed: ReconciliationSnapshot[][] = [];
    try {
      // Separate quotas keep old conferidos from starving today's picking/dispatch.
      for (const lane of ["early", "dispatch", "archive"]) {
        const { data, error } = await sb.rpc("siso_ml_reconciliacao_claim", {
          p_empresa_id: connection.empresa_id, p_run_id: runId, p_lane: lane,
          p_limit: lane === "archive" ? Math.min(limit, 20) : limit,
        });
        if (error) throw new Error(error.message);
        claimed.push((data ?? []) as ReconciliationSnapshot[]);
      }
      // Interleave lanes so the time budget cannot repeatedly skip the last lane.
      const rows: ReconciliationSnapshot[] = [];
      for (let i = 0; i < Math.max(0, ...claimed.map(lane => lane.length)); i++) {
        for (const lane of claimed) if (lane[i]) rows.push(lane[i]);
      }
      let consecutiveFailures = 0;
      let circuitOpen = false;
      for (const snapshot of rows) {
        if (Date.now() >= deadline || circuitOpen) { summary.deferred++; continue; }
        let evidence = null;
        let decision = null;
        let failure: string | null = null;
        try {
          evidence = await getMlReconciliationEvidence({
            connectionId: connection.id, sellerId: String(connection.ml_user_id),
            orderId: snapshot.id_pedido_ecommerce, shipmentId: snapshot.ml_shipment_id,
          });
          decision = classifyMlReconciliation(snapshot, evidence);
          summary.checked++;
          consecutiveFailures = 0;
        } catch (error) {
          failure = (error instanceof Error ? error.message : String(error)).slice(0, 500);
          summary.errors++;
          consecutiveFailures++;
          circuitOpen = /ML API (401|403|429)\b/.test(failure) || consecutiveFailures >= 3;
        }
        const { data: result, error } = await sb.rpc("siso_ml_reconciliacao_finish", {
          p_pedido_id: snapshot.id, p_run_id: runId, p_snapshot: snapshot,
          p_target: decision?.target ?? null, p_reason: decision?.reason ?? "falha_consulta_ml",
          p_evidence: evidence, p_error: failure, p_dry_run: options.dryRun === true,
        });
        if (error) {
          summary.errors++;
          circuitOpen = true;
          logger.error(SOURCE, "Falha ao persistir conferência ML", { pedidoId: snapshot.id, error: error.message });
          continue;
        }
        if (result?.changed) summary.changed++;
        if (result?.conflict) summary.conflicts++;
        if (decision?.target && !failure) {
          summary.targets[decision.target] = (summary.targets[decision.target] ?? 0) + 1;
        }
      }
    } catch (error) {
      summary.errors++;
      logger.error(SOURCE, "Falha na conferência da empresa", {
        empresaId: connection.empresa_id, runId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Release unprocessed claims on budget exhaustion; crashes expire after 6min.
      const { error } = await sb.from("siso_ml_reconciliacao")
        .update({ lease_id: null, lease_until: null })
        .eq("lease_id", runId).eq("empresa_id", connection.empresa_id);
      if (error) summary.errors++;
    }
    return summary;
  }));
  const result = { runId, dryRun: !!options.dryRun, companies: summaries };
  logger.info(SOURCE, "Conferência automática ML concluída", result);
  return result;
}
