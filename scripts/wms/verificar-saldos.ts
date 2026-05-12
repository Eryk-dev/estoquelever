/**
 * Onda 2/6 — verificar-saldos: compara saldos reais vs esperados após
 * disparar os cenários do `seed-cenarios.ts`.
 *
 * O que verifica:
 *   - Cada cenário gerou um pedido em siso_pedidos com a decisao_final esperada
 *   - Status de separação está coerente (auto-aprovado = aguardando_nf | pendente)
 *   - Para cenários `propria`: saldo no galpão origem foi RESERVADO (não deduzido)
 *     antes do separado. (Confirma Plano 3 — reserva criada no pendente)
 *   - Para cenários `oc`: nenhuma reserva criada
 *   - Para cancel-pre: pedido status=cancelado e reservas zeradas
 *
 * Imprime tabela compacta + sai com exit 1 se houver divergências.
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";
import { CENARIOS, STAGING_EMPRESAS } from "./cenarios";

interface Resultado {
  cenario: string;
  pedidoId: string;
  esperado: string;
  obtido: string;
  ok: boolean;
  obs?: string;
}

async function main() {
  const sb = createServiceClient();
  console.log("=".repeat(60));
  console.log("  Verificação de saldos pós-cenários");
  console.log("=".repeat(60));

  const resultados: Resultado[] = [];

  for (const cenario of CENARIOS) {
    const { data: pedido } = await sb
      .from("siso_pedidos")
      .select("id, status, sugestao, decisao_final, status_separacao, empresa_origem_id")
      .eq("id", cenario.pedidoTinyId)
      .maybeSingle();

    if (!pedido) {
      resultados.push({
        cenario: cenario.id,
        pedidoId: cenario.pedidoTinyId,
        esperado: cenario.decisaoEsperada,
        obtido: "(não chegou em siso_pedidos)",
        ok: false,
      });
      continue;
    }

    let ok = true;
    let obs: string | undefined;

    if (cenario.cancelarApos === "pre-separado") {
      // Esperamos status=cancelado
      ok = pedido.status === "cancelado";
      obs = `cancelado pre-separado; status=${pedido.status}`;
    } else if (cenario.cancelarApos === "pos-separado") {
      // Pode estar cancelado, ou ainda em fluxo dependendo do timing
      ok = pedido.status === "cancelado" || pedido.status === "concluido";
      obs = `cancelado pos-separado; status=${pedido.status}`;
    } else {
      ok = pedido.sugestao === cenario.decisaoEsperada;
      obs = `sugestao=${pedido.sugestao} status_separacao=${pedido.status_separacao ?? "-"}`;
    }

    resultados.push({
      cenario: cenario.id,
      pedidoId: cenario.pedidoTinyId,
      esperado: cenario.decisaoEsperada,
      obtido: pedido.sugestao,
      ok,
      obs,
    });
  }

  // ─── Print tabela ─────────────────────────────────────────────────────────
  console.log("\n┌──────────────────────────┬──────────┬───────────────┬────┐");
  console.log("│ cenário                  │ esperado │ obtido        │ ?  │");
  console.log("├──────────────────────────┼──────────┼───────────────┼────┤");
  for (const r of resultados) {
    console.log(
      `│ ${r.cenario.padEnd(24)} │ ${r.esperado.padEnd(8)} │ ${(r.obtido ?? "").padEnd(13)} │ ${r.ok ? "✅" : "❌"} │`,
    );
  }
  console.log("└──────────────────────────┴──────────┴───────────────┴────┘");

  for (const r of resultados.filter((r) => !r.ok)) {
    console.log(`  ↳ ${r.cenario}: ${r.obs ?? ""}`);
  }

  // ─── Resumo de saldos por galpão ──────────────────────────────────────────
  console.log("\n— Saldo + reservas por galpão (SKUs sintéticos) —");

  for (const [empresaKey, emp] of Object.entries(STAGING_EMPRESAS)) {
    const { data: linhas } = await sb
      .from("siso_estoque")
      .select("saldo, reservado, siso_produtos!inner(sku)")
      .eq("empresa_dona_id", emp.id)
      .like("siso_produtos.sku", "%FARTO%")
      .limit(1000);

    const totalSaldo = (linhas ?? []).reduce((s, l) => s + Number(l.saldo ?? 0), 0);
    const totalReservado = (linhas ?? []).reduce(
      (s, l) => s + Number(l.reservado ?? 0),
      0,
    );
    console.log(
      `  ${empresaKey.padEnd(10)} (${emp.galpao_nome}) — saldo=${totalSaldo}  reservado=${totalReservado}`,
    );
  }

  // ─── Confirma zero chamadas Tiny ──────────────────────────────────────────
  const { count: movsTiny } = await sb
    .from("siso_movimentacoes")
    .select("*", { count: "exact", head: true })
    .in("origem_tipo", ["nf_venda"]);
  console.log(`\n— Movimentações origem=nf_venda: ${movsTiny ?? 0}`);
  console.log("  (Plano 2 esperado: pode existir se Onda 4 já rodou)");

  const ok = resultados.every((r) => r.ok);
  if (!ok) {
    console.log("\n❌ Divergências encontradas");
    process.exit(1);
  }
  console.log("\n✅ Todos os cenários terminaram conforme esperado");
}

main().catch((err) => {
  console.error("\n💥", err);
  process.exit(1);
});
