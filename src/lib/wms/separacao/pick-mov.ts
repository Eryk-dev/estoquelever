import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "@/lib/wms/ledger";
import {
  buscarReservaPendente,
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
 * 2. Resolve loc destino (snapshot → live → DEFAULT-PICKING)
 * 3. Procura R pendente daquela tripla pro pedido
 * 4. Se R existe: emite L (liberacao_reserva) + S pareados
 *    Se não: emite só S (com warn log — caminho legado/órfão)
 * 5. Registra ambos em siso_pedido_item_mov_links pra estorno simétrico
 *
 * Retorna { movSaidaId, movLiberacaoId } ou null se contexto incompleto
 * (sem empresa_origem ou sem galpão — ainda em modo legacy).
 *
 * ⚠ IDEMPOTÊNCIA: este helper NÃO é idempotente. Chamá-lo duas vezes pro mesmo
 * (pedido_item) emite dois pares L+S — dupla baixa no ledger. Responsabilidade
 * do caller checar `siso_pedido_itens.mov_saida_id` (ou `separacao_marcado` +
 * `quantidade_pega`) ANTES de invocar, e pular itens já picados.
 *
 * ⚠ NULL RETURN: tem 3 casos distintos e silenciosos:
 *   1. empresa_origem_id ausente (legacy mode)
 *   2. galpao_id ausente (legacy mode)
 *   3. qty <= 0 (no-op)
 * Caller que precise distinguir esses casos deve validar `input` antes da chamada.
 *
 * ⚠ LINKS BEST-EFFORT: falha ao inserir em `siso_pedido_item_mov_links` é
 * logada como warn mas NÃO falha o helper. O caller observa via `linksFailed`
 * no resultado se precisar tomar ação compensatória (rollback de mov, retry, ...).
 */

export interface PickMovInput {
  empresa_origem_id: string | null;
  galpao_id: string | null;
  pedido_id: string;
  pedido_numero: string;
  item_id: number;
  produto_id_tiny: string;
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

export interface PickMovDeps {
  resolverProdutoWms: (empresaId: string, tinyId: string) => Promise<string>;
  resolverLocalizacaoWms: (galpaoId: string, codigo: string | null) => Promise<string>;
  buscarLocComMaiorSaldoNoGalpao: (galpaoId: string, produtoUuid: string) => Promise<string | null>;
  buscarSnapshotLoc: (pedidoId: string, produtoIdTiny: string, empresaId: string) => Promise<string | null>;
  buscarReservaPendente: (args: { pedido_id: string; tripla: { produto_id: string; galpao_id: string; localizacao_id: string } }) => Promise<{ id: string; quantidade: number } | null>;
  liberarReservaPicking: (args: {
    reserva: { id: string; quantidade: number };
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
    buscarSnapshotLoc: async (pedidoId, produtoIdTiny, empresaId) => {
      const { data } = await sb
        .from("siso_pedido_item_estoques")
        .select("localizacao")
        .eq("pedido_id", pedidoId)
        .eq("produto_id", produtoIdTiny)
        .eq("empresa_id", empresaId)
        .maybeSingle();
      return (data?.localizacao as string | null | undefined) ?? null;
    },
    buscarReservaPendente,
    // O real liberarReservaPicking espera ReservaPendenteRow (com produto_id/galpao_id/localizacao_id);
    // a interface narrowed pro helper só expõe { id, quantidade } pra simplificar os testes — em runtime
    // passamos o row inteiro retornado por buscarReservaPendente, então funciona estruturalmente.
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

  const produtoWmsId = await deps.resolverProdutoWms(
    input.empresa_origem_id,
    input.produto_id_tiny,
  );

  const snapshotLoc = await deps.buscarSnapshotLoc(
    input.pedido_id,
    input.produto_id_tiny,
    input.empresa_origem_id,
  );

  let locId: string;
  if (snapshotLoc) {
    locId = await deps.resolverLocalizacaoWms(input.galpao_id, snapshotLoc);
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
  const reserva = await deps.buscarReservaPendente({ pedido_id: input.pedido_id, tripla });
  if (reserva) {
    const movL = await deps.liberarReservaPicking({
      reserva,
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
