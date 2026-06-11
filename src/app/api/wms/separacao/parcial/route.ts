import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import {
  buscarReservaPendente,
  buscarReservaPendentePorProduto,
  liberarReservaPicking,
  criarReservaCascade,
  estornarLiberacaoReserva,
  type ReservaPendenteRow,
} from "@/lib/wms/reservas-picking";
import { registrarEvento } from "@/lib/historico-service";
import {
  resolverProdutoWms,
  resolverLocalizacaoWms,
  buscarLocComMaiorSaldoNoGalpao,
} from "@/lib/separacao/wms-mapping";
import { resolverRealocacao } from "@/lib/separacao/realocacao-resolver";
import { distribuirQtyPega } from "@/lib/separacao/distribuir-qty-pega";
import { mandarItensParaCompras } from "@/lib/wms/mandar-compras";
import { galpoesComSaldo } from "@/lib/wms/galpoes-com-saldo";

/**
 * POST /api/separacao/parcial
 *
 * Modo dual:
 *  - Item:       { pedido_item_id, quantidade_pega, loc_zerou }
 *  - Realocação: { realocacao_id, quantidade_pega, loc_zerou }
 *
 * Headers: X-Session-Id
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }
  // Admin não precisa de galpaoId — derivamos do próprio pedido abaixo

  const body = await request.json().catch(() => null);

  // Modo realocação aceita realocacao_id (single, compat) OU realocacao_ids (array,
  // pra UI consolidada quando o cascade encontra cobertura na MESMA loc pra múltiplos
  // pedido_items residuais).
  const isRealocacaoMode =
    body &&
    (typeof body.realocacao_id === "string" ||
      (Array.isArray(body.realocacao_ids) && body.realocacao_ids.length > 0));
  // Modo item aceita pedido_item_id (single, compat) OU pedido_item_ids (array,
  // pra fluxo de wave picking onde o mesmo SKU aparece em pedidos diferentes
  // consolidados numa única linha do checklist).
  const isItemMode =
    body &&
    (typeof body.pedido_item_id === "number" ||
      typeof body.pedido_item_id === "string" ||
      (Array.isArray(body.pedido_item_ids) && body.pedido_item_ids.length > 0));

  if (!isRealocacaoMode && !isItemMode) {
    return NextResponse.json(
      {
        error:
          "campo 'pedido_item_id'/'pedido_item_ids' OU 'realocacao_id'/'realocacao_ids' obrigatório",
      },
      { status: 400 },
    );
  }

  if (
    typeof body.quantidade_pega !== "number" ||
    body.quantidade_pega < 0 ||
    !Number.isInteger(body.quantidade_pega) ||
    typeof body.loc_zerou !== "boolean"
  ) {
    return NextResponse.json(
      {
        error:
          "campos 'quantidade_pega' (int>=0) e 'loc_zerou' (bool) obrigatórios",
      },
      { status: 400 },
    );
  }

  const { quantidade_pega, loc_zerou } = body as {
    quantidade_pega: number;
    loc_zerou: boolean;
  };

  const supabase = createServiceClient();

  if (isItemMode) {
    const ids: (number | string)[] = Array.isArray(body.pedido_item_ids)
      ? body.pedido_item_ids
      : [body.pedido_item_id];
    return processarParcialItem(supabase, session, ids, quantidade_pega, loc_zerou);
  }
  const realocIds: string[] = Array.isArray(body.realocacao_ids)
    ? body.realocacao_ids
    : [body.realocacao_id];
  return processarParcialRealocacao(
    supabase,
    session,
    realocIds,
    quantidade_pega,
    loc_zerou,
  );
}

async function processarParcialItem(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  pedido_item_ids: (number | string)[],
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Carrega TODOS os items na ordem de id (FCFS pra distribuição)
    const { data: itemsRaw, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, produto_id, sku, quantidade_pedida, quantidade_pega, separacao_marcado, separacao_parcial",
      )
      .in("id", pedido_item_ids)
      .order("id", { ascending: true });

    if (itemsErr || !itemsRaw || itemsRaw.length === 0) {
      return NextResponse.json({ error: "item(s) não encontrado(s)" }, { status: 404 });
    }

    if (itemsRaw.length !== pedido_item_ids.length) {
      return NextResponse.json(
        { error: "alguns item_ids não foram encontrados" },
        { status: 404 },
      );
    }

    // 2. Valida: nenhum já processado
    const jaProcessado = itemsRaw.find(
      (it) => it.separacao_marcado || it.separacao_parcial,
    );
    if (jaProcessado) {
      return NextResponse.json(
        { error: `item ${jaProcessado.id} já processado (marcado ou parcial)` },
        { status: 409 },
      );
    }

    // 3. Valida: todos com o mesmo produto_id (consolidação só faz sentido pro mesmo SKU)
    const produtoIdSet = new Set(itemsRaw.map((it) => String(it.produto_id)));
    if (produtoIdSet.size > 1) {
      return NextResponse.json(
        { error: "items devem ter o mesmo produto_id" },
        { status: 400 },
      );
    }

    // Teto = o que AINDA falta separar (desconta o que cada item já pegou em
    // parciais anteriores) — não o total do pedido. Sem isso, re-fazer parcial
    // num item já parcial acumularia além do pedido.
    const totalFaltante = itemsRaw.reduce(
      (s, it) =>
        s + Math.max(0, Number(it.quantidade_pedida) - Number(it.quantidade_pega ?? 0)),
      0,
    );
    if (quantidade_pega > totalFaltante) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder o que falta separar (${totalFaltante})` },
        { status: 400 },
      );
    }

    // 4. Carrega pedidos relacionados — todos devem estar em_separacao e
    //    no mesmo galpão / mesma empresa origem (invariante do wave picking)
    const pedidoIds = [...new Set(itemsRaw.map((it) => it.pedido_id))];
    const { data: pedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id, separacao_galpao_id, status_separacao")
      .in("id", pedidoIds);

    if (pedidosErr || !pedidos || pedidos.length !== pedidoIds.length) {
      return NextResponse.json({ error: "pedido(s) não encontrado(s)" }, { status: 404 });
    }

    const naoEmSeparacao = pedidos.find((p) => p.status_separacao !== "em_separacao");
    if (naoEmSeparacao) {
      return NextResponse.json(
        {
          error: `pedido ${naoEmSeparacao.numero} não está em_separacao (atual: ${naoEmSeparacao.status_separacao})`,
        },
        { status: 400 },
      );
    }

    const empresasSet = new Set(pedidos.map((p) => p.empresa_origem_id));
    const galpoesSet = new Set(
      pedidos.map((p) => p.separacao_galpao_id ?? session.galpaoId ?? null),
    );
    if (empresasSet.size > 1 || galpoesSet.size > 1) {
      return NextResponse.json(
        { error: "items devem estar no mesmo galpão e empresa origem" },
        { status: 400 },
      );
    }

    const empresaOrigemId = pedidos[0].empresa_origem_id as string | null;
    const galpaoId =
      (pedidos[0].separacao_galpao_id as string | null) ?? session.galpaoId;
    if (!empresaOrigemId || !galpaoId) {
      return NextResponse.json({ error: "pedido sem empresa/galpão" }, { status: 400 });
    }

    const pedidoById = new Map(pedidos.map((p) => [p.id, p]));
    const primeiroItem = itemsRaw[0];
    const primeiroPedido = pedidoById.get(primeiroItem.pedido_id)!;

    const produtoTinyId = String(primeiroItem.produto_id);
    const produtoWmsId = await resolverProdutoWms(empresaOrigemId, produtoTinyId);

    // 5. Loc original — vem da R VIVA do pedido (posição que `aprovar` reservou).
    // No wave picking todos compartilham a mesma loc consolidada. (Fase 1.4: era
    // lido do snapshot estale siso_pedido_item_estoques; agora da R / estoque vivo,
    // mesmo padrão do marcar-item.) Fallback pra loc com maior saldo se não houver R.
    const reservaOriginal = await buscarReservaPendentePorProduto({
      pedido_id: String(primeiroItem.pedido_id),
      produto_id: produtoWmsId,
      galpao_id: galpaoId,
    });
    let locOriginalId: string;
    if (reservaOriginal) {
      locOriginalId = reservaOriginal.localizacao_id;
    } else {
      const liveLocId = await buscarLocComMaiorSaldoNoGalpao(galpaoId, produtoWmsId);
      locOriginalId = liveLocId ?? (await resolverLocalizacaoWms(galpaoId, null));
    }
    // Código da loc (informativo, usado nos eventos de auditoria).
    const { data: locOrigRow } = await supabase
      .from("siso_localizacoes")
      .select("codigo")
      .eq("id", locOriginalId)
      .maybeSingle();
    const locCodigo = (locOrigRow?.codigo as string | null | undefined) ?? null;

    // 6. Saldo / reservado (3D: produto + galpao + loc)
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locOriginalId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    // A reserva do PRÓPRIO lote (R viva que o aprovar criou nesta loc, que o
    // passo 7a abaixo libera) não pode contar como indisponível — o pedido tem
    // direito às unidades reservadas pra ele. Só a reserva de OUTROS pedidos
    // restringe a saída. (Mesma lógica já aplicada no marcar-item via reserva_id;
    // sem isso, picking parcial num galpão com saldo 100% alocado entre pedidos
    // bloqueava todo mundo de pegar a própria reserva — disponivel=0.)
    let minhaReservaNestaLoc = 0;
    for (const pid of pedidoIds) {
      const r = await buscarReservaPendente({
        pedido_id: String(pid),
        tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locOriginalId },
      });
      if (r) minhaReservaNestaLoc += Number(r.quantidade);
    }
    const reservadoDeOutros = Math.max(0, reservadoWms - minhaReservaNestaLoc);
    const disponivelParaMim = saldoWms - reservadoDeOutros;

    if (quantidade_pega > 0 && disponivelParaMim < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado por outros ${reservadoDeOutros}, disponível pra você ${disponivelParaMim}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoDeOutros,
          disponivel: disponivelParaMim,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // Distribuição FCFS (movida pra ANTES da liberação): define, por pedido,
    // quanto foi pego (picked) e quanto sobra (residual). Isso governa QUAIS
    // reservas liberar (só de quem recebeu unidade) e qual residual re-reservar.
    const itemUpdates = distribuirQtyPega(itemsRaw, quantidade_pega).map((d) => ({
      item: d.item,
      qty_para_este: d.qty_para_este,
      qty_residual: d.qty_residual,
      pedido_id: d.item.pedido_id as string,
    }));
    const allocPorPedido = new Map<string, { picked: number; residual: number }>();
    for (const u of itemUpdates) {
      const cur = allocPorPedido.get(u.pedido_id) ?? { picked: 0, residual: 0 };
      cur.picked += u.qty_para_este;
      cur.residual += u.qty_residual;
      allocPorPedido.set(u.pedido_id, cur);
    }

    // 7. Gera mov S única (qty_pega total) e mov ajuste única — ambas vinculadas ao primeiro pedido,
    //    com lista completa de items cobertos em origem_detalhes pra rastreabilidade.
    const itemIdsList = itemsRaw.map((it) => Number(it.id));

    // 7a. R↔L↔S pairing por pedido do wave:
    //   - loc_zerou=false: só libera a R de quem pegou unidade (guard abaixo);
    //     a R de pedido não-atendido fica INTACTA, e o residual do próprio pick
    //     é re-reservado na mesma loc mais adiante (passo 10, ramo !loc_zerou).
    //   - loc_zerou=true: libera 100% da R de todos (a loc esvaziou); o cascade
    //     re-emite R nas locs destino pra qty residual.
    // Quando libera, libera a R inteira (Number(r.quantidade)) — o pareamento
    // com a qty pega é resolvido pela re-reserva (false) ou pelo cascade (true).
    const liberacoesPorPedido = new Map<string, { reserva: ReservaPendenteRow; movL_id: string }>();
    for (const pid of pedidoIds) {
      const alloc = allocPorPedido.get(pid) ?? { picked: 0, residual: 0 };
      // loc_zerou=false: NÃO liberar a R de pedido que não recebeu unidade
      // (FCFS deu tudo a outro do wave). Senão ele perde a reserva sem ter
      // sido separado — bug #50144/#50189. Com loc_zerou=true mantém o
      // comportamento antigo (libera todas; cascade recria em outra loc).
      if (!loc_zerou && alloc.picked === 0) continue;
      try {
        const r = await buscarReservaPendente({
          pedido_id: String(pid),
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: galpaoId,
            localizacao_id: locOriginalId,
          },
        });
        if (!r) {
          logger.warn("separacao-parcial", "R pendente não encontrada — pedido sem reserva", {
            pedido_id: pid,
            tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locOriginalId },
          });
          continue;
        }
        const pedidoNumero = pedidoById.get(pid)?.numero;
        const movL = await liberarReservaPicking({
          reserva: r,
          qty: Number(r.quantidade),
          pedido_id: String(pid),
          motivo: `Picking parcial pedido #${pedidoNumero ?? "?"} — libera reserva (loc esgotada)`,
          usuario_id: session.id,
          origem_detalhes: {
            pedido_numero: pedidoNumero,
            contexto: itemsRaw.length > 1 ? "parcial_consolidado" : "parcial",
          },
        });
        liberacoesPorPedido.set(pid, { reserva: r, movL_id: movL.id });
      } catch (libErr) {
        logger.warn("separacao-parcial", "Falhou liberar R pendente (continua)", {
          error: libErr instanceof Error ? libErr.message : String(libErr),
          pedido_id: pid,
        });
      }
    }

    // loc_zerou: o ajuste "phantom" zera o que o operador não achou na loc, mas
    // NÃO pode derrubar o saldo abaixo do reservado que SOBRA na loc (reservas de
    // OUTROS pedidos que este fluxo não liberou). Senão o ajuste viola o CHECK
    // reservado<=saldo e estoura 500. liberadoNaLoc = reservas DESTE wave já
    // liberadas no passo 7a (reduzem o reservado vivo da loc).
    const liberadoNaLoc = Array.from(liberacoesPorPedido.values()).reduce(
      (s, info) => s + Number(info.reserva.quantidade),
      0,
    );
    const reservadoRestanteLoc = Math.max(0, reservadoWms - liberadoNaLoc);

    // 7b. S(qty_pega) + ajuste(loc_zerou) atômicos via RPC (P019).
    const deltaAjuste = loc_zerou
      ? Math.max(0, saldoWms - quantidade_pega - reservadoRestanteLoc)
      : 0;
    let movSaidaId: string | null = null;
    let movAjusteId: string | null = null;
    if (quantidade_pega > 0 || deltaAjuste > 0) {
      const { data: pk, error: pkErr } = await supabase.rpc("wms_pick_parcial_atomico", {
        p_produto_id: produtoWmsId,
        p_galpao_id: galpaoId,
        p_localizacao_id: locOriginalId,
        p_qty_pega: quantidade_pega,
        p_delta_ajuste: deltaAjuste,
        p_pedido_id: String(primeiroPedido.id),
        p_empresa_vendedora_id: empresaOrigemId,
        p_usuario_id: session.id,
        p_origem_detalhes: {
          pedido_id_tiny: primeiroPedido.id,
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIdsList,
          sku: primeiroItem.sku,
          saldo_anterior: saldoWms,
          qty_pega: quantidade_pega,
          contexto: itemsRaw.length > 1 ? "parcial_consolidado" : "parcial",
        },
        p_motivo:
          itemsRaw.length > 1
            ? `Picking parcial wave — ${itemsRaw.length} items (pedido #${primeiroPedido.numero}…)`
            : `Picking parcial pedido #${primeiroPedido.numero}`,
      });
      if (pkErr) {
        // Compensação: o passo 7a já liberou as R dos pedidos do wave (commits
        // individuais). Sem re-reservar aqui, a falha do RPC deixaria as
        // reservas perdidas pra sempre (overselling). Recria cada R via
        // estorno da L (idempotente; nenhum link de liberação existe ainda —
        // só são criados no 9c).
        const compensacoesPendentes: Array<{
          pedido_id: string;
          mov_l_id: string;
          erro: string;
        }> = [];
        for (const [pid, info] of liberacoesPorPedido) {
          try {
            await estornarLiberacaoReserva({
              liberacao_mov_id: info.movL_id,
              pedido_id: String(pid),
              usuario_id: session.id,
              motivo: "Compensação — falha no pick parcial atômico (recria reserva)",
            });
          } catch (e) {
            compensacoesPendentes.push({
              pedido_id: pid,
              mov_l_id: info.movL_id,
              erro: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (compensacoesPendentes.length > 0) {
          logger.logError({
            error: new Error("compensação de liberações falhou após erro do RPC"),
            source: "separacao-parcial",
            message:
              "Reservas liberadas no 7a não foram recriadas — risco de overselling",
            category: "business_logic",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { compensacoesPendentes, rpc_error: pkErr.message },
          });
          return NextResponse.json(
            {
              error: "falha_pick_parcial",
              message:
                `${pkErr.message} — ATENÇÃO: ${compensacoesPendentes.length} reserva(s) ` +
                "liberada(s) não puderam ser recriadas. Acione o supervisor pra " +
                "re-reservar manualmente antes de tentar de novo.",
              reservas_nao_recriadas: compensacoesPendentes,
            },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: "falha_pick_parcial", message: pkErr.message },
          { status: 409 },
        );
      }
      movSaidaId = (pk as { mov_s_id: string | null }).mov_s_id;
      movAjusteId = (pk as { mov_ajuste_id: string | null }).mov_ajuste_id;
    }

    // (Fase 1.4 — 2026-05-28) REMOVIDO: sync do snapshot
    // siso_pedido_item_estoques pós-loc_zerou. A tabela foi dropada — o
    // worker/aprovação leem disponível VIVO de siso_estoque, então não há
    // mais snapshot estale pra ressincronizar (matava o loop OC→Própria).

    // 8. (itemUpdates já computado antes da liberação 7a — distribuição FCFS.)
    //    nowIso ainda usado no Pass A/B abaixo.
    const nowIso = new Date().toISOString();

    // 9. Update de cada item conforme distribuição
    //    Movs ficam vinculadas SÓ ao primeiro item que recebeu qty (ou ao primeiro
    //    item residual se ninguém recebeu — caso qty_pega=0 + loc_zerou).
    const indexPrimeiroBeneficiado =
      itemUpdates.findIndex((u) => u.qty_para_este > 0) >= 0
        ? itemUpdates.findIndex((u) => u.qty_para_este > 0)
        : 0;

    // 9a. Popula tabela ponte siso_pedido_item_mov_links — 1 linha por item com qty>0
    //     pra mov de saída (rateada), e 1 linha pro primeiro beneficiado se houve
    //     mov de ajuste loc_zerou (ajuste é da loc, não rateado).
    // P3-12b: se o INSERT dos links falhar APÓS a S já ter sido criada (RPC),
    // a S fica órfã (saldo debitado, nenhum link → desfazer-parcial/reset não
    // acham a fração). Estorna a S (+ ajuste) e recria as liberações do 7a antes
    // de 409, em vez de 500 com S órfã. estornarMovimentacao absorve "já estornada".
    async function compensarLinksItemERetornar409() {
      for (const movId of [movSaidaId, movAjusteId]) {
        if (!movId) continue;
        try {
          await estornarMovimentacao({
            mov_id: movId,
            usuario_id: session.id,
            motivo: "Compensação — falha persistindo links (parcial item)",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
            logger.warn("separacao-parcial-item", "compensação: estorno da mov falhou", {
              mov_id: movId,
              error: msg,
            });
          }
        }
      }
      for (const [pid, info] of liberacoesPorPedido) {
        try {
          await estornarLiberacaoReserva({
            liberacao_mov_id: info.movL_id,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: "Compensação — falha persistindo links (recria reserva)",
          });
        } catch (e) {
          logger.logError({
            error: e,
            source: "separacao-parcial-item",
            message: "Compensação de links: falhou recriar reserva — risco de overselling",
            category: "business_logic",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { pedido_id: pid, mov_l_id: info.movL_id },
          });
        }
      }
      return NextResponse.json(
        { error: "erro_persistindo_links" },
        { status: 409 },
      );
    }

    if (movSaidaId) {
      const linksData: Array<{
        pedido_item_id: number;
        realocacao_id: null;
        mov_id: string;
        qty: number;
        tipo_link: "saida" | "ajuste_loc_zerou";
      }> = [];

      for (const upd of itemUpdates) {
        if (upd.qty_para_este > 0) {
          linksData.push({
            pedido_item_id: Number(upd.item.id),
            realocacao_id: null,
            mov_id: movSaidaId,
            qty: upd.qty_para_este,
            tipo_link: "saida",
          });
        }
      }

      if (linksData.length > 0) {
        const { error: linkErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(linksData);
        if (linkErr) {
          logger.logError({
            error: linkErr,
            source: "separacao-parcial-item",
            message: "Falhou criar links",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movSaidaId, linksData },
          });
          return compensarLinksItemERetornar409();
        }
      }
    }

    if (movAjusteId && loc_zerou) {
      const delta = deltaAjuste;
      if (delta > 0) {
        // ajuste é da loc, não rateado entre itens — vai no primeiro beneficiado
        const { error: linkAjErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert({
            pedido_item_id: Number(itemsRaw[indexPrimeiroBeneficiado].id),
            realocacao_id: null,
            mov_id: movAjusteId,
            qty: delta,
            tipo_link: "ajuste_loc_zerou",
          });
        if (linkAjErr) {
          logger.logError({
            error: linkAjErr,
            source: "separacao-parcial-item",
            message: "Falhou criar link de ajuste",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movAjusteId, delta },
          });
          return compensarLinksItemERetornar409();
        }
      }
    }

    // 9c. Links das liberações de R (1 por pedido do wave). Linka no primeiro
    //     item do pedido (qualquer item serve — é metadata pra desfazer reverter).
    if (liberacoesPorPedido.size > 0) {
      const linksLib: Array<{
        pedido_item_id: number;
        realocacao_id: null;
        mov_id: string;
        qty: number;
        tipo_link: "liberacao_reserva";
      }> = [];
      for (const [pid, info] of liberacoesPorPedido) {
        const primeiroItemDoPedido = itemsRaw.find((it) => it.pedido_id === pid);
        if (!primeiroItemDoPedido) continue;
        linksLib.push({
          pedido_item_id: Number(primeiroItemDoPedido.id),
          realocacao_id: null,
          mov_id: info.movL_id,
          qty: Number(info.reserva.quantidade),
          tipo_link: "liberacao_reserva",
        });
      }
      if (linksLib.length > 0) {
        const { error: linkLibErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(linksLib);
        if (linkLibErr) {
          logger.warn("separacao-parcial-item", "Falhou criar links de liberação (continua)", {
            error: linkLibErr.message,
            linksLib,
          });
        }
      }
    }

    // Acumula quantidade_pega pra TODOS os items que receberam qty —
    // inclui items "em progresso" (qty_para_este>0 && qty_residual>0 && !loc_zerou)
    // que ficam abertos e não passam pelo Pass B. RPC é idempotente em retry?
    // Não — wms_acumular_qty_pega é UPDATE com soma. Em retry duplica. Por isso
    // roda aqui antes do claim atômico (que falha apenas se outro op marcou primeiro).
    for (const u of itemUpdates) {
      if (u.qty_para_este > 0) {
        await supabase.rpc("wms_acumular_qty_pega", {
          p_item_id: u.item.id,
          p_delta: u.qty_para_este,
        });
      }
    }

    // Log de items "em progresso" pra audit trail — Pass B só registra evento
    // pros marcados, então o em-progresso fica sem evento sem este log.
    if (!loc_zerou) {
      for (const u of itemUpdates) {
        if (u.qty_para_este > 0 && u.qty_residual > 0) {
          await registrarEvento({
            pedidoId: u.pedido_id,
            evento: "parcial_em_progresso",
            detalhes: {
              item_id: u.item.id,
              sku: u.item.sku,
              quantidade_pega: u.qty_para_este,
              quantidade_pedida: Number(u.item.quantidade_pedida),
              quantidade_residual: u.qty_residual,
              loc_codigo: locCodigo,
              wave_consolidado: itemsRaw.length > 1,
            },
            usuarioId: session.id,
          });
        }
      }
    }

    // C4: 2-pass atomic claim — evita drift mid-loop quando race acontece
    // numa iteração N>1 (iterações 1..N-1 já estavam committed no padrão antigo).
    //
    // Pass A: UPDATE atômico em lote que flipa `separacao_marcado` false→true em
    // TODOS os items ao mesmo tempo, com filtro de race. Se claimed.length !==
    // itemsParaMarcar.length, race detectada → rollback. SQL é atômico, então
    // ou claim TODOS ou NENHUM (sem commits parciais).
    //
    // Pass B: per-row UPDATE pra setar campos diferenciais (separacao_parcial,
    // parcial_motivo, mov_saida_id, etc) SEM filtro de race — já temos lock.
    //
    // Items "em progresso" (qty_para_este>0 && qty_residual>0 && !loc_zerou)
    // ficam ABERTOS: separacao_marcado=false, quantidade_pega já acumulada.
    // Operador volta pelo checkbox normal (marcar-item entende qty_pega>0 e
    // cria S de qty_pedida-qty_pega).
    const itemsParaMarcar = itemUpdates.filter(
      (u) => u.qty_residual === 0 || loc_zerou,
    );
    let racePerdida = false;
    let itemIdsClaimedParaReverter: number[] = [];

    if (itemsParaMarcar.length > 0) {
      // ─── Pass A: claim atômico em lote ─────────────────────────────────
      const itemIdsParaMarcar = itemsParaMarcar.map((u) => Number(u.item.id));
      const { data: claimedIds, error: claimErr } = await supabase
        .from("siso_pedido_itens")
        .update({
          separacao_marcado: true,
          separacao_marcado_em: nowIso,
        })
        .in("id", itemIdsParaMarcar)
        .eq("separacao_marcado", false)
        .select("id");

      if (claimErr) {
        logger.logError({
          error: claimErr,
          source: "separacao-parcial",
          message: "Falhou claim atômico em lote",
          category: "database",
          requestPath: "/api/wms/separacao/parcial",
          requestMethod: "POST",
          metadata: { itemIdsParaMarcar, movSaidaId, movAjusteId },
        });
        return NextResponse.json({ error: "erro persistindo parcial" }, { status: 500 });
      }

      if (!claimedIds || claimedIds.length !== itemIdsParaMarcar.length) {
        racePerdida = true;
        // Captura os IDs que FORAM claimed (Pass A parcial) pra reverter
        // os campos marker no rollback abaixo.
        itemIdsClaimedParaReverter = (claimedIds ?? []).map((r) => Number(r.id));
      }

      // ─── Pass B: differential per-row (sem race filter) ────────────────
      if (!racePerdida) {
        for (let i = 0; i < itemUpdates.length; i++) {
          const u = itemUpdates[i];
          const { item: it, qty_para_este, qty_residual } = u;
          const ehBeneficiario = i === indexPrimeiroBeneficiado;
          const isCompleto = qty_residual === 0;
          // Pass B só marca items "fechados" — qty_residual===0 (pegou tudo)
          // ou loc_zerou (cascade vai cuidar do residual em outra loc).
          // Items "em progresso" (qty_para_este>0 && qty_residual>0 && !loc_zerou)
          // já tiveram quantidade_pega acumulada no pre-pass e ficam abertos.
          const deveMarcar = isCompleto || loc_zerou;
          if (!deveMarcar) continue;

          const isParcial = !isCompleto;
          const { error: updErr } = await supabase
            .from("siso_pedido_itens")
            .update({
              separacao_parcial: isParcial,
              parcial_motivo: isParcial ? (loc_zerou ? "loc_zerou" : "qty_diferente") : null,
              parcial_em: isParcial ? nowIso : null,
              parcial_por: isParcial ? session.id : null,
              // Legacy field: mov_saida vinculada a TODOS os beneficiários (qty > 0)
              // pra desfazer-parcial/cancelar legados localizarem a mov. A tabela ponte
              // (criada acima) é a fonte de verdade pra rateamento.
              mov_saida_id: qty_para_este > 0 ? movSaidaId : null,
              // mov_ajuste é da loc — fica só no primeiro beneficiário (não rateado)
              mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
            })
            .eq("id", it.id);

          if (updErr) {
            logger.logError({
              error: updErr,
              source: "separacao-parcial",
              message: "Falhou update diferencial pedido_itens após claim",
              category: "database",
              requestPath: "/api/wms/separacao/parcial",
              requestMethod: "POST",
              metadata: { pedido_item_id: it.id, movSaidaId, movAjusteId },
            });
            return NextResponse.json({ error: "erro persistindo parcial" }, { status: 500 });
          }

          // qty_pega já foi acumulada no pre-pass (antes do claim atômico) —
          // não duplica aqui.

          await registrarEvento({
            pedidoId: it.pedido_id,
            evento: "parcial_loc_zerou",
            detalhes: {
              item_id: it.id,
              sku: it.sku,
              quantidade_pega: qty_para_este,
              quantidade_pedida: Number(it.quantidade_pedida),
              loc_codigo: locCodigo,
              loc_zerou,
              delta_ajuste: ehBeneficiario && movAjusteId ? deltaAjuste : 0,
              wave_consolidado: itemsRaw.length > 1,
            },
            usuarioId: session.id,
          });
        }
      }
    }

    if (racePerdida) {
      // Rollback: estornar movs + delete bridge links + reverter markers
      // de Pass A (rows que foram parcialmente claimed antes da race ser detectada).
      if (movSaidaId) {
        try {
          await estornarMovimentacao({
            mov_id: movSaidaId,
            usuario_id: session.id,
            motivo: "Race condition — outro operador marcou primeiro",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial", "rollback estorno falhou", {
            error: (e as Error).message,
          });
        }
      }
      if (movAjusteId) {
        try {
          await estornarMovimentacao({
            mov_id: movAjusteId,
            usuario_id: session.id,
            motivo: "Race condition (ajuste)",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial", "rollback ajuste falhou", {
            error: (e as Error).message,
          });
        }
      }
      // Estorna L's das liberações de R — recria a R via estornarLiberacaoReserva
      // (o estornarMovimentacao genérico rejeita L com estorno_de=R.id).
      for (const [pid, info] of liberacoesPorPedido) {
        try {
          await estornarLiberacaoReserva({
            liberacao_mov_id: info.movL_id,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: "Race condition — recria R liberada no 7a",
          });
        } catch (e: unknown) {
          // LOUD: reserva liberada no 7a fica perdida — risco de overselling.
          logger.logError({
            error: e,
            source: "separacao-parcial",
            message: "rollback: falhou recriar R (estorno de L) — reserva perdida",
            category: "business_logic",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { pedido_id: pid, mov_l_id: info.movL_id },
          });
        }
      }
      const movIdsRollback = [
        movSaidaId,
        movAjusteId,
        ...Array.from(liberacoesPorPedido.values()).map((info) => info.movL_id),
      ].filter((id): id is string => !!id);
      if (movIdsRollback.length > 0) {
        await supabase
          .from("siso_pedido_item_mov_links")
          .delete()
          .in("mov_id", movIdsRollback);
      }
      // Reverte marker fields de Pass A pras rows efetivamente claimed.
      // Pass B nunca rodou (skipped por racePerdida), então só os markers de
      // Pass A precisam voltar (separacao_marcado=false + separacao_marcado_em=null).
      if (itemIdsClaimedParaReverter.length > 0) {
        const { error: revertErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            separacao_marcado: false,
            separacao_marcado_em: null,
          })
          .in("id", itemIdsClaimedParaReverter);
        if (revertErr) {
          logger.warn("separacao-parcial", "rollback marker item falhou", {
            error: revertErr.message,
            itemIdsClaimedParaReverter,
          });
        }
      }
      // Reverte quantidade_pega acumulada no pre-pass (delta negativo via RPC).
      // Cobre todos os items que receberam qty (não só os claimed) porque o
      // pre-pass acumulou ANTES do filtro de race.
      for (const u of itemUpdates) {
        if (u.qty_para_este > 0) {
          const { error: rpcErr } = await supabase.rpc("wms_acumular_qty_pega", {
            p_item_id: u.item.id,
            p_delta: -u.qty_para_este,
          });
          if (rpcErr) {
            logger.warn("separacao-parcial", "rollback qty_pega falhou", {
              error: rpcErr.message,
              item_id: u.item.id,
            });
          }
        }
      }
      return NextResponse.json(
        {
          error: "race_item_ja_picado",
          message: "Outro operador marcou primeiro — atualize a tela",
        },
        { status: 409 },
      );
    }

    // 10. Cascade: pra cada item com residual, busca outra loc.
    //     Cascade só faz sentido se loc_zerou=true (caso contrário operador
    //     volta a picar normalmente o item — não há "esgotou" envolvido).
    const itemsResiduais = itemUpdates.filter((u) => u.qty_residual > 0);

    if (itemsResiduais.length === 0) {
      return NextResponse.json({ status: "completo" });
    }

    if (!loc_zerou) {
      // Operador pegou menos que o pedido mas a prateleira AINDA tem saldo
      // (não zerou). O item fica ABERTO no MESMO checklist e o pedido continua
      // em_separacao com o mesmo operador — sem reenfileirar nem soltar a onda.
      //
      // Estado dos itens residuais: separacao_parcial=false,
      // separacao_marcado=false, quantidade_pega acumulada. NÃO setamos
      // separacao_parcial=true de propósito: marcar-item, /parcial e
      // /bipar-checklist TODOS rejeitam (409 / skip) itens com
      // separacao_parcial=true, então o flag travaria o re-pick. Com o flag em
      // false o operador completa o restante depois na mesma onda (marcar-item,
      // bipar ou Parcial de novo descontam quantidade_pedida-quantidade_pega).
      // O concluir só fecha o pedido quando todos os itens estiverem marcados —
      // item aberto deixa o pedido pendente, sem avançar errado.
      // O badge "Parcial X/Y" no checklist deriva de quantidade_pega
      // (0 < pega < pedida && !marcado), não do flag.

      // RE-RESERVA do residual na MESMA loc: a R original foi liberada 100% no
      // passo 7a (só pra quem pegou unidade). Recriamos uma R do que falta na
      // própria prateleira pra (a) a linha "PEGAR" continuar protegida (ninguém
      // rouba o saldo) e (b) o próximo parcial/marcar-item achar a R viva.
      // Pedido com picked=0 manteve a R original intacta (Edição B) → nada a fazer.
      for (const u of itemUpdates) {
        if (u.qty_residual <= 0 || u.qty_para_este <= 0) continue;
        const pedidoDoItem = pedidoById.get(u.pedido_id);
        try {
          await criarReservaCascade({
            tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: locOriginalId },
            qty: u.qty_residual,
            pedido_id: String(u.pedido_id),
            usuario_id: session.id,
            motivo: `Re-reserva residual mesma loc — parcial pedido #${pedidoDoItem?.numero ?? "?"}`,
            origem_detalhes: { contexto: "residual_mesma_loc", sku: u.item.sku, loc_id: locOriginalId },
          });
        } catch (e) {
          logger.warn("separacao-parcial", "Falhou re-reservar residual mesma loc (continua)", {
            pedido_id: u.pedido_id,
            qty_residual: u.qty_residual,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const beneficiariosResiduais = itemsResiduais.filter((u) => u.qty_para_este > 0);
      return NextResponse.json({
        status: "parcial_em_progresso",
        items_parciais: beneficiariosResiduais.length,
        items_residuais_a_fazer: itemsResiduais.length,
      });
    }

    // 3D: cascade no pool físico do galpão. Empresa origem do pedido vira
    // empresa_dona da realocacao (tag de "ownership lógica" do pedido) — é
    // metadado do pedido, não chave de coordenada de estoque.
    type LinhaInsert = {
      pedido_item_id: number;
      empresa_dona_id: string;
      galpao_id: string;
      localizacao_id: string;
      quantidade: number;
      is_emprestimo: boolean;
      empresa_devedora_id: string | null;
      motivo: string;
      criado_por: string;
    };

    const porEmpresa = new Map<string, typeof itemsResiduais>();
    for (const u of itemsResiduais) {
      const pedido = pedidos.find((p) => p.id === u.pedido_id);
      const empOrigem = pedido?.empresa_origem_id as string | undefined;
      if (!empOrigem) continue;
      if (!porEmpresa.has(empOrigem)) porEmpresa.set(empOrigem, []);
      porEmpresa.get(empOrigem)!.push(u);
    }

    const linhasInsertTotais: LinhaInsert[] = [];
    let semCoberturaParcial = false;
    const codigoPorLocAll = new Map<string, string | null>();
    // Decisão (28/05): payload com pedido_ids + item_ids cujo cascade não
    // achou cobertura — frontend abre modal "Mandar pra Compras / Realocação
    // manual". Substitui a auto-transição pra pendente_realocacao.
    const semCoberturaPayload: { pedido_ids: string[]; item_ids: string[] } = {
      pedido_ids: [],
      item_ids: [],
    };

    for (const [empOrigem, grupo] of porEmpresa) {
      const totalResidualGrupo = grupo.reduce((s, u) => s + u.qty_residual, 0);

      const itemIdsGrupo = grupo.map((u) => Number(u.item.id));
      const pedidoIdsGrupo = [...new Set(grupo.map((u) => u.pedido_id))];

      // (Fase 1.4) Loc original a excluir do cascade = a R viva consolidada
      // (locOriginalId), que é a posição que acabou de esvaziar. Antes lia o
      // snapshot siso_pedido_item_estoques pra coletar locs por pedido; com a
      // tabela dropada, locOriginalId (vindo da R) já é a fonte de verdade.
      const locsOriginais = new Set<string>();
      if (locOriginalId) locsOriginais.add(locOriginalId);

      // Todas as realocs já tentadas em items desse grupo
      const { data: rls } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select("localizacao_id")
        .in("pedido_item_id", itemIdsGrupo);

      const excluir = Array.from(
        new Set([
          ...locsOriginais,
          ...((rls ?? []).map((r) => r.localizacao_id as string)),
        ]),
      );

      const produtoWmsGrupo = await resolverProdutoWms(
        empOrigem,
        String(grupo[0].item.produto_id),
      );

      const resolver = await resolverRealocacao({
        produto_id: produtoWmsGrupo,
        galpao_id: galpaoId,
        localizacoes_excluir: excluir,
        qty_residual: totalResidualGrupo,
      });

      if (resolver.status === "sem_cobertura") {
        semCoberturaParcial = true;
        // Decisão (28/05): NÃO transita mais pra pendente_realocacao automaticamente.
        // Em vez disso, acumula pedido_ids + item_ids no payload, e o frontend
        // abre modal com 2 opções: "Mandar pra Compras" (default) ou "Pedir
        // realocação manual" (link cinza). Mata o loop infinito do cascade que
        // voltava pra /wms/pedidos Pendentes via pendente_realocacao.
        for (const u of grupo) {
          await registrarEvento({
            pedidoId: u.pedido_id,
            evento: "realocacao_sem_cobertura_galpao",
            detalhes: {
              item_id: u.item.id,
              sku: u.item.sku,
              qty_residual: u.qty_residual,
              empresa_origem_id: empOrigem,
            },
            usuarioId: session.id,
          });
          semCoberturaPayload.item_ids.push(String(u.item.id));
        }
        for (const pid of pedidoIdsGrupo) {
          if (!semCoberturaPayload.pedido_ids.includes(pid)) {
            semCoberturaPayload.pedido_ids.push(pid);
          }
        }
        continue;
      }

      // Distribui as realocações desse grupo entre items dele (FCFS).
      // 3D: pool fungível por (produto, galpao). empresa_dona da realoc é
      // a empresa origem do pedido (ownership lógica, sem semântica física).
      let idxItemResid = 0;
      let restanteItemAtual = grupo[0]?.qty_residual ?? 0;
      for (const r of resolver.realocacoes) {
        codigoPorLocAll.set(r.localizacao_id, r.localizacao_codigo);
        let qtyDessaReal = r.quantidade;
        while (qtyDessaReal > 0 && idxItemResid < grupo.length) {
          const u = grupo[idxItemResid];
          const slice = Math.min(qtyDessaReal, restanteItemAtual);
          if (slice > 0) {
            linhasInsertTotais.push({
              pedido_item_id: Number(u.item.id),
              empresa_dona_id: empOrigem,
              galpao_id: galpaoId,
              localizacao_id: r.localizacao_id,
              quantidade: slice,
              is_emprestimo: false,
              empresa_devedora_id: null,
              motivo: "loc_zerou",
              criado_por: session.id,
            });
            qtyDessaReal -= slice;
            restanteItemAtual -= slice;
          }
          if (restanteItemAtual === 0) {
            idxItemResid++;
            restanteItemAtual = grupo[idxItemResid]?.qty_residual ?? 0;
          }
        }
      }
    }

    // Mudança 1 (Fase 1.5): cascade esgotou no galpão atual e nenhuma realoc
    // criada. ANTES de mandar pra Compras, checa saldo VIVO (siso_estoque) em
    // OUTRO galpão. Se houver, NÃO auto-manda pra Compras — deixa o pedido
    // em_separacao e devolve `tem_em_outro_galpao` + lista de galpões, pro
    // frontend abrir modal "Encaminhar p/ Galpão X" como 1ª opção (encaminhar-
    // first). Só vai DIRETO pra Compras quando não há saldo em galpão nenhum
    // (caso do cenário 61).
    if (semCoberturaParcial && linhasInsertTotais.length === 0) {
      const alternativos = await galpoesComSaldo(produtoWmsId, galpaoId);
      if (alternativos.length > 0) {
        return NextResponse.json({
          status: "sem_cobertura_outro_galpao",
          tem_em_outro_galpao: true,
          galpoes_alternativos: alternativos.map((g) => ({
            galpao_id: g.galpao_id,
            galpao_nome: g.galpao_nome,
            disponivel: g.disponivel,
          })),
          pedido_ids: semCoberturaPayload.pedido_ids,
          item_ids: semCoberturaPayload.item_ids,
        });
      }
      const result = await mandarItensParaCompras({
        supabase,
        pedido_ids: semCoberturaPayload.pedido_ids,
        item_ids: semCoberturaPayload.item_ids,
        usuario_id: session.id,
        usuario_nome: session.nome,
      });
      return NextResponse.json({
        status: "mandado_pra_compras",
        tem_em_outro_galpao: false,
        itens_atualizados: result.itens_atualizados,
        pedidos_atualizados: result.pedidos_atualizados,
        pedido_ids: semCoberturaPayload.pedido_ids,
        item_ids: semCoberturaPayload.item_ids,
      });
    }

    if (linhasInsertTotais.length === 0) {
      // Nenhum grupo elegível (porEmpresa vazio — defensivo)
      return NextResponse.json({
        status: "aguardando_supervisor",
        motivo: "sem_grupos_elegiveis",
      });
    }

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(linhasInsertTotais)
      .select("id, pedido_item_id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial",
        message: "Falhou criar realocações",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { rows: linhasInsertTotais },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    // Pra cada realocação criada, emite R cascade na loc destino. Isso preserva
    // o invariante "reservado_total_pedido = qty_residual_não_atendido" — quando
    // marcar-realocacao executar, vai liberar essa R pareada com a saída.
    const cascadeLinks: Array<{
      pedido_item_id: number;
      realocacao_id: string;
      mov_id: string;
      qty: number;
      tipo_link: "reserva_cascade";
    }> = [];
    for (const c of criadas ?? []) {
      const itemDaRealoc = itemsRaw.find((it) => it.id === c.pedido_item_id);
      const pedidoDaRealoc = itemDaRealoc
        ? pedidoById.get(itemDaRealoc.pedido_id)
        : null;
      if (!itemDaRealoc || !pedidoDaRealoc) {
        logger.warn("separacao-parcial", "Realoc sem item/pedido pra R cascade", {
          realocacao_id: c.id,
        });
        continue;
      }
      try {
        const movR = await criarReservaCascade({
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: galpaoId,
            localizacao_id: c.localizacao_id as string,
          },
          qty: Number(c.quantidade),
          pedido_id: String(pedidoDaRealoc.id),
          usuario_id: session.id,
          motivo: `Reserva cascade pedido #${pedidoDaRealoc.numero} (loc original esgotou)`,
          origem_detalhes: {
            realocacao_id: c.id,
            pedido_numero: pedidoDaRealoc.numero,
            sku: itemDaRealoc.sku,
            loc_origem_id: locOriginalId,
          },
        });
        cascadeLinks.push({
          pedido_item_id: Number(c.pedido_item_id),
          realocacao_id: c.id as string,
          mov_id: movR.id,
          qty: Number(c.quantidade),
          tipo_link: "reserva_cascade",
        });
      } catch (cascadeErr) {
        logger.warn("separacao-parcial", "Falhou criar R cascade (continua)", {
          realocacao_id: c.id,
          error: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        });
      }
    }
    if (cascadeLinks.length > 0) {
      const { error: linkCascadeErr } = await supabase
        .from("siso_pedido_item_mov_links")
        .insert(cascadeLinks);
      if (linkCascadeErr) {
        logger.warn("separacao-parcial", "Falhou criar links cascade (continua)", {
          error: linkCascadeErr.message,
        });
      }
    }

    // Decisão (28/05 v2): caso misto — alguns itens foram realocados, outros
    // ficaram sem cobertura. Transita os sem_cobertura pra aguardando_compra
    // automaticamente (sem modal). Mesma intenção do bloco 100% sem cobertura.
    let resumoCompras: { itens_atualizados: number; pedidos_atualizados: number } | null = null;
    if (semCoberturaParcial && semCoberturaPayload.item_ids.length > 0) {
      resumoCompras = await mandarItensParaCompras({
        supabase,
        pedido_ids: semCoberturaPayload.pedido_ids,
        item_ids: semCoberturaPayload.item_ids,
        usuario_id: session.id,
        usuario_nome: session.nome,
      });
    }

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c) => ({
        id: c.id,
        pedido_item_id: c.pedido_item_id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: codigoPorLocAll.get(c.localizacao_id as string) ?? null,
        quantidade: c.quantidade,
        is_emprestimo: c.is_emprestimo,
      })),
      sem_cobertura_parcial: semCoberturaParcial ? true : undefined,
      itens_mandados_pra_compras: resumoCompras?.itens_atualizados ?? 0,
      pedidos_mandados_pra_compras: resumoCompras?.pedidos_atualizados ?? 0,
    });
  } catch (err) {
    const { id: erro_id, timestamp: erro_em } = logger.logError({
      error: err,
      source: "separacao-parcial",
      message: "Erro inesperado em parcial",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { pedido_item_ids, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno", erro_id, erro_em }, { status: 500 });
  }
}

async function processarParcialRealocacao(
  supabase: ReturnType<typeof createServiceClient>,
  session: NonNullable<Awaited<ReturnType<typeof getSessionUser>>>,
  realocacao_ids: string[],
  quantidade_pega: number,
  loc_zerou: boolean,
): Promise<NextResponse> {
  try {
    // 1. Carrega TODAS as realocações (ordem por criado_em pra distribuição determinística)
    const { data: realocs, error: realocErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .select(`
        id, pedido_item_id, empresa_dona_id, galpao_id, localizacao_id,
        quantidade, is_emprestimo, empresa_devedora_id, status, criado_em
      `)
      .in("id", realocacao_ids)
      .order("criado_em", { ascending: true });

    if (realocErr || !realocs || realocs.length === 0) {
      return NextResponse.json({ error: "realocação(ões) não encontrada(s)" }, { status: 404 });
    }
    if (realocs.length !== realocacao_ids.length) {
      return NextResponse.json(
        { error: "algumas realocações não foram encontradas" },
        { status: 404 },
      );
    }

    // 2. Valida: todas aguardando_picking
    const naoAguardando = realocs.find((r) => r.status !== "aguardando_picking");
    if (naoAguardando) {
      return NextResponse.json(
        {
          error: `realocação ${naoAguardando.id} não está aguardando picking (atual: ${naoAguardando.status})`,
        },
        { status: 409 },
      );
    }

    // 3. Valida invariantes: mesma loc + mesma empresa_dona + mesmo galpao
    //    (UI só consolida realocs com essa chave; bate o invariante aqui)
    const locSet = new Set(realocs.map((r) => r.localizacao_id));
    const empresaDonaSet = new Set(realocs.map((r) => r.empresa_dona_id));
    const galpaoSet = new Set(realocs.map((r) => r.galpao_id));
    if (locSet.size > 1 || empresaDonaSet.size > 1 || galpaoSet.size > 1) {
      return NextResponse.json(
        { error: "realocações devem estar na mesma loc/empresa/galpão" },
        { status: 400 },
      );
    }

    const totalSugerido = realocs.reduce((s, r) => s + Number(r.quantidade), 0);
    if (quantidade_pega > totalSugerido) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder o total sugerido (${totalSugerido})` },
        { status: 400 },
      );
    }

    // 4. Carrega items pais + pedidos
    const itemIds = [...new Set(realocs.map((r) => r.pedido_item_id))];
    const { data: items, error: itemsErr } = await supabase
      .from("siso_pedido_itens")
      .select("id, pedido_id, produto_id, sku, quantidade_pedida")
      .in("id", itemIds);

    if (itemsErr || !items || items.length !== itemIds.length) {
      return NextResponse.json({ error: "item(s) pai não encontrado(s)" }, { status: 404 });
    }
    const itemById = new Map(items.map((i) => [i.id, i]));

    const pedidoIds = [...new Set(items.map((i) => i.pedido_id))];
    const { data: pedidos, error: pedidosErr } = await supabase
      .from("siso_pedidos")
      .select("id, numero, empresa_origem_id")
      .in("id", pedidoIds);

    if (pedidosErr || !pedidos || pedidos.length !== pedidoIds.length) {
      return NextResponse.json({ error: "pedido(s) não encontrado(s)" }, { status: 404 });
    }
    const semEmpresa = pedidos.find((p) => !p.empresa_origem_id);
    if (semEmpresa) {
      return NextResponse.json(
        { error: `pedido ${semEmpresa.numero} sem empresa de origem` },
        { status: 400 },
      );
    }
    const pedidoById = new Map(pedidos.map((p) => [p.id, p]));

    // 5. Quadrupla comum (validada acima)
    const primeira = realocs[0];
    const empresaDonaId = primeira.empresa_dona_id;
    const galpaoId = primeira.galpao_id;
    const localizacaoId = primeira.localizacao_id;
    const isEmprestimo = primeira.is_emprestimo;
    const empresaDevedoraId = primeira.empresa_devedora_id;

    const primeiroItem = itemById.get(primeira.pedido_item_id)!;
    const primeiroPedido = pedidoById.get(primeiroItem.pedido_id)!;
    const empresaOrigemPrimeiroPedido = primeiroPedido.empresa_origem_id as string;

    const produtoTinyId = String(primeiroItem.produto_id);
    const produtoWmsId = await resolverProdutoWms(empresaDonaId, produtoTinyId);

    // 6. Saldo / reservado (3D: produto + galpao + loc)
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", localizacaoId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    // Reserva do próprio lote (R cascade nesta loc, liberada no passo 7a abaixo)
    // não conta como indisponível — só a reserva de outros pedidos restringe.
    // Espelha o gate do caminho item acima.
    let minhaReservaNestaLoc = 0;
    for (const pid of pedidoIds) {
      const r = await buscarReservaPendente({
        pedido_id: String(pid),
        tripla: { produto_id: produtoWmsId, galpao_id: galpaoId, localizacao_id: localizacaoId },
      });
      if (r) minhaReservaNestaLoc += Number(r.quantidade);
    }
    const reservadoDeOutros = Math.max(0, reservadoWms - minhaReservaNestaLoc);
    const disponivelParaMim = saldoWms - reservadoDeOutros;

    if (quantidade_pega > 0 && disponivelParaMim < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado por outros ${reservadoDeOutros}, disponível pra você ${disponivelParaMim}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoDeOutros,
          disponivel: disponivelParaMim,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // 7. Gera mov S única (qty_pega total) e mov ajuste (se loc_zerou) — vinculadas ao primeiro pedido.
    // 3D: empréstimo deixou de existir; saída sempre `nf_venda` taggeada com a
    // empresa vendedora (origem do pedido). Eventual "dívida" entre empresas
    // que essa picada gerou não é mais rastreada pelo ledger físico.
    const realocIdsList = realocs.map((r) => r.id);
    void empresaDonaId;
    void isEmprestimo;
    void empresaDevedoraId;

    // Distribuição FCFS (movida pra ANTES da liberação — espelha o modo item):
    // define, por realoc, quanto foi pego (qty_para_esta) e quanto sobra
    // (qty_residual). Agregado por pedido, governa QUAIS R cascade liberar
    // (só de quem recebeu unidade quando !loc_zerou) e qual residual re-reservar.
    type RealocUpdate = {
      realoc: typeof realocs[number];
      qty_para_esta: number;
      qty_residual: number;
    };
    let qtyRestante = quantidade_pega;
    const updates: RealocUpdate[] = [];
    for (const r of realocs) {
      const qtdSugerida = Number(r.quantidade);
      const qtyParaEsta = Math.min(qtdSugerida, qtyRestante);
      qtyRestante -= qtyParaEsta;
      updates.push({
        realoc: r,
        qty_para_esta: qtyParaEsta,
        qty_residual: qtdSugerida - qtyParaEsta,
      });
    }
    const allocPorPedido = new Map<string, { picked: number; residual: number }>();
    for (const u of updates) {
      const itemDoU = itemById.get(u.realoc.pedido_item_id);
      if (!itemDoU) continue;
      const cur = allocPorPedido.get(itemDoU.pedido_id) ?? { picked: 0, residual: 0 };
      cur.picked += u.qty_para_esta;
      cur.residual += u.qty_residual;
      allocPorPedido.set(itemDoU.pedido_id, cur);
    }

    // 7a. R↔L↔S pairing: pra cada pedido único do batch de realocs, libera
    // a R cascade que estava nessa loc. Cada modo-item anterior criou
    // uma R por realoc; aqui consolidamos em 1 L por pedido (idempotente:
    // buscarReservaPendente já filtra L existente).
    //   - loc_zerou=false: só libera a R de quem pegou unidade (guard abaixo);
    //     a R de pedido não-atendido fica INTACTA, e o residual do próprio pick
    //     é re-reservado na mesma loc mais adiante (passo 10, ramo !loc_zerou).
    //   - loc_zerou=true: libera 100% da R de todos (a loc esvaziou); o cascade
    //     re-emite R nas locs destino pra qty residual.
    const liberacoesRealocPorPedido = new Map<
      string,
      { reserva: ReservaPendenteRow; movL_id: string }
    >();
    for (const pid of pedidoIds) {
      const alloc = allocPorPedido.get(pid) ?? { picked: 0, residual: 0 };
      // !loc_zerou: NÃO liberar a R cascade de pedido que não recebeu unidade
      // (FCFS deu tudo a outro do batch). Senão ele perde a reserva sem ter
      // sido separado — mesmo guard do modo item (bug #50144/#50189). Com
      // loc_zerou=true mantém o comportamento antigo (libera todas; o cascade
      // recria em outra loc).
      if (!loc_zerou && alloc.picked === 0) continue;
      try {
        const r = await buscarReservaPendente({
          pedido_id: String(pid),
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: galpaoId,
            localizacao_id: localizacaoId,
          },
        });
        if (!r) {
          logger.warn(
            "separacao-parcial-realoc",
            "R cascade pendente não encontrada — pedido sem reserva",
            {
              pedido_id: pid,
              tripla: {
                produto_id: produtoWmsId,
                galpao_id: galpaoId,
                localizacao_id: localizacaoId,
              },
            },
          );
          continue;
        }
        const pedidoNumero = pedidoById.get(pid)?.numero;
        const movL = await liberarReservaPicking({
          reserva: r,
          qty: Number(r.quantidade),
          pedido_id: String(pid),
          motivo: `Picking parcial realoc pedido #${pedidoNumero ?? "?"} — libera R cascade`,
          usuario_id: session.id,
          origem_detalhes: {
            pedido_numero: pedidoNumero,
            contexto:
              realocs.length > 1
                ? "realocacao_parcial_consolidado"
                : "realocacao_parcial",
          },
        });
        liberacoesRealocPorPedido.set(pid, { reserva: r, movL_id: movL.id });
      } catch (libErr) {
        logger.warn("separacao-parcial-realoc", "Falhou liberar R cascade (continua)", {
          error: libErr instanceof Error ? libErr.message : String(libErr),
          pedido_id: pid,
        });
      }
    }

    // P2-SEP-08: compensa as liberações de R do passo 7a quando a S (ou o ajuste)
    // falha. Sem isso, um throw do inserirMovimentacao caía no catch externo →
    // 500, deixando as R liberadas no 7a PERDIDAS (overselling) — mesmo bug do
    // SEP-04 no modo item. Espelha a compensação da race-loss (estornarLiberacaoReserva).
    // Opcionalmente estorna uma S já criada (caso a falha seja no ajuste).
    async function compensar7aERetornar409(
      motivoFalha: string,
      movSaidaJaCriada: string | null,
    ) {
      if (movSaidaJaCriada) {
        try {
          await estornarMovimentacao({
            mov_id: movSaidaJaCriada,
            usuario_id: session.id,
            motivo: "Compensação — falha no ajuste pós-S (realocação parcial)",
          });
        } catch (e) {
          logger.warn("separacao-parcial-realoc", "compensação: estorno da S falhou", {
            mov_id: movSaidaJaCriada,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const naoRecriadas: Array<{ pedido_id: string; mov_l_id: string; erro: string }> = [];
      for (const [pid, info] of liberacoesRealocPorPedido) {
        try {
          await estornarLiberacaoReserva({
            liberacao_mov_id: info.movL_id,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: "Compensação — falha na S do parcial realocação (recria R cascade)",
          });
        } catch (e) {
          naoRecriadas.push({
            pedido_id: pid,
            mov_l_id: info.movL_id,
            erro: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (naoRecriadas.length > 0) {
        logger.logError({
          error: new Error("compensação de liberações falhou após erro da S (realocação)"),
          source: "separacao-parcial-realoc",
          message: "Reservas cascade liberadas no 7a não foram recriadas — risco de overselling",
          category: "business_logic",
          requestPath: "/api/wms/separacao/parcial",
          requestMethod: "POST",
          metadata: { naoRecriadas, motivoFalha },
        });
        return NextResponse.json(
          {
            error: "falha_pick_parcial",
            message:
              `${motivoFalha} — ATENÇÃO: ${naoRecriadas.length} reserva(s) liberada(s) ` +
              "não puderam ser recriadas. Acione o supervisor antes de tentar de novo.",
            reservas_nao_recriadas: naoRecriadas,
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: "falha_pick_parcial", message: motivoFalha },
        { status: 409 },
      );
    }

    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      try {
        const mov = await inserirMovimentacao({
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: galpaoId,
            localizacao_id: localizacaoId,
          },
          tipo: "S",
          qty: quantidade_pega,
          origem_tipo: "nf_venda",
          origem_detalhes: {
            pedido_id_tiny: primeiroPedido.id,
            pedido_numero: primeiroPedido.numero,
            pedido_item_ids: itemIds,
            realocacao_ids: realocIdsList,
            sku: primeiroItem.sku,
            contexto:
              realocs.length > 1 ? "realocacao_parcial_consolidado" : "realocacao_parcial",
          },
          empresa_vendedora_id: empresaOrigemPrimeiroPedido,
          motivo:
            realocs.length > 1
              ? `Picking parcial wave realocada — ${realocs.length} realocações (pedido #${primeiroPedido.numero}…)`
              : `Picking parcial pedido #${primeiroPedido.numero} — realocação`,
          usuario_id: session.id,
        });
        movSaidaId = mov.id;
      } catch (sErr) {
        return compensar7aERetornar409(
          sErr instanceof Error ? sErr.message : String(sErr),
          null,
        );
      }
    }

    let movAjusteId: string | null = null;
    // loc_zerou: idem modo-item — o ajuste não pode derrubar o saldo abaixo do
    // reservado que SOBRA na loc (reservas de OUTROS pedidos não liberadas aqui),
    // senão viola o CHECK reservado<=saldo e estoura 500. liberadoNaLoc = R cascade
    // DESTE batch já liberadas no passo 7a.
    const liberadoNaLoc = Array.from(liberacoesRealocPorPedido.values()).reduce(
      (s, info) => s + Number(info.reserva.quantidade),
      0,
    );
    const reservadoRestanteLoc = Math.max(0, reservadoWms - liberadoNaLoc);
    const deltaAjuste = loc_zerou
      ? Math.max(0, saldoWms - quantidade_pega - reservadoRestanteLoc)
      : 0;
    if (loc_zerou) {
      const delta = deltaAjuste;
      if (delta > 0) {
        try {
          const movAj = await inserirMovimentacao({
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: localizacaoId,
            },
            tipo: "S",
            qty: delta,
            origem_tipo: "ajuste_pick_zerou",
            origem_detalhes: {
              pedido_id_tiny: primeiroPedido.id,
              pedido_numero: primeiroPedido.numero,
              pedido_item_ids: itemIds,
              realocacao_ids: realocIdsList,
              saldo_anterior: saldoWms,
              qty_pega: quantidade_pega,
            },
            motivo: "loc zerou no bipe",
            usuario_id: session.id,
          });
          movAjusteId = movAj.id;
        } catch (ajErr) {
          // P2-SEP-08: falha no ajuste pós-S — estorna a S já criada e compensa
          // as liberações do 7a antes de 409 (senão a S fica órfã + R perdidas).
          return compensar7aERetornar409(
            ajErr instanceof Error ? ajErr.message : String(ajErr),
            movSaidaId,
          );
        }
      }

      // (Fase 1.4 — 2026-05-28) REMOVIDO: sync do snapshot
      // siso_pedido_item_estoques pós-loc_zerou (cascade path). Tabela dropada.
    }

    // 8. (updates já computado antes da liberação 7a — distribuição FCFS.)
    const indexPrimeiroBeneficiario =
      updates.findIndex((u) => u.qty_para_esta > 0) >= 0
        ? updates.findIndex((u) => u.qty_para_esta > 0)
        : 0;

    const nowIso = new Date().toISOString();

    // P3-12b (realocação): se o INSERT dos links falhar APÓS a S já criada, a S
    // fica órfã. Estorna S (+ ajuste) e recria as liberações do 7a antes de 409
    // (erro_persistindo_links), em vez de 500 com S órfã. Espelha o modo item.
    async function compensarLinksRealocERetornar409() {
      for (const movId of [movSaidaId, movAjusteId]) {
        if (!movId) continue;
        try {
          await estornarMovimentacao({
            mov_id: movId,
            usuario_id: session.id,
            motivo: "Compensação — falha persistindo links (parcial realocação)",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/já\s+(é\s+um\s+estorno|foi\s+estornada)/i.test(msg)) {
            logger.warn("separacao-parcial-realoc", "compensação: estorno da mov falhou", {
              mov_id: movId,
              error: msg,
            });
          }
        }
      }
      for (const [pid, info] of liberacoesRealocPorPedido) {
        try {
          await estornarLiberacaoReserva({
            liberacao_mov_id: info.movL_id,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: "Compensação — falha persistindo links (recria R cascade)",
          });
        } catch (e) {
          logger.logError({
            error: e,
            source: "separacao-parcial-realoc",
            message: "Compensação de links: falhou recriar R cascade — risco de overselling",
            category: "business_logic",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { pedido_id: pid, mov_l_id: info.movL_id },
          });
        }
      }
      return NextResponse.json(
        { error: "erro_persistindo_links" },
        { status: 409 },
      );
    }

    // 8a. Popula tabela ponte siso_pedido_item_mov_links — 1 linha por realoc com qty>0
    //     pra mov de saída (rateada). Ajuste loc_zerou (não rateado) vai no primeiro
    //     beneficiário com qty>0 (fallback: primeiro update se ninguém pegou nada).
    if (movSaidaId) {
      const linksRealoc: Array<{
        pedido_item_id: number;
        realocacao_id: string;
        mov_id: string;
        qty: number;
        tipo_link: "saida";
      }> = [];

      for (const u of updates) {
        if (u.qty_para_esta > 0) {
          linksRealoc.push({
            pedido_item_id: Number(u.realoc.pedido_item_id),
            realocacao_id: u.realoc.id,
            mov_id: movSaidaId,
            qty: u.qty_para_esta,
            tipo_link: "saida",
          });
        }
      }

      if (linksRealoc.length > 0) {
        const { error: linkErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(linksRealoc);
        if (linkErr) {
          logger.logError({
            error: linkErr,
            source: "separacao-parcial-realoc",
            message: "Falhou criar links",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movSaidaId, linksRealoc },
          });
          return compensarLinksRealocERetornar409();
        }
      }
    }

    if (movAjusteId && loc_zerou) {
      const delta = deltaAjuste;
      if (delta > 0) {
        const primeiraComQty = updates.find((u) => u.qty_para_esta > 0) ?? updates[0];
        const { error: linkAjErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert({
            pedido_item_id: Number(primeiraComQty.realoc.pedido_item_id),
            realocacao_id: primeiraComQty.realoc.id,
            mov_id: movAjusteId,
            qty: delta,
            tipo_link: "ajuste_loc_zerou",
          });
        if (linkAjErr) {
          logger.logError({
            error: linkAjErr,
            source: "separacao-parcial-realoc",
            message: "Falhou criar link de ajuste",
            category: "database",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { movAjusteId, delta },
          });
          return compensarLinksRealocERetornar409();
        }
      }
    }

    // 8c. Links das liberações de R cascade (1 por pedido do batch).
    if (liberacoesRealocPorPedido.size > 0) {
      const linksLibRealoc: Array<{
        pedido_item_id: number;
        realocacao_id: string;
        mov_id: string;
        qty: number;
        tipo_link: "liberacao_reserva";
      }> = [];
      for (const [pid, info] of liberacoesRealocPorPedido) {
        const primeiraRealocDoPedido = realocs.find((r) => {
          const it = itemById.get(r.pedido_item_id);
          return it?.pedido_id === pid;
        });
        if (!primeiraRealocDoPedido) continue;
        linksLibRealoc.push({
          pedido_item_id: Number(primeiraRealocDoPedido.pedido_item_id),
          realocacao_id: primeiraRealocDoPedido.id,
          mov_id: info.movL_id,
          qty: Number(info.reserva.quantidade),
          tipo_link: "liberacao_reserva",
        });
      }
      if (linksLibRealoc.length > 0) {
        const { error: linkLibErr } = await supabase
          .from("siso_pedido_item_mov_links")
          .insert(linksLibRealoc);
        if (linkLibErr) {
          logger.warn(
            "separacao-parcial-realoc",
            "Falhou criar links de liberação (continua)",
            {
              error: linkLibErr.message,
            },
          );
        }
      }
    }

    // 9. Update cada realocação + acumula no item pai
    //    C4: 2-pass atomic claim — evita drift mid-loop quando race acontece
    //    numa iteração N>1 (iterações 1..N-1 já estavam committed no padrão antigo).
    //
    //    Pass A: UPDATE atômico em lote que muda status='aguardando_picking' →
    //    'picado_parcial' (placeholder) em TODAS as realocs ao mesmo tempo,
    //    com filtro de race. Se claimed.length !== updatesParaMarcar.length,
    //    race detectada → rollback. SQL atômico = claim TODOS ou NENHUM.
    //
    //    Pass B: per-row UPDATE pra setar campos diferenciais (status final,
    //    quantidade_pega, parcial flags, mov_saida_id, etc) SEM filtro de race
    //    — já temos lock exclusivo nessas linhas.
    const updatesParaMarcar = updates.filter(
      (u) => u.qty_para_esta > 0 || loc_zerou,
    );
    let racePerdida = false;
    let realocIdsClaimedParaReverter: string[] = [];

    if (updatesParaMarcar.length > 0) {
      // ─── Pass A: claim atômico em lote ─────────────────────────────────
      // Usa 'picado_parcial' como status intermediário do claim — qualquer
      // outro endpoint que filtra por status='aguardando_picking' deixa de
      // ver essas linhas, ou seja, lock exclusivo efetivo.
      const realocIdsParaMarcar = updatesParaMarcar.map((u) => u.realoc.id);
      const { data: claimedIds, error: claimErr } = await supabase
        .from("siso_pedido_item_realocacoes")
        .update({
          status: "picado_parcial",
          picado_em: nowIso,
          picado_por: session.id,
        })
        .in("id", realocIdsParaMarcar)
        .eq("status", "aguardando_picking")
        .select("id");

      if (claimErr) {
        logger.logError({
          error: claimErr,
          source: "separacao-parcial-realoc",
          message: "Falhou claim atômico em lote",
          category: "database",
          requestPath: "/api/wms/separacao/parcial",
          requestMethod: "POST",
          metadata: { realocIdsParaMarcar, movSaidaId, movAjusteId },
        });
        return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
      }

      if (!claimedIds || claimedIds.length !== realocIdsParaMarcar.length) {
        racePerdida = true;
        // Captura os IDs que FORAM claimed (Pass A parcial) pra reverter
        // os campos marker no rollback abaixo.
        realocIdsClaimedParaReverter = (claimedIds ?? []).map((r) => r.id as string);
      }

      // ─── Pass B: differential per-row (sem race filter) ────────────────
      if (!racePerdida) {
        for (let i = 0; i < updates.length; i++) {
          const u = updates[i];
          const { realoc, qty_para_esta, qty_residual } = u;
          const ehBeneficiario = i === indexPrimeiroBeneficiario;
          const isCompletoEsta = qty_residual === 0;
          const deveMarcar = qty_para_esta > 0 || loc_zerou;

          if (!deveMarcar) continue; // realoc fica como aguardando_picking pra próxima ação

          const isParcialEsta = !isCompletoEsta;

          const { error: updErr } = await supabase
            .from("siso_pedido_item_realocacoes")
            .update({
              status: isCompletoEsta ? "picado" : "picado_parcial",
              quantidade_pega: qty_para_esta,
              parcial: isParcialEsta,
              parcial_motivo: isParcialEsta
                ? loc_zerou ? "cascade_loc_zerou" : "cascade_parcial"
                : null,
              parcial_em: isParcialEsta ? nowIso : null,
              parcial_por: isParcialEsta ? session.id : null,
              // Legacy field: mov_saida vinculada a TODAS as realocs beneficiadas (qty > 0).
              // Tabela ponte (criada acima) é a fonte de verdade pra rateamento.
              mov_saida_id: qty_para_esta > 0 ? movSaidaId : null,
              // mov_ajuste é da loc — fica só na primeira beneficiária (não rateado)
              mov_ajuste_loc_zerou_id: ehBeneficiario ? movAjusteId : null,
            })
            .eq("id", realoc.id);

          if (updErr) {
            logger.logError({
              error: updErr,
              source: "separacao-parcial-realoc",
              message: "Falhou update diferencial realocação após claim",
              category: "database",
              requestPath: "/api/wms/separacao/parcial",
              requestMethod: "POST",
              metadata: { realocacao_id: realoc.id, movSaidaId, movAjusteId },
            });
            return NextResponse.json({ error: "erro persistindo realocação" }, { status: 500 });
          }

          // I9: acumula qty no item pai atomicamente via RPC (substitui RMW)
          const item = itemById.get(realoc.pedido_item_id)!;
          if (qty_para_esta > 0) {
            await supabase.rpc("wms_acumular_qty_pega", {
              p_item_id: item.id,
              p_delta: qty_para_esta,
            });
          }

          const pedido = pedidoById.get(item.pedido_id)!;
          await registrarEvento({
            pedidoId: pedido.id,
            evento: isCompletoEsta ? "realocacao_picada" : "realocacao_parcial",
            detalhes: {
              item_id: item.id,
              realocacao_id: realoc.id,
              sku: item.sku,
              quantidade_pega: qty_para_esta,
              quantidade_sugerida: Number(realoc.quantidade),
              is_emprestimo: isEmprestimo,
              loc_zerou,
              wave_consolidado: realocs.length > 1,
            },
            usuarioId: session.id,
          });
        }
      }
    }

    if (racePerdida) {
      // Rollback: estornar movs + delete bridge links + reverter markers
      // de Pass A (rows que foram parcialmente claimed antes da race ser detectada).
      if (movSaidaId) {
        try {
          await estornarMovimentacao({
            mov_id: movSaidaId,
            usuario_id: session.id,
            motivo: "Race condition — outro operador picou primeiro",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial-realoc", "rollback estorno falhou", {
            error: (e as Error).message,
          });
        }
      }
      if (movAjusteId) {
        try {
          await estornarMovimentacao({
            mov_id: movAjusteId,
            usuario_id: session.id,
            motivo: "Race condition (ajuste)",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial-realoc", "rollback ajuste falhou", {
            error: (e as Error).message,
          });
        }
      }
      // Estorna L's das liberações de R cascade — recria a R via
      // estornarLiberacaoReserva (o estornarMovimentacao genérico rejeita
      // L com estorno_de=R.id).
      for (const [pid, info] of liberacoesRealocPorPedido) {
        try {
          await estornarLiberacaoReserva({
            liberacao_mov_id: info.movL_id,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: "Race condition — recria R cascade liberada no 7a",
          });
        } catch (e: unknown) {
          // LOUD: reserva liberada no 7a fica perdida — risco de overselling.
          logger.logError({
            error: e,
            source: "separacao-parcial-realoc",
            message: "rollback: falhou recriar R (estorno de L) — reserva perdida",
            category: "business_logic",
            requestPath: "/api/wms/separacao/parcial",
            requestMethod: "POST",
            metadata: { pedido_id: pid, mov_l_id: info.movL_id },
          });
        }
      }
      const movIdsRollback = [
        movSaidaId,
        movAjusteId,
        ...Array.from(liberacoesRealocPorPedido.values()).map((info) => info.movL_id),
      ].filter((id): id is string => !!id);
      if (movIdsRollback.length > 0) {
        await supabase
          .from("siso_pedido_item_mov_links")
          .delete()
          .in("mov_id", movIdsRollback);
      }
      // Reverte marker fields de Pass A pras rows efetivamente claimed.
      // Pass B nunca rodou (skipped por racePerdida), então só os markers de
      // Pass A precisam voltar a 'aguardando_picking' + picado_em/por NULL.
      if (realocIdsClaimedParaReverter.length > 0) {
        const { error: revertErr } = await supabase
          .from("siso_pedido_item_realocacoes")
          .update({
            status: "aguardando_picking",
            picado_em: null,
            picado_por: null,
          })
          .in("id", realocIdsClaimedParaReverter);
        if (revertErr) {
          logger.warn("separacao-parcial-realoc", "rollback marker realoc falhou", {
            error: revertErr.message,
            realocIdsClaimedParaReverter,
          });
        }
      }
      return NextResponse.json(
        {
          error: "realocacao_ja_picada",
          message: "Outro operador picou primeiro — atualize a tela",
        },
        { status: 409 },
      );
    }

    // 10. Cascade — pra cada realoc com residual em loc_zerou=true, busca próxima loc
    const realocsResiduais = updates.filter((u) => u.qty_residual > 0);

    if (realocsResiduais.length === 0) {
      return NextResponse.json({ status: "completo" });
    }

    if (!loc_zerou) {
      // Sem loc_zerou, residuais ficam como aguardando_picking (não foram marcados)
      // — operador continua picando normalmente.
      //
      // RE-RESERVA do residual na MESMA loc (espelha o modo item): a R cascade
      // foi liberada 100% no passo 7a (só de quem pegou unidade). Recriamos uma
      // R do que falta na própria prateleira pra (a) o saldo continuar protegido
      // (ninguém rouba) e (b) o próximo pick achar a R viva. Pedido com picked=0
      // manteve a R original intacta (guard do 7a) → nada a fazer.
      for (const pid of liberacoesRealocPorPedido.keys()) {
        const alloc = allocPorPedido.get(pid) ?? { picked: 0, residual: 0 };
        if (alloc.residual <= 0) continue;
        const pedidoDoPid = pedidoById.get(pid);
        try {
          await criarReservaCascade({
            tripla: {
              produto_id: produtoWmsId,
              galpao_id: galpaoId,
              localizacao_id: localizacaoId,
            },
            qty: alloc.residual,
            pedido_id: String(pid),
            usuario_id: session.id,
            motivo: `Re-reserva residual mesma loc — parcial realoc pedido #${pedidoDoPid?.numero ?? "?"}`,
            origem_detalhes: {
              contexto: "residual_mesma_loc",
              sku: primeiroItem.sku,
              loc_id: localizacaoId,
            },
          });
        } catch (e) {
          logger.warn(
            "separacao-parcial-realoc",
            "Falhou re-reservar residual mesma loc (continua)",
            {
              pedido_id: pid,
              qty_residual: alloc.residual,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      }
      return NextResponse.json({ status: "completo" });
    }

    // I8: agrupa realocs residuais pela empresa_origem_id do pedido pai do
    // item da realoc. Items distintos no mesmo wave (mesma loc consolidada)
    // podem ter empresas origem diferentes — sem grupamento, o cascade
    // atribuía empresa errada nas novas realocs.
    type RealocUpdateLocal = typeof realocsResiduais[number];
    const porEmpresa = new Map<string, RealocUpdateLocal[]>();
    for (const u of realocsResiduais) {
      const item = itemById.get(u.realoc.pedido_item_id);
      if (!item) continue;
      const pedido = pedidoById.get(item.pedido_id);
      const empOrigem = pedido?.empresa_origem_id as string | undefined;
      if (!empOrigem) continue;
      if (!porEmpresa.has(empOrigem)) porEmpresa.set(empOrigem, []);
      porEmpresa.get(empOrigem)!.push(u);
    }

    type LinhaInsert = {
      pedido_item_id: number;
      parent_realocacao_id: string;
      empresa_dona_id: string;
      galpao_id: string;
      localizacao_id: string;
      quantidade: number;
      is_emprestimo: boolean;
      empresa_devedora_id: string | null;
      motivo: string;
      criado_por: string;
    };

    const linhasInsertTotais: LinhaInsert[] = [];
    const codigoPorLocAll = new Map<string, string | null>();
    let semCoberturaParcial = false;
    const realocsSemCobertura: RealocUpdateLocal[] = [];

    for (const [empOrigem, grupo] of porEmpresa) {
      const totalResidualGrupo = grupo.reduce((s, u) => s + u.qty_residual, 0);

      const itemIdsGrupo = [
        ...new Set(grupo.map((u) => Number(u.realoc.pedido_item_id))),
      ];

      const itemsGrupo = itemIdsGrupo
        .map((id) => itemById.get(id))
        .filter((i): i is NonNullable<typeof i> => !!i);

      // (Fase 1.4) Loc original a excluir do cascade = a loc do cascade atual
      // (localizacaoId), que acabou de esvaziar. Antes coletava locs via snapshot
      // siso_pedido_item_estoques; tabela dropada — estoque é lido vivo.
      const locsOriginais = new Set<string>();
      locsOriginais.add(localizacaoId);

      // Todas as realocs já tentadas em items desse grupo
      const { data: todasRealoc } = await supabase
        .from("siso_pedido_item_realocacoes")
        .select("localizacao_id")
        .in("pedido_item_id", itemIdsGrupo);

      const excluir = Array.from(
        new Set([
          ...locsOriginais,
          ...((todasRealoc ?? []).map((r) => r.localizacao_id as string)),
        ]),
      );

      const produtoWmsGrupo = await resolverProdutoWms(
        empOrigem,
        String(itemsGrupo[0].produto_id),
      );

      const resolver = await resolverRealocacao({
        produto_id: produtoWmsGrupo,
        galpao_id: galpaoId,
        localizacoes_excluir: excluir,
        qty_residual: totalResidualGrupo,
      });

      if (resolver.status === "sem_cobertura") {
        semCoberturaParcial = true;
        for (const u of grupo) {
          const item = itemById.get(u.realoc.pedido_item_id)!;
          const pedido = pedidoById.get(item.pedido_id)!;
          await registrarEvento({
            pedidoId: pedido.id,
            evento: "realocacao_sem_cobertura_cascade",
            detalhes: {
              item_id: item.id,
              realocacao_id: u.realoc.id,
              sku: item.sku,
              qty_residual: u.qty_residual,
              empresa_origem_id: empOrigem,
            },
            usuarioId: session.id,
          });
          realocsSemCobertura.push(u);
        }
        continue;
      }

      // Distribui realocações encontradas entre os realocs residuais desse grupo (FCFS).
      // parent_realocacao_id = realoc residual atual (mantém a chain).
      // 3D: empresa_dona da nova realoc é a empresa origem do pedido (ownership lógica).
      let idxRes = 0;
      let restanteAtual = grupo[0]?.qty_residual ?? 0;
      for (const r of resolver.realocacoes) {
        codigoPorLocAll.set(r.localizacao_id, r.localizacao_codigo);
        let qtyDessaReal = r.quantidade;
        while (qtyDessaReal > 0 && idxRes < grupo.length) {
          const u = grupo[idxRes];
          const slice = Math.min(qtyDessaReal, restanteAtual);
          if (slice > 0) {
            linhasInsertTotais.push({
              pedido_item_id: Number(u.realoc.pedido_item_id),
              parent_realocacao_id: u.realoc.id,
              empresa_dona_id: empOrigem,
              galpao_id: galpaoId,
              localizacao_id: r.localizacao_id,
              quantidade: slice,
              is_emprestimo: false,
              empresa_devedora_id: null,
              motivo: loc_zerou ? "cascade_loc_zerou" : "cascade_parcial",
              criado_por: session.id,
            });
            qtyDessaReal -= slice;
            restanteAtual -= slice;
          }
          if (restanteAtual === 0) {
            idxRes++;
            restanteAtual = grupo[idxRes]?.qty_residual ?? 0;
          }
        }
      }
    }

    if (semCoberturaParcial && linhasInsertTotais.length === 0) {
      // Decisão (28/05): inclui payload pro frontend abrir modal Mandar pra Compras
      const payload: { pedido_ids: string[]; item_ids: string[] } = {
        pedido_ids: [],
        item_ids: [],
      };
      for (const u of realocsSemCobertura) {
        const item = itemById.get(u.realoc.pedido_item_id);
        if (!item) continue;
        const pedido = pedidoById.get(item.pedido_id);
        if (pedido && !payload.pedido_ids.includes(pedido.id)) {
          payload.pedido_ids.push(pedido.id);
        }
        if (!payload.item_ids.includes(String(item.id))) {
          payload.item_ids.push(String(item.id));
        }
      }
      return NextResponse.json({
        status: "sem_cobertura",
        sem_cobertura: true,
        sem_cobertura_payload: payload.item_ids.length > 0 ? payload : undefined,
      });
    }

    if (linhasInsertTotais.length === 0) {
      return NextResponse.json({ status: "sem_cobertura" });
    }

    const { data: criadas, error: insErr } = await supabase
      .from("siso_pedido_item_realocacoes")
      .insert(linhasInsertTotais)
      .select("id, pedido_item_id, parent_realocacao_id, empresa_dona_id, localizacao_id, quantidade, is_emprestimo");

    if (insErr) {
      logger.logError({
        error: insErr,
        source: "separacao-parcial-realoc",
        message: "Falhou criar realocações no cascade",
        category: "database",
        requestPath: "/api/wms/separacao/parcial",
        requestMethod: "POST",
        metadata: { realocacao_ids: realocIdsList, rows: linhasInsertTotais },
      });
      return NextResponse.json({ error: "erro criando realocações" }, { status: 500 });
    }

    // Pra cada realocação filha criada, emite R cascade nessa loc destino
    // (mesmo padrão do modo item). Mantém o invariante reservado = qty residual
    // pendente até o final do picking.
    const cascadeLinksRealoc: Array<{
      pedido_item_id: number;
      realocacao_id: string;
      mov_id: string;
      qty: number;
      tipo_link: "reserva_cascade";
    }> = [];
    for (const c of criadas ?? []) {
      const itemDaFilha = itemById.get(c.pedido_item_id);
      const pedidoDaFilha = itemDaFilha
        ? pedidoById.get(itemDaFilha.pedido_id)
        : null;
      if (!itemDaFilha || !pedidoDaFilha) {
        logger.warn("separacao-parcial-realoc", "Filha sem item/pedido pra R cascade", {
          realocacao_id: c.id,
        });
        continue;
      }
      try {
        const movR = await criarReservaCascade({
          tripla: {
            produto_id: produtoWmsId,
            galpao_id: galpaoId,
            localizacao_id: c.localizacao_id as string,
          },
          qty: Number(c.quantidade),
          pedido_id: String(pedidoDaFilha.id),
          usuario_id: session.id,
          motivo: `Reserva cascade pedido #${pedidoDaFilha.numero} (chain de realocação)`,
          origem_detalhes: {
            realocacao_id: c.id,
            parent_realocacao_id: c.parent_realocacao_id,
            pedido_numero: pedidoDaFilha.numero,
            sku: itemDaFilha.sku,
          },
        });
        cascadeLinksRealoc.push({
          pedido_item_id: Number(c.pedido_item_id),
          realocacao_id: c.id as string,
          mov_id: movR.id,
          qty: Number(c.quantidade),
          tipo_link: "reserva_cascade",
        });
      } catch (cascadeErr) {
        logger.warn("separacao-parcial-realoc", "Falhou criar R cascade filha (continua)", {
          realocacao_id: c.id,
          error: cascadeErr instanceof Error ? cascadeErr.message : String(cascadeErr),
        });
      }
    }
    if (cascadeLinksRealoc.length > 0) {
      const { error: linkCascadeErr } = await supabase
        .from("siso_pedido_item_mov_links")
        .insert(cascadeLinksRealoc);
      if (linkCascadeErr) {
        logger.warn(
          "separacao-parcial-realoc",
          "Falhou criar links cascade filhas (continua)",
          { error: linkCascadeErr.message },
        );
      }
    }

    // Conta filhas criadas por parent pra evento cascade
    const filhasPorParent = new Map<string, number>();
    for (const c of criadas ?? []) {
      const parent = c.parent_realocacao_id as string;
      filhasPorParent.set(parent, (filhasPorParent.get(parent) ?? 0) + 1);
    }

    const semCobertSet = new Set(realocsSemCobertura.map((u) => u.realoc.id));
    for (const u of realocsResiduais) {
      if (semCobertSet.has(u.realoc.id)) continue; // já registrou sem_cobertura
      const item = itemById.get(u.realoc.pedido_item_id)!;
      const pedido = pedidoById.get(item.pedido_id)!;
      await registrarEvento({
        pedidoId: pedido.id,
        evento: "realocacao_parcial_cascade",
        detalhes: {
          item_id: item.id,
          realocacao_id_origem: u.realoc.id,
          qtd_novas_realocacoes: filhasPorParent.get(u.realoc.id) ?? 0,
          sku: item.sku,
        },
        usuarioId: session.id,
      });
    }

    void empresaOrigemPrimeiroPedido; // mantido pra debug histórico (escopo unificado)

    // Decisão (28/05): payload pro frontend abrir modal Mandar pra Compras
    // quando o cascade da realocação esgota cobertura.
    const semCoberturaPayloadCascade: { pedido_ids: string[]; item_ids: string[] } = {
      pedido_ids: [],
      item_ids: [],
    };
    for (const u of realocsSemCobertura) {
      const item = itemById.get(u.realoc.pedido_item_id);
      if (!item) continue;
      const pedido = pedidoById.get(item.pedido_id);
      if (pedido && !semCoberturaPayloadCascade.pedido_ids.includes(pedido.id)) {
        semCoberturaPayloadCascade.pedido_ids.push(pedido.id);
      }
      if (!semCoberturaPayloadCascade.item_ids.includes(String(item.id))) {
        semCoberturaPayloadCascade.item_ids.push(String(item.id));
      }
    }

    return NextResponse.json({
      status: "realocado",
      realocacoes: (criadas ?? []).map((c) => ({
        id: c.id,
        empresa_dona_id: c.empresa_dona_id,
        localizacao_id: c.localizacao_id,
        localizacao_codigo: codigoPorLocAll.get(c.localizacao_id as string) ?? null,
        quantidade: c.quantidade,
        is_emprestimo: c.is_emprestimo,
      })),
      sem_cobertura_parcial: semCoberturaParcial ? true : undefined,
      sem_cobertura: semCoberturaParcial,
      sem_cobertura_payload:
        semCoberturaParcial && semCoberturaPayloadCascade.item_ids.length > 0
          ? semCoberturaPayloadCascade
          : undefined,
    });
  } catch (err) {
    const { id: erro_id, timestamp: erro_em } = logger.logError({
      error: err,
      source: "separacao-parcial-realoc",
      message: "Erro inesperado em parcial realocação",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { realocacao_ids, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno", erro_id, erro_em }, { status: 500 });
  }
}
