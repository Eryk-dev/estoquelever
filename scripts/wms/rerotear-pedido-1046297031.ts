/**
 * One-off: re-roteia o pedido 1046297031 (preso em pendente/transferência)
 * pra própria. CWB reabasteceu 024497 (11 livres) → ele virou própria de
 * verdade, mas nada re-roteia pendente quando estoque chega.
 *
 * Sequência LIMPA (evita reserva-fantasma):
 *   1. solta a(s) R reserva_pedido ATIVA(s) do pedido (a de SP, 1 un.)
 *   2. reprocessa o webhook → re-rota (CWB→própria), cria R em CWB,
 *      auto-aprova própria (aguardando_nf + enfileira lancar_estoque)
 *   3. kicka o worker → emite a NF no Tiny
 *
 * ⚠️ EMITE NF REAL no Tiny. Rodar UMA vez. Abortado se já não estiver pendente.
 */
import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { estornarReservaIndividual } from "../../src/lib/wms/reservas";
import { processWebhook } from "../../src/lib/webhook-processor";
import { getEmpresaById } from "../../src/lib/empresa-lookup";
import { kickWorker } from "../../src/lib/execution-worker";

const PEDIDO_ID = "1046297031";

async function main() {
  const sb = createServiceClient();

  // 0. Sanity — pedido ainda pendente?
  const { data: ped } = await sb
    .from("siso_pedidos")
    .select("id, status, sugestao, decisao_final, empresa_origem_id, separacao_galpao_id")
    .eq("id", PEDIDO_ID)
    .maybeSingle();
  if (!ped) throw new Error(`pedido ${PEDIDO_ID} não encontrado`);
  console.log("ANTES:", ped);
  if (ped.status !== "pendente") {
    console.log(`status=${ped.status} (não pendente) — nada a fazer, abortando.`);
    return;
  }

  // 1. Solta as R reserva_pedido ATIVAS (sem L estorno) do pedido.
  const { data: rs } = await sb
    .from("siso_movimentacoes")
    .select("id")
    .eq("tipo", "R")
    .eq("origem_tipo", "reserva_pedido")
    .eq("origem_id", PEDIDO_ID);
  const rIds = (rs ?? []).map((r) => r.id as string);
  let liberadas = new Set<string>();
  if (rIds.length > 0) {
    const { data: libs } = await sb
      .from("siso_movimentacoes")
      .select("estorno_de")
      .eq("tipo", "L")
      .in("estorno_de", rIds);
    liberadas = new Set(
      (libs ?? []).map((l) => l.estorno_de as string).filter(Boolean),
    );
  }
  const ativas = rIds.filter((id) => !liberadas.has(id));
  console.log(`R reserva_pedido: ${rIds.length} total, ${ativas.length} ativa(s)`);
  for (const id of ativas) {
    await estornarReservaIndividual({ reserva_id: id, motivo: "outro" });
    console.log(`  ✓ liberada R ${id}`);
  }

  // 2. Webhook log aprovado do pedido.
  const { data: log } = await sb
    .from("siso_webhook_logs")
    .select("id, tiny_pedido_id, empresa_id")
    .eq("tiny_pedido_id", PEDIDO_ID)
    .eq("codigo_situacao", "aprovado")
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!log) throw new Error(`nenhum webhook log 'aprovado' pra ${PEDIDO_ID}`);

  const empresaId = (log.empresa_id as string | null) ?? ped.empresa_origem_id;
  if (!empresaId) throw new Error("empresa_origem_id ausente");
  const emp = await getEmpresaById(empresaId);
  if (!emp?.galpaoId) throw new Error("galpão da empresa não resolvido");

  // 3. Reprocessa → re-rota própria + R em CWB + auto-aprova → enfileira NF.
  console.log("reprocessando...", { logId: log.id, empresaId, galpaoId: emp.galpaoId });
  const r = await processWebhook(
    log.id,
    log.tiny_pedido_id as string,
    empresaId,
    emp.galpaoId,
    emp.grupoId ?? null,
  );
  console.log("processWebhook:", r);

  // 4. Kicka o worker pra emitir a NF.
  await kickWorker();

  const { data: depois } = await sb
    .from("siso_pedidos")
    .select("id, status, sugestao, decisao_final, separacao_galpao_id, status_separacao")
    .eq("id", PEDIDO_ID)
    .maybeSingle();
  console.log("DEPOIS:", depois);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
