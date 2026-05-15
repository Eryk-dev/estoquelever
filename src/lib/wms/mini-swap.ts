import type {
  EstadoEstoqueSku, Demanda, PlanoMiniSwap,
  OperacaoSwap, OperacaoEmprestimo,
} from "./mini-swap-types";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

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
      (l) =>
        l.empresa_dona_id === demanda.empresa_picadora_id &&
        l.saldo - l.reservado > 0,
    );
    if (locsPicadora.length <= 1) {
      plano.demandas_skipadas.push({ produto_id: demanda.produto_id, motivo: "ja_consolidado" });
      continue;
    }
    // ─── Encontrar contrapartida F: empresa com mais saldo em alguma loc do galpão ───
    type Candidata = { loc_id: string; loc_codigo: string; empresa_id: string; saldo: number };
    const candidatas: Candidata[] = estadoSku.linhas
      .filter((l) => l.empresa_dona_id !== demanda.empresa_picadora_id && l.saldo - l.reservado > 0)
      .map((l) => ({
        loc_id: l.localizacao_id,
        loc_codigo: l.localizacao_codigo,
        empresa_id: l.empresa_dona_id,
        saldo: l.saldo - l.reservado, // disponível
      }))
      .sort((a, b) => b.saldo - a.saldo);

    const saldoPicadoraOutras = locsPicadora.reduce((s, l) => s + (l.saldo - l.reservado), 0);

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
      const dispLinha = linha.saldo - linha.reservado;
      const qtyDessaLoc = isUltima
        ? restante
        : Math.min(dispLinha, Math.floor((escolhida!.qty_swap * dispLinha) / saldoPicadoraOutras));
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

export interface ExecutarInput {
  pedido_ids: string[];
  galpao_id: string;
  usuario_id?: string;
}

export interface ExecutarResultado {
  ok: boolean;
  plano: PlanoMiniSwap;
  executado: unknown[];
  motivo_falha?: string;
}

/**
 * Lê estado de estoque + reservas + decisões do roteamento, computa plano via
 * `planejarMiniSwap`, chama RPC `wms_executar_mini_swap` pra aplicar atomicamente.
 *
 * Graceful: qualquer erro retorna `{ ok: false, plano: vazio }` SEM lançar.
 * Caller deve continuar fluxo normal.
 */
export async function executarMiniSwap(input: ExecutarInput): Promise<ExecutarResultado> {
  const sb = createServiceClient();

  try {
    // 1. Buscar itens dos pedidos da wave (qty agregada por empresa+sku)
    const { data: itens, error: errItens } = await sb
      .from("siso_pedido_itens")
      .select("pedido_id, produto_id, quantidade, pedido:siso_pedidos!inner(empresa_origem_id)")
      .in("pedido_id", input.pedido_ids);
    if (errItens) throw errItens;

    type Aggregate = { empresa_picadora_id: string; produto_id: string; qty_total: number };
    const aggMap = new Map<string, Aggregate>();
    for (const it of (itens ?? []) as unknown as Array<{
      produto_id: string;
      quantidade: number;
      pedido: { empresa_origem_id: string };
    }>) {
      const key = `${it.pedido.empresa_origem_id}::${it.produto_id}`;
      const existing = aggMap.get(key);
      if (existing) {
        existing.qty_total += Number(it.quantidade);
      } else {
        aggMap.set(key, {
          empresa_picadora_id: it.pedido.empresa_origem_id,
          produto_id: it.produto_id,
          qty_total: Number(it.quantidade),
        });
      }
    }

    if (aggMap.size === 0) {
      return { ok: true, plano: { galpao_id: input.galpao_id, pedido_ids: input.pedido_ids, demandas_planejadas: [], demandas_skipadas: [] }, executado: [] };
    }

    const produtoIds = [...new Set([...aggMap.values()].map((a) => a.produto_id))];

    // 2. Buscar saldo atual de cada SKU no galpão
    const { data: estoqueRows, error: errEstoque } = await sb
      .from("siso_estoque")
      .select("produto_id, empresa_dona_id, localizacao_id, saldo, reservado, localizacao:siso_localizacoes!inner(codigo)")
      .eq("galpao_id", input.galpao_id)
      .in("produto_id", produtoIds);
    if (errEstoque) throw errEstoque;

    const estado: EstadoEstoqueSku[] = produtoIds.map((pid) => ({
      produto_id: pid,
      galpao_id: input.galpao_id,
      linhas: ((estoqueRows ?? []) as unknown as Array<{
        produto_id: string; empresa_dona_id: string; localizacao_id: string;
        saldo: number; reservado: number; localizacao: { codigo: string };
      }>)
        .filter((r) => r.produto_id === pid)
        .map((r) => ({
          empresa_dona_id: r.empresa_dona_id,
          localizacao_id: r.localizacao_id,
          localizacao_codigo: r.localizacao.codigo,
          saldo: Number(r.saldo),
          reservado: Number(r.reservado),
        })),
    }));

    // 3. Buscar reservas existentes + qty empréstimo planejada por demanda
    const demandas: Demanda[] = [];
    for (const agg of aggMap.values()) {
      const { data: reservas } = await sb
        .from("siso_movimentacoes")
        .select("id, quantidade, empresa_dona_id")
        .in("origem_id", input.pedido_ids)
        .eq("origem_tipo", "reserva_pedido")
        .eq("tipo", "R")
        .eq("produto_id", agg.produto_id);

      // qty_emprestimo_planejada = soma das reservas onde empresa_dona ≠ picadora
      let qtyEmp = 0;
      const reservasIds: string[] = [];
      for (const r of (reservas ?? []) as Array<{ id: string; quantidade: number; empresa_dona_id: string }>) {
        // Filtra apenas reservas não-estornadas
        const { data: estornoExiste } = await sb
          .from("siso_movimentacoes")
          .select("id")
          .eq("estorno_de", r.id)
          .maybeSingle();
        if (estornoExiste) continue;

        if (r.empresa_dona_id !== agg.empresa_picadora_id) {
          qtyEmp += Number(r.quantidade);
        }
        reservasIds.push(r.id);
      }

      demandas.push({
        empresa_picadora_id: agg.empresa_picadora_id,
        produto_id: agg.produto_id,
        qty_total: agg.qty_total,
        qty_emprestimo_planejada: qtyEmp,
        reservas_existentes_ids: reservasIds,
      });
    }

    // 4. Computa plano puro
    const plano = planejarMiniSwap({
      galpao_id: input.galpao_id,
      pedido_ids: input.pedido_ids,
      estado,
      demandas,
    });

    if (plano.demandas_planejadas.length === 0) {
      return { ok: true, plano, executado: [] };
    }

    // 5. Chama RPC pra aplicar atomicamente
    const { data: executado, error: errRpc } = await sb.rpc("wms_executar_mini_swap", {
      p_plano: plano as unknown as object,
      p_pedido_ids: input.pedido_ids,
      p_galpao_id: input.galpao_id,
      p_usuario_id: input.usuario_id ?? null,
    });
    if (errRpc) throw errRpc;

    return { ok: true, plano, executado: (executado as unknown[]) ?? [] };
  } catch (err) {
    logger.logError({
      source: "wms.mini-swap",
      message: "executarMiniSwap falhou — wave segue sem otimização",
      category: "database",
      error: err,
      metadata: { pedido_ids: input.pedido_ids, galpao_id: input.galpao_id },
    });
    return {
      ok: false,
      plano: { galpao_id: input.galpao_id, pedido_ids: input.pedido_ids, demandas_planejadas: [], demandas_skipadas: [] },
      executado: [],
      motivo_falha: err instanceof Error ? err.message : String(err),
    };
  }
}
