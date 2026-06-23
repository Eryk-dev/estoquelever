import type { Cenario, Ctx } from "../_harness/types";

/**
 * Cenário 70 (regressão) — Parcial NÃO pode bloquear o pedido de pegar a
 * PRÓPRIA reserva quando o saldo da loc está 100% alocado entre vários pedidos.
 *
 * Bug (parcial/route.ts, gate `disponivel < quantidade_pega`): o gate subtraía
 * TODO o `reservado` — inclusive a reserva do próprio pedido (a R que o aprovar
 * criou e que o passo 7a libera logo em seguida). Com a loc 100% alocada
 * (disponivel=0), o operador não conseguia registrar nem um parcial da própria
 * reserva — erro "Posição reservada por outro pedido — saldo X, disponível 0".
 * O caminho de pick completo (marcar-item) nunca teve esse problema porque passa
 * o reserva_id pro RPC atômico.
 *
 * Setup: CWB A-01-04 com saldo 3.
 *   - Pedido A (NetAir, qty 2) auto-aprova própria → reserva 2 na loc.
 *   - Pedido B (NetAir, qty 1) auto-aprova própria → reserva 1 na loc.
 *   - Loc agora: saldo 3, reservado 3, disponivel 0.
 * Run: A faz parcial qty=1 (pegou 1 de 2), loc_zerou=false.
 *   - ANTES do fix: 409 posicao_reservada (disponivel 0 < 1) → ctx.parcial lança → cenário FALHA.
 *   - DEPOIS do fix: disponivel_pra_mim = saldo − reservado_de_outros = 3 − 1 = 2 ≥ 1 → permite.
 * Esperado:
 *   - A liberou sua R(2) inteira + deu saída de 1 → saldo 3→2.
 *   - Reserva de B (1) PRESERVADA → reservado = 1 (o fix não fura a reserva alheia).
 *   - A reenfileirado (qty<pedido, prateleira ainda tem) com quantidade_pega=1.
 */
export default {
  nome: "70 — Parcial libera a reserva do próprio pedido (saldo 100% alocado)",
  descricao:
    "Loc com saldo dividido entre 2 pedidos (disponivel=0); pedido faz parcial da própria reserva — não pode bloquear, e não pode tocar a reserva do outro pedido.",
  tags: ["separacao", "parcial", "reserva", "regressao"],

  setup: async (ctx: Ctx) => {
    const sku = ctx.skuUnico("70");
    await ctx.criarProduto({ sku, descricao: "Parcial reserva própria 70" });
    await ctx.semearSaldo({ produto: sku, galpao: "CWB", loc: "A-01-04", qty: 3 });
    return { sku };
  },

  run: async (ctx, { sku }) => {
    // Pedido A (qty 2) — CWB cobre (disponivel 3 ≥ 2) → auto-aprova própria → reserva 2.
    const pedidoA = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 2 }],
    });
    await ctx.aguardarStatus(pedidoA.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedidoA.id, "aguardando_separacao");

    // Pedido B (qty 1) — disponivel restante 1 ≥ 1 → auto-aprova própria → reserva 1.
    // Sequencial (espera A reservar antes) pra ser determinístico.
    const pedidoB = await ctx.webhook({
      empresa: ctx.staging.empresas.netair.cnpj,
      items: [{ sku, qty: 1 }],
    });
    await ctx.aguardarStatus(pedidoB.id, "concluido");
    await ctx.aguardarStatusSeparacao(pedidoB.id, "aguardando_separacao");

    // Loc A-01-04 agora: saldo 3, reservado 3 (2 de A + 1 de B), disponivel 0.
    await ctx.assertReservado(sku, "CWB", "A-01-04", 3);

    await ctx.iniciarSeparacao(pedidoA.id);
    await ctx.iniciarSeparacao(pedidoB.id);

    // Núcleo do bug: A pega 1 da SUA reserva via parcial. Com o gate antigo isto
    // lançava 409 (disponivel 0 < 1) e o ctx.parcial estouraria — falhando o cenário.
    await ctx.parcial({ pedido: pedidoA.id, item: sku, qty: 1, loc_zerou: false });

    return { pedidoAId: pedidoA.id, pedidoBId: pedidoB.id };
  },

  assertEsperado: async (ctx, { sku }) => {
    // A: liberou R(2) inteira + S de 1 → saldo 3→2.
    await ctx.assertSaldo(sku, "CWB", "A-01-04", 2);
    // B: reserva (1) intacta — o fix devolve só a MINHA reserva, nunca a alheia.
    await ctx.assertReservado(sku, "CWB", "A-01-04", 1);
    // A reenfileirado com o que já pegou preservado.
    const item = await carregarItemPedido(ctx, sku);
    if (Number(item.quantidade_pega) !== 1) {
      throw new Error(`final: pedido A quantidade_pega deve ser 1; real=${item.quantidade_pega}`);
    }
  },
} satisfies Cenario<{ sku: string }>;

type ItemRow = { pedido_id: string; quantidade_pega: number | null; quantidade_pedida: number };

// Carrega o item do pedido A — é o único com quantidade_pedida=2 (B pediu 1).
async function carregarItemPedido(ctx: Ctx, sku: string): Promise<ItemRow> {
  const { data } = await ctx.sb
    .from("siso_pedido_itens")
    .select("pedido_id, quantidade_pega, quantidade_pedida")
    .eq("sku", sku);
  const rows = (data ?? []) as ItemRow[];
  const itemA = rows.find((r) => Number(r.quantidade_pedida) === 2);
  if (!itemA) throw new Error(`item do pedido A (sku ${sku}, qty 2) não encontrado`);
  return itemA;
}

import { runStandalone } from "../_harness/standalone";

// ESM-puro: roda só se invocado direto via `tsx <arquivo.ts>`.
const _isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();
if (_isMain) {
  void (async () => {
    const mod = await import(import.meta.url);
    await runStandalone(mod.default);
  })();
}
