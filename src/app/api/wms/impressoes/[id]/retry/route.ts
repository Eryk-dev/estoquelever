import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { enviarImpressaoZpl } from "@/lib/printnode";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/impressoes/[id]/retry
 *
 * Reenvia o mesmo payload ZPL pra mesma impressora. Atualiza status
 * pra 'sucesso' ou 'erro' (overwrite). Idempotente: status='sucesso'
 * retorna 409 (use Browse/View pra confirmar).
 *
 * Resolve a api_key da printnode_account_id armazenada no log.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.imprimir")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const sb = createServiceClient();

  const { data: log, error: fetchErr } = await sb
    .from("siso_impressoes_log")
    .select(
      "id, printer_id, payload_zpl, status, printnode_account_id, contexto",
    )
    .eq("id", id)
    .single();

  if (fetchErr || !log) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (log.status === "sucesso") {
    return NextResponse.json({ error: "ja_sucesso" }, { status: 409 });
  }

  // Resolve api_key: se temos printnode_account_id, busca dela; senão
  // usa a primeira conta ativa (fallback histórico).
  let apiKey: string | null = null;
  if (log.printnode_account_id) {
    const { data: conta } = await sb
      .from("siso_printnode_contas")
      .select("api_key, ativo")
      .eq("id", log.printnode_account_id)
      .single();
    if (conta?.ativo) apiKey = (conta as { api_key: string }).api_key;
  }
  if (!apiKey) {
    const { data: contas } = await sb
      .from("siso_printnode_contas")
      .select("api_key")
      .eq("ativo", true)
      .limit(1);
    if (contas && contas[0]) apiKey = (contas[0] as { api_key: string }).api_key;
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "nenhuma conta PrintNode ativa pra retry" },
      { status: 500 },
    );
  }

  try {
    const { jobId } = await enviarImpressaoZpl({
      apiKey,
      printerId: log.printer_id as number,
      zpl: log.payload_zpl as string,
      titulo: `RETRY ${log.contexto ?? "manual"} ${id.slice(0, 8)}`,
    });
    await sb
      .from("siso_impressoes_log")
      .update({
        printnode_job_id: jobId,
        status: "sucesso",
        erro_msg: null,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", id);
    return NextResponse.json({ ok: true, job_id: jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb
      .from("siso_impressoes_log")
      .update({
        status: "erro",
        erro_msg: msg,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", id);
    logger.warn("wms.impressoes.retry", "retry falhou", { id, msg });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
