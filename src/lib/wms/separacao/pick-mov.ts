import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import {
  buscarReservaPendentePorProduto,
  liberarReservaPicking,
} from "@/lib/wms/reservas-picking";
import {
  resolverProdutoWms,
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
 * 3. Se R existe: emite L (liberacao_reserva) + S pareados
 *    Se não: emite só S (com warn log — caminho legado/órfão)
 * 4. Registra ambos em siso_pedido_item_mov_links pra estorno simétrico
 *
 * Retorna { movSaidaId, movLiberacaoId } ou null se contexto incompleto
 * (sem empresa_origem ou sem galpão — ainda em modo legacy).
 *
 * ⚠ IDEMPOTÊNCIA: este helper NÃO é idempotente. Chamá-lo duas vezes pro mesmo
 * (pedido_item) emite dois pares L+S — dupla baixa no ledger. Responsabilidade
 * do caller checar `siso_pedido_itens.mov_saida_id` (ou `separacao_marcado` +
 * `quantidade_pega`) ANTES de invocar, e pular itens já picados.
 *
 * ⚠ ATOMICIDADE: ao contrário do marcar-item (que usa wms_pick_item_atomico),
 * este helper ainda emite L e S em chamadas separadas (não-atômico). Aceitável
 * porque o caller (bipar-checklist) não é termômetro de gate e o guard de dupla
 * baixa via `mov_saida_id` cobre re-execução. TODO: migrar pro RPC atômico.
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

export interface PickMovDeps {
  resolverProdutoWms: (empresaId: string, tinyId: string) => Promise<string>;
  resolverLocalizacaoWms: (galpaoId: string, codigo: string | null) => Promise<string>;
  buscarLocComMaiorSaldoNoGalpao: (galpaoId: string, produtoUuid: string) => Promise<string | null>;
  /** Resolve a R viva do pedido por (produto, galpão) — a loc vem dela. */
  buscarReservaPorProduto: (args: {
    pedido_id: string;
    produto_id: string;
    galpao_id: string;
  }) => Promise<ReservaResolvida | null>;
  liberarReservaPicking: (args: {
    reserva: { id: string; quantidade: number; localizacao_id: string; produto_id: string; galpao_id: string };
    qty: number;
    pedido_id: string;
    motivo: string;
    usuario_id: string;
    origem_detalhes: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  inserirMov: typeof inserirMovimentacao;
  registrarLinks: (links: Array<{ pedido_item_id: number; realocacao_id: null; mov_id: string; qty: number; tipo_link: "saida" | "liberacao_reserva" }>) => Promise<boolean>;
}

function defaultDeps(): PickMovDeps {
  const sb = createServiceClient();
  return {
    resolverProdutoWms,
    resolverLocalizacaoWms,
    buscarLocComMaiorSaldoNoGalpao,
    buscarReservaPorProduto: async ({ pedido_id, produto_id, galpao_id }) => {
      const r = await buscarReservaPendentePorProduto({ pedido_id, produto_id, galpao_id });
      if (!r) return null;
      return { id: r.id, quantidade: Number(r.quantidade), localizacao_id: r.localizacao_id };
    },
    // O real liberarReservaPicking espera ReservaPendenteRow completa; passamos o
    // row inteiro (com produto_id/galpao_id/localizacao_id) em runtime — funciona
    // estruturalmente. A interface narrowed simplifica os testes.
    liberarReservaPicking: liberarReservaPicking as unknown as PickMovDeps["liberarReservaPicking"],
    inserirMov: inserirMovimentacao,
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
    (await deps.resolverProdutoWms(input.empresa_origem_id, input.produto_id_tiny));

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
  }

  const tripla = {
    produto_id: produtoWmsId,
    galpao_id: input.galpao_id,
    localizacao_id: locId,
  };

  let movLiberacaoId: string | null = null;
  if (reserva) {
    const movL = await deps.liberarReservaPicking({
      reserva: {
        id: reserva.id,
        quantidade: reserva.quantidade,
        localizacao_id: locId,
        produto_id: produtoWmsId,
        galpao_id: input.galpao_id,
      },
      qty: input.qty,
      pedido_id: input.pedido_id,
      motivo: `Picking pedido #${input.pedido_numero} — libera reserva (${input.contexto ?? "pick"})`,
      usuario_id: input.usuario_id,
      origem_detalhes: {
        pedido_numero: input.pedido_numero,
        pedido_item_id: input.item_id,
        sku: input.sku,
        contexto: input.contexto ?? "pick",
      },
    });
    movLiberacaoId = movL.id;
  } else {
    logger.warn("pick-mov", "R não encontrada — S sem L par", {
      pedido_id: input.pedido_id,
      item_id: input.item_id,
      tripla,
    });
  }

  const movS = await deps.inserirMov({
    tripla,
    tipo: "S",
    qty: input.qty,
    origem_tipo: "nf_venda",
    origem_detalhes: {
      pedido_id_tiny: input.pedido_id,
      pedido_numero: input.pedido_numero,
      pedido_item_id: input.item_id,
      sku: input.sku,
      contexto: input.contexto ?? "pick",
      reserva_origem: reserva?.id ?? null,
    },
    empresa_vendedora_id: input.empresa_origem_id,
    motivo: `Picking pedido #${input.pedido_numero} — ${input.contexto ?? "pick"}`,
    usuario_id: input.usuario_id,
  });

  const links: Array<{
    pedido_item_id: number;
    realocacao_id: null;
    mov_id: string;
    qty: number;
    tipo_link: "saida" | "liberacao_reserva";
  }> = [];
  if (movLiberacaoId) {
    links.push({
      pedido_item_id: input.item_id,
      realocacao_id: null,
      mov_id: movLiberacaoId,
      qty: input.qty,
      tipo_link: "liberacao_reserva",
    });
  }
  links.push({
    pedido_item_id: input.item_id,
    realocacao_id: null,
    mov_id: movS.id,
    qty: input.qty,
    tipo_link: "saida",
  });
  const linksOk = await deps.registrarLinks(links);

  return {
    movSaidaId: movS.id,
    movLiberacaoId,
    tripla,
    linksFailed: !linksOk,
  };
}
