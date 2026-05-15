/**
 * E2E mini-swap intra-galpão — stress test em staging.
 *
 * Setup esperado (manual, antes de rodar):
 *   - SKU 19MINISWAP-01 cadastrado em siso_produtos
 *   - NetAir: 3 unidades em LOC_A + 1 unidade em LOC_B (mesmo galpão CWB)
 *   - NetParts: 5 unidades em LOC_C (mesmo galpão CWB, empresa credora)
 *   - 1 pedido NetAir em status aguardando_separacao, qty=5 desse SKU
 *   - Roteamento: NetAir cobre 4 (próprio, 2 locs) + NetParts empresta 1
 *   - siso_wms_mini_swap_config: ativo=true para GALPAO_CWB_ID
 *
 * O script dispara POST /api/separacao/iniciar e valida:
 *   1. Pedido entra em em_separacao (resposta da API)
 *   2. siso_movimentacoes contém par de movs origem_tipo='swap' criado
 *   3. Saldo total por empresa preservado (conservação de estoque)
 *   4. siso_pedido_historico contém evento 'mini_swap_executado'
 *
 * Pré-requisitos:
 *   - `npm run dev` em outra aba (TINY_DISABLED=true recomendado)
 *   - .env com as variáveis abaixo:
 *
 * Variáveis obrigatórias (.env.local):
 *   STRESS_SESSION_ID    — session id de um usuário admin com galpaoId=GALPAO_CWB_ID
 *   GALPAO_CWB_ID        — UUID do galpão CWB em siso_galpoes
 *   OPERADOR_ID          — UUID do usuário operador (siso_usuarios.id)
 *   NETAIR_ID            — UUID da empresa NetAir (siso_empresas.id)
 *   NETPARTS_ID          — UUID da empresa NetParts (siso_empresas.id)
 *   STRESS_PEDIDO_ID     — UUID do pedido em siso_pedidos (status aguardando_separacao)
 *
 * Variáveis opcionais:
 *   WEBHOOK_BASE_URL     — default http://localhost:3000
 *
 * Uso:
 *   tsx scripts/wms/stress-mini-swap.ts
 */

import "dotenv/config";
import { createServiceClient } from "../../src/lib/supabase-server";

const BASE = process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
const SKU_TESTE = "19MINISWAP-01";
const GALPAO_CWB_ID = process.env.GALPAO_CWB_ID;
const SESSION_ID = process.env.STRESS_SESSION_ID;
const OPERADOR_ID = process.env.OPERADOR_ID;
const NETAIR_ID = process.env.NETAIR_ID;
const NETPARTS_ID = process.env.NETPARTS_ID;
const PEDIDO_ID = process.env.STRESS_PEDIDO_ID;

// ─── Validação de env ──────────────────────────────────────────────────────

const missingEnv = [
  !GALPAO_CWB_ID && "GALPAO_CWB_ID",
  !SESSION_ID && "STRESS_SESSION_ID",
  !OPERADOR_ID && "OPERADOR_ID",
  !NETAIR_ID && "NETAIR_ID",
  !NETPARTS_ID && "NETPARTS_ID",
  !PEDIDO_ID && "STRESS_PEDIDO_ID",
].filter(Boolean);

if (missingEnv.length > 0) {
  console.error("Variáveis de env faltando:", missingEnv.join(", "));
  process.exit(1);
}

// ─── Tipos ────────────────────────────────────────────────────────────────

interface SaldoRow {
  empresa_dona_id: string;
  localizacao_id: string;
  saldo: number;
  localizacao_codigo: string;
}

interface MovRow {
  id: string;
  tipo: string;
  quantidade: number;
  empresa_dona_id: string;
  localizacao_id: string;
  origem_tipo: string;
}

interface HistoricoRow {
  evento: string;
  detalhes: unknown;
  criado_em: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function getProdutoId(): Promise<string> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_produtos")
    .select("id")
    .eq("sku", SKU_TESTE)
    .single();
  if (error || !data) {
    throw new Error(
      `Produto ${SKU_TESTE} não existe — cadastre antes de rodar o stress test`,
    );
  }
  return (data as { id: string }).id;
}

async function getEstoqueNoGalpao(produtoId: string): Promise<SaldoRow[]> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("siso_estoque")
    .select(
      "empresa_dona_id, localizacao_id, saldo, localizacao:siso_localizacoes!inner(codigo)",
    )
    .eq("produto_id", produtoId)
    .eq("galpao_id", GALPAO_CWB_ID!)
    .gt("saldo", 0);

  if (error) throw new Error(`Erro ao buscar estoque: ${error.message}`);

  return (
    (data ?? []) as unknown as Array<{
      empresa_dona_id: string;
      localizacao_id: string;
      saldo: number;
      localizacao: { codigo: string };
    }>
  ).map((r) => ({
    empresa_dona_id: r.empresa_dona_id,
    localizacao_id: r.localizacao_id,
    saldo: r.saldo,
    localizacao_codigo: r.localizacao.codigo,
  }));
}

function totalPorEmpresa(rows: SaldoRow[]): Record<string, number> {
  const totais: Record<string, number> = {};
  for (const r of rows) {
    totais[r.empresa_dona_id] = (totais[r.empresa_dona_id] ?? 0) + r.saldo;
  }
  return totais;
}

function empresaNome(id: string): string {
  if (id === NETAIR_ID) return "NetAir";
  if (id === NETPARTS_ID) return "NetParts";
  return id.slice(0, 8);
}

// ─── Validações ───────────────────────────────────────────────────────────

function validarConservacaoSaldo(
  antes: Record<string, number>,
  depois: Record<string, number>,
): boolean {
  let ok = true;
  for (const [emp, totalAntes] of Object.entries(antes)) {
    const totalDepois = depois[emp] ?? 0;
    if (totalAntes !== totalDepois) {
      console.log(
        `  ❌ ${empresaNome(emp)}: saldo MUDOU ${totalAntes} → ${totalDepois} (esperado preservar)`,
      );
      ok = false;
    } else {
      console.log(`  ✅ ${empresaNome(emp)}: saldo preservado (${totalAntes})`);
    }
  }
  // Verifica se surgiram empresas novas (não deveria)
  for (const emp of Object.keys(depois)) {
    if (!(emp in antes)) {
      console.log(
        `  ⚠  ${empresaNome(emp)}: nova empresa apareceu pós-swap (saldo=${depois[emp]})`,
      );
    }
  }
  return ok;
}

async function validarMovsSwap(produtoId: string): Promise<boolean> {
  const sb = createServiceClient();
  const { data: movs, error } = await sb
    .from("siso_movimentacoes")
    .select("id, tipo, quantidade, empresa_dona_id, localizacao_id, origem_tipo")
    .eq("origem_tipo", "swap")
    .eq("produto_id", produtoId)
    .order("criado_em", { ascending: false })
    .limit(20);

  if (error) {
    console.log(`  ❌ Erro ao buscar movs swap: ${error.message}`);
    return false;
  }

  const lista = (movs ?? []) as MovRow[];
  console.log(
    `  Movs origem_tipo=swap encontradas (últimas 20): ${lista.length}`,
  );

  // Um swap atômico gera exatamente 2 movs: S da loc fragmentada + E na loc destino
  // (ambas com a mesma empresa_dona_id). Pode ter mais se houve empréstimo adjacente.
  if (lista.length === 0) {
    console.log(
      "  ❌ Nenhuma mov swap encontrada — mini-swap não executou ou não gravou",
    );
    return false;
  }

  const porTipo = lista.reduce(
    (acc, m) => {
      acc[m.tipo] = (acc[m.tipo] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log("  Distribuição por tipo:", JSON.stringify(porTipo));

  // Valida par mínimo S+E (swap simples sem empréstimo = 1S + 1E da picadora)
  const temS = (porTipo["S"] ?? 0) >= 1;
  const temE = (porTipo["E"] ?? 0) >= 1;
  if (temS && temE) {
    console.log("  ✅ Par S+E de swap presente");
    return true;
  }
  console.log("  ❌ Par S+E de swap INCOMPLETO");
  return false;
}

async function validarHistorico(pedidoId: string): Promise<boolean> {
  const sb = createServiceClient();
  const { data: hist, error } = await sb
    .from("siso_pedido_historico")
    .select("evento, detalhes, criado_em")
    .eq("pedido_id", pedidoId)
    .order("criado_em", { ascending: false })
    .limit(15);

  if (error) {
    console.log(`  ❌ Erro ao buscar histórico: ${error.message}`);
    return false;
  }

  const eventos = (hist ?? []) as HistoricoRow[];
  console.log("  Eventos recentes:");
  for (const e of eventos) {
    console.log(`    ${e.criado_em.slice(0, 19)}  ${e.evento}`);
  }

  const temMiniSwap = eventos.some((h) => h.evento === "mini_swap_executado");
  if (temMiniSwap) {
    const ev = eventos.find((h) => h.evento === "mini_swap_executado");
    console.log(
      "  ✅ Evento 'mini_swap_executado' presente:",
      JSON.stringify(ev?.detalhes ?? {}),
    );
    return true;
  }
  console.log("  ❌ Evento 'mini_swap_executado' AUSENTE no histórico");
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  STRESS TEST — mini-swap intra-galpão E2E");
  console.log("=".repeat(60));
  console.log(`  SKU: ${SKU_TESTE}`);
  console.log(`  Pedido: ${PEDIDO_ID}`);
  console.log(`  Galpão CWB: ${GALPAO_CWB_ID}`);
  console.log(`  Base URL: ${BASE}`);

  const produtoId = await getProdutoId();
  console.log(`\n  produto_id = ${produtoId}`);

  // ── Snapshot antes ──
  const saldosAntes = await getEstoqueNoGalpao(produtoId);
  const totaisAntes = totalPorEmpresa(saldosAntes);
  console.log("\n— Estoque ANTES do iniciar —");
  for (const r of saldosAntes) {
    console.log(
      `  ${empresaNome(r.empresa_dona_id).padEnd(10)} @ ${r.localizacao_codigo.padEnd(12)} → saldo=${r.saldo}`,
    );
  }
  console.log("  Totais:", JSON.stringify(totaisAntes));

  // ── Verificar config mini-swap ──
  const sb = createServiceClient();
  const { data: cfg } = await sb
    .from("siso_wms_mini_swap_config")
    .select("ativo, max_movs_por_wave, max_distancia_metros")
    .eq("galpao_id", GALPAO_CWB_ID!)
    .maybeSingle();
  console.log("\n— Config mini-swap do galpão —");
  if (!cfg) {
    console.log("  ⚠  Nenhuma config encontrada — mini-swap não vai rodar!");
    console.log(
      "     Insira uma linha em siso_wms_mini_swap_config com ativo=true.",
    );
  } else {
    console.log(`  ativo=${cfg.ativo}  max_movs=${cfg.max_movs_por_wave ?? "∞"}  max_dist=${cfg.max_distancia_metros ?? "∞"}m`);
    if (!cfg.ativo) {
      console.log("  ⚠  Config existe mas ativo=false — mini-swap não vai executar");
    }
  }

  // ── Disparar /api/separacao/iniciar ──
  console.log(`\n— POST /api/separacao/iniciar { pedido_ids: [${PEDIDO_ID}] } —`);
  const res = await fetch(`${BASE}/api/separacao/iniciar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": SESSION_ID!,
    },
    body: JSON.stringify({
      pedido_ids: [PEDIDO_ID],
      operador_id: OPERADOR_ID,
    }),
  });

  const resBody = (await res.json().catch(() => ({}))) as {
    pedido_ids?: string[];
    error?: string;
  };
  console.log(`  HTTP ${res.status}`);
  console.log("  Body:", JSON.stringify(resBody));

  // ── Snapshot depois ──
  const saldosDepois = await getEstoqueNoGalpao(produtoId);
  const totaisDepois = totalPorEmpresa(saldosDepois);
  console.log("\n— Estoque DEPOIS do iniciar —");
  for (const r of saldosDepois) {
    console.log(
      `  ${empresaNome(r.empresa_dona_id).padEnd(10)} @ ${r.localizacao_codigo.padEnd(12)} → saldo=${r.saldo}`,
    );
  }
  console.log("  Totais:", JSON.stringify(totaisDepois));

  // ── Validações ──
  console.log("\n— Validações —");
  const resultados: boolean[] = [];

  // 1. API retornou 200
  const apiOk = res.status === 200 && !resBody.error;
  resultados.push(apiOk);
  console.log(
    apiOk
      ? `  ✅ [1] API retornou 200`
      : `  ❌ [1] API falhou (${res.status}): ${resBody.error ?? "sem error"}`,
  );

  // 2. Conservação de saldo por empresa
  console.log("  — [2] Conservação de saldo —");
  const conservacaoOk = validarConservacaoSaldo(totaisAntes, totaisDepois);
  resultados.push(conservacaoOk);

  // 3. Movs swap geradas
  console.log("  — [3] Movimentações swap —");
  const movsOk = await validarMovsSwap(produtoId);
  resultados.push(movsOk);

  // 4. Evento de histórico
  console.log("  — [4] Histórico do pedido —");
  const histOk = await validarHistorico(PEDIDO_ID!);
  resultados.push(histOk);

  // ── Resumo final ──
  const totalOk = resultados.filter(Boolean).length;
  const total = resultados.length;
  console.log("\n" + "=".repeat(60));
  console.log(`  RESULTADO: ${totalOk}/${total} validações OK`);
  console.log("=".repeat(60));

  if (totalOk < total) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFalhou:", err);
  process.exit(1);
});
