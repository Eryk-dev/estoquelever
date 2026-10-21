/** Regras da conferência automática: só expede embalado/conferido com coleta confirmada no ML. */
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
  target: "expedido" | null;
  reason: string;
  collected: boolean;
}

const COLLECTED_SUBSTATUSES = new Set([
  "picked_up", "authorized_by_carrier", "in_hub", "dropped_off",
]);
// Só a expedição é conferida no ML. Separação/embalagem/etiqueta são físicas e
// o ML não as enxerga: o substatus "printed" nasce quando o Tiny BAIXA a
// etiqueta (pré-download do agrupamento), não quando o WMS imprime.
const DISPATCH_STAGES = new Set(["embalado", "conferido"]);

export function isBellator(name: string): boolean {
  return name.trim().toLocaleLowerCase("pt-BR") === "bellator";
}

function collected(status: string, substatus: string | null): boolean {
  return status === "shipped" || status === "delivered" ||
    (status === "ready_to_ship" && COLLECTED_SUBSTATUSES.has(substatus ?? ""));
}

export function classifyMlReconciliation(
  order: ReconciliationSnapshot,
  evidence: MlReconciliationEvidence,
): ReconciliationDecision {
  const result: ReconciliationDecision = { target: null, reason: "sem_alteracao", collected: false };
  if (!DISPATCH_STAGES.has(order.status_separacao)) return { ...result, reason: "fora_da_expedicao" };
  if (evidence.status === "cancelled" || evidence.status === "canceled") {
    return { ...result, reason: "cancelamento_exige_tratamento" };
  }
  if (evidence.kind !== "shipment") return { ...result, reason: "pedido_sem_confirmacao_logistica" };
  result.collected = collected(evidence.status, evidence.substatus) ||
    evidence.history.some(event => collected(event.status, event.substatus));
  if (result.collected) return { ...result, target: "expedido", reason: "coleta_confirmada_ml" };
  return result;
}
