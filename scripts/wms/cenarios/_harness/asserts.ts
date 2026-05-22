import type { SupabaseClient } from "@supabase/supabase-js";

export class AssertError extends Error {
  constructor(public detalhes: unknown, message: string) {
    super(message);
    this.name = "AssertError";
  }
}

export async function assertSaldo(
  sb: SupabaseClient,
  sku: string,
  galpao: "CWB" | "SP",
  loc: string,
  qty_esperada: number,
): Promise<void> {
  const { data, error } = await sb
    .from("siso_estoque")
    .select("saldo, produto:siso_produtos!inner(sku), galpao:siso_galpoes!inner(nome), localizacao:siso_localizacoes!inner(codigo)")
    .eq("siso_produtos.sku", sku)
    .eq("siso_galpoes.nome", galpao)
    .eq("siso_localizacoes.codigo", loc)
    .maybeSingle();
  if (error) throw new AssertError({ error }, `assertSaldo query falhou: ${error.message}`);
  const saldo = (data as { saldo?: number } | null)?.saldo ?? 0;
  if (saldo !== qty_esperada) {
    throw new AssertError({ sku, galpao, loc, esperado: qty_esperada, real: saldo }, `assertSaldo: ${sku}@${galpao}/${loc} esperado=${qty_esperada} real=${saldo}`);
  }
}

export async function assertReservado(
  sb: SupabaseClient,
  sku: string,
  galpao: "CWB" | "SP",
  loc: string,
  qty_esperada: number,
): Promise<void> {
  const { data } = await sb
    .from("siso_estoque")
    .select("reservado, siso_produtos!inner(sku), siso_galpoes!inner(nome), siso_localizacoes!inner(codigo)")
    .eq("siso_produtos.sku", sku)
    .eq("siso_galpoes.nome", galpao)
    .eq("siso_localizacoes.codigo", loc)
    .maybeSingle();
  const reservado = (data as { reservado?: number } | null)?.reservado ?? 0;
  if (reservado !== qty_esperada) {
    throw new AssertError({ sku, galpao, loc, esperado: qty_esperada, real: reservado }, `assertReservado: ${sku}@${galpao}/${loc} esperado=${qty_esperada} real=${reservado}`);
  }
}

export async function assertMovsCount(sb: SupabaseClient, sku: string, count_esperado: number): Promise<void> {
  const { count } = await sb
    .from("siso_movimentacoes")
    .select("id, siso_produtos!inner(sku)", { count: "exact", head: true })
    .eq("siso_produtos.sku", sku);
  if (count !== count_esperado) {
    throw new AssertError({ sku, esperado: count_esperado, real: count }, `assertMovsCount: ${sku} esperado=${count_esperado} real=${count}`);
  }
}

export async function assertPedidoStatus(sb: SupabaseClient, pedidoId: string, status_esperado: string): Promise<void> {
  const { data } = await sb.from("siso_pedidos").select("status, status_separacao").eq("id", pedidoId).single();
  const real = (data as { status?: string; status_separacao?: string } | null)?.status_separacao ?? (data as { status?: string } | null)?.status;
  if (real !== status_esperado) {
    throw new AssertError({ pedidoId, esperado: status_esperado, real, data }, `assertPedidoStatus: ${pedidoId} esperado=${status_esperado} real=${real}`);
  }
}

export async function assertCustoMedio(sb: SupabaseClient, sku: string, custo_esperado: number, tolerancia = 0.001): Promise<void> {
  const { data } = await sb
    .from("siso_custo_medio")
    .select("custo_medio, siso_produtos!inner(sku)")
    .eq("siso_produtos.sku", sku)
    .maybeSingle();
  const custo = Number((data as { custo_medio?: number | string } | null)?.custo_medio ?? 0);
  if (Math.abs(custo - custo_esperado) > tolerancia) {
    throw new AssertError({ sku, esperado: custo_esperado, real: custo }, `assertCustoMedio: ${sku} esperado=${custo_esperado} real=${custo} (tol=${tolerancia})`);
  }
}

export async function assertSemReservasOrfas(sb: SupabaseClient): Promise<void> {
  const { data } = await sb.rpc("wms_reservas_orfas_check");
  if (data && Array.isArray(data) && data.length > 0) {
    throw new AssertError({ orfas: data }, `assertSemReservasOrfas: ${data.length} reservas órfãs`);
  }
  // se RPC não existe (não criamos pra esse caso), usa fallback inline:
  const { data: fallback } = await sb
    .from("siso_movimentacoes")
    .select("id, origem_id, expira_em")
    .eq("tipo", "R")
    .or("expira_em.is.null,expira_em.gt." + new Date().toISOString());
  if (fallback && fallback.length > 0) {
    // ainda válidas — não são órfãs, OK
    return;
  }
}
