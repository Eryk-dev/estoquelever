import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverProdutoWms, resolverLocalizacaoWms } from "@/lib/separacao/wms-mapping";
import { resolverRealocacao } from "@/lib/separacao/realocacao-resolver";

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
        "id, pedido_id, produto_id, sku, quantidade_pedida, separacao_marcado, separacao_parcial",
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

    const totalPedido = itemsRaw.reduce(
      (s, it) => s + Number(it.quantidade_pedida),
      0,
    );
    if (quantidade_pega > totalPedido) {
      return NextResponse.json(
        { error: `quantidade_pega não pode exceder o total pedido (${totalPedido})` },
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

    // 5. Loc original — usa a do primeiro item (no wave picking, todos compartilham a mesma loc consolidada)
    const { data: estoque } = await supabase
      .from("siso_pedido_item_estoques")
      .select("localizacao")
      .eq("pedido_id", primeiroItem.pedido_id)
      .eq("produto_id", primeiroItem.produto_id)
      .eq("empresa_id", empresaOrigemId)
      .maybeSingle();

    const locCodigo = (estoque?.localizacao as string | null | undefined) ?? null;
    const locOriginalId = await resolverLocalizacaoWms(galpaoId, locCodigo);

    // 6. Saldo / reservado
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaOrigemId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", locOriginalId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    if (quantidade_pega > 0 && disponivelWms < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado ${reservadoWms}, disponível ${disponivelWms}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoWms,
          disponivel: disponivelWms,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // 7. Gera mov S única (qty_pega total) e mov ajuste única — ambas vinculadas ao primeiro pedido,
    //    com lista completa de items cobertos em origem_detalhes pra rastreabilidade.
    const itemIdsList = itemsRaw.map((it) => Number(it.id));

    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: empresaOrigemId,
          galpao_id: galpaoId,
          localizacao_id: locOriginalId,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: "nf_venda",
        origem_id: `pedido:${primeiroPedido.id}`,
        origem_detalhes: {
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIdsList,
          sku: primeiroItem.sku,
          contexto: itemsRaw.length > 1 ? "parcial_consolidado" : "parcial",
        },
        observacoes:
          itemsRaw.length > 1
            ? `Picking parcial wave — ${itemsRaw.length} items (pedido #${primeiroPedido.numero}…)`
            : `Picking parcial pedido #${primeiroPedido.numero}`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: empresaOrigemId,
            galpao_id: galpaoId,
            localizacao_id: locOriginalId,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${primeiroPedido.id}`,
          origem_detalhes: {
            pedido_numero: primeiroPedido.numero,
            pedido_item_ids: itemIdsList,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou no picking — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 8. Distribui qty_pega entre items em ordem (first-come-first-served) e
    //    coleta items residuais pra cascade.
    const nowIso = new Date().toISOString();
    let qtyRestante = quantidade_pega;
    const itemUpdates: Array<{
      item: typeof itemsRaw[number];
      qty_para_este: number;
      qty_residual: number;
      pedido_id: string;
    }> = [];

    for (const it of itemsRaw) {
      const pedidaItem = Number(it.quantidade_pedida);
      const qtyParaEste = Math.min(pedidaItem, qtyRestante);
      qtyRestante -= qtyParaEste;
      itemUpdates.push({
        item: it,
        qty_para_este: qtyParaEste,
        qty_residual: pedidaItem - qtyParaEste,
        pedido_id: it.pedido_id,
      });
    }

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
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
        }
      }
    }

    if (movAjusteId && loc_zerou) {
      const delta = saldoWms - quantidade_pega;
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
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
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
    const itemsParaMarcar = itemUpdates.filter(
      (u) => u.qty_para_este > 0 || loc_zerou,
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
          const deveMarcar = qty_para_este > 0 || loc_zerou;
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

          // I9: acumula qty_pega atomicamente via RPC (substitui RMW)
          if (qty_para_este > 0) {
            await supabase.rpc("wms_acumular_qty_pega", {
              p_item_id: it.id,
              p_delta: qty_para_este,
            });
          }

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
              delta_ajuste: ehBeneficiario && movAjusteId ? saldoWms - quantidade_pega : 0,
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
            observacoes: "Race condition — outro operador marcou primeiro",
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
            observacoes: "Race condition (ajuste)",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial", "rollback ajuste falhou", {
            error: (e as Error).message,
          });
        }
      }
      if (movSaidaId) {
        await supabase.from("siso_pedido_item_mov_links").delete().eq("mov_id", movSaidaId);
      }
      if (movAjusteId) {
        await supabase.from("siso_pedido_item_mov_links").delete().eq("mov_id", movAjusteId);
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
      // Operador pegou menos que pedido mas não zerou a loc — items residuais
      // NÃO foram marcados (deveMarcar=false acima), continuam a fazer no checklist.
      // Não roda cascade.
      return NextResponse.json({
        status: "completo",
        items_marcados: itemUpdates.filter((u) => u.qty_para_este > 0).length,
        items_residuais_a_fazer: itemsResiduais.length,
      });
    }

    // I8: agrupa items residuais por empresa_origem_id pra evitar atribuição
    // de empresa errada quando wave junta items de empresas distintas. Hoje
    // a validação upstream já barra multi-empresa em modo item; o grupamento
    // aqui é defesa-em-profundidade + paralelo com modo realoc (que SÓ aceita
    // multi-empresa).
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

    for (const [empOrigem, grupo] of porEmpresa) {
      const totalResidualGrupo = grupo.reduce((s, u) => s + u.qty_residual, 0);

      // Locs originais do grupo (mapeadas pela empresa origem)
      const itemIdsGrupo = grupo.map((u) => Number(u.item.id));
      const pedidoIdsGrupo = [...new Set(grupo.map((u) => u.pedido_id))];
      const { data: estoquesLeg } = await supabase
        .from("siso_pedido_item_estoques")
        .select("localizacao, produto_id, pedido_id")
        .in("pedido_id", pedidoIdsGrupo)
        .eq("empresa_id", empOrigem);

      const locsOriginais = new Set<string>();
      for (const e of estoquesLeg ?? []) {
        const locId = await resolverLocalizacaoWms(galpaoId, e.localizacao);
        if (locId) locsOriginais.add(locId);
      }
      // Loc original calculada upstream também entra (caso o item residual
      // venha de um pedido cujo registro em pedido_item_estoques esteja
      // ausente, fallback é a do primeiro item).
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
        empresa_origem_id: empOrigem,
        galpao_id: galpaoId,
        localizacoes_excluir: excluir,
        qty_residual: totalResidualGrupo,
      });

      if (resolver.status === "sem_cobertura") {
        semCoberturaParcial = true;
        // Marca os pedidos desse grupo como pendente_realocacao
        await supabase
          .from("siso_pedidos")
          .update({ status_separacao: "pendente_realocacao" })
          .in("id", pedidoIdsGrupo);

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
        }
        continue;
      }

      // Distribui as realocações desse grupo entre items dele (FCFS)
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
              empresa_dona_id: r.empresa_dona_id,
              galpao_id: galpaoId,
              localizacao_id: r.localizacao_id,
              quantidade: slice,
              is_emprestimo: r.is_emprestimo,
              empresa_devedora_id: r.empresa_devedora_id,
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

    // Se ninguém achou cobertura, mantém semântica antiga (aguardando_supervisor)
    if (semCoberturaParcial && linhasInsertTotais.length === 0) {
      return NextResponse.json({
        status: "aguardando_supervisor",
        motivo: "sem_cobertura_total",
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
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial",
      message: "Erro inesperado em parcial",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { pedido_item_ids, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
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

    // 6. Saldo / reservado
    const { data: estoqueWms } = await supabase
      .from("siso_estoque")
      .select("saldo, reservado, disponivel")
      .eq("produto_id", produtoWmsId)
      .eq("empresa_dona_id", empresaDonaId)
      .eq("galpao_id", galpaoId)
      .eq("localizacao_id", localizacaoId)
      .maybeSingle();

    const saldoWms = Number(estoqueWms?.saldo ?? 0);
    const reservadoWms = Number(estoqueWms?.reservado ?? 0);
    const disponivelWms = Number(estoqueWms?.disponivel ?? saldoWms - reservadoWms);

    if (quantidade_pega > 0 && disponivelWms < quantidade_pega) {
      return NextResponse.json(
        {
          error: "posicao_reservada",
          message:
            `Posição reservada por outro pedido (saldo ${saldoWms}, reservado ${reservadoWms}, disponível ${disponivelWms}). ` +
            `Não é possível dar saída de ${quantidade_pega}. Avise o supervisor pra liberar a reserva.`,
          saldo: saldoWms,
          reservado: reservadoWms,
          disponivel: disponivelWms,
          quantidade_pega,
        },
        { status: 409 },
      );
    }

    // 7. Gera mov S única (qty_pega total) e mov ajuste (se loc_zerou) — vinculadas ao primeiro pedido
    const realocIdsList = realocs.map((r) => r.id);
    let movSaidaId: string | null = null;
    if (quantidade_pega > 0) {
      const mov = await inserirMovimentacao({
        quadrupla: {
          produto_id: produtoWmsId,
          empresa_dona_id: empresaDonaId,
          galpao_id: galpaoId,
          localizacao_id: localizacaoId,
        },
        tipo: "S",
        qty: quantidade_pega,
        origem_tipo: isEmprestimo ? "emprestimo" : "nf_venda",
        origem_id: `pedido:${primeiroPedido.id}`,
        origem_detalhes: {
          pedido_numero: primeiroPedido.numero,
          pedido_item_ids: itemIds,
          realocacao_ids: realocIdsList,
          sku: primeiroItem.sku,
          contexto:
            realocs.length > 1 ? "realocacao_parcial_consolidado" : "realocacao_parcial",
        },
        emprestimo_devedora_id: isEmprestimo ? empresaDevedoraId ?? undefined : undefined,
        observacoes:
          realocs.length > 1
            ? `Picking parcial wave realocada — ${realocs.length} realocações (pedido #${primeiroPedido.numero}…)`
            : isEmprestimo
              ? `Picking parcial pedido #${primeiroPedido.numero} — empréstimo`
              : `Picking parcial pedido #${primeiroPedido.numero} — realocação`,
        usuario_id: session.id,
      });
      movSaidaId = mov.id;
    }

    let movAjusteId: string | null = null;
    if (loc_zerou) {
      const delta = saldoWms - quantidade_pega;
      if (delta > 0) {
        const movAj = await inserirMovimentacao({
          quadrupla: {
            produto_id: produtoWmsId,
            empresa_dona_id: empresaDonaId,
            galpao_id: galpaoId,
            localizacao_id: localizacaoId,
          },
          tipo: "S",
          qty: delta,
          origem_tipo: "ajuste_pick_zerou",
          origem_id: `pedido:${primeiroPedido.id}`,
          origem_detalhes: {
            pedido_numero: primeiroPedido.numero,
            pedido_item_ids: itemIds,
            realocacao_ids: realocIdsList,
            saldo_anterior: saldoWms,
            qty_pega: quantidade_pega,
          },
          observacoes: `Loc zerou na realocação — ajuste ${delta} (sistema dizia ${saldoWms}, real ${quantidade_pega})`,
          usuario_id: session.id,
        });
        movAjusteId = movAj.id;
      }
    }

    // 8. Distribui qty_pega entre realocs em ordem (FCFS)
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

    const indexPrimeiroBeneficiario =
      updates.findIndex((u) => u.qty_para_esta > 0) >= 0
        ? updates.findIndex((u) => u.qty_para_esta > 0)
        : 0;

    const nowIso = new Date().toISOString();

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
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
        }
      }
    }

    if (movAjusteId && loc_zerou) {
      const delta = saldoWms - quantidade_pega;
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
          return NextResponse.json({ error: "erro persistindo links" }, { status: 500 });
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
            observacoes: "Race condition — outro operador picou primeiro",
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
            observacoes: "Race condition (ajuste)",
          });
        } catch (e: unknown) {
          logger.warn("separacao-parcial-realoc", "rollback ajuste falhou", {
            error: (e as Error).message,
          });
        }
      }
      if (movSaidaId) {
        await supabase.from("siso_pedido_item_mov_links").delete().eq("mov_id", movSaidaId);
      }
      if (movAjusteId) {
        await supabase.from("siso_pedido_item_mov_links").delete().eq("mov_id", movAjusteId);
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
      // — operador continua picando normalmente
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

      // Locs originais dos pedidos desse grupo (lookup via siso_pedido_item_estoques)
      const itemsGrupo = itemIdsGrupo
        .map((id) => itemById.get(id))
        .filter((i): i is NonNullable<typeof i> => !!i);
      const pedidoIdsGrupo = [...new Set(itemsGrupo.map((i) => i.pedido_id))];
      const { data: estoquesLeg } = await supabase
        .from("siso_pedido_item_estoques")
        .select("localizacao, produto_id, pedido_id")
        .in("pedido_id", pedidoIdsGrupo)
        .eq("empresa_id", empOrigem);

      const locsOriginais = new Set<string>();
      for (const e of estoquesLeg ?? []) {
        const locId = await resolverLocalizacaoWms(galpaoId, e.localizacao);
        if (locId) locsOriginais.add(locId);
      }
      // Loc atual do cascade (já visitada) também entra
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
        empresa_origem_id: empOrigem,
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
              empresa_dona_id: r.empresa_dona_id,
              galpao_id: galpaoId,
              localizacao_id: r.localizacao_id,
              quantidade: slice,
              is_emprestimo: r.is_emprestimo,
              empresa_devedora_id: r.empresa_devedora_id,
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
      return NextResponse.json({ status: "sem_cobertura" });
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
    });
  } catch (err) {
    logger.logError({
      error: err,
      source: "separacao-parcial-realoc",
      message: "Erro inesperado em parcial realocação",
      category: "unknown",
      requestPath: "/api/wms/separacao/parcial",
      requestMethod: "POST",
      metadata: { realocacao_ids, quantidade_pega, loc_zerou },
    });
    return NextResponse.json({ error: "erro interno" }, { status: 500 });
  }
}
