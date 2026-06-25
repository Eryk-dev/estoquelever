/**
 * Campos de auditoria de cancelamento gravados em `siso_pedidos` — alimentam a
 * aba "Cancelados" da separação (motivo + origem + quando). Um único helper pros
 * ~7 caminhos de cancelamento (webhook cliente, compras, separação, aprovação,
 * estorno) gravarem o mesmo shape, sem drift.
 */
export type OrigemCancelamento = "cliente" | "comprador" | "operador" | "sistema";

export interface CamposCancelamento {
  cancelado_origem: OrigemCancelamento;
  motivo_cancelamento: string | null;
  cancelado_em: string;
}

export function camposCancelamento(
  origem: OrigemCancelamento,
  motivo: string | null,
): CamposCancelamento {
  return {
    cancelado_origem: origem,
    motivo_cancelamento: motivo?.trim() || null,
    cancelado_em: new Date().toISOString(),
  };
}
