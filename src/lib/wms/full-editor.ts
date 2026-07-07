/**
 * Editor de itens da lane Full (FULL-06) — reconciliação atômica de reserva e
 * estoque já baixado. Cada ação (add / remove / set_qty) é uma unidade; falha
 * em qualquer passo retorna erro e o passo faz rollback pela própria primitiva.
 *
 * Estratégia de menor risco pra estoque: NÃO faz cirurgia parcial de S. Quando
 * precisa mexer no que já foi picado, DESMARCA o item inteiro (via as mesmas
 * mov-links + `wms_desmarcar_item_atomico` do checklist → S→E devolve o saldo,
 * recria a R clampada ao livre), LIBERA todas as R e RE-RESERVA o alvo. Assim o
 * ledger sempre fecha (pares S+E, R+L) e nunca há baixa parcial órfã.
 *
 * Full não usa troca de equivalência → resolve o produto WMS direto
 * (resolverProdutoWms), nunca resolverProdutoEfetivoDoItem.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { reservarAtomico, estornarReservaIndividual } from "./reservas";
import { resolverDisponibilidadeVenda } from "./vendas-disponibilidade";

const TTL_HORAS = 24 * 30; // 30 dias, alinhado com criar/aprovar/webhook.

export interface PedidoFull {
  id: string;
  status_separacao: string | null;
  separacao_full: boolean | null;
  fechado_em: string | null;
  separacao_galpao_id: string | null;
  empresa_origem_id: string | null;
  /** payload do criar — carrega o flag `preservar_linhas` ("Separar na ordem da lista"). */
  payload_original: Record<string, unknown> | null;
}

export type FullEditavel =
  | { ok: true; pedido: PedidoFull }
  | { ok: false; status: number; erro: string };

/**
 * Guard comum do editor: o pedido tem de ser Full e NÃO estar fechado. Um Full
 * fechado (aba Fechados) precisa ser reaberto antes de editar.
 */
export async function carregarFullEditavel(pedidoId: string): Promise<FullEditavel> {
  const sb = createServiceClient();
  const { data: pedido, error } = await sb
    .from("siso_pedidos")
    .select("id, status_separacao, separacao_full, fechado_em, separacao_galpao_id, empresa_origem_id, payload_original")
    .eq("id", pedidoId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, erro: error.message };
  if (!pedido) return { ok: false, status: 404, erro: "pedido não encontrado" };
  if (!pedido.separacao_full) return { ok: false, status: 400, erro: "pedido não é Full" };
  if (pedido.fechado_em != null) {
    return { ok: false, status: 400, erro: "Full fechado — reabra antes de editar" };
  }
  return { ok: true, pedido: pedido as PedidoFull };
}

/**
 * Reserva PARCIAL de `qty` pro item: distribui pelas locs disponíveis (maior
 * saldo primeiro, via resolverDisponibilidadeVenda) e reserva o que der. O que
 * faltar fica pendente pro operador resolver no picking. Espelha o loop do
 * /full/criar. Retorna quanto foi efetivamente reservado.
 */
export async function reservarParcialItem(opts: {
  produtoWms: string;
  galpaoId: string;
  qty: number;
  pedidoId: string;
  usuarioId?: string;
}): Promise<{ reservado: number; reservaIds: string[] }> {
  const sb = createServiceClient();
  const disp = await resolverDisponibilidadeVenda(sb as never, {
    produto_id: opts.produtoWms,
    galpao_id: opts.galpaoId,
  });

  const reservaIds: string[] = [];
  let restante = opts.qty;
  for (const sug of disp.sugestoes ?? []) {
    if (restante <= 0) break;
    const qtyLoc = Math.min(restante, sug.disponivel);
    if (qtyLoc <= 0) continue;
    const rid = await reservarAtomico({
      tripla: { produto_id: opts.produtoWms, galpao_id: opts.galpaoId, localizacao_id: sug.localizacao_id },
      qty: qtyLoc,
      pedido_id: opts.pedidoId,
      ttl_horas: TTL_HORAS,
      usuario_id: opts.usuarioId,
    });
    reservaIds.push(rid);
    restante -= qtyLoc;
  }
  return { reservado: opts.qty - restante, reservaIds };
}

/**
 * Alvo de re-reserva do PRODUTO no pedido: Σ max(0, pedida − pega) sobre TODAS
 * as linhas do produto (com preservar_linhas o mesmo produto pode ter N rows).
 * A R vive por (pedido, produto, galpão, loc) — nunca por linha — então todo
 * caminho "liberar tudo + re-reservar" tem de re-reservar o produto INTEIRO,
 * senão a edição de uma linha evapora a reserva das irmãs.
 *
 * `excluirItemId`: linha em edição/remoção — o caller soma a parcela projetada
 * dela por fora (remove: 0; set_qty: novaQty − picado projetado).
 */
export async function alvoReservaProduto(opts: {
  pedidoId: string;
  tinyProdutoId: number;
  excluirItemId?: number;
}): Promise<number> {
  const sb = createServiceClient();
  const { data: rows } = await sb
    .from("siso_pedido_itens")
    .select("id, quantidade_pedida, quantidade_pega")
    .eq("pedido_id", opts.pedidoId)
    .eq("produto_id", opts.tinyProdutoId);

  let alvo = 0;
  for (const r of rows ?? []) {
    if (opts.excluirItemId != null && Number(r.id) === opts.excluirItemId) continue;
    const pedida = Number(r.quantidade_pedida ?? 0);
    const pega = Number(r.quantidade_pega ?? 0);
    alvo += Math.max(0, pedida - pega);
  }
  return alvo;
}

interface ReservaVivaRow {
  id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  quantidade: number;
}

/**
 * Lista as R vivas do item (mov tipo R, origem_tipo='reserva_pedido',
 * origem_id=pedido, produto+galpão) que ainda NÃO foram liberadas (sem L com
 * estorno_de=R.id). Cobre as R do criar/add E as recriadas pelo desmarcar
 * (também origem_tipo='reserva_pedido').
 */
async function listarReservasVivas(opts: {
  pedidoId: string;
  produtoWms: string;
  galpaoId: string;
}): Promise<ReservaVivaRow[]> {
  const sb = createServiceClient();
  const { data: candidatas } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("origem_id", opts.pedidoId)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R")
    .eq("produto_id", opts.produtoWms)
    .eq("galpao_id", opts.galpaoId);

  const rows = (candidatas ?? []) as ReservaVivaRow[];
  if (rows.length === 0) return [];

  const { data: liberadas } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", rows.map((r) => r.id))
    .eq("tipo", "L");
  const liberadasSet = new Set(
    (liberadas ?? []).map((l) => l.estorno_de as string | null).filter((x): x is string => !!x),
  );
  return rows.filter((r) => !liberadasSet.has(r.id));
}

/**
 * Libera TODAS as R vivas do item (cada uma inteira, via estornarReservaIndividual
 * — idempotente). Retorna quantas liberou.
 */
export async function liberarTodasReservas(opts: {
  pedidoId: string;
  produtoWms: string;
  galpaoId: string;
  usuarioId: string;
}): Promise<number> {
  const vivas = await listarReservasVivas({
    pedidoId: opts.pedidoId,
    produtoWms: opts.produtoWms,
    galpaoId: opts.galpaoId,
  });
  for (const r of vivas) {
    await estornarReservaIndividual({
      reserva_id: r.id,
      motivo: "liberar_reservas_admin",
      usuario_id: opts.usuarioId,
    });
  }
  return vivas.length;
}

/**
 * Desmarca (un-pica) o item INTEIRO reusando as mov-links do checklist:
 * pra cada S link chama `wms_desmarcar_item_atomico` (S→E devolve saldo + recria
 * R clampada ao livre), depois apaga as links. NÃO reseta os campos do item nem
 * o deleta — o caller decide (remove deleta; set_qty reseta+re-reserva).
 *
 * Espelha o ramo de desmarcar do POST /separacao/marcar-item (mesma RPC, mesmo
 * rateio por p_qty_link pra S consolidada). Idempotente no retry.
 */
export async function desmarcarItemFull(opts: {
  itemId: number;
  pedidoId: string;
  pedidoNumero?: string | null;
  usuarioId: string;
}): Promise<void> {
  const sb = createServiceClient();
  const { data: links } = await sb
    .from("siso_pedido_item_mov_links")
    .select("id, mov_id, tipo_link, qty")
    .eq("pedido_item_id", opts.itemId)
    .in("tipo_link", ["saida", "liberacao_reserva"]);

  const movsS = (links ?? [])
    .filter((l) => l.tipo_link === "saida")
    .sort((a, b) => Number(a.id) - Number(b.id));
  const movsL = (links ?? [])
    .filter((l) => l.tipo_link === "liberacao_reserva")
    .sort((a, b) => Number(a.id) - Number(b.id));

  for (let i = 0; i < movsS.length; i++) {
    const { error } = await sb.rpc("wms_desmarcar_item_atomico", {
      p_mov_s_id: movsS[i].mov_id,
      p_mov_l_id: movsL[i]?.mov_id ?? null,
      p_pedido_id: opts.pedidoId,
      p_usuario_id: opts.usuarioId,
      p_motivo: `Editor Full — desmarcar item ${opts.itemId}`,
      p_qty_link: Number(movsS[i].qty),
      p_pedido_item_id: opts.itemId,
    });
    if (error) {
      throw new Error(`desmarcar atômico falhou (mov ${movsS[i].mov_id}): ${error.message}`);
    }
  }

  if ((links ?? []).length > 0) {
    await sb
      .from("siso_pedido_item_mov_links")
      .delete()
      .in("id", (links ?? []).map((l) => l.id as string));
  }
}

/**
 * Reabre o pedido pra `em_separacao` se estiver em `separado` (uma edição criou
 * pendência). UPDATE direto de status — Full bypassa cutover, então é seguro
 * (não passa por voltar-etapa nem dispara reverterCutover).
 */
export async function reabrirSeSeparado(pedido: PedidoFull): Promise<void> {
  if (pedido.status_separacao !== "separado") return;
  const sb = createServiceClient();
  await sb
    .from("siso_pedidos")
    .update({ status_separacao: "em_separacao", separacao_concluida_em: null })
    .eq("id", pedido.id);
}

/** Log helper padrão do editor. */
export function logEditor(msg: string, meta: Record<string, unknown>) {
  logger.info("wms.full-editor", msg, meta);
}
