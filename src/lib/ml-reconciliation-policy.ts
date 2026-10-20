/** Regras da conferência automática. Nunca infere coleta pela idade ou etiqueta. */
export interface MlTrackingEvent {
  date: string;
  status: string;
  substatus: string | null;
}

export interface MlReconciliationEvidence {
  kind: "shipment" | "order";
  resourceId: string;
  orderReference: string | null;
  connectionId: string;
  sellerId: string;
  checkedAt: string;
  status: string;
  substatus: string | null;
  noShipping: boolean;
  history: MlTrackingEvent[];
}

export interface ReconciliationSnapshot {
  id: string;
  empresa_origem_id: string;
  id_pedido_ecommerce: string | null;
  ml_shipment_id: string | null;
  status_separacao: string;
  etiqueta_status: string | null;
  data: string | null;
  decisao_final: string | null;
  impressao_em: string | null;
  atividade_em: string;
  [key: string]: unknown;
}

export interface ReconciliationDecision {
  target: "expedido" | "embalado" | "aguardando_separacao" | "validacao_oc" | null;
  reason: string;
  collected: boolean;
  printed: boolean;
}

const COLLECTED_SUBSTATUSES = new Set([
  "picked_up", "authorized_by_carrier", "in_hub", "dropped_off",
]);
const EARLY_STAGES = new Set([
  "aguardando_nf", "aguardando_separacao", "validacao_oc", "em_separacao", "separado",
]);
export const STALE_PICKING_MS = 2 * 60 * 60 * 1000;

export function isBellator(name: string): boolean {
  return name.trim().toLocaleLowerCase("pt-BR") === "bellator";
}

function collected(status: string, substatus: string | null): boolean {
  return status === "shipped" || status === "delivered" ||
    (status === "ready_to_ship" && COLLECTED_SUBSTATUSES.has(substatus ?? ""));
}

/** Datas de negócio usam São Paulo; o limiar é estritamente maior que 20 dias. */
export function orderAgeDays(date: string | null, now: Date): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000;
  return Number.isFinite(age) ? age : null;
}

export function classifyMlReconciliation(
  order: ReconciliationSnapshot,
  evidence: MlReconciliationEvidence,
  now = new Date(),
): ReconciliationDecision {
  const result: ReconciliationDecision = {
    target: null, reason: "sem_alteracao", collected: false, printed: false,
  };
  if (order.status_separacao === "expedido") return result;
  if (evidence.status === "cancelled" || evidence.status === "canceled") {
    return { ...result, reason: "cancelamento_exige_tratamento" };
  }
  if (evidence.kind === "shipment") {
    result.collected = collected(evidence.status, evidence.substatus) ||
      evidence.history.some(event => collected(event.status, event.substatus));
    if (result.collected) return { ...result, target: "expedido", reason: "coleta_confirmada_ml" };
    if (!["pending", "handling", "ready_to_ship"].includes(evidence.status)) {
      return { ...result, reason: "situacao_logistica_exige_tratamento" };
    }
  } else if (evidence.status !== "paid" || !evidence.noShipping) {
    return { ...result, reason: "pedido_sem_confirmacao_logistica" };
  }

  result.printed = order.etiqueta_status === "impresso" || !!order.impressao_em ||
    evidence.substatus === "printed" ||
    evidence.history.some(event => event.substatus === "printed");

  // Conferência física/embalagem concluída não retrocede por uma consulta ML.
  if (!EARLY_STAGES.has(order.status_separacao)) return result;
  if (result.printed) return { ...result, target: "embalado", reason: "etiqueta_impressa" };

  const age = orderAgeDays(order.data, now);
  if (evidence.kind === "order" && evidence.noShipping && age !== null && age > 20) {
    return { ...result, target: "embalado", reason: "sem_rastreio_mais_20_dias" };
  }
  // Só devolve separação abandonada. Não interrompe a wave que está trabalhando.
  const lastActivity = Date.parse(order.atividade_em);
  if (["em_separacao", "separado"].includes(order.status_separacao) &&
      Number.isFinite(lastActivity) && now.getTime() - lastActivity >= STALE_PICKING_MS) {
    return {
      ...result,
      target: order.decisao_final === "oc" ? "validacao_oc" : "aguardando_separacao",
      reason: "sem_impressao_sem_atividade_2h",
    };
  }
  return result;
}
