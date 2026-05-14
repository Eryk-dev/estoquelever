import type { EstadoEstoqueSku, Demanda, PlanoMiniSwap } from "./mini-swap-types";

export interface PlanejarInput {
  galpao_id: string;
  pedido_ids: string[];
  estado: EstadoEstoqueSku[];
  demandas: Demanda[];
}

export function planejarMiniSwap(input: PlanejarInput): PlanoMiniSwap {
  const plano: PlanoMiniSwap = {
    galpao_id: input.galpao_id,
    pedido_ids: input.pedido_ids,
    demandas_planejadas: [],
    demandas_skipadas: [],
  };

  for (const demanda of input.demandas) {
    const estadoSku = input.estado.find((e) => e.produto_id === demanda.produto_id);
    if (!estadoSku) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "sem_estado" });
      continue;
    }
    const locsPicadora = estadoSku.linhas.filter(
      (l) => l.empresa_dona_id === demanda.empresa_picadora_id && l.saldo > 0,
    );
    if (locsPicadora.length <= 1) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "ja_consolidado" });
      continue;
    }
    // TODO Tasks seguintes: lógica de planejamento real
    plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "nao_implementado_ainda" });
  }

  return plano;
}
