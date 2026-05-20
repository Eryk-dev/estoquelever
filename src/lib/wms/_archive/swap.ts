// ARCHIVED 2026-05-20 — see docs/superpowers/archive/README.md
// This module is no longer imported anywhere. Kept as reference for the
// 4D ownership model in case it gets resurrected.
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { inserirMovimentacao } from "./ledger";

/**
 * Swap simétrico (permuta) inter-empresa.
 *
 * Cenário típico (na hora de atender um pedido):
 * - A vendedora V tem o pedido pra atender no galpão G_dest
 * - V NÃO tem saldo em G_dest, mas tem saldo em algum outro galpão G_orig
 * - Empresa-irmã I (com regra de empréstimo ativa V↔I) tem saldo em G_dest
 * - I tem regra que permite receber saldo de V (e vice-versa)
 *
 * Em vez de transferir fisicamente V/G_orig → V/G_dest (caminhão, dias):
 *   - I "empresta" qty pra V em G_dest (V ganha saldo onde precisa)
 *   - V "empresta" qty pra I em G_orig (I ganha saldo onde ela roda)
 *
 * Como I deve qty pra V (leg 1) e V deve qty pra I (leg 2), o saldo
 * devedor líquido = 0. Zero caminhão, zero dívida pendente.
 *
 * Pré-condição:
 * - Regras siso_emprestimo_regras ativas nos DOIS sentidos:
 *   - I credora → V devedora
 *   - V credora → I devedora
 * - Saldos suficientes em ambos os lados
 */

export interface SwapOportunidade {
  produto_id: string;
  qty: number;
  vendedora_id: string;
  irma_id: string;
  galpao_destino_id: string;
  galpao_contrapartida_id: string;
  /** Saldo da irmã no galpão destino (capacidade da leg 1) */
  saldo_irma_destino: number;
  /** Saldo da vendedora no galpão contrapartida (capacidade da leg 2) */
  saldo_vendedora_contrapartida: number;
}

interface BuscarLinhaArgs {
  produto_id: string;
  empresa_dona_id: string;
  galpao_id: string;
  qty: number;
}

interface LinhaCandidata {
  id: string;
  localizacao_id: string;
  disponivel: number;
}

/**
 * Detecta oportunidades de swap simétrico pra um item específico.
 *
 * Retorna lista de oportunidades ordenadas por preferência:
 * 1. Maior min(saldo_irma_destino, saldo_vendedora_contrapartida) primeiro
 * 2. Galpão contrapartida que seja "home" da empresa irmã (geo-priority)
 *
 * Pré-requisito: regras de empréstimo bidirecionais ativas.
 */
export async function detectarSwap(
  produto_id: string,
  qty: number,
  vendedora_id: string,
  galpao_destino_id: string,
): Promise<SwapOportunidade[]> {
  const sb = createServiceClient();

  // Lista empresas que podem emprestar pra vendedora via SWAP (irmã→vendedora
  // com permite_swap=true). Filtra explicitamente — empréstimo unidirecional
  // sem swap não conta aqui (use roteamento.ts pra isso).
  const { data: regrasParaVendedora } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_credora_id")
    .eq("empresa_devedora_id", vendedora_id)
    .eq("ativo", true)
    .eq("permite_swap", true);
  const credorasDeVendedora = new Set(
    ((regrasParaVendedora ?? []) as Array<{ empresa_credora_id: string }>).map(
      (r) => r.empresa_credora_id,
    ),
  );
  if (credorasDeVendedora.size === 0) return [];

  // Pra swap simétrico precisamos da intersecção: empresa I onde a regra
  // I→V tem permite_swap=true E a regra V→I também tem permite_swap=true.
  const { data: regrasDeVendedora } = await sb
    .from("siso_emprestimo_regras")
    .select("empresa_devedora_id")
    .eq("empresa_credora_id", vendedora_id)
    .eq("ativo", true)
    .eq("permite_swap", true);
  const devedorasDeVendedora = new Set(
    ((regrasDeVendedora ?? []) as Array<{ empresa_devedora_id: string }>).map(
      (r) => r.empresa_devedora_id,
    ),
  );
  const irmasBidirecionais = [...credorasDeVendedora].filter((i) =>
    devedorasDeVendedora.has(i),
  );
  if (irmasBidirecionais.length === 0) return [];

  // Pra cada empresa irmã: checa saldo dela no galpão destino + saldo da vendedora em outros galpões
  const oportunidades: SwapOportunidade[] = [];
  for (const irma_id of irmasBidirecionais) {
    // Leg 1: saldo da irmã no galpão destino
    const { data: saldoIrmaDest } = await sb
      .from("siso_estoque")
      .select("disponivel")
      .match({
        produto_id,
        empresa_dona_id: irma_id,
        galpao_id: galpao_destino_id,
      })
      .gt("disponivel", 0)
      .maybeSingle();
    if (!saldoIrmaDest || Number(saldoIrmaDest.disponivel) <= 0) continue;

    // Leg 2: saldo da vendedora em OUTROS galpões (preferencialmente em algum
    // dos galpões preferenciais da irmã — N:N opcional).
    const { data: irmaPrefRows } = await sb
      .from("siso_empresa_galpoes_preferenciais")
      .select("galpao_id")
      .eq("empresa_id", irma_id);
    const homesIrma = new Set(
      (irmaPrefRows ?? []).map(
        (r) => (r as { galpao_id: string }).galpao_id,
      ),
    );

    const { data: saldosVendedoraOutros } = await sb
      .from("siso_estoque")
      .select("galpao_id, disponivel")
      .eq("produto_id", produto_id)
      .eq("empresa_dona_id", vendedora_id)
      .neq("galpao_id", galpao_destino_id)
      .gt("disponivel", 0);

    if (!saldosVendedoraOutros || saldosVendedoraOutros.length === 0) continue;

    // Prefere galpões preferenciais da irmã (qualquer um da lista), depois
    // ordena por maior saldo. Irmã sem preferenciais → só ordena por saldo.
    type Row = { galpao_id: string; disponivel: number };
    const ordered = (saldosVendedoraOutros as Row[]).sort((a, b) => {
      const aHome = homesIrma.has(a.galpao_id) ? 0 : 1;
      const bHome = homesIrma.has(b.galpao_id) ? 0 : 1;
      if (aHome !== bHome) return aHome - bHome;
      return Number(b.disponivel) - Number(a.disponivel);
    });
    const escolhido = ordered[0];

    oportunidades.push({
      produto_id,
      qty,
      vendedora_id,
      irma_id,
      galpao_destino_id,
      galpao_contrapartida_id: escolhido.galpao_id,
      saldo_irma_destino: Number(saldoIrmaDest.disponivel),
      saldo_vendedora_contrapartida: Number(escolhido.disponivel),
    });
  }

  // Ordena por capacidade efetiva (min entre as duas pernas) decrescente
  oportunidades.sort((a, b) => {
    const capA = Math.min(a.saldo_irma_destino, a.saldo_vendedora_contrapartida);
    const capB = Math.min(b.saldo_irma_destino, b.saldo_vendedora_contrapartida);
    return capB - capA;
  });

  return oportunidades;
}

export interface SwapExecutado {
  produto_id: string;
  qty_swap: number;
  vendedora_id: string;
  irma_id: string;
  galpao_destino_id: string;
  galpao_contrapartida_id: string;
  movs: {
    leg1_saida_irma: string;
    leg1_entrada_vendedora: string;
    leg2_saida_vendedora: string;
    leg2_entrada_irma: string;
  };
}

/**
 * Executa swap simétrico. Cria 4 movimentações atômicas (ledger):
 *
 *   Leg 1 (no galpão destino):
 *     S: irma/loc_origem_irma  → empréstimo, devedora=vendedora
 *     E: vendedora/loc_putaway → empréstimo, devedora=vendedora
 *
 *   Leg 2 (no galpão contrapartida):
 *     S: vendedora/loc_origem_vendedora → empréstimo, devedora=irma
 *     E: irma/loc_putaway → empréstimo, devedora=irma
 *
 * Saldo devedor líquido vendedora↔irma: 0 (cada lado deve qty pro outro).
 *
 * `buscarLinha` define como achar a localização concreta de cada saída/entrada.
 */
export async function executarSwap(
  oportunidade: SwapOportunidade,
  qty_swap: number,
  usuarioId: string,
  buscarLinha: (q: BuscarLinhaArgs) => Promise<LinhaCandidata | null>,
): Promise<SwapExecutado> {
  if (qty_swap <= 0) throw new Error("qty_swap deve ser > 0");
  if (qty_swap > oportunidade.saldo_irma_destino)
    throw new Error("qty_swap excede saldo da irmã no destino");
  if (qty_swap > oportunidade.saldo_vendedora_contrapartida)
    throw new Error("qty_swap excede saldo da vendedora na contrapartida");

  // Localiza linhas concretas:
  // - Leg 1 origem (irmã no destino)
  const leg1Origem = await buscarLinha({
    produto_id: oportunidade.produto_id,
    empresa_dona_id: oportunidade.irma_id,
    galpao_id: oportunidade.galpao_destino_id,
    qty: qty_swap,
  });
  if (!leg1Origem) throw new Error("linha de origem da leg 1 não encontrada");

  // - Leg 2 origem (vendedora na contrapartida)
  const leg2Origem = await buscarLinha({
    produto_id: oportunidade.produto_id,
    empresa_dona_id: oportunidade.vendedora_id,
    galpao_id: oportunidade.galpao_contrapartida_id,
    qty: qty_swap,
  });
  if (!leg2Origem) throw new Error("linha de origem da leg 2 não encontrada");

  // Putaway: usamos a mesma localização (irmã→vendedora vai pra mesma loc físicamente,
  // já que o produto está lá). Funciona porque siso_estoque é por quádrupla, então
  // mesma loc + dona diferente = registro diferente.
  const leg1Destino = leg1Origem.localizacao_id;
  const leg2Destino = leg2Origem.localizacao_id;

  // Leg 1
  const mov1S = await inserirMovimentacao({
    quadrupla: {
      produto_id: oportunidade.produto_id,
      empresa_dona_id: oportunidade.irma_id,
      galpao_id: oportunidade.galpao_destino_id,
      localizacao_id: leg1Origem.localizacao_id,
    },
    tipo: "S",
    qty: qty_swap,
    origem_tipo: "emprestimo",
    emprestimo_devedora_id: oportunidade.vendedora_id,
    usuario_id: usuarioId,
    observacoes: "swap simétrico (leg 1: irmã→vendedora no destino)",
  });
  const mov1E = await inserirMovimentacao({
    quadrupla: {
      produto_id: oportunidade.produto_id,
      empresa_dona_id: oportunidade.vendedora_id,
      galpao_id: oportunidade.galpao_destino_id,
      localizacao_id: leg1Destino,
    },
    tipo: "E",
    qty: qty_swap,
    origem_tipo: "emprestimo",
    emprestimo_devedora_id: oportunidade.vendedora_id,
    usuario_id: usuarioId,
    observacoes: "swap simétrico (leg 1: irmã→vendedora no destino)",
  });

  // Leg 2 (contrapartida)
  const mov2S = await inserirMovimentacao({
    quadrupla: {
      produto_id: oportunidade.produto_id,
      empresa_dona_id: oportunidade.vendedora_id,
      galpao_id: oportunidade.galpao_contrapartida_id,
      localizacao_id: leg2Origem.localizacao_id,
    },
    tipo: "S",
    qty: qty_swap,
    origem_tipo: "emprestimo",
    emprestimo_devedora_id: oportunidade.irma_id,
    usuario_id: usuarioId,
    observacoes: "swap simétrico (leg 2: vendedora→irmã na contrapartida)",
  });
  const mov2E = await inserirMovimentacao({
    quadrupla: {
      produto_id: oportunidade.produto_id,
      empresa_dona_id: oportunidade.irma_id,
      galpao_id: oportunidade.galpao_contrapartida_id,
      localizacao_id: leg2Destino,
    },
    tipo: "E",
    qty: qty_swap,
    origem_tipo: "emprestimo",
    emprestimo_devedora_id: oportunidade.irma_id,
    usuario_id: usuarioId,
    observacoes: "swap simétrico (leg 2: vendedora→irmã na contrapartida)",
  });

  return {
    produto_id: oportunidade.produto_id,
    qty_swap,
    vendedora_id: oportunidade.vendedora_id,
    irma_id: oportunidade.irma_id,
    galpao_destino_id: oportunidade.galpao_destino_id,
    galpao_contrapartida_id: oportunidade.galpao_contrapartida_id,
    movs: {
      leg1_saida_irma: mov1S.id,
      leg1_entrada_vendedora: mov1E.id,
      leg2_saida_vendedora: mov2S.id,
      leg2_entrada_irma: mov2E.id,
    },
  };
}

/**
 * Swap atômico (Plano 4): 4 movs origem_tipo='swap' numa única transação via
 * RPC `wms_executar_swap`. Diferente do `executarSwap` legacy, NÃO cria saldo
 * devedor entre as empresas — é uma troca limpa, saldo total preservado.
 *
 * Use este wrapper no fluxo automático de fulfillment do
 * webhook-processor-wms. O `executarSwap` legacy (origem=emprestimo) fica
 * pros endpoints manuais `/api/wms/swap/*`.
 */
export interface ExecutarSwapAtomicoInput {
  produto_id: string;
  /** Empresa que vai "ganhar" estoque em galpao_a (tipicamente vendedora) */
  empresa_a_id: string;
  /** Empresa par — vai "ganhar" estoque em galpao_b */
  empresa_b_id: string;
  /** Galpão onde a empresa_a quer cumprir o pedido */
  galpao_a_id: string;
  /** Galpão espelho onde empresa_a tem estoque pra ceder em troca */
  galpao_b_id: string;
  /** Localização em galpao_a onde empresa_b tinha o estoque (post-swap empresa_a) */
  localizacao_a_id: string;
  /** Localização em galpao_b onde empresa_a tinha o estoque (post-swap empresa_b) */
  localizacao_b_id: string;
  qty: number;
  pedido_id: string;
  usuario_id?: string;
  observacoes?: string;
}

export interface ExecutarSwapAtomicoResult {
  mov_saida_b_em_a: string;
  mov_entrada_a_em_a: string;
  mov_saida_a_em_b: string;
  mov_entrada_b_em_b: string;
}

export async function executarSwapAtomico(
  input: ExecutarSwapAtomicoInput,
): Promise<ExecutarSwapAtomicoResult> {
  const sb = createServiceClient();
  const { data, error } = await sb.rpc("wms_executar_swap", {
    p_produto: input.produto_id,
    p_empresa_a: input.empresa_a_id,
    p_empresa_b: input.empresa_b_id,
    p_galpao_a: input.galpao_a_id,
    p_galpao_b: input.galpao_b_id,
    p_localizacao_a: input.localizacao_a_id,
    p_localizacao_b: input.localizacao_b_id,
    p_qty: input.qty,
    p_pedido: input.pedido_id,
    p_usuario: input.usuario_id ?? null,
    p_observacoes: input.observacoes ?? null,
  });
  if (error) {
    logger.error("wms.swap", "wms_executar_swap falhou", { error, input });
    throw error;
  }
  const rows = (data ?? []) as ExecutarSwapAtomicoResult[];
  const first = rows[0];
  if (!first) {
    throw new Error("RPC wms_executar_swap não retornou movimentações");
  }
  return first;
}

/**
 * Wrapper de conveniência: detecta + executa o melhor swap pra um item.
 *
 * Retorna null se não há swap viável. Caller deve fazer fallback (transferência
 * física, OC, etc) quando null.
 */
export async function tentarSwapAutomatico(
  produto_id: string,
  qty: number,
  vendedora_id: string,
  galpao_destino_id: string,
  usuarioId: string,
  buscarLinha: (q: BuscarLinhaArgs) => Promise<LinhaCandidata | null>,
): Promise<SwapExecutado | null> {
  const oportunidades = await detectarSwap(
    produto_id,
    qty,
    vendedora_id,
    galpao_destino_id,
  );
  for (const op of oportunidades) {
    const cap = Math.min(
      op.saldo_irma_destino,
      op.saldo_vendedora_contrapartida,
    );
    const usarQty = Math.min(qty, cap);
    if (usarQty < qty) {
      // Swap parcial não cobre qty inteira; pula essa oportunidade
      continue;
    }
    try {
      return await executarSwap(op, usarQty, usuarioId, buscarLinha);
    } catch {
      // Falhou (ex: saldo mudou no meio) — tenta próxima oportunidade
      continue;
    }
  }
  return null;
}
