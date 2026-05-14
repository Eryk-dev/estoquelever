import type {
  EstadoEstoqueSku, Demanda, PlanoMiniSwap, PlanoDemanda,
  OperacaoSwap, OperacaoEmprestimo,
} from "./mini-swap-types";

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
    // ─── Encontrar contrapartida F: empresa com mais saldo em alguma loc do galpão ───
    type Candidata = { loc_id: string; loc_codigo: string; empresa_id: string; saldo: number };
    const candidatas: Candidata[] = estadoSku.linhas
      .filter((l) => l.empresa_dona_id !== demanda.empresa_picadora_id && l.saldo > 0)
      .map((l) => ({ loc_id: l.localizacao_id, loc_codigo: l.localizacao_codigo, empresa_id: l.empresa_dona_id, saldo: l.saldo }))
      .sort((a, b) => b.saldo - a.saldo);

    const saldoPicadoraOutras = locsPicadora.reduce((s, l) => s + l.saldo, 0);

    let escolhida: { loc_id: string; loc_codigo: string; F: string; qty_swap: number; qty_emp: number } | null = null;
    for (const cand of candidatas) {
      // V1: 1 contrapartida F = a com mais saldo na loc cand. Outras na mesma loc são ignoradas.
      const qtySwapMax = Math.min(saldoPicadoraOutras, cand.saldo);
      const qtyEmpMax = Math.min(demanda.qty_emprestimo_planejada, cand.saldo - qtySwapMax);
      const capacidade = qtySwapMax + qtyEmpMax;
      if (capacidade >= demanda.qty_total) {
        // Resolve qty exata: prioriza minimizar empréstimo
        const qtySwap = Math.min(qtySwapMax, demanda.qty_total);
        const qtyEmp = demanda.qty_total - qtySwap;
        escolhida = { loc_id: cand.loc_id, loc_codigo: cand.loc_codigo, F: cand.empresa_id, qty_swap: qtySwap, qty_emp: qtyEmp };
        break;
      }
    }

    if (!escolhida) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "nenhuma_loc_viavel" });
      continue;
    }

    // ─── Construir ops de swap (proporcional ao saldo da picadora em cada loc origem) ───
    const swaps: OperacaoSwap[] = [];
    let restante = escolhida.qty_swap;
    for (let i = 0; i < locsPicadora.length; i++) {
      const linha = locsPicadora[i];
      const isUltima = i === locsPicadora.length - 1;
      const qtyDessaLoc = isUltima
        ? restante
        : Math.min(linha.saldo, Math.floor((escolhida!.qty_swap * linha.saldo) / saldoPicadoraOutras));
      if (qtyDessaLoc <= 0) continue;
      // Op: picadora saída na loc origem → F entrada na loc origem
      swaps.push({
        loc_id: linha.localizacao_id,
        empresa_origem_id: demanda.empresa_picadora_id,
        empresa_destino_id: escolhida.F,
        qty: qtyDessaLoc,
      });
      restante -= qtyDessaLoc;
    }
    // Op consolidada: F saída na loc destino → picadora entrada na loc destino
    if (escolhida.qty_swap > 0) {
      swaps.push({
        loc_id: escolhida.loc_id,
        empresa_origem_id: escolhida.F,
        empresa_destino_id: demanda.empresa_picadora_id,
        qty: escolhida.qty_swap,
      });
    }

    const emprestimos: OperacaoEmprestimo[] = [];
    if (escolhida.qty_emp > 0) {
      emprestimos.push({
        loc_id: escolhida.loc_id,
        empresa_credora_id: escolhida.F,
        empresa_devedora_id: demanda.empresa_picadora_id,
        qty: escolhida.qty_emp,
      });
    }

    plano.demandas_planejadas.push({
      produto_id: demanda.produto_id,
      empresa_picadora_id: demanda.empresa_picadora_id,
      loc_destino_id: escolhida.loc_id,
      loc_destino_codigo: escolhida.loc_codigo,
      qty_swap: escolhida.qty_swap,
      qty_emprestimo: escolhida.qty_emp,
      swaps,
      emprestimos,
      reservas_a_cancelar: demanda.reservas_existentes_ids,
    });
  }

  return plano;
}
