/**
 * Helpers de reserva durante picking — paream S/E (saída/estorno) com
 * L/R (liberação/reserva) sobre as R criadas pelo aprovar.
 *
 * Contexto:
 *   - `pedidos/aprovar` cria 1 R por item do pedido em loc com maior saldo.
 *   - `marcar-item` / `parcial` / `marcar-realocacao` consomem essas R
 *     emitindo L (estorno_de=R.id) + S no mesmo evento.
 *   - Cascade do parcial cria R nova em locs destino (segue rastreável
 *     via origem_tipo='reserva_pedido' + origem_id=pedido_id).
 *
 * Por que `estorno_de=R.id` no L?
 *   `execution-worker-wms.ts` (cutover) filtra reservas "já convertidas"
 *   olhando `EXISTS (L WHERE estorno_de=R.id)`. Marcar essa flag aqui
 *   garante que o cutover no `concluir` vire no-op e não duplique a saída.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "./ledger";
import type { Tripla, Movimentacao } from "./types";

export interface ReservaPendenteRow {
  id: string;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  quantidade: number;
}

/**
 * Busca a R do pedido na tripla informada que ainda não foi liberada
 * (sem L com estorno_de=R.id).
 *
 * Retorna null se não houver. Em caso de múltiplos matches (não esperado
 * sob "1 R por item" do D4), retorna a primeira e loga warn — debugger
 * pode investigar duplicação no aprovar.
 */
export async function buscarReservaPendente(opts: {
  pedido_id: string;
  tripla: Tripla;
}): Promise<ReservaPendenteRow | null> {
  const sb = createServiceClient();

  const { data: candidates, error } = await sb
    .from("siso_movimentacoes")
    .select("id, produto_id, galpao_id, localizacao_id, quantidade")
    .eq("origem_id", opts.pedido_id)
    .eq("origem_tipo", "reserva_pedido")
    .eq("tipo", "R")
    .eq("produto_id", opts.tripla.produto_id)
    .eq("galpao_id", opts.tripla.galpao_id)
    .eq("localizacao_id", opts.tripla.localizacao_id);

  if (error) {
    logger.error("wms.reservas-picking", "falha ao buscar reserva pendente", {
      error: error.message,
      pedido_id: opts.pedido_id,
      tripla: opts.tripla,
    });
    throw error;
  }

  if (!candidates || candidates.length === 0) return null;

  const reservaIds = (candidates as ReservaPendenteRow[]).map((r) => r.id);
  const { data: liberadas } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .in("estorno_de", reservaIds)
    .eq("tipo", "L");

  const liberadasSet = new Set<string>(
    (liberadas ?? [])
      .map((l) => l.estorno_de as string | null)
      .filter((id): id is string => !!id),
  );

  const pendentes = (candidates as ReservaPendenteRow[]).filter(
    (r) => !liberadasSet.has(r.id),
  );

  if (pendentes.length === 0) return null;
  if (pendentes.length > 1) {
    logger.warn("wms.reservas-picking", "múltiplas R pendentes na mesma tripla", {
      pedido_id: opts.pedido_id,
      tripla: opts.tripla,
      count: pendentes.length,
      ids: pendentes.map((r) => r.id),
    });
  }
  return pendentes[0];
}

/**
 * Emite L apontando pra R (estorno_de=R.id) que libera `qty` do reservado.
 * `qty` pode ser menor, igual ou maior que R.quantidade — `wms_inserir_movimentacao`
 * valida que `reservado >= qty` no momento da inserção.
 *
 * Use `qty` igual à R.quantidade pra liberar 100% da reserva (caso parcial
 * com loc_zerou: a R original em A perdeu sentido inteira, mesmo se só
 * pegamos X<Y unidades).
 *
 * Retorna a mov L criada.
 */
export async function liberarReservaPicking(opts: {
  reserva: ReservaPendenteRow;
  qty: number;
  pedido_id: string;
  motivo: string;
  usuario_id?: string;
  origem_detalhes?: Record<string, unknown>;
}): Promise<Movimentacao> {
  return inserirMovimentacao({
    tripla: {
      produto_id: opts.reserva.produto_id,
      galpao_id: opts.reserva.galpao_id,
      localizacao_id: opts.reserva.localizacao_id,
    },
    tipo: "L",
    qty: opts.qty,
    origem_tipo: "liberacao_reserva",
    origem_id: opts.pedido_id,
    origem_detalhes: {
      ...(opts.origem_detalhes ?? {}),
      reserva_origem: opts.reserva.id,
      contexto: "picking",
    },
    estorno_de: opts.reserva.id,
    motivo: opts.motivo,
    usuario_id: opts.usuario_id,
  });
}

/**
 * Cria uma R nova durante cascade do parcial — destino do remanejamento
 * quando a loc original esvaziou. Diferente do `aprovar` (que usa
 * `wms_reservar_atomico` via RPC com TTL longo), aqui inserimos direto
 * via `inserirMovimentacao` mantendo a convenção de origem_id=pedido_id
 * + origem_tipo='reserva_pedido' que o cutover consome.
 */
export async function criarReservaCascade(opts: {
  tripla: Tripla;
  qty: number;
  pedido_id: string;
  ttl_horas?: number;
  usuario_id?: string;
  motivo?: string;
  origem_detalhes?: Record<string, unknown>;
}): Promise<Movimentacao> {
  const ttlHoras = opts.ttl_horas ?? 24 * 30;
  const expira = new Date(Date.now() + ttlHoras * 3600 * 1000).toISOString();
  return inserirMovimentacao({
    tripla: opts.tripla,
    tipo: "R",
    qty: opts.qty,
    origem_tipo: "reserva_pedido",
    origem_id: opts.pedido_id,
    origem_detalhes: {
      ...(opts.origem_detalhes ?? {}),
      contexto: "cascade_parcial",
    },
    expira_em: expira,
    motivo: opts.motivo ?? `Reserva cascade pedido ${opts.pedido_id}`,
    usuario_id: opts.usuario_id,
  });
}

/**
 * Estorna uma R do cascade (cria L com estorno_de=R.id via ledger.estornar).
 * Usado no `desfazer-parcial` quando reverte cascade que ainda não foi pego.
 */
export async function estornarReservaCascade(opts: {
  reserva_mov_id: string;
  usuario_id: string;
  motivo?: string;
}): Promise<Movimentacao> {
  return estornarMovimentacao({
    mov_id: opts.reserva_mov_id,
    usuario_id: opts.usuario_id,
    motivo: opts.motivo ?? "Estorno R cascade (desfazer-parcial)",
  });
}

/**
 * Estorna uma L de liberação de reserva criando uma R nova ("ressuscita" a
 * reserva). Usado no desmarcar do checkbox de separação — quando operador
 * retorna o item, o reservado precisa voltar.
 *
 * Por que helper específico em vez de `estornarMovimentacao` genérico?
 *   L de liberação carrega `estorno_de=R.id` por convenção arquitetural
 *   (cutover do execution-worker filtra reservas "já convertidas" via
 *   EXISTS L WHERE estorno_de=R.id). Mas a guarda em ledger.estornarMovimentacao
 *   confunde isso com "mov já é um estorno contábil" e rejeita o estorno.
 *
 * E mesmo se a guarda fosse relaxada, o `estornarMovimentacao` genérico
 * criaria a R nova com `origem_tipo='estorno'` — e `buscarReservaPendente`
 * filtra por `origem_tipo='reserva_pedido'`. A R nova ficaria invisível.
 * Aqui criamos com origem_tipo='reserva_pedido' + origem_id=pedido_id pra
 * que a próxima re-marcação encontre essa reserva ressuscitada.
 *
 * Idempotente: se a L já foi estornada (existe R com estorno_de=L.id),
 * retorna a R existente sem criar duplicata.
 */
export async function estornarLiberacaoReserva(opts: {
  liberacao_mov_id: string;
  pedido_id: string;
  usuario_id: string;
  motivo?: string;
  ttl_horas?: number;
}): Promise<Movimentacao> {
  const sb = createServiceClient();

  const { data: l } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("id", opts.liberacao_mov_id)
    .single();
  if (!l) {
    throw new Error(`L ${opts.liberacao_mov_id} não encontrada`);
  }
  if (l.tipo !== "L" || l.origem_tipo !== "liberacao_reserva") {
    throw new Error(
      `mov ${opts.liberacao_mov_id} não é uma L de liberação_reserva (tipo=${l.tipo}, origem=${l.origem_tipo})`,
    );
  }

  const { data: existente } = await sb
    .from("siso_movimentacoes")
    .select("*")
    .eq("estorno_de", opts.liberacao_mov_id)
    .eq("tipo", "R")
    .maybeSingle();
  if (existente) {
    return existente as unknown as Movimentacao;
  }

  // wms_inserir_movimentacao exige expira_em em movs tipo R (CHECK constraint).
  // Alinhado com criarReservaCascade e webhook-processor-wms: 30 dias.
  const ttlHoras = opts.ttl_horas ?? 24 * 30;
  const expira = new Date(Date.now() + ttlHoras * 3600 * 1000).toISOString();

  return inserirMovimentacao({
    tripla: {
      produto_id: l.produto_id as string,
      galpao_id: l.galpao_id as string,
      localizacao_id: l.localizacao_id as string,
    },
    tipo: "R",
    qty: Number(l.quantidade),
    origem_tipo: "reserva_pedido",
    origem_id: opts.pedido_id,
    origem_detalhes: {
      contexto: "estorno_liberacao",
      estorno_de_L: opts.liberacao_mov_id,
    },
    expira_em: expira,
    estorno_de: opts.liberacao_mov_id,
    motivo: opts.motivo ?? `Ressuscita reserva — estorno de L ${opts.liberacao_mov_id}`,
    usuario_id: opts.usuario_id,
  });
}
