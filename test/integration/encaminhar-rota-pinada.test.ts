import { describe, it, expect, beforeAll } from "vitest";
import { createServiceClient } from "../../src/lib/supabase-server";
import { encaminharPedido } from "../../src/app/api/wms/separacao/encaminhar/route";

/**
 * Plano 2026-06-25-encaminhar-rota-pinada — re-rota PINADA no galpão destino.
 *
 * INVARIANTE: o roteamento da re-rota avalia cobertura SÓ no galpão destino
 * escolhido pelo operador. Decisões possíveis: propria (cobre) | troca
 * (equivalente no destino) | oc (não cobre). NUNCA transferencia.
 *
 * Roda contra STAGING REAL (vitest.integration.config.ts) — exige
 * ALLOW_STAGING_WIPE=true (trunca tabelas operacionais). Chama encaminharPedido
 * direto (mesmo padrão de cancelar-venda-rpc.test.ts, que chama o lib direto em
 * vez de simular a rota HTTP) com uma sessão sintética {id, nome}.
 *
 * Fase 0 (red-guard do estado legado) foi SUPERSEDIDA: o código já implementa
 * o alvo, então testamos diretamente o comportamento novo (Fases 2,4,5).
 * Fase 3 (troca) fica como it.todo — exige seed do cluster cross + curadoria
 * (tier_qualidade + siso_equivalencias_verificadas) que não dá pra montar aqui
 * sem fixtures do cross.
 */

const sb = createServiceClient();
let galpaoCwbId: string, galpaoSpId: string, locCwbId: string;
let empresaId: string, userId: string;

const SUF = Date.now();

beforeAll(async () => {
  const { data: cwb } = await sb.from("siso_galpoes").select("id").eq("nome", "CWB").single();
  galpaoCwbId = cwb!.id;
  const { data: sp } = await sb.from("siso_galpoes").select("id").eq("nome", "SP").single();
  galpaoSpId = sp!.id;

  // Loc picking real em CWB (re-rota lê siso_estoque em loc vendável).
  const { data: loc } = await sb
    .from("siso_localizacoes")
    .select("id")
    .eq("galpao_id", galpaoCwbId)
    .eq("tipo", "picking")
    .eq("ativo", true)
    .limit(1)
    .single();
  locCwbId = loc!.id;

  const { data: e } = await sb.from("siso_empresas").select("id").limit(1).single();
  empresaId = e!.id;
  const { data: u } = await sb.from("siso_usuarios").select("id").eq("nome", "test-runner").single();
  userId = u!.id;
});

const session = () => ({ id: userId, nome: "test-runner" });
const destinoCwb = () => ({ id: galpaoCwbId, nome: "CWB" });

/** Cria um produto + (opcional) saldo E em CWB. Retorna {prodId, sku}. */
async function criarProduto(comSaldoCwb: number): Promise<{ prodId: string; sku: string }> {
  const sku = `ENC-PIN-${SUF}-${Math.floor(Math.random() * 1e6)}`;
  const { data: p } = await sb
    .from("siso_produtos")
    .insert({ sku, descricao: "encaminhar pinado", ativo: true })
    .select("id")
    .single();
  const prodId = p!.id as string;
  if (comSaldoCwb > 0) {
    await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prodId,
      p_galpao_id: galpaoCwbId,
      p_localizacao_id: locCwbId,
      p_tipo: "E",
      p_quantidade: comSaldoCwb,
      p_origem_tipo: "inventario_inicial",
      p_motivo: "seed encaminhar pinado",
    });
  }
  return { prodId, sku };
}

/**
 * Cria um pedido SP "sendo separado em SP" (separacao_galpao_id=SP). NF
 * opcional. O item usa sku=produto.sku → resolverProdutoEfetivoDoItem resolve
 * via SKU (sem precisar de bridge tiny).
 */
async function criarPedidoSp(opts: {
  sku: string;
  qty: number;
  comNf: boolean;
}): Promise<string> {
  const pedidoId = `ENC-PIN-PED-${SUF}-${Math.floor(Math.random() * 1e6)}`;
  let notaFiscalId: string | null = null;
  let chave: string | null = null;
  if (opts.comNf) {
    chave = `CHV-${pedidoId}`.padEnd(44, "0").slice(0, 44);
    const { data: nf } = await sb
      .from("siso_notas_fiscais")
      .insert({ tipo: "saida", chave_acesso: chave, empresa_id: empresaId })
      .select("id")
      .single();
    notaFiscalId = nf!.id as string;
  }
  await sb.from("siso_pedidos").insert({
    id: pedidoId,
    status: "executando",
    status_separacao: "aguardando_separacao",
    decisao_final: "transferencia",
    numero: pedidoId,
    data: "2026-06-25",
    filial_origem: "SP",
    cliente_nome: "Cli",
    empresa_origem_id: empresaId,
    separacao_galpao_id: galpaoSpId,
    nota_fiscal_id: notaFiscalId,
    chave_acesso_nf: chave,
  });
  await sb.from("siso_pedido_itens").insert({
    pedido_id: pedidoId,
    produto_id: 999_000_000 + Math.floor(Math.random() * 1e6), // tiny id fake → cai no SKU
    sku: opts.sku,
    descricao: "item encaminhar",
    quantidade_pedida: opts.qty,
  });
  return pedidoId;
}

async function reservadoEm(prodId: string): Promise<number> {
  const { data } = await sb
    .from("siso_estoque")
    .select("reservado")
    .eq("produto_id", prodId)
    .eq("galpao_id", galpaoCwbId)
    .eq("localizacao_id", locCwbId)
    .maybeSingle();
  return Number(data?.reservado ?? 0);
}

async function jobsLancar(pedidoId: string): Promise<Array<{ decisao: string | null }>> {
  const { data } = await sb
    .from("siso_fila_execucao")
    .select("decisao")
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque");
  return (data ?? []) as Array<{ decisao: string | null }>;
}

describe("encaminhar — re-rota PINADA no destino", () => {
  // ── Fase 2: PRÓPRIA (destino cobre) ──────────────────────────────────────
  it("destino cobre → propria ancorada no destino + R na loc + job propria (NF preservada)", async () => {
    const { prodId, sku } = await criarProduto(5);
    const pedidoId = await criarPedidoSp({ sku, qty: 2, comNf: true });

    await encaminharPedido(sb, pedidoId, destinoCwb(), session());

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("separacao_galpao_id, decisao_final, status, status_separacao, nota_fiscal_id")
      .eq("id", pedidoId)
      .single();
    expect(ped!.separacao_galpao_id).toBe(galpaoCwbId); // PINADO, não null
    expect(ped!.decisao_final).toBe("propria");
    expect(ped!.status).toBe("executando");
    expect(ped!.status_separacao).toBe("aguardando_separacao");
    expect(ped!.nota_fiscal_id).not.toBeNull(); // NF preservada

    expect(await reservadoEm(prodId)).toBe(2); // R reserva_pedido viva na loc CWB

    const jobs = await jobsLancar(pedidoId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].decisao).toBe("propria");
  });

  // ── Fase 5 #3: PRÓPRIA sem NF → aguardando_nf ────────────────────────────
  it("destino cobre mas SEM NF → propria em aguardando_nf", async () => {
    const { sku } = await criarProduto(4);
    const pedidoId = await criarPedidoSp({ sku, qty: 1, comNf: false });

    await encaminharPedido(sb, pedidoId, destinoCwb(), session());

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("decisao_final, status_separacao, separacao_galpao_id")
      .eq("id", pedidoId)
      .single();
    expect(ped!.decisao_final).toBe("propria");
    expect(ped!.separacao_galpao_id).toBe(galpaoCwbId);
    expect(ped!.status_separacao).toBe("aguardando_nf");
  });

  // ── Fase 4: OC ancorada no destino (não cobre, sem equivalente) ──────────
  it("destino NÃO cobre e sem cross → oc ancorada no destino + job oc + sem R", async () => {
    const { prodId, sku } = await criarProduto(0); // zero saldo em qualquer galpão
    const pedidoId = await criarPedidoSp({ sku, qty: 3, comNf: true });

    await encaminharPedido(sb, pedidoId, destinoCwb(), session());

    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("decisao_final, separacao_galpao_id, status, status_separacao")
      .eq("id", pedidoId)
      .single();
    expect(ped!.decisao_final).toBe("oc");
    expect(ped!.separacao_galpao_id).toBe(galpaoCwbId); // ancorado, NÃO o galpão de origem
    expect(ped!.status).toBe("executando");
    expect(ped!.status_separacao).toBeNull(); // worker (executarMarcadoresOnly) seta validacao_oc

    expect(await reservadoEm(prodId)).toBe(0); // OC não reserva

    const jobs = await jobsLancar(pedidoId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].decisao).toBe("oc");
  });

  // ── Guard: mesmo galpão ──────────────────────────────────────────────────
  it("encaminhar pro MESMO galpão atual lança (guard preservado)", async () => {
    const { sku } = await criarProduto(2);
    const pedidoId = await criarPedidoSp({ sku, qty: 1, comNf: true });
    // pedido está em SP → encaminhar pra SP deve falhar
    await expect(
      encaminharPedido(sb, pedidoId, { id: galpaoSpId, nome: "SP" }, session()),
    ).rejects.toThrow();
  });

  // ── Fase 3: TROCA no destino (equivalente) ───────────────────────────────
  it.todo(
    "destino não cobre original mas equivalente cobre → troca no destino " +
      "(3a par livre → propria; 3b par exige aprovação → pendente+troca_equivalente, " +
      "separacao_galpao_id JÁ pinado). Requer seed do cluster cross + curadoria.",
  );

  // ── Fase 5 #2: falha não move (uuid não resolve / saldo some) ────────────
  it.todo(
    "falha na re-rota (item não resolvível / criarReservasRotaAtomico rollback) " +
      "→ re-lança, pedido não migra (catch do caller registra em falhas[]).",
  );
});
