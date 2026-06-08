import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvariantResult } from "./types";

async function tempoRpc<T>(fn: () => Promise<T>): Promise<{ valor: T; ms: number }> {
  const t0 = Date.now();
  const valor = await fn();
  return { valor, ms: Date.now() - t0 };
}

// I1 — Ledger ↔ cache coerente
async function i1LedgerVsCache(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb.rpc("wms_detectar_divergencias_estoque");
  if (error) {
    return { nome: "I1: ledger↔cache", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  }
  const linhas = (data as unknown[]) ?? [];
  return {
    nome: "I1: ledger↔cache",
    ok: linhas.length === 0,
    detalhes: linhas.length > 0 ? { divergencias: linhas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I8 — Reservado ↔ ledger coerente (fecha o ponto-cego do I1, que só checa saldo)
async function i8ReservadoVsLedger(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb.rpc("wms_detectar_divergencias_reservado");
  if (error) {
    return { nome: "I8: reservado↔ledger", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  }
  const linhas = (data as unknown[]) ?? [];
  return {
    nome: "I8: reservado↔ledger",
    ok: linhas.length === 0,
    detalhes: linhas.length > 0 ? { divergencias: linhas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I2 — disponivel = saldo - reservado (sanity da coluna GENERATED)
async function i2DisponivelGenerated(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_estoque")
    .select("id, saldo, reservado, disponivel");
  if (error) return { nome: "I2: disponivel", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const ruins = (data ?? []).filter((r) => r.disponivel !== r.saldo - r.reservado);
  return {
    nome: "I2: disponivel",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I3 — Custo médio coerente
async function i3CustoMedio(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  // Pega produtos TEST-* (cenários) — recalcula custo ponderado das entradas com custo_unitario
  const { data: produtos } = await sb.from("siso_produtos").select("id, sku").like("sku", "TEST-%");
  const divergentes: Array<{ sku: string; esperado: number; real: number }> = [];
  for (const p of produtos ?? []) {
    const { data: movs } = await sb
      .from("siso_movimentacoes")
      .select("quantidade, custo_unitario")
      .eq("produto_id", p.id)
      .eq("tipo", "E")
      .not("custo_unitario", "is", null)
      .in("origem_tipo", ["nf_compra", "devolucao_cliente_integra", "lancamento_retroativo", "ajuste_manual", "inventario_inicial"])
      .order("criado_em", { ascending: true });
    if (!movs || movs.length === 0) continue;
    let custoMed = 0;
    let saldo = 0;
    for (const m of movs) {
      const q = Number(m.quantidade);
      const c = Number(m.custo_unitario);
      const novoSaldo = saldo + q;
      custoMed = novoSaldo === 0 ? 0 : (custoMed * saldo + c * q) / novoSaldo;
      saldo = novoSaldo;
    }
    const { data: cache } = await sb.from("siso_custo_medio").select("custo_medio").eq("produto_id", p.id).maybeSingle();
    const real = Number(cache?.custo_medio ?? 0);
    if (Math.abs(custoMed - real) > 0.001) {
      divergentes.push({ sku: p.sku, esperado: custoMed, real });
    }
  }
  return {
    nome: "I3: custo médio",
    ok: divergentes.length === 0,
    detalhes: divergentes.length > 0 ? { divergentes } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I4 — Sem reservas órfãs
async function i4ReservasOrfas(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const agora = new Date().toISOString();
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, expira_em, criado_em")
    .eq("tipo", "R");
  if (error) return { nome: "I4: reservas órfãs", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const orfas: unknown[] = [];
  for (const r of data ?? []) {
    if (r.expira_em && r.expira_em > agora) continue; // ainda válida
    // Procura mov L correspondente (mesmo origem_id). origem_id pode ser null
    // em reservas avulsas (harness/teste sem pedido); usar .is() pra match com null.
    let q = sb.from("siso_movimentacoes").select("id").eq("tipo", "L");
    if (r.origem_id === null || r.origem_id === undefined) {
      q = q.is("origem_id", null);
    } else {
      q = q.eq("origem_id", r.origem_id);
    }
    const { data: lib } = await q.limit(1);
    if (!lib || lib.length === 0) orfas.push(r);
  }
  return {
    nome: "I4: reservas órfãs",
    ok: orfas.length === 0,
    detalhes: orfas.length > 0 ? { orfas } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I5 — Pendências de guarda coerentes
async function i5PendenciasGuarda(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_wms_pendencias_guarda")
    .select("id, qty_inicial, qty_guardada, qty_pendente, status");
  if (error) return { nome: "I5: pendências", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const ruins = (data ?? []).filter((p) => {
    const expected = p.qty_inicial - p.qty_guardada;
    if (p.qty_pendente !== expected) return true;
    if (p.status === "guardada" && p.qty_pendente !== 0) return true;
    // 'encerrada_sem_saldo' (FASE 6) é terminal mas NÃO exige qty_pendente=0:
    // o estoque sumiu legitimamente via pick antes do put-away, então a peça
    // nunca foi guardada — qty_pendente fica > 0 por design.
    return false;
  });
  return {
    nome: "I5: pendências guarda",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I6 — Pares S+E balanceados
async function i6ParesSE(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const tiposPares = ["transferencia_galpao", "transferencia_localizacao", "ajuste_pick_zerou"];
  const { data, error } = await sb
    .from("siso_movimentacoes")
    .select("id, tipo, origem_id, origem_tipo, quantidade")
    .in("origem_tipo", tiposPares)
    .not("origem_id", "is", null);
  if (error) return { nome: "I6: pares S+E", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  const grupos = new Map<string, { S: number; E: number; qtyS: number; qtyE: number }>();
  for (const m of data ?? []) {
    const key = `${m.origem_tipo}:${m.origem_id}`;
    const g = grupos.get(key) ?? { S: 0, E: 0, qtyS: 0, qtyE: 0 };
    if (m.tipo === "S") { g.S += 1; g.qtyS += Number(m.quantidade); }
    else if (m.tipo === "E") { g.E += 1; g.qtyE += Number(m.quantidade); }
    grupos.set(key, g);
  }
  const ruins: unknown[] = [];
  for (const [key, g] of grupos) {
    if (g.S !== 1 || g.E !== 1 || g.qtyS !== g.qtyE) ruins.push({ key, ...g });
  }
  return {
    nome: "I6: pares S+E",
    ok: ruins.length === 0,
    detalhes: ruins.length > 0 ? { ruins } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

// I7 — Fila vazia ao fim
async function i7FilaVazia(sb: SupabaseClient): Promise<InvariantResult> {
  const t0 = Date.now();
  const { data, error } = await sb
    .from("siso_fila_execucao")
    .select("id, status, tipo")
    .in("status", ["pendente", "executando"]);
  if (error) return { nome: "I7: fila vazia", ok: false, detalhes: { error: error.message }, duracao_ms: Date.now() - t0 };
  return {
    nome: "I7: fila vazia",
    ok: (data ?? []).length === 0,
    detalhes: (data ?? []).length > 0 ? { jobs_pendentes: data } : undefined,
    duracao_ms: Date.now() - t0,
  };
}

export async function rodarInvariantes(sb: SupabaseClient): Promise<InvariantResult[]> {
  return [
    await i1LedgerVsCache(sb),
    await i8ReservadoVsLedger(sb),
    await i2DisponivelGenerated(sb),
    await i3CustoMedio(sb),
    await i4ReservasOrfas(sb),
    await i5PendenciasGuarda(sb),
    await i6ParesSE(sb),
    await i7FilaVazia(sb),
  ];
}
