import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { processWebhook } from "@/lib/webhook-processor";
import { getEmpresaByCnpj } from "@/lib/empresa-lookup";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhook/reprocessar
 *
 * Reprocesses failed webhook logs (status = 'pendente' after reset).
 * Used to retry orders that failed due to bugs that have since been fixed.
 */
export async function POST() {
  const supabase = createServiceClient();

  const { data: logs, error } = await supabase
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, cnpj, empresa_id")
    .eq("codigo_situacao", "aprovado")
    .eq("status", "pendente")
    .order("criado_em", { ascending: true });

  if (error || !logs?.length) {
    return NextResponse.json({ message: "Nenhum webhook pendente para reprocessar", count: 0 });
  }

  logger.info("reprocessar", `Reprocessando ${logs.length} webhooks`, {
    pedidoIds: logs.map((l) => l.tiny_pedido_id),
  });

  const results: { pedidoId: string; status: string; erro?: string }[] = [];

  for (const log of logs) {
    try {
      // Resolve empresa from CNPJ or stored empresa_id
      let empresaId = log.empresa_id as string | null;
      let galpaoId: string | null = null;
      let grupoId: string | null = null;

      if (!empresaId && log.cnpj) {
        const empresa = await getEmpresaByCnpj(log.cnpj);
        if (empresa) {
          empresaId = empresa.empresaId;
          galpaoId = empresa.galpaoId;
          grupoId = empresa.grupoId;
        }
      }

      if (!empresaId) {
        results.push({ pedidoId: log.tiny_pedido_id, status: "erro", erro: "Empresa não encontrada" });
        continue;
      }

      if (!galpaoId) {
        const { getEmpresaById } = await import("@/lib/empresa-lookup");
        const emp = await getEmpresaById(empresaId);
        galpaoId = emp?.galpaoId ?? null;
        grupoId = emp?.grupoId ?? null;
      }

      await processWebhook(log.id, log.tiny_pedido_id, empresaId, galpaoId!, grupoId);
      results.push({ pedidoId: log.tiny_pedido_id, status: "ok" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ pedidoId: log.tiny_pedido_id, status: "erro", erro: msg });
    }
  }

  return NextResponse.json({ reprocessed: results.length, results });
}
