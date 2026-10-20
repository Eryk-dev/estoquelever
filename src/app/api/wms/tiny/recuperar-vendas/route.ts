import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/wms/auth";
import { createServiceClient } from "@/lib/supabase-server";
import { handleNfWebhook } from "@/lib/nf-webhook-handler";

export const maxDuration = 300;
const Empresa = z.string().uuid();
const Body = z.object({
  empresaId: Empresa,
  notas: z.array(z.number().int().positive().safe()).min(1).max(5),
});

/** Consulta não altera pedidos. Somente notas órfãs da empresa selecionada. */
export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const empresaId = Empresa.safeParse(new URL(req.url).searchParams.get("empresaId"));
  if (!empresaId.success) return NextResponse.json({ error: "Empresa inválida" }, { status: 400 });
  const { data, error } = await createServiceClient().from("siso_webhook_logs")
    .select("tiny_pedido_id").eq("empresa_id", empresaId.data).eq("tipo", "nota_fiscal")
    .eq("status", "aguardando_pedido").is("processado_em", null)
    .order("criado_em", { ascending: false }).limit(1000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const notas = [...new Set((data ?? []).map((r) => Number(r.tiny_pedido_id)))]
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return NextResponse.json({ notas, truncado: data?.length === 1000 });
}

/** Lotes pequenos; o mesmo método é chamado automaticamente pelo webhook/poll. */
export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Informe empresa e até 5 notas" }, { status: 400 });
  const sb = createServiceClient();
  const { empresaId, notas } = body.data;
  const { data: empresa, error: empresaError } = await sb.from("siso_empresas")
    .select("cnpj").eq("id", empresaId).eq("ativo", true).maybeSingle();
  if (empresaError) return NextResponse.json({ error: empresaError.message }, { status: 500 });
  if (!empresa) return NextResponse.json({ error: "Empresa não encontrada ou inativa" }, { status: 404 });
  const resultados = [];
  for (const nota of [...new Set(notas)]) {
    try {
      const { data: log, error: logError } = await sb.from("siso_webhook_logs")
        .select("id, status").eq("empresa_id", empresaId).eq("tipo", "nota_fiscal")
        .eq("tiny_pedido_id", String(nota)).maybeSingle();
      if (logError) throw logError;
      if (!log) {
        resultados.push({ nota, status: "não encontrada nesta empresa" });
        continue;
      }
      if (log.status === "aguardando_pedido") {
        await handleNfWebhook({
          cnpj: empresa.cnpj, tipo: "nota_fiscal",
          dados: { idNotaFiscalTiny: nota },
        }, empresaId, { aguardarFase1: true });
      }
      const { data: atual, error } = await sb.from("siso_webhook_logs")
        .select("status").eq("id", log.id).single();
      if (error) throw error;
      resultados.push({ nota, status: atual.status });
    } catch (err) {
      resultados.push({ nota, status: "erro", erro: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ resultados });
}
