import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { buscarReservaPendentePorProduto } from "@/lib/wms/reservas-picking";
import {
  resolverProdutoWmsFlex,
  resolverLocalizacaoWms,
  buscarLocComMaiorSaldoNoGalpao,
} from "@/lib/separacao/wms-mapping";

/**
 * Centraliza o par (L?+S) gerado quando um item é "picado" — seja via
 * checkbox (marcar-item), bipe individual (bipar), ou bipe agregado de
 * checklist (bipar-checklist). Sem este helper, o caminho do checklist
 * pula o ledger inteiramente — bug ALTO #2.5 (dupla baixa pós-cutover).
 *
 * O caller passa contexto do item (pedido, sku, qty, usuario) e o helper:
 * 1. Resolve produto WMS via empresa+tinyProdutoId
 * 2. Resolve loc destino A PARTIR DA R VIVA do pedido (Fase 1.4 — antes lia o
 *    snapshot estale siso_pedido_item_estoques; agora a loc vem da reserva que
 *    `aprovar` criou na posição com saldo). Sem R, cai pra loc com maior saldo
 *    vivo → DEFAULT-PICKING.
 * 3. Emite o par L (liberacao_reserva) + S (nf_venda) via a RPC ATÔMICA
 *    `wms_pick_item_atomico` (mesma do marcar-item). Sem R → S-only (passa
 *    p_reserva_id=null; loc da tripla resolvida).
 * 4. Registra ambos em siso_pedido_item_mov_links pra estorno simétrico
 *
 * Retorna { movSaidaId, movLiberacaoId } ou null se contexto incompleto
 * (sem empresa_origem ou sem galpão — ainda em modo legacy).
 *
 * ✅ ATOMICIDADE + DOUBLE-TAP (fix BUG-06/07): o par L+S agora sai numa única
 * RPC `wms_pick_item_atomico`. Com reserva, a RPC trava a R (FOR UPDATE) e
 * rejeita 2ª chamada concorrente com 'reserva já liberada' (ERRCODE 22023) —
 * fecha a corrida de double-tap do scanner e elimina a janela L-sem-S. O RPC
 * também seta origem_id=pedido na S → o reverter-cutover acha a S pelo Caminho 1.
 *
 * ⚠ IDEMPOTÊNCIA (caminho SEM reserva): o ramo S-only (OC "bipa onde achou")
 * NÃO passa idempotency_key, então double-tap simultâneo sem R ainda pode
 * duplicar a S. O guard `mov_saida_id` no item cobre o RETRY sequencial, não a
 * corrida. Caminho raro (item sem reserva viva).
 *
 * ⚠ NULL RETURN: 3 casos silenciosos: empresa_origem ausente, galpao_id ausente,
 * qty <= 0. Caller que precise distinguir deve validar `input` antes.
 *
 * ⚠ LINKS BEST-EFFORT: falha ao inserir em `siso_pedido_item_mov_links` é
 * logada como warn mas NÃO falha o helper (observável via `linksFailed`).
 */

export interface PickMovInput {
  empresa_origem_id: string | null;
  galpao_id: string | null;
  pedido_id: string;
  pedido_numero: string;
  item_id: number;
  produto_id_tiny: string;
  /**
   * Troca de equivalência: uuid WMS do produto FÍSICO quando o item teve
   * troca aprovada — curto-circuita a resolução via bridge tiny.
   */
  produto_wms_substituto_id?: string | null;
  sku: string;
  qty: number;
  usuario_id: string;
  /** Contexto descritivo pro origem_detalhes (ex: "checkbox", "bipe", "checklist"). */
  contexto?: string;
}

export interface PickMovResult {
  movSaidaId: string;
  movLiberacaoId: string | null;
  tripla: { produto_id: string; galpao_id: string; localizacao_id: string };
  /** true se a tentativa de inserir em siso_pedido_item_mov_links falhou (warn-logado). */
  linksFailed: boolean;
}

interface ReservaResolvida {
  id: string;
  quantidade: number;
  localizacao_id: string;
}

/** Resultado bruto da RPC wms_pick_item_atomico. */
interface PickAtomicoResult {
  mov_l_id: string | null;
  mov_s_id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
}

export interface PickMovDeps {
  resolverProdutoWms: (empresaId: string, tinyId: string, sku?: string | null) => Promise<string>;
  resolverLocalizacaoWms: (galpaoId: string, codigo: string | null) => Promise<string>;
  buscarLocComMaiorSaldoNoGalpao: (galpaoId: string, produtoUuid: string) => Promise<string | null>;
  /** Resolve a R viva do pedido por (produto, galpão) — a loc vem dela. */
  buscarReservaPorProduto: (args: {
    pedido_id: string;
    produto_id: string;
    galpao_id: string;
  }) => Promise<ReservaResolvida | null>;
  /**
   * Emite o par L+S (ou S-only quando reserva_id=null) atomicamente via
   * wms_pick_item_atomico. Lança em falha (ex.: 'reserva já liberada' no
   * double-tap) — o caller trata como pick-falha.
   */
  pickItemAtomico: (args: {
    reserva_id: string | null;
    produto_id: string;
    galpao_id: string;
    localizacao_id: string;
    qty: number;
    pedido_id: string;
    empresa_vendedora_id: string;
    usuario_id: string;
    origem_detalhes: Record<string, unknown>;
    motivo: string;
  }) => Promise<PickAtomicoResult>;
  registrarLinks: (links: Array<{ pedido_item_id: number; realocacao_id: null; mov_id: string; qty: number; tipo_link: "saida" | "liberacao_reserva" }>) => Promise<boolean>;
}

function defaultDeps(): PickMovDeps {
  const sb = createServiceClient();
  return {
    resolverProdutoWms: (empresaId, tinyId, sku) =>
      resolverProdutoWmsFlex(empresaId, { tinyProdutoId: tinyId, sku }),
    resolverLocalizacaoWms,
    buscarLocComMaiorSaldoNoGalpao,
    buscarReservaPorProduto: async ({ pedido_id, produto_id, galpao_id }) => {
      const r = await buscarReservaPendentePorProduto({ pedido_id, produto_id, galpao_id });
      if (!r) return null;
      return { id: r.id, quantidade: Number(r.quantidade), localizacao_id: r.localizacao_id };
    },
    pickItemAtomico: async (a) => {
      const { data, error } = await sb.rpc("wms_pick_item_atomico", {
        p_reserva_id: a.reserva_id,
        p_produto_id: a.produto_id,
        p_galpao_id: a.galpao_id,
        p_localizacao_id: a.localizacao_id,
        p_qty: a.qty,
        p_pedido_id: a.pedido_id,
        p_empresa_vendedora_id: a.empresa_vendedora_id,
        p_usuario_id: a.usuario_id,
        p_origem_detalhes: a.origem_detalhes,
        p_motivo: a.motivo,
      });
      if (error) throw new Error(error.message);
      return data as PickAtomicoResult;
    },
    registrarLinks: async (links) => {
      if (links.length === 0) return true;
      const { error } = await sb.from("siso_pedido_item_mov_links").insert(links);
      if (error) {
        logger.warn("pick-mov", "falhou criar links (continua)", { error: error.message });
        return false;
      }
      return true;
    },
  };
}

export async function pickMovPicking(
  input: PickMovInput,
  deps: PickMovDeps = defaultDeps(),
): Promise<PickMovResult | null> {
  if (!input.empresa_origem_id || !input.galpao_id || input.qty <= 0) {
    return null;
  }

  const produtoWmsId =
    input.produto_wms_substituto_id ??
    (await deps.resolverProdutoWms(input.empresa_origem_id, input.produto_id_tiny, input.sku));

  // Loc do pick vem da R VIVA do pedido (posição reservada por aprovar). Sem R,
  // cai pra loc com maior saldo vivo → DEFAULT-PICKING.
  const reserva = await deps.buscarReservaPorProduto({
    pedido_id: input.pedido_id,
    produto_id: produtoWmsId,
    galpao_id: input.galpao_id,
  });

  let locId: string;
  if (reserva) {
    locId = reserva.localizacao_id;
  } else {
    const liveLocId = await deps.buscarLocComMaiorSaldoNoGalpao(input.galpao_id, produtoWmsId);
    locId = liveLocId ?? (await deps.resolverLocalizacaoWms(input.galpao_id, null));
    logger.warn("pick-mov", "R não encontrada — S-only (sem L par)", {
      pedido_id: input.pedido_id,
      item_id: input.item_id,
      tripla: { produto_id: produtoWmsId, galpao_id: input.galpao_id, localizacao_id: locId },
    });
  }

  // Par L+S (ou S-only) atômico. Com reserva, a RPC trava a R e rejeita
  // double-tap concorrente ('reserva já liberada') — lança, o caller trata
  // como pick-falha e NÃO marca o item (sem dupla baixa).
  const pick = await deps.pickItemAtomico({
    reserva_id: reserva?.id ?? null,
    produto_id: produtoWmsId,
    galpao_id: input.galpao_id,
    localizacao_id: locId,
    qty: input.qty,
    pedido_id: input.pedido_id,
    empresa_vendedora_id: input.empresa_origem_id,
    usuario_id: input.usuario_id,
    origem_detalhes: {
      pedido_id_tiny: input.pedido_id,
      pedido_numero: input.pedido_numero,
      pedido_item_id: input.item_id,
      sku: input.sku,
      contexto: input.contexto ?? "pick",
      reserva_origem: reserva?.id ?? null,
    },
    motivo: `Picking pedido #${input.pedido_numero} — ${input.contexto ?? "pick"}`,
  });

  // A tripla autoritativa vem da RPC (com reserva, a loc é a da R).
  const tripla = {
    produto_id: pick.produto_id,
    galpao_id: pick.galpao_id,
    localizacao_id: pick.localizacao_id,
  };

  const links: Array<{
    pedido_item_id: number;
    realocacao_id: null;
    mov_id: string;
    qty: number;
    tipo_link: "saida" | "liberacao_reserva";
  }> = [];
  if (pick.mov_l_id) {
    links.push({
      pedido_item_id: input.item_id,
      realocacao_id: null,
      mov_id: pick.mov_l_id,
      qty: input.qty,
      tipo_link: "liberacao_reserva",
    });
  }
  links.push({
    pedido_item_id: input.item_id,
    realocacao_id: null,
    mov_id: pick.mov_s_id,
    qty: input.qty,
    tipo_link: "saida",
  });
  const linksOk = await deps.registrarLinks(links);

  return {
    movSaidaId: pick.mov_s_id,
    movLiberacaoId: pick.mov_l_id,
    tripla,
    linksFailed: !linksOk,
  };
}
