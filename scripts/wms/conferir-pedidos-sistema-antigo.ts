#!/usr/bin/env tsx
/**
 * scripts/wms/conferir-pedidos-sistema-antigo.ts — one-off (2026-06-12).
 * Pedidos do funil que JÁ FORAM embalados/atendidos pelo sistema antigo
 * (decisão do Eryk): libera as reservas R vivas e joga status_separacao
 * pra 'conferido', tirando-os do caminho operacional sem cancelar.
 *
 * Mantém fora: os 16 do incidente (seguem pra separação real) e vendas
 * novas em fluxo normal (51237).
 *
 * Rodar: npx tsx scripts/wms/conferir-pedidos-sistema-antigo.ts
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { estornarReservaIndividual } from "../../src/lib/wms/reservas";

const MANTER = [
  // 16 do incidente (NFs 019959–019974)
  "937845304", "937864604", "938039226", "938084558", "938086309",
  "938127831", "938161494", "938166909", "938204034", "938224325",
  "938228440", "938230733", "938235288", "938235502", "938235910",
  "938239502",
  // vendas novas em fluxo normal
  "938241722", // 51237
];

const STATUS_FUNIL = [
  "aguardando_compra",
  "validacao_oc",
  "aguardando_nf",
  "aguardando_separacao",
  "em_separacao",
  "pendente_realocacao",
  "separado",
  "embalado",
];

async function main() {
  const sb = createServiceClient();

  const { data: pedidos, error } = await sb
    .from("siso_pedidos")
    .select("id, numero, status, status_separacao")
    .neq("status", "cancelado")
    .in("status_separacao", STATUS_FUNIL)
    .not("id", "in", `(${MANTER.join(",")})`);

  if (error) {
    console.error("query falhou:", error.message);
    process.exit(1);
  }

  console.log(`pedidos a conferir: ${pedidos?.length ?? 0}`);

  let reservasLiberadas = 0;
  for (const p of pedidos ?? []) {
    // Rs vivas do pedido (sem L de estorno) — mesma régua do resolver_fantasma
    const { data: reservas } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("origem_id", p.id);

    for (const r of (reservas ?? []) as Array<{ id: string }>) {
      const { data: jaEstornada } = await sb
        .from("siso_movimentacoes")
        .select("id")
        .eq("estorno_de", r.id)
        .eq("tipo", "L")
        .maybeSingle();
      if (jaEstornada) continue;
      try {
        await estornarReservaIndividual({
          reserva_id: r.id,
          motivo: "liberar_reservas_admin",
        });
        reservasLiberadas++;
      } catch (err) {
        console.error(
          `  ${p.numero}: falha liberando R ${r.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { error: updErr } = await sb
      .from("siso_pedidos")
      .update({ status_separacao: "conferido" })
      .eq("id", p.id);
    console.log(
      `${p.id} (${p.numero}): ${p.status_separacao} -> conferido${updErr ? ` ERRO: ${updErr.message}` : ""}`,
    );
  }

  console.log(`\nreservas liberadas: ${reservasLiberadas}`);
}

main().then(() => process.exit(0));
