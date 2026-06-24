/**
 * Preempção de separação futura (Fase 7).
 *
 * Regra (spec §5): uma venda que ENVIA AGORA (ready) ganha de uma futura
 * (buffered) quando o estoque é escasso — MAS só enquanto a futura está
 * RESERVADA e ainda NÃO foi picada (R viva, status_separacao='aguardando_separacao').
 * Depois do pick a peça já está na caixa do dia (comprometida) → a ready vai pra OC.
 *
 * Quando uma ready roteia 'oc' por falta de cobertura, este helper checa se
 * liberar as reservas de futuras não-picadas no galpão-casa faria a casa cobrir
 * 100%. Se sim: libera essas R (a ready re-roteia e vira propria) e DEMOVE as
 * futuras afetadas pra OC (perderam o estoque → re-compram; quando o estoque
 * voltar, o reconciliador-oc as devolve à pista futura). Se não ajudar, NÃO mexe.
 */

import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { estornarReservaIndividual } from "@/lib/wms/reservas";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

const TIPOS_LOC_VENDAVEIS = ["picking", "overstock"];

interface ReservaFutura {
  id: string;
  pedido_id: string;
  quantidade: number;
}

/**
 * Decisão PURA: vale preemptar? Por item, `disponivel` é o que sobra SEM soltar a
 * futura, `futuraReservado` é o que voltaria se soltasse, `necessario` é a qty do
 * pedido novo. Só vale se a casa cobre TODO item ao soltar a futura
 * (disponivel+futuraReservado >= necessario p/ todos) E pelo menos um item está
 * curto hoje (disponivel < necessario) — senão a preempção não muda o roteamento.
 */
export function preempcaoViabiliza(
  itens: Array<{ disponivel: number; futuraReservado: number; necessario: number }>,
): boolean {
  if (itens.length === 0) return false;
  const todosCobrem = itens.every((i) => i.disponivel + i.futuraReservado >= i.necessario);
  const algumCurto = itens.some((i) => i.disponivel < i.necessario);
  return todosCobrem && algumCurto;
}

/**
 * Calcula, por produto no galpão-casa: D = disponível vendável (já EXCLUI a R da
 * futura) e a lista de R de futuras não-picadas (live). Libera+demove só se TODO
 * item fica coberto (D+F >= qty) E pelo menos um item está curto hoje (D < qty) —
 * senão a preempção não muda o roteamento e não vale soltar reserva à toa.
 */
export async function preemptarFuturasParaCobertura(args: {
  itens: Array<{ produto_id: string; qty: number }>;
  galpaoId: string;
}): Promise<{ reservasLiberadas: number; futurasDemovidas: string[] }> {
  const { itens, galpaoId } = args;
  const sb = createServiceClient();

  // Soma qty por produto (um pedido pode repetir o mesmo SKU em linhas).
  const qtyPorProduto = new Map<string, number>();
  for (const it of itens) {
    qtyPorProduto.set(it.produto_id, (qtyPorProduto.get(it.produto_id) ?? 0) + it.qty);
  }
  const produtos = [...qtyPorProduto.keys()];
  if (produtos.length === 0) return { reservasLiberadas: 0, futurasDemovidas: [] };

  // Locs travadas (inventário em curso) — excluídas, igual ao roteamento.
  const { data: locks } = await sb
    .from("siso_localizacao_locks")
    .select("localizacao_id")
    .is("finalizado_em", null);
  const blocked = new Set((locks ?? []).map((l) => (l as { localizacao_id: string }).localizacao_id));

  // R de futuras não-picadas, por produto (no galpão-casa).
  const reservasPorProduto = new Map<string, ReservaFutura[]>();
  const analise: Array<{ disponivel: number; futuraReservado: number; necessario: number }> = [];

  for (const produto of produtos) {
    const qtyNeed = qtyPorProduto.get(produto) ?? 0;

    // D — disponível vendável (exclui locks). disponivel já desconta o reservado
    // (inclui a R da futura), então D = "o que sobra SEM soltar a futura".
    const { data: est } = await sb
      .from("siso_estoque")
      .select("disponivel, localizacao_id, siso_localizacoes!inner(tipo)")
      .eq("produto_id", produto)
      .eq("galpao_id", galpaoId)
      .in("siso_localizacoes.tipo", TIPOS_LOC_VENDAVEIS)
      .gt("disponivel", 0);
    const D = (est ?? [])
      .filter((r) => !blocked.has((r as { localizacao_id: string }).localizacao_id))
      .reduce((acc, r) => acc + Number((r as { disponivel: number }).disponivel ?? 0), 0);

    // F — R de futuras não-picadas (aguardando_separacao) nesse produto+galpão.
    const { data: rRows } = await sb
      .from("siso_movimentacoes")
      .select("id, origem_id, quantidade, siso_pedidos!inner(separacao_futura, status_separacao)")
      .eq("tipo", "R")
      .eq("origem_tipo", "reserva_pedido")
      .eq("produto_id", produto)
      .eq("galpao_id", galpaoId);

    const candidatas: ReservaFutura[] = [];
    for (const r of rRows ?? []) {
      const pedRaw = (r as { siso_pedidos: unknown }).siso_pedidos;
      const ped = Array.isArray(pedRaw)
        ? (pedRaw[0] as { separacao_futura?: boolean; status_separacao?: string } | undefined)
        : (pedRaw as { separacao_futura?: boolean; status_separacao?: string } | null);
      if (ped?.separacao_futura !== true || ped.status_separacao !== "aguardando_separacao") continue;
      candidatas.push({
        id: (r as { id: string }).id,
        pedido_id: String((r as { origem_id: string | null }).origem_id ?? ""),
        quantidade: Number((r as { quantidade: number }).quantidade ?? 0),
      });
    }

    // Filtra R já liberadas (L com estorno_de) — só as vivas contam.
    const liberadas = await reservasJaLiberadas(sb, candidatas.map((c) => c.id));
    const vivas = candidatas.filter((c) => !liberadas.has(c.id));
    const F = vivas.reduce((acc, c) => acc + c.quantidade, 0);

    analise.push({ disponivel: D, futuraReservado: F, necessario: qtyNeed });
    reservasPorProduto.set(produto, vivas);
  }

  // Só preempta se soltar a futura faz a casa cobrir TODOS os itens E algum item
  // está curto hoje. Senão, não solta reserva à toa (evita demover futura sem
  // ganho de roteamento).
  if (!preempcaoViabiliza(analise)) {
    return { reservasLiberadas: 0, futurasDemovidas: [] };
  }

  // Libera as R das futuras dos produtos curtos + demove cada futura afetada p/ OC.
  let liberadas = 0;
  const futurasAfetadas = new Set<string>();
  for (const produto of produtos) {
    const qtyNeed = qtyPorProduto.get(produto) ?? 0;
    const Dcurto = await disponivelVendavel(sb, produto, galpaoId, blocked);
    if (Dcurto >= qtyNeed) continue; // este item não estava curto → não preempta
    for (const r of reservasPorProduto.get(produto) ?? []) {
      try {
        await estornarReservaIndividual({ reserva_id: r.id, motivo: "outro" });
        liberadas++;
        if (r.pedido_id) futurasAfetadas.add(r.pedido_id);
      } catch (e) {
        logger.warn("preempcao-futura", "falha liberando R de futura (segue)", {
          reserva_id: r.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  for (const futuraId of futurasAfetadas) {
    await demoverFuturaParaOc(sb, futuraId);
  }

  logger.info("preempcao-futura", "futuras preemptadas por venda que envia agora", {
    galpaoId,
    reservasLiberadas: liberadas,
    futurasDemovidas: [...futurasAfetadas],
  });
  return { reservasLiberadas: liberadas, futurasDemovidas: [...futurasAfetadas] };
}

async function reservasJaLiberadas(
  sb: ReturnType<typeof createServiceClient>,
  rIds: string[],
): Promise<Set<string>> {
  if (rIds.length === 0) return new Set();
  const { data: ls } = await sb
    .from("siso_movimentacoes")
    .select("estorno_de")
    .eq("tipo", "L")
    .in("estorno_de", rIds);
  return new Set((ls ?? []).map((l) => (l as { estorno_de: string | null }).estorno_de).filter((x): x is string => !!x));
}

async function disponivelVendavel(
  sb: ReturnType<typeof createServiceClient>,
  produto: string,
  galpaoId: string,
  blocked: Set<string>,
): Promise<number> {
  const { data: est } = await sb
    .from("siso_estoque")
    .select("disponivel, localizacao_id, siso_localizacoes!inner(tipo)")
    .eq("produto_id", produto)
    .eq("galpao_id", galpaoId)
    .in("siso_localizacoes.tipo", TIPOS_LOC_VENDAVEIS)
    .gt("disponivel", 0);
  return (est ?? [])
    .filter((r) => !blocked.has((r as { localizacao_id: string }).localizacao_id))
    .reduce((acc, r) => acc + Number((r as { disponivel: number }).disponivel ?? 0), 0);
}

/**
 * Demove uma futura pra OC: perdeu o estoque pra uma venda que envia agora →
 * vira futura-OC (re-compra, sem NF). Sem re-checar estoque (race-free): declara
 * direto validacao_oc + itens oc_pendente. Quando o estoque voltar, o
 * reconciliador-oc (gate futura) a devolve à pista futura.
 */
async function demoverFuturaParaOc(
  sb: ReturnType<typeof createServiceClient>,
  futuraId: string,
): Promise<void> {
  await sb
    .from("siso_pedidos")
    .update({ decisao_final: "oc", status_separacao: "validacao_oc" })
    .eq("id", futuraId)
    .eq("separacao_futura", true);

  const { data: itens } = await sb
    .from("siso_pedido_itens")
    .select("id, sku, quantidade_pedida")
    .eq("pedido_id", futuraId);

  const now = new Date().toISOString();
  for (const it of itens ?? []) {
    const sku = (it as { sku: string | null }).sku ?? "";
    await sb
      .from("siso_pedido_itens")
      .update({
        compra_status: "oc_pendente",
        compra_quantidade_solicitada: Number((it as { quantidade_pedida: number | null }).quantidade_pedida ?? 0),
        compra_solicitada_em: now,
        fornecedor_oc: getFornecedorBySku(sku).fornecedor,
      })
      .eq("id", (it as { id: string }).id);
  }
}
