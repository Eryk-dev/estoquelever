import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";
import { registrarEvento } from "@/lib/historico-service";
import { pickMovPicking } from "@/lib/wms/separacao/pick-mov";
import { estornarMovimentacao, inserirMovimentacao } from "@/lib/wms/ledger";
import { resolverProdutoWms } from "@/lib/separacao/wms-mapping";
import { registrarContagemInline, enfileirarLocParaContagem } from "@/lib/wms/contagem-inline";
import { alocarContagem, type PlanoAlocacao } from "@/lib/wms/separacao/alocacao-contagem";

/**
 * POST /api/separacao/validar-oc-item
 *
 * Handles OC item validation during the validacao_oc phase.
 * Two actions:
 *   - "encontrei": item was found physically → clear compra fields + mark as picked
 *   - "esgotado": item confirmed missing → send to compras (aguardando_compra)
 *
 * After processing, auto-transitions pedidos when all OC items are resolved:
 *   - FR-9: all found → decisao propria, status aguardando_separacao
 *   - FR-8: all esgotado + 100% OC → status aguardando_compra
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const itemIds: unknown = body?.item_ids;
  const acao: unknown = body?.acao;

  const qtyContadaBody =
    typeof body?.qty_contada === "number" && Number.isFinite(body.qty_contada)
      ? Math.trunc(body.qty_contada)
      : null;
  const locCodigoBody =
    typeof body?.localizacao_codigo === "string" ? body.localizacao_codigo.trim() : null;
  // solicitar_contagem=true: pega só a qty do pedido + enfileira a loc pra contagem futura.
  // Mutuamente exclusivo com qty_contada (qty_contada = contagem inline imediata).
  const solicitarContagem = body?.solicitar_contagem === true;
  if (solicitarContagem && qtyContadaBody !== null) {
    return NextResponse.json(
      { error: "solicitar_contagem e qty_contada são mutuamente exclusivos" },
      { status: 400 },
    );
  }

  if (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    !itemIds.every((id) => typeof id === "string" || typeof id === "number")
  ) {
    return NextResponse.json(
      { error: "item_ids deve ser um array de strings não vazio" },
      { status: 400 },
    );
  }

  // Normalize to strings (Supabase returns integer PKs as numbers)
  const normalizedIds = itemIds.map((id) => String(id));

  if (acao !== "encontrei" && acao !== "esgotado" && acao !== "desfazer_encontrei") {
    return NextResponse.json(
      { error: "acao deve ser 'encontrei', 'esgotado' ou 'desfazer_encontrei'" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  try {
    // Fetch the target items with necessary fields
    const { data: items, error: fetchErr } = await supabase
      .from("siso_pedido_itens")
      .select(
        "id, pedido_id, sku, quantidade_pedida, quantidade_pega, compra_status, fornecedor_oc",
      )
      .in("id", normalizedIds);

    if (fetchErr) {
      logger.logError({
        error: fetchErr,
        source: "validar-oc-item",
        message: "Erro ao buscar itens",
        category: "database",
      });
      return NextResponse.json(
        { error: "Erro ao buscar itens" },
        { status: 500 },
      );
    }

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Nenhum item encontrado" },
        { status: 404 },
      );
    }

    const now = new Date().toISOString();
    let itensAtualizados = 0;
    // SEP-03: itens cujo pick falhou no "encontrei" — NÃO são marcados como
    // pegos; reportados na resposta pro operador re-tentar.
    const itensNaoValidados: Array<{
      item_id: string;
      sku: string | null;
      motivo: string;
    }> = [];
    // Resumo da alocação da contagem parcial (só no caminho encontrei+qty_contada)
    let coberturaResp: {
      qty_contada: number;
      itens_cobertos: number;
      itens_parciais: number;
      itens_esgotados: number;
      qty_para_compras: number;
    } | null = null;

    // ─── Process each item ──────────────────────────────────────
    if (acao === "encontrei") {
      // Pre-fetch pedido contexto pra cada item (empresa + galpão + numero).
      // Sem isso, não temos como resolver tripla WMS pra emitir o par S+L.
      const pedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
      const { data: pedidosCtx } = await supabase
        .from("siso_pedidos")
        .select("id, numero, empresa_origem_id, separacao_galpao_id")
        .in("id", pedidoIds);
      const ctxMap = new Map<
        string,
        { numero: string; empresa: string | null; galpao: string | null }
      >(
        (pedidosCtx ?? []).map((p) => [
          p.id as string,
          {
            numero: (p.numero as string) ?? "",
            empresa: (p.empresa_origem_id as string | null) ?? null,
            galpao: (p.separacao_galpao_id as string | null) ?? null,
          },
        ]),
      );

      // Re-fetch items com produto_id (Tiny bigint) + mov_saida_id (pra
      // short-circuit idempotente em retry — clique duplo do operador).
      const { data: itensFull } = await supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, produto_id, sku, quantidade_pedida, mov_saida_id")
        .in(
          "id",
          items.map((i) => i.id),
        );

      // Decisão 3 (28/05): se o body trouxer localizacao_id (loc bipada pelo
      // operador via modal "Onde você achou?"), é o caminho "Encontrei sem
      // cadastro" — produto não tem nenhuma loc com saldo no galpão. Geramos
      // par E+S na loc indicada. Alternativamente, se o snapshot já tem loc
      // salva via /separacao/localizacao, usamos essa.
      const locManualBody =
        typeof body?.localizacao_id === "string" ? body.localizacao_id : null;

      // ─── Contagem parcial: distribui a contagem entre os itens pendentes,
      // liberando o máximo de pedidos por inteiro (menor qty primeiro). A sobra
      // vira pick parcial do próximo item e o restante descoberto vai pra
      // compras automaticamente (decisão do operador ao contar menos que o total).
      const infoMap = new Map(items.map((i) => [String(i.id), i]));
      let planoContagem: Map<string, PlanoAlocacao> | null = null;
      if (qtyContadaBody !== null) {
        if (qtyContadaBody <= 0) {
          return NextResponse.json(
            { error: "contagem_invalida", message: "Quantidade contada deve ser maior que zero." },
            { status: 422 },
          );
        }
        const itensAlocaveis = (itensFull ?? []).filter((it) => {
          if (it.mov_saida_id) return false; // já picado (retry) — fora da alocação
          const c = ctxMap.get(it.pedido_id as string);
          return Boolean(c && c.galpao && c.empresa);
        });

        // A contagem é de UMA prateleira de UM produto: itens de SKUs ou
        // galpões diferentes na mesma chamada corromperiam a reconciliação
        // (que roda uma vez, no galpão do primeiro item). A UI agrupa por
        // produto, mas a API não pode confiar nisso.
        const skusDistintos = new Set(itensAlocaveis.map((it) => String(it.sku)));
        const galpoesDistintos = new Set(
          itensAlocaveis.map((it) => ctxMap.get(it.pedido_id as string)?.galpao),
        );
        if (skusDistintos.size > 1 || galpoesDistintos.size > 1) {
          return NextResponse.json(
            {
              error: "grupo_heterogeneo",
              message:
                "Contagem só pode ser aplicada a itens do mesmo SKU e galpão.",
            },
            { status: 422 },
          );
        }

        const alocaveis = itensAlocaveis.map((it) => ({
          id: String(it.id),
          qty: Number(it.quantidade_pedida ?? 0),
        }));
        planoContagem = alocarContagem(alocaveis, qtyContadaBody);

        let cobertos = 0;
        let parciais = 0;
        let esgotados = 0;
        let qtyParaCompras = 0;
        for (const a of alocaveis) {
          const p = planoContagem.get(a.id);
          if (!p || p.tipo === "cobre_total") cobertos++;
          else if (p.tipo === "parcial") {
            parciais++;
            qtyParaCompras += Math.max(0, a.qty - p.qty_pega);
          } else {
            esgotados++;
            qtyParaCompras += a.qty;
          }
        }
        coberturaResp = {
          qty_contada: qtyContadaBody,
          itens_cobertos: cobertos,
          itens_parciais: parciais,
          itens_esgotados: esgotados,
          qty_para_compras: qtyParaCompras,
        };

        // Reconciliação da loc roda UMA vez (contagem oficial da prateleira),
        // ANTES dos picks. Dentro do loop ela re-inflaria o saldo a cada pick
        // já consumido quando o grupo tem mais de um item.
        const primeiro = (itensFull ?? []).find((it) =>
          planoContagem!.has(String(it.id)),
        );
        if (primeiro) {
          const ctx = ctxMap.get(primeiro.pedido_id as string)!;
          // Resolve loc-alvo: localizacao_id (uuid) OU localizacao_codigo (string).
          let locAlvoId: string | null = locManualBody;
          if (!locAlvoId && locCodigoBody) {
            const { data: locByCod } = await supabase
              .from("siso_localizacoes")
              .select("id")
              .eq("galpao_id", ctx.galpao!)
              .eq("codigo", locCodigoBody)
              .maybeSingle();
            locAlvoId = (locByCod as { id?: string } | null)?.id ?? null;
          }
          if (!locAlvoId) {
            return NextResponse.json(
              { error: "loc_obrigatoria", message: "Bipe/escolha a localização onde contou o item." },
              { status: 422 },
            );
          }
          // Se veio por uuid, confirma que pertence ao galpão.
          if (locManualBody) {
            const { data: locChk } = await supabase
              .from("siso_localizacoes")
              .select("id, galpao_id")
              .eq("id", locManualBody)
              .maybeSingle();
            if (!locChk || (locChk as { galpao_id?: string }).galpao_id !== ctx.galpao) {
              return NextResponse.json(
                { error: "loc_invalida", message: "Localização não pertence ao galpão do pedido" },
                { status: 422 },
              );
            }
          }
          const produtoWmsPrimeiro = await resolverProdutoWms(
            ctx.empresa!,
            String(primeiro.produto_id),
          );
          try {
            await registrarContagemInline({
              produto_id: produtoWmsPrimeiro,
              galpao_id: ctx.galpao!,
              localizacao_id: locAlvoId,
              qty_contada: qtyContadaBody,
              contada_por: user.id,
              sku: String(primeiro.sku),
              pedido_id: String(primeiro.pedido_id),
            });
          } catch (contErr) {
            logger.logError({
              error: contErr instanceof Error ? contErr : new Error(String(contErr)),
              source: "validar-oc-item",
              message: "Falhou registrar contagem inline",
              category: "business_logic",
              metadata: { item_id: primeiro.id, sku: primeiro.sku, loc_id: locAlvoId },
            });
            // [INV-04] Perda bloqueada por reserva viva: a RPC
            // wms_contagem_inline_atomica manda mensagem orientada ("libere ou
            // realoque as reservas") — propaga como 409 em vez do 500 genérico.
            const contMsg =
              contErr instanceof Error ? contErr.message : String(contErr);
            if (/abaixo do reservado/i.test(contMsg)) {
              return NextResponse.json(
                { error: "contagem_bloqueada_reserva", message: contMsg },
                { status: 409 },
              );
            }
            return NextResponse.json(
              { error: "falhou_contagem_inline", message: "Não foi possível registrar a contagem" },
              { status: 500 },
            );
          }
        }
      }

      for (const item of itensFull ?? []) {
        // Idempotência: item já picado anteriormente — pula pickMovPicking
        // pra evitar dupla baixa em retry. O update abaixo é safe (mesmos
        // campos, sem regredir estado).
        const jaPicado = Boolean(item.mov_saida_id);
        const info = infoMap.get(String(item.id));

        // Item parcial já resolvido (pick parcial + restante em compras):
        // replay/clique-duplo NÃO pode cair no update compartilhado — ele
        // limparia os campos de compra e inflaria quantidade_pega pro total.
        if (jaPicado && info?.compra_status === "aguardando_compra") continue;

        const ctx = ctxMap.get(item.pedido_id as string);
        let movSaidaId: string | null = null;
        if (!jaPicado && ctx && ctx.galpao && ctx.empresa) {
          const qty = Number(item.quantidade_pedida ?? 0);
          const produtoWmsId = await resolverProdutoWms(ctx.empresa, String(item.produto_id));

          if (qtyContadaBody !== null) {
            const plano = planoContagem?.get(String(item.id));
            const jaPega = Number(info?.quantidade_pega ?? 0);

            if (plano?.tipo === "parcial") {
              // ─── Contagem parcial: pega a sobra da contagem e manda o
              // restante do item pra compras (decisão explícita do operador).
              let movParcialId: string | null = null;
              try {
                const result = await pickMovPicking({
                  empresa_origem_id: ctx.empresa,
                  galpao_id: ctx.galpao,
                  pedido_id: String(item.pedido_id),
                  pedido_numero: ctx.numero,
                  item_id: Number(item.id),
                  produto_id_tiny: String(item.produto_id),
                  sku: String(item.sku),
                  qty: plano.qty_pega,
                  usuario_id: user.id,
                  contexto: "encontrei_oc_parcial",
                });
                movParcialId = result?.movSaidaId ?? null;
              } catch (movErr) {
                logger.logError({
                  error: movErr instanceof Error ? movErr : new Error(String(movErr)),
                  source: "validar-oc-item",
                  message: "pickMovPicking falhou em encontrei parcial — item segue pendente p/ retry",
                  category: "business_logic",
                  metadata: { item_id: item.id, sku: item.sku },
                });
                continue;
              }
              const pegaTotal = jaPega + plano.qty_pega;
              const enviado = await enviarItemParaCompras(
                supabase,
                user,
                {
                  id: String(item.id),
                  pedido_id: String(item.pedido_id),
                  sku: (item.sku as string | null) ?? null,
                  quantidade_pedida: Number(item.quantidade_pedida ?? 0),
                  fornecedor_oc: (info?.fornecedor_oc as string | null) ?? null,
                },
                {
                  qtyJaPega: pegaTotal,
                  now,
                  motivo: "encontrei_parcial_restante",
                  updatesExtras: {
                    quantidade_pega: pegaTotal,
                    quantidade_bipada: pegaTotal,
                    separacao_parcial: true,
                    parcial_motivo: "encontrei_parcial",
                    parcial_em: now,
                    separacao_marcado: false,
                    bipado_completo: false,
                    ...(movParcialId ? { mov_saida_id: movParcialId } : {}),
                  },
                },
              );
              if (enviado) {
                itensAtualizados++;
                registrarEvento({
                  pedidoId: item.pedido_id,
                  evento: "oc_item_encontrado",
                  usuarioId: user.id,
                  usuarioNome: user.nome,
                  detalhes: {
                    sku: item.sku,
                    item_id: item.id,
                    parcial: true,
                    qty_pega: plano.qty_pega,
                    mov_saida_id: movParcialId,
                  },
                });
              }
              continue;
            }

            if (plano?.tipo === "esgotado") {
              // ─── Contagem não cobre nada deste item → tudo pra compras.
              const enviado = await enviarItemParaCompras(
                supabase,
                user,
                {
                  id: String(item.id),
                  pedido_id: String(item.pedido_id),
                  sku: (item.sku as string | null) ?? null,
                  quantidade_pedida: Number(item.quantidade_pedida ?? 0),
                  fornecedor_oc: (info?.fornecedor_oc as string | null) ?? null,
                },
                { qtyJaPega: jaPega, now, motivo: "sem_cobertura_contagem" },
              );
              if (enviado) itensAtualizados++;
              continue;
            }

            // ─── cobre_total: a contagem cobre o item inteiro — pick normal.
            // Fase 1 é OC-only: o produto não tinha saldo em outra loc, então o
            // pickMovPicking (que resolve por maior saldo no galpão) sai da loc
            // reconciliada antes do loop. Revisitar se estender a itens não-OC.
            try {
              const result = await pickMovPicking({
                empresa_origem_id: ctx.empresa,
                galpao_id: ctx.galpao,
                pedido_id: String(item.pedido_id),
                pedido_numero: ctx.numero,
                item_id: Number(item.id),
                produto_id_tiny: String(item.produto_id),
                sku: String(item.sku),
                qty,
                usuario_id: user.id,
                contexto: "encontrei_oc",
              });
              movSaidaId = result?.movSaidaId ?? null;
            } catch (movErr) {
              logger.logError({
                error: movErr instanceof Error ? movErr : new Error(String(movErr)),
                source: "validar-oc-item",
                message: "pickMovPicking falhou em encontrei (inline) — item segue pendente p/ retry",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku },
              });
              // Falha de pick NÃO deve marcar o item como pego: sem o continue,
              // a atualização compartilhada abaixo gravaria separacao_marcado/
              // bipado_completo=true com mov_saida_id nulo (item falsamente "pego",
              // saldo inflado). O ganho de reconciliação já foi emitido e reflete a
              // realidade física — deixamos. O operador re-tenta (retry: delta=0,
              // sem novo ganho; o pick é refeito).
              continue;
            }
          } else if (solicitarContagem) {
            // ─── Solicitar contagem depois (Fase 4): pega qty do pedido agora,
            // enfileira a loc pra contagem futura. Saldo da loc fica temporariamente
            // subcontado de propósito — o operador contará depois via inventário.
            // Fluxo: mov E (ajuste_manual achado, qty=pedida) + mov S (nf_venda, qty=pedida).
            // origem_id distinto de "encontrei-sem-cadastro-*" pra evitar colisão de
            // idempotência quando ambos os caminhos chegam pro mesmo item.

            // Resolve loc-alvo: localizacao_id (uuid) OU localizacao_codigo (string).
            let locAlvoId: string | null = locManualBody;
            if (!locAlvoId && locCodigoBody) {
              const { data: locByCod } = await supabase
                .from("siso_localizacoes")
                .select("id")
                .eq("galpao_id", ctx.galpao)
                .eq("codigo", locCodigoBody)
                .maybeSingle();
              locAlvoId = (locByCod as { id?: string } | null)?.id ?? null;
            }
            if (!locAlvoId) {
              return NextResponse.json(
                {
                  error: "loc_obrigatoria",
                  message: "Bipe/escolha a localização onde achou o item.",
                  item_id: item.id,
                },
                { status: 422 },
              );
            }
            // Se veio por uuid, confirma que pertence ao galpão.
            if (locManualBody) {
              const { data: locChk } = await supabase
                .from("siso_localizacoes")
                .select("id, galpao_id")
                .eq("id", locManualBody)
                .maybeSingle();
              if (!locChk || (locChk as { galpao_id?: string }).galpao_id !== ctx.galpao) {
                return NextResponse.json(
                  { error: "loc_invalida", message: "Localização não pertence ao galpão do pedido" },
                  { status: 422 },
                );
              }
            }
            try {
              // Mov E: registra o que o operador achou (qty do pedido — não a loc toda)
              await inserirMovimentacao({
                tripla: {
                  produto_id: produtoWmsId,
                  galpao_id: ctx.galpao,
                  localizacao_id: locAlvoId,
                },
                tipo: "E",
                qty,
                origem_tipo: "ajuste_manual",
                origem_id: `solicitar-contagem-${item.id}`,
                origem_detalhes: {
                  motivo: "solicitar contagem depois — pega só qty pedido",
                  item_id: item.id,
                  pedido_id: item.pedido_id,
                  sku: item.sku,
                },
                motivo: "Achado em pick — contagem da loc adiada",
                motivo_categoria: "achado",
                usuario_id: user.id,
                fornecedor_id: null,
              });
              logger.info(
                "validar-oc-item",
                "solicitar_contagem: mov E gerada (qty=pedida, loc não reconciliada)",
                {
                  item_id: item.id,
                  sku: item.sku,
                  loc_id: locAlvoId,
                  qty,
                },
              );
            } catch (entErr) {
              logger.logError({
                error: entErr,
                source: "validar-oc-item",
                message: "Falhou gerar mov E em solicitar_contagem",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku, loc_id: locAlvoId },
              });
              return NextResponse.json(
                {
                  error: "falhou_gerar_entrada",
                  message: "Não foi possível registrar a entrada do produto",
                },
                { status: 500 },
              );
            }
            // Mov S: pick da qty do pedido
            try {
              const result = await pickMovPicking({
                empresa_origem_id: ctx.empresa,
                galpao_id: ctx.galpao,
                pedido_id: String(item.pedido_id),
                pedido_numero: ctx.numero,
                item_id: Number(item.id),
                produto_id_tiny: String(item.produto_id),
                sku: String(item.sku),
                qty,
                usuario_id: user.id,
                contexto: "encontrei_oc",
              });
              movSaidaId = result?.movSaidaId ?? null;
            } catch (movErr) {
              logger.logError({
                error: movErr instanceof Error ? movErr : new Error(String(movErr)),
                source: "validar-oc-item",
                message: "pickMovPicking falhou em solicitar_contagem — item segue pendente p/ retry",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku },
              });
              continue;
            }
            // Enfileira a loc pra contagem futura (fire-and-forget; falha não bloqueia)
            enfileirarLocParaContagem(supabase, ctx.galpao, locAlvoId, user.id).catch((e) =>
              logger.warn("validar-oc-item", "enfileirar contagem falhou", { error: String(e) }),
            );
          } else {
            // ─── caminho legado (sem qty_contada) ───
            // Verifica se produto tem alguma loc com saldo no galpão
            const { data: locsExistentes } = await supabase
              .from("siso_estoque")
              .select("localizacao_id")
              .eq("produto_id", produtoWmsId)
              .eq("galpao_id", ctx.galpao)
              .gt("saldo", 0)
              .limit(1);
            const semSaldo = !locsExistentes || locsExistentes.length === 0;

            if (semSaldo) {
              // (Fase 1.4) Loc vem do body (modal "bipe"). Sem fallback de snapshot
              // siso_pedido_item_estoques (tabela dropada) — se não veio loc e não há
              // saldo vivo, o operador bipa/escolhe a loc onde achou.
              const locManualId = locManualBody;
              if (!locManualId) {
                return NextResponse.json(
                  {
                    error: "produto_sem_cadastro",
                    message:
                      "Produto sem localização cadastrada. Bipe ou escolha a localização onde achou.",
                    item_id: item.id,
                  },
                  { status: 422 },
                );
              }
              // Confirma que loc existe e pertence ao galpão
              const { data: loc } = await supabase
                .from("siso_localizacoes")
                .select("id, galpao_id")
                .eq("id", locManualId)
                .maybeSingle();
              if (!loc || loc.galpao_id !== ctx.galpao) {
                return NextResponse.json(
                  {
                    error: "loc_invalida",
                    message:
                      "Localização não pertence ao galpão do pedido",
                  },
                  { status: 422 },
                );
              }
              try {
                // Mov E: entrada do que o operador achou
                await inserirMovimentacao({
                  tripla: {
                    produto_id: produtoWmsId,
                    galpao_id: ctx.galpao,
                    localizacao_id: locManualId,
                  },
                  tipo: "E",
                  qty,
                  origem_tipo: "ajuste_manual",
                  origem_id: `encontrei-sem-cadastro-${item.id}`,
                  origem_detalhes: {
                    motivo: "encontrei sem cadastro",
                    item_id: item.id,
                    pedido_id: item.pedido_id,
                    sku: item.sku,
                  },
                  motivo: "Achado em pick — produto sem cadastro",
                  motivo_categoria: "achado",
                  usuario_id: user.id,
                  fornecedor_id: null,
                });
                logger.info(
                  "validar-oc-item",
                  "encontrei sem cadastro: mov E gerada",
                  {
                    item_id: item.id,
                    sku: item.sku,
                    loc_id: locManualId,
                    qty,
                  },
                );
              } catch (entErr) {
                logger.logError({
                  error: entErr,
                  source: "validar-oc-item",
                  message: "Falhou gerar mov E em encontrei sem cadastro",
                  category: "business_logic",
                  metadata: { item_id: item.id, sku: item.sku, loc_id: locManualId },
                });
                return NextResponse.json(
                  {
                    error: "falhou_gerar_entrada",
                    message: "Não foi possível registrar a entrada do produto",
                  },
                  { status: 500 },
                );
              }
            }

            // Caminho normal: pickMovPicking gera mov S (que vai achar a loc
            // com saldo, possivelmente a que acabamos de criar via mov E acima).
            try {
              const result = await pickMovPicking({
                empresa_origem_id: ctx.empresa,
                galpao_id: ctx.galpao,
                pedido_id: String(item.pedido_id),
                pedido_numero: ctx.numero,
                item_id: Number(item.id),
                produto_id_tiny: String(item.produto_id),
                sku: String(item.sku),
                qty,
                usuario_id: user.id,
                contexto: "encontrei_oc",
              });
              movSaidaId = result?.movSaidaId ?? null;
            } catch (movErr) {
              const msg = movErr instanceof Error ? movErr.message : String(movErr);
              logger.logError({
                error: movErr instanceof Error ? movErr : new Error(msg),
                source: "validar-oc-item",
                message: "pickMovPicking falhou em encontrei (legado) — item segue pendente p/ retry",
                category: "business_logic",
                metadata: { item_id: item.id, sku: item.sku },
              });
              // Falha de pick NÃO deve marcar o item como pego (mesmo tratamento
              // do ramo de contagem acima): sem o continue, o update compartilhado
              // abaixo gravaria separacao_marcado/bipado_completo=true com
              // mov_saida_id nulo (item falsamente "pego", saldo nunca debitado).
              itensNaoValidados.push({
                item_id: String(item.id),
                sku: (item.sku as string | null) ?? null,
                motivo: msg,
              });
              continue;
            }
          }
        }

        // Backstop fail-loud: item sem pick confirmado (ctx de pedido ausente ou
        // pickMovPicking retornou null) NÃO entra no update compartilhado — só
        // itens com baixa OK (movSaidaId) ou já picados antes (jaPicado/replay).
        if (!jaPicado && !movSaidaId) {
          const motivo =
            ctx && ctx.galpao && ctx.empresa
              ? "baixa de estoque não confirmada (pick não gerou movimentação)"
              : "pedido sem empresa/galpão — não é possível dar baixa no estoque";
          logger.logError({
            error: new Error(motivo),
            source: "validar-oc-item",
            message: "encontrei sem baixa confirmada — item NÃO marcado",
            category: "business_logic",
            metadata: { item_id: item.id, sku: item.sku, pedido_id: item.pedido_id },
          });
          itensNaoValidados.push({
            item_id: String(item.id),
            sku: (item.sku as string | null) ?? null,
            motivo,
          });
          continue;
        }

        const updates: Record<string, unknown> = {
          compra_status: null,
          fornecedor_oc: null,
          compra_quantidade_solicitada: 0, // NOT NULL DEFAULT 0 — null viola a constraint
          compra_solicitada_em: null,
          ordem_compra_id: null,
          separacao_marcado: true,
          bipado_completo: true,
          quantidade_bipada: Number(item.quantidade_pedida ?? 0),
          quantidade_pega: Number(item.quantidade_pedida ?? 0),
        };
        if (movSaidaId) updates.mov_saida_id = movSaidaId;

        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update(updates)
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (encontrei)`,
            category: "database",
          });
          continue;
        }
        itensAtualizados++;

        // Fire-and-forget history
        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_encontrado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: { sku: item.sku, item_id: item.id, mov_saida_id: movSaidaId },
        });
      }
    } else if (acao === "desfazer_encontrei") {
      // Fix-Final A T15 (#2.6): estorna a mov S do encontrei + limpa
      // mov_saida_id/quantidade_pega/separacao_parcial. Antes desse fix,
      // desfazer_encontrei restaurava o status pra oc_pendente sem reverter
      // a saída do estoque, deixando o saldo permanentemente decrementado.
      for (const item of items) {
        const fornecedorInfo = getFornecedorBySku(item.sku);

        // 1. Estorna a mov S registrada em mov_saida_id (se houver).
        //    Se mov_saida_id é null, significa que o encontrei não chegou a
        //    gerar mov (modo legacy ou WMS_AS_SOURCE off) — só limpa campos.
        const movSaidaId = (item as { mov_saida_id?: string | null }).mov_saida_id;
        if (movSaidaId) {
          try {
            await estornarMovimentacao({
              mov_id: movSaidaId,
              usuario_id: user.id,
              motivo: `desfazer_encontrei OC (item ${item.id})`,
            });
          } catch (e) {
            logger.logError({
              error: e instanceof Error ? e : new Error(String(e)),
              source: "validar-oc-item",
              message: `Falha ao estornar mov_saida ${movSaidaId} em desfazer_encontrei`,
              category: "business_logic",
              metadata: { item_id: item.id, mov_saida_id: movSaidaId },
            });
            continue;
          }
        }

        // 2. Limpa todos os campos de pick + mov_saida_id + quantidade_pega
        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "oc_pendente",
            fornecedor_oc: fornecedorInfo.fornecedor,
            compra_quantidade_solicitada: 0, // NOT NULL DEFAULT 0 — null viola a constraint
            compra_solicitada_em: null,
            ordem_compra_id: null,
            separacao_marcado: false,
            bipado_completo: false,
            quantidade_bipada: 0,
            mov_saida_id: null,
            quantidade_pega: 0,
            separacao_parcial: false,
            parcial_motivo: null,
          })
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (desfazer_encontrei)`,
            category: "database",
          });
          continue;
        }
        itensAtualizados++;

        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_desfazer_encontrado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: { sku: item.sku, item_id: item.id, mov_estornada: movSaidaId },
        });
      }
    } else {
      // acao === "esgotado"
      for (const item of items) {
        const fornecedorInfo = getFornecedorBySku(item.sku);

        // Qty efetiva = pedida - já pegada (parcial). As realocações picadas JÁ
        // estão acumuladas em quantidade_pega via wms_acumular_qty_pega — somar de
        // novo daqui seria double-count (P3-01). A query antiga lia a coluna
        // INEXISTENTE qty_picada (erro engolido pelo PostgREST → soma 0 "por
        // acidente correto"); removida.
        const qtyJaPega = Number(item.quantidade_pega ?? 0);
        const qtyRealocsPicadas = 0;
        const qtyEfetiva = Math.max(
          0,
          Number(item.quantidade_pedida ?? 0) - qtyJaPega - qtyRealocsPicadas,
        );

        if (qtyEfetiva === 0) {
          // Item totalmente coberto — não dá pra marcar esgotado
          return NextResponse.json(
            {
              error:
                "item já totalmente coberto — não pode ser marcado esgotado",
              item_id: item.id,
              sku: item.sku,
              qty_pedida: Number(item.quantidade_pedida ?? 0),
              qty_ja_pega: qtyJaPega,
              qty_realocs_picadas: qtyRealocsPicadas,
            },
            { status: 409 },
          );
        }

        // Update item to aguardando_compra — usando qty efetiva
        const { error: updErr } = await supabase
          .from("siso_pedido_itens")
          .update({
            compra_status: "aguardando_compra",
            compra_quantidade_solicitada: qtyEfetiva,
            compra_solicitada_em: now,
            fornecedor_oc: item.fornecedor_oc || fornecedorInfo.fornecedor,
          })
          .eq("id", item.id);

        if (updErr) {
          logger.logError({
            error: updErr,
            source: "validar-oc-item",
            message: `Erro ao atualizar item ${item.id} (esgotado)`,
            category: "database",
          });
          continue;
        }

        // Find or create OC for this item
        const fornecedor = item.fornecedor_oc || fornecedorInfo.fornecedor;
        await linkItemToOC(supabase, item, fornecedor);

        itensAtualizados++;

        registrarEvento({
          pedidoId: item.pedido_id,
          evento: "oc_item_confirmado",
          usuarioId: user.id,
          usuarioNome: user.nome,
          detalhes: {
            sku: item.sku,
            item_id: item.id,
            fornecedor,
            qty_pedida: Number(item.quantidade_pedida ?? 0),
            qty_ja_pega: qtyJaPega,
            qty_realocs_picadas: qtyRealocsPicadas,
            qty_efetiva: qtyEfetiva,
          },
        });
      }
    }

    // ─── Auto-transitions per pedido ────────────────────────────
    const affectedPedidoIds = [...new Set(items.map((i) => i.pedido_id as string))];
    const transicoes: Array<{ pedido_id: string; novo_status: string }> = [];

    for (const pedidoId of affectedPedidoIds) {
      // Fetch ALL items for this pedido to evaluate transitions
      const { data: allItems } = await supabase
        .from("siso_pedido_itens")
        .select("id, compra_status, separacao_marcado")
        .eq("pedido_id", pedidoId);

      if (!allItems) continue;

      const hasOcPendente = allItems.some((i) => i.compra_status === "oc_pendente");

      // Fetch current pedido status
      const { data: pedido } = await supabase
        .from("siso_pedidos")
        .select("id, status_separacao, decisao_final")
        .eq("id", pedidoId)
        .single();

      if (!pedido) continue;

      if (acao === "desfazer_encontrei" && hasOcPendente) {
        // Revert decisao_final back to "oc" if it was flipped to "propria"
        if (pedido.decisao_final === "propria") {
          await supabase
            .from("siso_pedidos")
            .update({ decisao_final: "oc" })
            .eq("id", pedidoId);
        }
        continue;
      }

      if (hasOcPendente) continue; // Still has unresolved OC items — no transition

      const compraItems = allItems.filter(
        (i) => i.compra_status === "aguardando_compra" || i.compra_status === "comprado",
      );
      const normalItems = allItems.filter((i) => i.compra_status === null);

      if (compraItems.length === 0) {
        // FR-9: All OC items found → flip decisao to propria
        const updates: Record<string, unknown> = {
          decisao_final: "propria",
        };
        if (pedido.status_separacao === "validacao_oc") {
          updates.status_separacao = "aguardando_separacao";
        }
        // If em_separacao, keep as is

        await supabase
          .from("siso_pedidos")
          .update(updates)
          .eq("id", pedidoId);

        if (updates.status_separacao) {
          transicoes.push({
            pedido_id: pedidoId,
            novo_status: updates.status_separacao as string,
          });
        }
      } else if (normalItems.length === 0) {
        // FR-8: 100% OC pedido, all now aguardando_compra → transition
        await supabase
          .from("siso_pedidos")
          .update({
            status_separacao: "aguardando_compra",
            separacao_operador_id: null,
            separacao_iniciada_em: null,
          })
          .eq("id", pedidoId);

        transicoes.push({
          pedido_id: pedidoId,
          novo_status: "aguardando_compra",
        });
      } else if (
        // Misto: parte virou compra, parte é normal. Só transiciona pra
        // Compras quando TODOS os normais já foram pegos (separacao_marcado).
        // Senão o operador perderia a wave dos normais ainda não bipados.
        normalItems.every((i) => i.separacao_marcado === true)
      ) {
        const { error: updErr } = await supabase
          .from("siso_pedidos")
          .update({ status_separacao: "aguardando_compra" })
          .eq("id", pedidoId)
          .in("status_separacao", ["validacao_oc", "em_separacao"]); // idempotente
        if (updErr) {
          logger.warn("validar-oc-item", "misto: falha ao transicionar aguardando_compra", {
            pedidoId,
            error: updErr.message,
          });
        } else {
          transicoes.push({ pedido_id: pedidoId, novo_status: "aguardando_compra" });
        }
      }
    }

    logger.info("validar-oc-item", `${acao}: ${itensAtualizados} itens atualizados`, {
      acao,
      item_ids: normalizedIds,
      transicoes,
      itens_nao_validados: itensNaoValidados.length,
      operador: user.nome,
    });

    // SEP-03: todos os picks do "encontrei" falharam → erro explícito (a UI
    // surfaça error+message via erroApiTexto) em vez de 200 com toast de sucesso.
    if (acao === "encontrei" && itensAtualizados === 0 && itensNaoValidados.length > 0) {
      return NextResponse.json(
        {
          error: "falha_baixa_estoque",
          message: `Nenhum item validado — baixa de estoque falhou: ${itensNaoValidados[0].motivo}`,
          itens_nao_validados: itensNaoValidados,
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      itens_atualizados: itensAtualizados,
      transicoes,
      ...(itensNaoValidados.length > 0 ? { itens_nao_validados: itensNaoValidados } : {}),
      ...(coberturaResp ? { cobertura: coberturaResp } : {}),
    });
  } catch (err) {
    const { id: erro_id, timestamp: erro_em } = logger.logError({
      error: err,
      source: "validar-oc-item",
      message: "Erro inesperado",
      category: "business_logic",
      requestPath: "/api/wms/separacao/validar-oc-item",
      requestMethod: "POST",
    });
    return NextResponse.json({ error: "Erro interno", erro_id, erro_em }, { status: 500 });
  }
}

// ─── Helper: manda item OC pra compras (esgotado automático) ────────────────
// Usado pela contagem parcial: itens sem cobertura (ou com sobra parcial)
// viram aguardando_compra com a qty efetiva (pedida − pega − realocs picadas),
// igual ao "esgotado" explícito. `updatesExtras` permite gravar os campos do
// pick parcial no MESMO update (mov_saida_id, quantidade_pega, etc).

async function enviarItemParaCompras(
  supabase: ReturnType<typeof createServiceClient>,
  user: { id: string; nome: string },
  item: {
    id: string;
    pedido_id: string;
    sku: string | null;
    quantidade_pedida: number;
    fornecedor_oc: string | null;
  },
  opts: {
    qtyJaPega: number;
    now: string;
    motivo: string;
    updatesExtras?: Record<string, unknown>;
  },
): Promise<boolean> {
  const fornecedorInfo = getFornecedorBySku(item.sku);
  const fornecedor = item.fornecedor_oc || fornecedorInfo.fornecedor;

  // Realocações picadas JÁ estão acumuladas em quantidade_pega (= opts.qtyJaPega)
  // via wms_acumular_qty_pega — somar de novo seria double-count (P3-01). A query
  // antiga lia a coluna INEXISTENTE qty_picada (erro engolido → soma 0); removida.
  const qtyRealocsPicadas = 0;
  const qtyEfetiva = Math.max(
    0,
    item.quantidade_pedida - opts.qtyJaPega - qtyRealocsPicadas,
  );

  // 1) Campos do pick parcial primeiro, INCONDICIONAL — o S já saiu no ledger,
  //    o item tem que registrar mov_saida_id/quantidade_pega mesmo que a parte
  //    de compras perca a corrida pro reconciliador-oc.
  const temExtras =
    opts.updatesExtras && Object.keys(opts.updatesExtras).length > 0;
  if (temExtras) {
    const { error: extrasErr } = await supabase
      .from("siso_pedido_itens")
      .update(opts.updatesExtras!)
      .eq("id", item.id);
    if (extrasErr) {
      logger.logError({
        error: extrasErr,
        source: "validar-oc-item",
        message: `Erro ao gravar pick parcial do item ${item.id} (${opts.motivo})`,
        category: "database",
      });
      return false;
    }
  }

  if (qtyEfetiva <= 0) {
    // Tudo já coberto por picks/realocs — nada a comprar.
    logger.warn("validar-oc-item", "item sem qty efetiva pra compras — não vai pra OC", {
      item_id: item.id,
      sku: item.sku,
      motivo: opts.motivo,
    });
    return Boolean(temExtras);
  }

  // 2) Campos de compras com compare-and-swap (mesmo padrão do reconciliador):
  //    só aplica se o item ainda está em estado de compra pendente. Se uma
  //    entrada concorrente (reconciliador-oc) reivindicou o item nesse
  //    meio-tempo (compra_status=null + reserva criada), NÃO sobrescrever —
  //    o item já voltou pro fluxo próprio.
  const { data: claimed, error: updErr } = await supabase
    .from("siso_pedido_itens")
    .update({
      compra_status: "aguardando_compra",
      compra_quantidade_solicitada: qtyEfetiva,
      compra_solicitada_em: opts.now,
      fornecedor_oc: fornecedor,
    })
    .eq("id", item.id)
    .in("compra_status", ["oc_pendente", "aguardando_compra"])
    .select("id");
  if (updErr) {
    logger.logError({
      error: updErr,
      source: "validar-oc-item",
      message: `Erro ao mandar item ${item.id} pra compras (${opts.motivo})`,
      category: "database",
    });
    return false;
  }
  if (!claimed || claimed.length === 0) {
    logger.warn(
      "validar-oc-item",
      "item reivindicado por fluxo concorrente — não foi pra compras",
      { item_id: item.id, sku: item.sku, motivo: opts.motivo },
    );
    return Boolean(temExtras);
  }

  await linkItemToOC(
    supabase,
    { id: item.id, pedido_id: item.pedido_id, sku: item.sku },
    fornecedor,
  );
  registrarEvento({
    pedidoId: item.pedido_id,
    evento: "oc_item_confirmado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      sku: item.sku,
      item_id: item.id,
      fornecedor,
      qty_efetiva: qtyEfetiva,
      qty_ja_pega: opts.qtyJaPega,
      qty_realocs_picadas: qtyRealocsPicadas,
      motivo: opts.motivo,
    },
  });
  return true;
}

// ─── Helper: find or create OC and link item ────────────────────────────────

async function linkItemToOC(
  supabase: ReturnType<typeof createServiceClient>,
  item: { id: string; pedido_id: string; sku: string | null },
  fornecedor: string,
) {
  try {
    // Get empresa from pedido
    const { data: pedido } = await supabase
      .from("siso_pedidos")
      .select("empresa_origem_id")
      .eq("id", item.pedido_id)
      .single();

    const empresaId = pedido?.empresa_origem_id;
    if (!empresaId) {
      logger.warn("validar-oc-item", "Pedido sem empresa_origem_id — OC não vinculada", {
        pedidoId: item.pedido_id,
        itemId: item.id,
      });
      return;
    }

    // Resolve galpao_id from empresa
    const { data: empresa } = await supabase
      .from("siso_empresas")
      .select("galpao_id")
      .eq("id", empresaId)
      .single();

    const galpaoId = empresa?.galpao_id ?? null;

    // Look for existing draft OC by fornecedor + galpao
    let existingOCQuery = supabase
      .from("siso_ordens_compra")
      .select("id")
      .eq("fornecedor", fornecedor)
      .eq("status", "aguardando_compra")
      .limit(1);

    if (galpaoId) {
      existingOCQuery = existingOCQuery.eq("galpao_id", galpaoId);
    } else {
      existingOCQuery = existingOCQuery.eq("empresa_id", empresaId);
    }

    const { data: existingOC } = await existingOCQuery.maybeSingle();

    let ordemCompraId: string | null = null;

    if (existingOC) {
      ordemCompraId = existingOC.id;
    } else {
      const { data: newOC, error: ocError } = await supabase
        .from("siso_ordens_compra")
        .insert({
          fornecedor,
          galpao_id: galpaoId,
          empresa_id: empresaId,
          status: "aguardando_compra",
          observacao: `Criada automaticamente — validação OC SKU ${item.sku}`,
        })
        .select("id")
        .single();

      if (ocError) {
        logger.warn("validar-oc-item", "Erro ao criar OC automática", {
          error: ocError.message,
          fornecedor,
          empresaId,
        });
        return;
      }
      ordemCompraId = newOC.id;
    }

    if (ordemCompraId) {
      await supabase
        .from("siso_pedido_itens")
        .update({ ordem_compra_id: ordemCompraId })
        .eq("id", item.id);
    }
  } catch (err) {
    logger.warn("validar-oc-item", "Erro ao vincular item a OC (não-crítico)", {
      error: err instanceof Error ? err.message : String(err),
      itemId: item.id,
    });
  }
}
