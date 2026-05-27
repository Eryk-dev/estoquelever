import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase-server";
import { processWebhook } from "@/lib/webhook-processor";
import { getEmpresaByCnpj, getEmpresaById } from "@/lib/empresa-lookup";
import { logger } from "@/lib/logger";
import { requireAdmin } from "@/lib/wms/auth";

/**
 * POST /api/wms/webhook/reprocessar
 *
 * Reprocesses a SINGLE failed webhook log identified by `pedidoId` (the
 * `tiny_pedido_id` text column in siso_webhook_logs). Admin-only.
 *
 * Body schema: { pedidoId: string }
 *
 * Returns 404 if no matching log exists. Other pending webhooks are NOT
 * touched.
 */
const Body = z.object({
  pedidoId: z.string().min(1, "pedidoId obrigatório"),
});

export async function POST(req: NextRequest) {
  // Auth (finding 1.3 — admin only)
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let parsed: z.infer<typeof Body>;
  try {
    const raw = await req.json();
    parsed = Body.parse(raw);
  } catch (e) {
    const msg =
      e instanceof z.ZodError
        ? e.issues.map((er) => `${er.path.join(".")}: ${er.message}`).join("; ")
        : "body inválido";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { pedidoId } = parsed;
  const supabase = createServiceClient();

  const { data: log, error } = await supabase
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, cnpj, empresa_id")
    .eq("tiny_pedido_id", pedidoId)
    .eq("codigo_situacao", "aprovado")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!log) {
    return NextResponse.json(
      { error: `Nenhum webhook log encontrado pra pedidoId=${pedidoId}` },
      { status: 404 },
    );
  }

  logger.info("reprocessar", `Reprocessando 1 webhook`, { pedidoId, logId: log.id });

  try {
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
      return NextResponse.json(
        { error: "Empresa não encontrada", pedidoId },
        { status: 422 },
      );
    }
    if (!galpaoId) {
      const emp = await getEmpresaById(empresaId);
      galpaoId = emp?.galpaoId ?? null;
      grupoId = emp?.grupoId ?? null;
    }

    await processWebhook(log.id, log.tiny_pedido_id, empresaId, galpaoId!, grupoId);
    return NextResponse.json({ ok: true, pedidoId, logId: log.id });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : JSON.stringify(err);
    logger.error("reprocessar", `Reprocessamento falhou`, { pedidoId, err: msg });
    return NextResponse.json({ ok: false, pedidoId, error: msg }, { status: 500 });
  }
}
