import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/monitoring
 *
 * Returns operational stats for the SISO monitoring dashboard:
 * - Order counts today by status
 * - Webhook stats for the last 24 hours
 * - Recent error logs (last 10)
 * - System health indicators
 */
export async function GET() {
  try {
    const supabase = createServiceClient();
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const todayIso = startOfToday.toISOString();
    const yesterdayIso = yesterday.toISOString();

    // ── 1. Orders today by status ────────────────────────────────────────────
    const { data: pedidosHoje } = await supabase
      .from("siso_pedidos")
      .select("status, processado_em")
      .gte("processado_em", todayIso);

    const ordersByStatus = {
      pendente: 0,
      concluido: 0,
      cancelado: 0,
      erro: 0,
    };

    for (const p of pedidosHoje ?? []) {
      const s = p.status as keyof typeof ordersByStatus;
      if (s in ordersByStatus) {
        ordersByStatus[s]++;
      }
    }

    // Also count pedidos created today that are still pending (processado_em may be null)
    const { data: pedidosPendentesHoje } = await supabase
      .from("siso_pedidos")
      .select("id")
      .eq("status", "pendente")
      .gte("created_at", todayIso);

    // Merge: pendentes created today (processado_em is null so not counted above)
    ordersByStatus.pendente = (pedidosPendentesHoje ?? []).length;

    const totalOrders = Object.values(ordersByStatus).reduce((a, b) => a + b, 0);

    // ── 2. Webhook stats last 24h ────────────────────────────────────────────
    const { data: webhookLogs } = await supabase
      .from("siso_webhook_logs")
      .select("status, criado_em, processado_em")
      .gte("criado_em", yesterdayIso);

    const webhookStats = {
      received: (webhookLogs ?? []).length,
      processed: 0,
      errors: 0,
      duplicates: 0,
    };

    for (const w of webhookLogs ?? []) {
      if (w.status === "concluido") webhookStats.processed++;
      else if (w.status === "erro") webhookStats.errors++;
      else if (w.status === "duplicado") webhookStats.duplicates++;
    }

    // Processing times (only completed entries with both timestamps)
    const processingTimes: number[] = [];
    for (const w of webhookLogs ?? []) {
      if (w.status === "concluido" && w.processado_em && w.criado_em) {
        const ms =
          new Date(w.processado_em).getTime() -
          new Date(w.criado_em).getTime();
        if (ms > 0) processingTimes.push(ms);
      }
    }
    const avgProcessingMs =
      processingTimes.length > 0
        ? Math.round(
            processingTimes.reduce((a, b) => a + b, 0) /
              processingTimes.length,
          )
        : null;

    // Webhook throughput per hour (last 24h, 24 buckets)
    const hourlyBuckets: Record<string, number> = {};
    for (let h = 0; h < 24; h++) {
      const d = new Date(now.getTime() - h * 60 * 60 * 1000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
      hourlyBuckets[key] = 0;
    }
    for (const w of webhookLogs ?? []) {
      if (!w.criado_em) continue;
      const d = new Date(w.criado_em);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
      if (key in hourlyBuckets) {
        hourlyBuckets[key]++;
      }
    }
    // Return as ordered array (oldest first)
    const webhookThroughput = Object.entries(hourlyBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, count]) => ({ hour, count }));

    // ── 3. Recent errors (last 10) ───────────────────────────────────────────
    const { data: recentErrors } = await supabase
      .from("siso_logs")
      .select("id, timestamp, source, message, metadata, pedido_id, filial")
      .eq("level", "error")
      .order("timestamp", { ascending: false })
      .limit(10);

    // ── 4. System health ─────────────────────────────────────────────────────
    const { data: lastWebhook } = await supabase
      .from("siso_webhook_logs")
      .select("criado_em, status")
      .order("criado_em", { ascending: false })
      .limit(1)
      .single();

    const { data: lastSuccess } = await supabase
      .from("siso_webhook_logs")
      .select("processado_em")
      .eq("status", "concluido")
      .order("processado_em", { ascending: false })
      .limit(1)
      .single();

    const errorRate =
      webhookStats.received > 0
        ? Math.round((webhookStats.errors / webhookStats.received) * 100)
        : 0;

    return NextResponse.json({
      generatedAt: now.toISOString(),
      orders: {
        today: ordersByStatus,
        total: totalOrders,
      },
      webhooks: {
        last24h: webhookStats,
        avgProcessingMs,
        throughputPerHour: webhookThroughput,
        errorRate,
      },
      recentErrors: recentErrors ?? [],
      health: {
        lastWebhookReceivedAt: lastWebhook?.criado_em ?? null,
        lastSuccessfulProcessingAt: lastSuccess?.processado_em ?? null,
        status:
          errorRate >= 50
            ? "degraded"
            : errorRate >= 20
              ? "warning"
              : "healthy",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
