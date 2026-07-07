/**
 * webhook-processor-wms — fluxo do Plano 2 (WMS_AS_SOURCE=true).
 *
 * Lê estoque direto de siso_estoque (zero chamadas Tiny pra getEstoque),
 * roteia via rotearPedidoDoBanco (algoritmo WMS-3) e cria reservas no
 * ledger no momento que o pedido é gravado.
 *
 * Chamado por processWebhook() em webhook-processor.ts (estoque é fonte única
 * WMS). Estrutura mantida espelhada ao fluxo legado pra não quebrar
 * UI/queries existentes:
 *   - siso_pedidos (mesmas colunas)
 *   - siso_pedido_itens (mesmas colunas; estoque_cwb_* e estoque_sp_* ficam
 *     null/0 nesse fluxo — UI já lê do siso_pedido_item_estoques)
 *   - siso_pedido_item_estoques (uma linha por (pedido, produto, empresa))
 *   - reservas: uma mov tipo='R' por item via wms_reservar_atomico
 *
 * Fase 5 (ledger simplificado 3D): roteamento devolve apenas
 * `propria | transferencia | oc` (sem empréstimo). Estoque é fungível
 * por (produto, galpão, localização) — não há mais filtro por dona.
 */

import { createServiceClient } from "./supabase-server";
import { logger } from "./logger";
import { registrarEvento } from "./historico-service";
import { kickWorker } from "./execution-worker";
import { getFornecedorBySku } from "./sku-fornecedor";
import { criarMarcadoresPedido } from "./tiny-api";
import {
  getActiveMlConnectionForEmpresa,
  getMlShipmentSla,
  getMlShipmentStatus,
} from "./ml-api";
import { isMercadoLivre } from "./domain-helpers";
import { getValidTokenByEmpresa } from "./tiny-oauth";
import { runWithEmpresa } from "./tiny-queue";
import { reservarAtomico, estornarReservaIndividual } from "./wms/reservas";
import {
  MARCADOR_FUTURA,
  TAG_FUTURA,
  statusPosAutorizacaoNf,
  SUBSTATUS_FUTURA,
  ttlHorasReservaFutura,
  classificarPromocaoFutura,
} from "./wms/separacao-futura";
import { preemptarFuturasParaCobertura } from "./wms/preempcao-futura";
import { ensureProdutoFromTiny } from "./wms/sync-tiny";
import { rotearPedidoDoBanco } from "./wms/roteamento";
import {
  planejarTrocaRoteamento,
  planejarTrocaRemota,
  aplicarTrocasRoteamento,
  type PlanoTrocaRoteamento,
} from "./wms/trocas-roteamento";
import type { RotaResult } from "./wms/roteamento";
import type { TinyPedidoDetalhe } from "./tiny-api";

/** Map WMS decision → legacy Decisao shape. */
type LegacyDecisao = "propria" | "transferencia" | "oc" | "troca_equivalente";

interface ProcessWebhookWmsInput {
  webhookLogId: string;
  pedido: TinyPedidoDetalhe;
  empresaOrigemId: string;
  galpaoOrigemId: string;
  galpaoOrigemNome: string;
  /** Separação futura (ML buffered): reserva + separa sem gerar NF. Default false. */
  separacaoFutura?: boolean;
}

interface ResolvedItem {
  /** Tiny produto_id na empresa origem (ou null se não tem mapeamento) */
  tinyProdutoId: number;
  /** UUID do produto no catálogo WMS */
  produtoIdWms: string | null;
  sku: string;
  descricao: string;
  quantidade: number;
  imagemUrl: string | null;
  gtin: string | null;
  /** true se o produto é cabeçalho de kit. Componentes que entram via expansão
   *  ficam sempre false aqui. */
  ehKit: boolean;
}

/** Carrega o produto WMS de cada item via siso_produto_empresas. */
async function resolverItensWms(
  pedido: TinyPedidoDetalhe,
  empresaOrigemId: string,
): Promise<ResolvedItem[]> {
  const sb = createServiceClient();
  const tinyIds = pedido.itens.map((i) => i.produto.id);

  const { data: mappings } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresaOrigemId)
    .in("tiny_produto_id", tinyIds);

  const wmsByTinyId = new Map<number, string>();
  for (const m of mappings ?? []) {
    wmsByTinyId.set(Number(m.tiny_produto_id), m.produto_id);
  }

  // Auto-provisionamento: itens com tiny_produto_id válido (>0) que ainda não
  // existem em siso_produto_empresas são puxados do Tiny (GET /produtos/{id} via
  // ensureProdutoFromTiny → cria siso_produtos + bridge + sincroniza todos os
  // dados). Produto id=0 (sem vínculo Tiny) NÃO entra aqui — exige SKU manual
  // na aba de pedidos. Falha no Tiny não derruba o webhook: o item segue sem
  // mapeamento (pulado no roteamento, como antes).
  const skuPorTiny = new Map<number, string>();
  for (const it of pedido.itens) {
    if (it.produto.id > 0 && it.produto.sku) skuPorTiny.set(it.produto.id, it.produto.sku);
  }
  const faltantes = Array.from(new Set(tinyIds)).filter(
    (id) => id > 0 && !wmsByTinyId.has(id),
  );
  for (const tinyId of faltantes) {
    const sku = skuPorTiny.get(tinyId);
    if (!sku) continue; // sem SKU não há como criar/sincronizar
    try {
      const produtoId = await ensureProdutoFromTiny(sku, empresaOrigemId, tinyId);
      wmsByTinyId.set(tinyId, produtoId);
      logger.info("processor.wms", "produto auto-provisionado do Tiny", {
        pedidoId: pedido.id,
        tinyProdutoId: tinyId,
        sku,
      });
    } catch (e) {
      logger.warn("processor.wms", "falha auto-provisionando produto do Tiny (segue sem mapeamento)", {
        pedidoId: pedido.id,
        tinyProdutoId: tinyId,
        sku,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  // Recupera criações parciais: ensureProdutoFromTiny pode ter criado o produto
  // + bridge e falhado depois no sync (Tiny intermitente) — nesse caso o mapeamento
  // já existe no banco mas não entrou no Map acima. Re-consulta os que sobraram.
  const aindaFaltam = faltantes.filter((id) => !wmsByTinyId.has(id));
  if (aindaFaltam.length > 0) {
    const { data: recheck } = await sb
      .from("siso_produto_empresas")
      .select("produto_id, tiny_produto_id")
      .eq("empresa_id", empresaOrigemId)
      .in("tiny_produto_id", aindaFaltam);
    for (const m of recheck ?? []) {
      wmsByTinyId.set(Number(m.tiny_produto_id), m.produto_id);
    }
  }

  // SKU-first fallback: itens sem vínculo Tiny (produto.id=0) ou cuja empresa
  // não tem bridge resolvem direto pelo SKU no catálogo unificado
  // (siso_produtos.sku UNIQUE global). Cobre venda cross-catálogo no ML (ex.
  // NetParts vendendo SKU cadastrado só na NetAir) sem depender do tiny_id.
  const skusSemTiny = Array.from(
    new Set(
      pedido.itens
        .filter((it) => !wmsByTinyId.has(it.produto.id) && it.produto.sku)
        .map((it) => it.produto.sku),
    ),
  );
  const wmsBySku = new Map<string, string>();
  if (skusSemTiny.length > 0) {
    const { data: porSku } = await sb
      .from("siso_produtos")
      .select("id, sku")
      .in("sku", skusSemTiny);
    for (const p of porSku ?? []) wmsBySku.set(p.sku, p.id);
  }

  const produtoIds = Array.from(
    new Set([...wmsByTinyId.values(), ...wmsBySku.values()]),
  );
  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, gtin, imagem_url, eh_kit")
    .in("id", produtoIds);

  const produtoById = new Map(produtos?.map((p) => [p.id, p]) ?? []);

  const resolvidos: ResolvedItem[] = pedido.itens.map((item) => {
    const produtoIdWms =
      wmsByTinyId.get(item.produto.id) ??
      (item.produto.sku ? wmsBySku.get(item.produto.sku) ?? null : null);
    const produto = produtoIdWms ? produtoById.get(produtoIdWms) : null;
    return {
      tinyProdutoId: item.produto.id,
      produtoIdWms,
      sku: produto?.sku ?? item.produto.sku ?? "",
      descricao: produto?.descricao ?? item.produto.descricao ?? "",
      quantidade: item.quantidade,
      imagemUrl: produto?.imagem_url ?? null,
      gtin: produto?.gtin ?? null,
      ehKit: produto?.eh_kit === true,
    };
  });

  return expandirKits(resolvidos, empresaOrigemId);
}

/**
 * Substitui itens que são kit pelos seus componentes no WMS.
 *
 * Pra cada item com `eh_kit=true`, busca a composição em `siso_produto_kits`
 * e produz uma linha por componente (`quantidade_componente × quantidade_kit_pedida`).
 * Resolve o `tinyProdutoId` do componente NA EMPRESA ORIGEM via
 * `siso_produto_empresas` (pra UI legada continuar funcionando).
 *
 * Kits sem composição cadastrada: mantém o item-kit original e loga warn —
 * vai pra OC porque kit pai não tem saldo direto em `siso_estoque`.
 */
async function expandirKits(
  itens: ResolvedItem[],
  empresaOrigemId: string,
): Promise<ResolvedItem[]> {
  const sb = createServiceClient();
  const kits = itens.filter((i) => i.ehKit && i.produtoIdWms);
  if (kits.length === 0) return itens;

  // 1. Composição de todos os kits, em uma query
  const kitIds = kits.map((k) => k.produtoIdWms as string);
  const { data: composicoes } = await sb
    .from("siso_produto_kits")
    .select(
      `kit_produto_id, quantidade,
       componente:siso_produtos!siso_produto_kits_componente_produto_id_fkey
         (id, sku, descricao, gtin, imagem_url, eh_kit)`,
    )
    .in("kit_produto_id", kitIds);

  type ComposicaoRow = {
    kit_produto_id: string;
    quantidade: number;
    // Supabase tipa embedded relations como array — só pegamos o primeiro
    componente:
      | Array<{
          id: string;
          sku: string | null;
          descricao: string | null;
          gtin: string | null;
          imagem_url: string | null;
          eh_kit: boolean | null;
        }>
      | {
          id: string;
          sku: string | null;
          descricao: string | null;
          gtin: string | null;
          imagem_url: string | null;
          eh_kit: boolean | null;
        }
      | null;
  };

  const pickComponente = (
    c: ComposicaoRow["componente"],
  ): {
    id: string;
    sku: string | null;
    descricao: string | null;
    gtin: string | null;
    imagem_url: string | null;
  } | null => {
    if (!c) return null;
    return Array.isArray(c) ? (c[0] ?? null) : c;
  };

  const porKit = new Map<
    string,
    Array<{
      componente_id: string;
      sku: string;
      descricao: string;
      gtin: string | null;
      imagem_url: string | null;
      quantidade: number;
    }>
  >();

  for (const r of (composicoes ?? []) as unknown as ComposicaoRow[]) {
    const componente = pickComponente(r.componente);
    if (!componente) continue;
    const arr = porKit.get(r.kit_produto_id) ?? [];
    arr.push({
      componente_id: componente.id,
      sku: componente.sku ?? "",
      descricao: componente.descricao ?? "",
      gtin: componente.gtin,
      imagem_url: componente.imagem_url,
      quantidade: r.quantidade,
    });
    porKit.set(r.kit_produto_id, arr);
  }

  // 2. Resolve tinyProdutoId do componente NA empresa origem
  const componenteIds = Array.from(
    new Set(
      Array.from(porKit.values()).flatMap((arr) => arr.map((c) => c.componente_id)),
    ),
  );
  const { data: mappings } = await sb
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresaOrigemId)
    .in("produto_id", componenteIds);

  const tinyIdByComponente = new Map<string, number>();
  for (const m of mappings ?? []) {
    tinyIdByComponente.set(m.produto_id, Number(m.tiny_produto_id));
  }

  // 3. Expandir os itens — kit pai sai, componentes entram
  const expandido: ResolvedItem[] = [];
  for (const item of itens) {
    if (!item.ehKit || !item.produtoIdWms) {
      expandido.push(item);
      continue;
    }
    const comps = porKit.get(item.produtoIdWms) ?? [];
    if (comps.length === 0) {
      logger.warn("processor.wms", "kit sem composição cadastrada — mantém como item único", {
        kitSku: item.sku,
        kitProdutoId: item.produtoIdWms,
      });
      expandido.push(item);
      continue;
    }

    logger.info("processor.wms", "kit expandido em componentes", {
      kitSku: item.sku,
      qty: item.quantidade,
      componentes: comps.map((c) => ({ sku: c.sku, qty: c.quantidade })),
    });

    for (const c of comps) {
      const tinyId = tinyIdByComponente.get(c.componente_id);
      if (!tinyId) {
        logger.warn("processor.wms", "componente sem mapeamento na empresa origem — pulado", {
          kitSku: item.sku,
          componenteSku: c.sku,
          empresaId: empresaOrigemId,
        });
        continue;
      }
      expandido.push({
        tinyProdutoId: tinyId,
        produtoIdWms: c.componente_id,
        sku: c.sku,
        descricao: c.descricao,
        quantidade: c.quantidade * item.quantidade,
        imagemUrl: c.imagem_url,
        gtin: c.gtin,
        ehKit: false,
      });
    }
  }

  return expandido;
}

/** Lê siso_estoque agregado por (produto, galpão) — 3D, sem dona. */
async function lerEstoquesDoWms(itens: ResolvedItem[]): Promise<
  Map<
    string,
    Array<{
      galpao_id: string;
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao: string | null;
    }>
  >
> {
  const sb = createServiceClient();
  const produtoIds = itens.map((i) => i.produtoIdWms).filter((id): id is string => !!id);
  if (produtoIds.length === 0) return new Map();

  const { data: linhas } = await sb
    .from("siso_estoque")
    .select(
      "produto_id, galpao_id, saldo, reservado, disponivel, siso_localizacoes(codigo)",
    )
    .in("produto_id", produtoIds);

  const map = new Map<
    string,
    Array<{
      galpao_id: string;
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao: string | null;
    }>
  >();

  // Aggregate by (produto_id, galpao_id) — many localizações viram 1 linha
  const aggKey = (produto: string, galpao: string) => `${produto}|${galpao}`;
  const agg = new Map<
    string,
    {
      produto_id: string;
      galpao_id: string;
      saldo: number;
      reservado: number;
      disponivel: number;
      localizacao: string | null;
    }
  >();

  for (const linha of (linhas ?? []) as Array<{
    produto_id: string;
    galpao_id: string;
    saldo: number | null;
    reservado: number | null;
    disponivel: number | null;
    siso_localizacoes?: { codigo?: string | null } | null;
  }>) {
    const k = aggKey(linha.produto_id, linha.galpao_id);
    const cur = agg.get(k);
    const loc = linha.siso_localizacoes?.codigo ?? null;
    if (!cur) {
      agg.set(k, {
        produto_id: linha.produto_id,
        galpao_id: linha.galpao_id,
        saldo: Number(linha.saldo ?? 0),
        reservado: Number(linha.reservado ?? 0),
        disponivel: Number(linha.disponivel ?? 0),
        localizacao: loc,
      });
    } else {
      cur.saldo += Number(linha.saldo ?? 0);
      cur.reservado += Number(linha.reservado ?? 0);
      cur.disponivel += Number(linha.disponivel ?? 0);
      if (!cur.localizacao && loc) cur.localizacao = loc;
    }
  }

  for (const v of agg.values()) {
    const arr = map.get(v.produto_id) ?? [];
    arr.push({
      galpao_id: v.galpao_id,
      saldo: v.saldo,
      reservado: v.reservado,
      disponivel: v.disponivel,
      localizacao: v.localizacao,
    });
    map.set(v.produto_id, arr);
  }

  return map;
}

/**
 * Convert Tiny datetime "YYYY-MM-DD HH:MM:SS" (BRT) to ISO timestamptz.
 * Duplicada da legada porque é trivial; mantém isolamento.
 */
function parseTinyDateTime(dateStr: string): string {
  const cleaned = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return `${cleaned}T23:59:59-03:00`;
  return `${cleaned.replace(" ", "T")}-03:00`;
}

function formatDate(dateStr: string): string {
  if (dateStr.includes("/")) {
    const [d, m, y] = dateStr.split("/");
    return `${y}-${m}-${d}`;
  }
  return dateStr;
}

/**
 * P085: cria as reservas R da rota de forma all-or-nothing. Se qualquer item
 * falhar, estorna as já criadas (rollback) e RE-LANÇA o erro pra o caller
 * sinalizar 'erro' no webhook (Tiny retenta). reservarAtomico é idempotente
 * por (pedido,produto,tripla) (P003), então o retry não duplica a R do item
 * que já tinha dado certo.
 */
export async function criarReservasRotaAtomico(args: {
  pedidoId: string;
  rotas: Array<{ produto_id: string; galpao_id: string; localizacao_id: string; qty: number }>;
  /** TTL das R em horas. Default 30d. Separação futura passa um TTL mais longo
   *  (derivado da dataPrevista) — etiqueta buffered pode estar semanas à frente. */
  ttlHoras?: number;
}): Promise<{ reservasCriadas: number }> {
  const { pedidoId, rotas } = args;
  const ttlHoras = args.ttlHoras ?? 24 * 30;
  const criadas: string[] = [];
  for (const r of rotas) {
    try {
      const id = await reservarAtomico({
        tripla: { produto_id: r.produto_id, galpao_id: r.galpao_id, localizacao_id: r.localizacao_id },
        qty: r.qty,
        pedido_id: pedidoId,
        ttl_horas: ttlHoras,
      });
      criadas.push(id);
    } catch (err) {
      for (const rid of criadas) {
        try {
          await estornarReservaIndividual({ reserva_id: rid, motivo: "rollback_aprovacao" });
        } catch (e) {
          logger.warn("processor.wms", "falha no rollback de R (segue)", {
            pedidoId, reserva_id: rid, error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      throw new Error(
        `reserva_falhou: item produto=${r.produto_id} qty=${r.qty} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { reservasCriadas: criadas.length };
}

// ─── Promoção de futura (etiqueta liberou) ─────────────────────────────────

/**
 * Promove um pedido da pista futura pro fluxo normal: flipa
 * `separacao_futura=false` e enfileira `lancar_estoque` (decisao do pedido) —
 * IGUAL ao fluxo normal. O worker então gera NF + agrupamento pra TODOS,
 * inclusive OC (executarMarcadoresOnly emite a NF + agrupamento e segue a compra
 * quando `!futura`). MANTÉM o `status_separacao` atual (separado cai em
 * embalagem; aguardando_separacao cai na fila de separação).
 *
 * Sempre enfileira (não precisa de gate "já tem NF"): o worker é idempotente —
 * `gerarNotaFiscalPedido` reusa a NF existente (não re-emite) e o cutover é
 * idempotente (estorno_de). Pula só se já houver job `lancar_estoque`
 * pendente/executando (evita corrida de duplo job).
 *
 * Único ponto de promoção: usado pelo ramo inline (webhook normal reentrante),
 * pelo handler de NF e pelo sweep de polling-futura.
 */
export async function promoverPedidoFutura(
  sb: ReturnType<typeof createServiceClient>,
  params: {
    pedidoId: string;
    decisaoFinal: string | null;
    galpaoNome: string | null;
    empresaId: string | null;
  },
): Promise<{ enfileirouLancamento: boolean }> {
  const { pedidoId, decisaoFinal, galpaoNome, empresaId } = params;

  // GUARDA: pedido SEM decisão (decisao_final=null) NÃO é uma venda comprometida
  // — é uma futura aguardando aprovação humana (troca equivalente, sugestao=
  // 'troca_equivalente', status='pendente'). Promover geraria NF de venda não
  // aprovada (a aprovação da troca é que seta decisao_final + aprova o pedido).
  // Não flipa a flag, não enfileira nada.
  if (decisaoFinal == null) {
    logger.warn("processor.wms", "promoção de futura ignorada — pedido sem decisão (troca pendente?)", {
      pedidoId,
    });
    return { enfileirouLancamento: false };
  }

  const decisao =
    decisaoFinal === "transferencia"
      ? "transferencia"
      : decisaoFinal === "oc"
        ? "oc"
        : "propria";

  // Status na promoção. Um pedido NÃO pode aparecer "pronto" (separado) enquanto
  // a NF ainda não está AUTORIZADA — senão entra na fila de embalagem sem etiqueta.
  // Vai pra `aguardando_nf` e só avança quando a NF autorizar; aí o
  // nf-webhook-handler (Step 5b) decide separado×aguardando_separacao pelo
  // `estoque_lancado` (via statusPosAutorizacaoNf).
  // EXCEÇÃO — NF JÁ autorizada no ato da promoção (caminho do webhook de NF, que
  // promove DEPOIS de gravar a chave): vai direto pro destino.
  // OC fica de fora: o worker (executarMarcadoresOnly) é quem define o status dela
  // (validacao_oc / aguardando_compra / vira propria). Só flipa a flag.
  // ⚠ Mantém a baixa: o pick da futura já lançou o estoque (S sem NF; a peça já
  //   saiu da loc). Este UPDATE direto de status NÃO passa por
  //   reverterCutoverSeRetrocedeu, então a baixa permanece; o cutover de volta a
  //   `separado` vê `estoque_lancado` e é no-op.
  let novoStatus: string | null = null;
  if (decisao !== "oc") {
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("estoque_lancado, chave_acesso_nf")
      .eq("id", pedidoId)
      .maybeSingle();
    const nfAutorizada = !!ped?.chave_acesso_nf;
    novoStatus = nfAutorizada
      ? statusPosAutorizacaoNf(ped?.estoque_lancado === true)
      : "aguardando_nf";
  }

  await sb
    .from("siso_pedidos")
    .update(
      novoStatus
        ? { separacao_futura: false, status_separacao: novoStatus }
        : { separacao_futura: false },
    )
    .eq("id", pedidoId);

  let enfileirou = false;
  const { data: jobExistente } = await sb
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedidoId)
    .eq("tipo", "lancar_estoque")
    .in("status", ["pendente", "executando"])
    .maybeSingle();
  if (!jobExistente) {
    await sb.from("siso_fila_execucao").insert({
      pedido_id: pedidoId,
      tipo: "lancar_estoque",
      filial_execucao: galpaoNome,
      empresa_id: empresaId,
      decisao,
    });
    enfileirou = true;
    kickWorker().catch((err) => {
      logger.error("processor.wms", "kickWorker falhou (promoção futura)", {
        pedidoId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  registrarEvento({
    pedidoId,
    evento: "auto_aprovado",
    detalhes: { decisao, via: "wms", promocao_futura: true },
  }).catch(() => {});

  logger.info("processor.wms", "futura PROMOVIDA (etiqueta liberou)", {
    pedidoId,
    decisao,
    enfileirouLancamento: enfileirou,
  });
  return { enfileirouLancamento: enfileirou };
}

// ─── Main ──────────────────────────────────────────────────────────────────

export async function processWebhookWms(input: ProcessWebhookWmsInput): Promise<{
  ok: boolean;
  pedidoId: string;
  status: string;
  sugestao: LegacyDecisao;
}> {
  const sb = createServiceClient();
  const { webhookLogId, pedido, empresaOrigemId, galpaoOrigemId, galpaoOrigemNome } = input;
  let separacaoFutura = input.separacaoFutura === true;

  // 0. Classificação de SEPARAÇÃO FUTURA no intake. O webhook do Tiny chega com
  //    separacaoFutura=false (o poll-futura já passa true). Pra um pedido ML cuja
  //    etiqueta o ML segura pra data futura (shipment.substatus='buffered'),
  //    classificamos AQUI — senão o webhook de um pedido "em aberto" cairia no
  //    fluxo normal e geraria NF cedo. Vale pra webhook E poll (idempotente: o
  //    poll já manda true → pula a chamada ML). Falha na consulta degrada pro
  //    fluxo normal (não bloqueia o intake).
  // substatus/status ML lidos no intake — reusados na PROMOÇÃO (4b) pra exigir
  // confirmação POSITIVA de que a etiqueta liberou (não promover por ausência de
  // flag: uma falha transitória do ML promoveria um pedido ainda buffered).
  let substatusIntake: string | null = null;
  let statusIntakeMl: string | null = null;
  if (!separacaoFutura && isMercadoLivre(pedido.nomeEcommerce) && pedido.idPedidoEcommerce) {
    try {
      const connId = await getActiveMlConnectionForEmpresa(empresaOrigemId);
      if (connId) {
        const st = await getMlShipmentStatus(connId, pedido.idPedidoEcommerce);
        substatusIntake = st?.substatus ?? null;
        statusIntakeMl = st?.status ?? null;
        if (st?.substatus === SUBSTATUS_FUTURA) {
          separacaoFutura = true;
          logger.info("processor.wms", "pedido classificado como FUTURA via ML substatus", {
            pedidoId: pedido.id,
            substatus: st.substatus,
            shipmentId: st.shipmentId,
          });
        }
      }
    } catch (err) {
      logger.warn("processor.wms", "falha classificando substatus ML (segue fluxo normal)", {
        pedidoId: pedido.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 1. Resolver itens (mapping Tiny → WMS produto)
  const itensResolvidos = await resolverItensWms(pedido, empresaOrigemId);
  const semMapeamento = itensResolvidos.filter((i) => !i.produtoIdWms);
  if (semMapeamento.length > 0) {
    logger.warn("processor.wms", "itens sem mapeamento WMS — pulando", {
      pedidoId: pedido.id,
      skus: semMapeamento.map((i) => i.sku),
    });
  }

  // 1b. Itens que NÃO resolveram pra produto WMS (nem por tiny bridge, nem por
  //     SKU no catálogo unificado): não dá pra rotear/reservar. O pedido é
  //     PARQUEADO como pendente (sem auto-OC, sem reservas, sem job) com marcador
  //     REQUER_SKU até um operador definir o SKU / cadastrar o produto na aba de
  //     pedidos (POST .../itens/[itemId]/definir-sku → reprocessa nativo).
  //     Item com produto_id=0 que CASA por SKU (siso_produtos.sku UNIQUE) já
  //     resolveu em resolverItensWms e segue o fluxo normal — não cai aqui.
  const requerSku = semMapeamento.length > 0;

  // 3. Roteamento via algoritmo WMS
  const itensPraRotear = itensResolvidos
    .filter((i) => i.produtoIdWms)
    .map((i) => ({ produto_id: i.produtoIdWms as string, qty: i.quantidade }));

  let rota: RotaResult =
    itensPraRotear.length > 0
      ? await rotearPedidoDoBanco(empresaOrigemId, itensPraRotear)
      : { decisao: "oc", motivo: "sem_cobertura" };

  // 3a. Preempção (Fase 7): uma venda que envia AGORA (não-futura) escassa ganha
  //     de futura RESERVADA não-picada. Se a ready roteou 'oc' por falta, tenta
  //     soltar reservas de futuras não-picadas no galpão-casa; se isso cobre,
  //     re-roteia (vira propria) e as futuras afetadas viram OC. Futura JÁ picada
  //     está travada (R consumida) → não é tocada e a ready segue pra OC.
  if (!separacaoFutura && rota.decisao === "oc" && itensPraRotear.length > 0 && !requerSku) {
    try {
      const preempt = await preemptarFuturasParaCobertura({
        itens: itensPraRotear,
        galpaoId: galpaoOrigemId,
      });
      if (preempt.reservasLiberadas > 0) {
        rota = await rotearPedidoDoBanco(empresaOrigemId, itensPraRotear);
        logger.info("processor.wms", "re-roteado após preempção de futura", {
          pedidoId: pedido.id,
          reservasLiberadas: preempt.reservasLiberadas,
          novaDecisao: rota.decisao,
        });
      }
    } catch (e) {
      logger.warn("processor.wms", "falha na preempção de futura (segue rota oc)", {
        pedidoId: pedido.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3b. Troca de equivalência (Fase 4): galpão-casa não cobre com o SKU
  //     original → tenta cobrir com SUBSTITUTOS do cluster cross (D10: troca
  //     local vence transferência). Falha no planejamento NUNCA derruba o
  //     webhook — segue a rota normal.
  let planoTroca: PlanoTrocaRoteamento | null = null;
  let planoGalpao = galpaoOrigemId;
  let trocaRemota = false;
  if (rota.decisao !== "propria" && itensPraRotear.length > 0) {
    const itensTroca = itensResolvidos
      .filter((i) => i.produtoIdWms)
      .map((i) => ({
        tiny_id: String(i.tinyProdutoId),
        sku: i.sku,
        produto_uuid: i.produtoIdWms as string,
        qty: i.quantidade,
      }));
    try {
      // Nível 2: troca local (galpão-casa) — vence transferência (D10).
      planoTroca = await planejarTrocaRoteamento({
        galpaoId: galpaoOrigemId,
        itens: itensTroca,
      });
      // Nível 4: troca remota — só quando NEM o original cobre em galpão nenhum
      // (rota=oc). Transferência (original remoto, nível 3) vence a troca remota.
      if (!planoTroca && rota.decisao === "oc") {
        const remoto = await planejarTrocaRemota({
          empresaId: empresaOrigemId,
          galpaoCasaId: galpaoOrigemId,
          itens: itensTroca,
        });
        if (remoto) {
          planoTroca = remoto.plano;
          planoGalpao = remoto.galpaoId;
          trocaRemota = true;
        }
      }
    } catch (e) {
      logger.warn("processor.wms", "falha planejando troca de equivalência (segue rota normal)", {
        pedidoId: pedido.id,
        error: e instanceof Error ? e.message : String(e),
      });
      planoTroca = null;
      planoGalpao = galpaoOrigemId;
      trocaRemota = false;
    }
  }

  // 4. Mapear WMS decisao → legacy Decisao
  // Em 3D só temos propria | transferencia | oc — não há empréstimo.
  // Com plano de troca: todosAuto → propria (auto-troca, zero humano);
  // senão → pendente com sugestao='troca_equivalente' (painel decide).
  let sugestao: LegacyDecisao;
  let separacaoGalpaoId: string;
  let motivo: string;

  if (planoTroca && planoTroca.todosAuto && !trocaRemota) {
    sugestao = "propria";
    separacaoGalpaoId = galpaoOrigemId;
    motivo =
      "Troca de equivalência automática — substituto mesmo nível (par verificado) no galpão casa";
  } else if (planoTroca) {
    sugestao = "troca_equivalente";
    separacaoGalpaoId = planoGalpao;
    motivo = trocaRemota
      ? "Equivalente em estoque em outro galpão — aguardando aprovação de troca (remota)"
      : "Equivalente em estoque no galpão casa — aguardando aprovação de troca";
  } else {
    switch (rota.decisao) {
      case "propria":
        sugestao = "propria";
        separacaoGalpaoId = rota.galpao_id;
        motivo = "Estoque próprio no galpão origem";
        break;
      case "transferencia":
        sugestao = "transferencia";
        separacaoGalpaoId = rota.galpao_id;
        motivo = "Estoque em outro galpão — transferência";
        break;
      case "oc":
        sugestao = "oc";
        separacaoGalpaoId = galpaoOrigemId;
        motivo =
          rota.motivo === "split_galpoes"
            ? "Itens em galpões diferentes — vai pra OC"
            : "Sem cobertura de estoque — vai pra OC";
        break;
    }
  }

  // requerSku bloqueia qualquer auto-aprovação: o pedido fica pendente até o SKU
  // ser definido. O motivo exibido prioriza a pendência de SKU.
  if (requerSku) {
    motivo =
      "Item sem produto resolvível (SKU não cadastrado no WMS) — defina o SKU ou cadastre o produto na aba de pedidos";
  }
  const isAuto = sugestao === "propria" && !requerSku;
  const autoEnfileiraOc = sugestao === "oc" && !requerSku;
  // FUTURA separa direto também na TRANSFERÊNCIA: a venda buffered cuja cobertura
  // está num galpão não-casa é pré-separada NESSE galpão (peça na caixa do dia
  // de lá; expede de lá na promoção) — auto, sem painel humano. Sem isso, toda
  // futura transferência caía em `pendente`/status nulo → sumia da pista futura.
  // Troca de equivalência (curadoria) segue pro painel /wms/trocas, mesmo futura.
  const futuraTransferencia =
    separacaoFutura && sugestao === "transferencia" && !requerSku;
  // Futura que separa cedo no galpão de cobertura (propria OU transferência).
  const futuraSeparaDireto = (isAuto && separacaoFutura) || futuraTransferencia;
  const autoAprova = isAuto || autoEnfileiraOc || futuraTransferencia;
  const status = autoAprova ? "executando" : "pendente";
  const tipoResolucao = autoAprova ? "auto" : null;

  // 4b. Idempotência: se pedido já existe e já foi COMPROMETIDO no pipeline,
  //     log e sai. (Cobre re-entregas de webhook — tipicamente
  //     `atualizacao_pedido`, que o Tiny dispara após emitir a NF / concluir a
  //     expedição — sem reprocessar.)
  //
  //     "Comprometido" = já existe job `lancar_estoque` pro pedido. Esse é o
  //     último passo do intake auto-aprovado (propria/oc) e da aprovação humana
  //     de transferência (wms_aprovar_e_enfileirar). Reprocessar um pedido
  //     comprometido re-rodaria o roteamento, REGREDIRIA o status_separacao
  //     (ex.: aguardando_separacao → aguardando_nf, desfazendo a transição que
  //     o webhook da NF já fez) e enfileiraria um lancar_estoque DUPLICADO. O
  //     fluxo de NF/separação segue por seus próprios webhooks/rotas.
  //
  //     Pedidos `pendente` (sem job, aguardando decisão humana) e os que
  //     erraram ANTES do enqueue do job (retry de webhook falho) NÃO têm job →
  //     seguem reprocessando normalmente. O harness de teste trunca
  //     siso_fila_execucao + siso_pedidos, então seed:cenarios reprocessa limpo.
  //
  //     A guarda de estoque_lancado é mantida como rede redundante (post-pick).
  const { data: existente } = await sb
    .from("siso_pedidos")
    .select("estoque_lancado, separacao_futura, status_separacao, decisao_final, empresa_origem_id")
    .eq("id", pedido.id)
    .maybeSingle();

  const { data: jobComprometido } = await sb
    .from("siso_fila_execucao")
    .select("id")
    .eq("pedido_id", pedido.id)
    .eq("tipo", "lancar_estoque")
    .limit(1)
    .maybeSingle();

  // ⚠ Futura é exceção à guarda de `jobComprometido`: OC futura ENFILEIRA um
  //   `lancar_estoque` (decisao='oc') no intake (validacao_oc, sem NF). Esse job
  //   fica `concluido` e dispararia o early-return aqui ANTES do ramo de promoção
  //   (4b-promoção) → OC futura nunca promoveria pelo webhook. A flag futura
  //   sinaliza "ainda não comprometido de verdade" (NF só nasce na promoção), então
  //   só a guarda de estoque_lancado vale pra ela.
  const comprometidoBloqueia =
    existente?.estoque_lancado === true ||
    (!!jobComprometido && existente?.separacao_futura !== true);
  if (comprometidoBloqueia) {
    logger.info("processor.wms", "pedido já comprometido — skip idempotente (re-entrega de webhook)", {
      pedidoId: pedido.id,
      motivo: existente?.estoque_lancado === true ? "estoque_lancado" : "job_lancar_estoque_existe",
    });
    await sb
      .from("siso_webhook_logs")
      .update({
        status: "duplicado",
        empresa_id: empresaOrigemId,
        processado_em: new Date().toISOString(),
      })
      .eq("id", webhookLogId);
    return { ok: true, pedidoId: pedido.id, status: "duplicado", sugestao };
  }

  // 4b-futura. Re-detecção de buffered já carregado na pista futura: o poll de
  //   abertos pode re-ver o mesmo pedido buffered em runs seguintes. Se o pedido
  //   JÁ é futura e estamos sendo chamados de novo como futura (ainda buffered),
  //   é no-op — NÃO reprocessar (o upsert abaixo regrediria status_separacao e
  //   apagaria um pick já feito na pista futura). A PROMOÇÃO (etiqueta liberou)
  //   chega como webhook normal (separacaoFutura=false) e NÃO cai aqui → segue
  //   pro ramo de promoção (§Fase 6).
  if (existente?.separacao_futura === true && separacaoFutura) {
    logger.info("processor.wms", "futura já carregada — skip re-detecção buffered", {
      pedidoId: pedido.id,
      statusSeparacao: existente.status_separacao,
    });
    await sb
      .from("siso_webhook_logs")
      .update({
        status: "duplicado",
        empresa_id: empresaOrigemId,
        processado_em: new Date().toISOString(),
      })
      .eq("id", webhookLogId);
    return { ok: true, pedidoId: pedido.id, status: "duplicado", sugestao };
  }

  // 4b-promoção. A etiqueta liberou: o pedido era futura e agora chega como
  //   webhook NORMAL (separacaoFutura=false). PROMOVE — sem passar pelo upsert
  //   ingênuo abaixo (que regrediria status_separacao e zeraria o pick já feito).
  //   promoverPedidoFutura flipa a flag, DEFINE o status pela autorização da NF
  //   (aguardando_nf enquanto não autorizada; só vira separado/aguardando_separacao
  //   quando a NF autorizar) e enfileira lancar_estoque conforme a decisao_final →
  //   segue o fluxo NORMAL (gera NF + agrupamento; OC segue a compra). A reserva já
  //   existe; o cutover/pos-NF é idempotente (estorno_de) → não duplica S.
  //   ⚠ Só pega futura NÃO picada aqui (estoque_lancado=false): a picada é barrada
  //   pela guarda post-pick acima e promove via sweep / webhook de NF.
  //
  //   GUARDAS (ver erros-conhecidos SEP-FUTURA-PROMO):
  //   (a) só promove com CONFIRMAÇÃO POSITIVA de release lida do ML neste intake
  //       (classificarPromocaoFutura(substatus,status)==='promover') — uma falha
  //       transitória do ML (substatus null) NÃO promove um pedido ainda buffered,
  //       e shipment cancelado não vira NF de venda cancelada. O sweep promove
  //       depois com leitura fresca.
  //   (b) decisao_final != null (a guarda em promoverPedidoFutura também barra):
  //       troca pendente (decisao_final=null) nunca promove — a aprovação da troca
  //       é que seta a decisão + aprova o pedido.
  if (existente?.separacao_futura === true && !separacaoFutura) {
    const liberou =
      existente.decisao_final != null &&
      classificarPromocaoFutura(substatusIntake, statusIntakeMl) === "promover";
    if (liberou) {
      await promoverPedidoFutura(sb, {
        pedidoId: pedido.id,
        decisaoFinal: existente.decisao_final as string,
        galpaoNome: galpaoOrigemNome,
        empresaId: (existente.empresa_origem_id as string | null) ?? empresaOrigemId,
      });
      await sb
        .from("siso_webhook_logs")
        .update({ status: "concluido", empresa_id: empresaOrigemId, processado_em: new Date().toISOString() })
        .eq("id", webhookLogId);
      return { ok: true, pedidoId: pedido.id, status: "promovido", sugestao };
    }
    // Ainda buffered / sem confirmação / troca pendente → NÃO promove e NÃO
    // reprocessa (o upsert ingênuo abaixo regrediria o estado da futura). Fica
    // como está; o sweep/nf-webhook promovem quando confirmar.
    logger.info("processor.wms", "futura não promovida (sem confirmação de release ou sem decisão)", {
      pedidoId: pedido.id,
      substatus: substatusIntake,
      mlStatus: statusIntakeMl,
      decisaoFinal: existente.decisao_final ?? null,
    });
    await sb
      .from("siso_webhook_logs")
      .update({ status: "duplicado", empresa_id: empresaOrigemId, processado_em: new Date().toISOString() })
      .eq("id", webhookLogId);
    return { ok: true, pedidoId: pedido.id, status: "duplicado", sugestao };
  }

  // 4c. Auto-vendedor_nome para marketplaces rastreados (ML/Shopee).
  //     Preserva vendedor_id já setado manualmente em re-entregas.
  const trackedMarketplaces = new Set(["Mercado Livre", "Shopee"]);
  let empresaOrigemNome: string | null = null;
  {
    const { data: empresaRow } = await sb
      .from("siso_empresas")
      .select("nome")
      .eq("id", empresaOrigemId)
      .single();
    empresaOrigemNome = empresaRow?.nome ?? null;
  }
  const vendedorNomeAuto =
    pedido.nomeEcommerce && trackedMarketplaces.has(pedido.nomeEcommerce) && empresaOrigemNome
      ? `${pedido.nomeEcommerce} ${empresaOrigemNome}`
      : null;
  const { data: pedidoPrev } = await sb
    .from("siso_pedidos")
    .select("vendedor_id, vendedor_nome")
    .eq("id", pedido.id)
    .maybeSingle();

  // [P2 re-audit #7.M2] auto-atribui pedidos ML/Shopee ao user sintético
  // system-marketplace (criado em migration 20260527_user_system_marketplace).
  // Preserva manual: se pedido já tem vendedor_id setado, não sobrescreve.
  // Espelha bloco 8d de webhook-processor.ts:371-384 (legacy path — antes
  // do cutover WMS_AS_SOURCE este era o caminho ativo).
  let vendedorIdAuto: string | null = null;
  if (vendedorNomeAuto && !pedidoPrev?.vendedor_id) {
    const { data: sysUser } = await sb
      .from("siso_usuarios")
      .select("id")
      .eq("nome", "system-marketplace")
      .maybeSingle();
    vendedorIdAuto = sysUser?.id ?? null;
  }

  const vendedorIdFinal = pedidoPrev?.vendedor_id ?? vendedorIdAuto;
  const vendedorNomeFinal =
    pedidoPrev?.vendedor_id != null ? pedidoPrev.vendedor_nome : vendedorNomeAuto;

  // 5. Grava siso_pedidos — resetar flags de estoque pra permitir reprocessamento
  //    em staging (re-run do seed:cenarios). Em prod o early-return acima
  //    pega o caso de duplicado antes de chegar aqui.
  const { error: pedidoErr } = await sb.from("siso_pedidos").upsert(
    {
      id: pedido.id,
      estoque_lancado: false,
      nf_estoque_lancado: false,
      numero: pedido.numero,
      data: formatDate(pedido.data),
      filial_origem: galpaoOrigemNome as "CWB" | "SP",
      empresa_origem_id: empresaOrigemId,
      id_pedido_ecommerce: pedido.idPedidoEcommerce ?? null,
      nome_ecommerce: pedido.nomeEcommerce ?? null,
      cliente_nome: pedido.cliente.nome,
      cliente_cpf_cnpj: pedido.cliente.cpfCnpj ?? null,
      forma_envio_id: pedido.formaEnvio?.id ?? null,
      forma_envio_descricao: pedido.formaEnvio?.descricao ?? null,
      forma_frete_id: pedido.formaFrete?.id ?? null,
      transportador_id: pedido.transportadorId ?? null,
      sugestao,
      sugestao_motivo: motivo,
      status,
      tipo_resolucao: tipoResolucao,
      decisao_final: isAuto
        ? "propria"
        : futuraTransferencia
          ? "transferencia"
          : (autoEnfileiraOc ? "oc" : null),
      separacao_galpao_id: separacaoGalpaoId,
      separacao_futura: separacaoFutura,
      // status_separacao no intake:
      //  - futura propria/transferência → aguardando_separacao (sem etapa de NF;
      //    a R segura o estoque no galpão de cobertura, o pick faz R→L+S).
      //  - normal propria → aguardando_nf.
      //  - OC (futura ou normal) → NULL: o worker (executarMarcadoresOnly) seta
      //    validacao_oc; setar aguardando_nf dispararia enriquecerDadosNf cedo.
      status_separacao: futuraSeparaDireto
        ? "aguardando_separacao"
        : (isAuto ? "aguardando_nf" : null),
      prazo_envio: pedido.dataEnvio ? parseTinyDateTime(pedido.dataEnvio) : null,
      processado_em: null,
      marcadores: requerSku
        ? ["REQUER_SKU", "LVR"]
        : (() => {
            const base = isAuto
              ? [galpaoOrigemNome, "LVR"]
              : (autoEnfileiraOc ? ["OC", galpaoOrigemNome, "LVR"] : ["LVR"]);
            return separacaoFutura ? [...base, MARCADOR_FUTURA] : base;
          })(),
      ...(separacaoFutura ? { separacao_tags: [TAG_FUTURA] } : {}),
      payload_original: pedido,
      vendedor_id: vendedorIdFinal,
      vendedor_nome: vendedorNomeFinal,
      origem_pedido: "webhook",
    },
    { onConflict: "id" },
  );
  if (pedidoErr) throw pedidoErr;

  // 5b. Tag "WMS" no pedido Tiny assim que ele ENTRA no sistema (pedido novo).
  //     Fire-and-forget: falha não bloqueia o intake; 400 do Tiny = marcador
  //     já existe (re-entrega de webhook) → idempotente, silencioso.
  if (!existente) {
    void (async () => {
      try {
        const { token } = await getValidTokenByEmpresa(empresaOrigemId);
        // Futura: marca SEP FUTURA além do WMS (visibilidade Tiny-side; ≠ NF).
        const marcadoresTiny = separacaoFutura ? ["WMS", MARCADOR_FUTURA] : ["WMS"];
        await runWithEmpresa(empresaOrigemId, () =>
          criarMarcadoresPedido(token, pedido.id, marcadoresTiny),
        );
        logger.info("processor.wms", "marcador WMS aplicado no pedido Tiny", {
          pedidoId: pedido.id,
          separacaoFutura,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("400")) {
          logger.warn("processor.wms", "falha ao aplicar marcador WMS no Tiny", {
            pedidoId: pedido.id,
            error: msg,
          });
        }
      }
    })();
  }

  // 5c. Enrich: prazo de despacho (SLA) do Mercado Livre. O Tiny já gravou
  //     `prazo_envio` com só o DIA (23:59:59); o ML traz a HORA exata do
  //     limite de despacho via /shipments/{id}/sla → sobrescreve quando
  //     disponível. Fire-and-forget: falha mantém o valor do Tiny.
  if (isMercadoLivre(pedido.nomeEcommerce) && pedido.idPedidoEcommerce) {
    const orderIdMl = pedido.idPedidoEcommerce;
    void (async () => {
      try {
        const connId = await getActiveMlConnectionForEmpresa(empresaOrigemId);
        if (!connId) return; // empresa sem conexão ML vinculada
        const sla = await getMlShipmentSla(connId, orderIdMl);
        if (!sla) return;
        // Persiste o shipment_id (mesmo sem SLA) — é a chave de match do webhook
        // de notificações do ML (promoção futura real-time). prazo_envio entra
        // junto quando o ML expõe a hora-limite de despacho.
        const upd: Record<string, string> = {};
        if (sla.shipmentId) upd.ml_shipment_id = String(sla.shipmentId);
        if (sla.expectedDate) upd.prazo_envio = sla.expectedDate;
        if (Object.keys(upd).length === 0) return;
        await sb.from("siso_pedidos").update(upd).eq("id", pedido.id);
        logger.info("processor.wms", "enrich ML (prazo_envio + shipment_id)", {
          pedidoId: pedido.id,
          shipmentId: sla.shipmentId,
          expectedDate: sla.expectedDate ?? "null",
        });
      } catch (err) {
        logger.warn("processor.wms", "falha no enrich de prazo_envio (ML)", {
          pedidoId: pedido.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  // 6. Grava itens (siso_pedido_itens) — upsert + limpa órfãos
  const tinyIdsNovos = itensResolvidos.map((i) => i.tinyProdutoId);
  for (const item of itensResolvidos) {
    const fornecedor = getFornecedorBySku(item.sku);
    const { error: itemErr } = await sb.from("siso_pedido_itens").upsert(
      {
        pedido_id: pedido.id,
        produto_id: item.tinyProdutoId,
        produto_id_tiny: item.tinyProdutoId,
        sku: item.sku,
        descricao: item.descricao,
        quantidade_pedida: item.quantidade,
        fornecedor_oc: fornecedor?.fornecedor ?? null,
        imagem_url: item.imagemUrl,
        gtin: item.gtin,
      },
      // linha default 1 no INSERT; o índice único agora é
      // (pedido_id, produto_id, linha) — 20260707_pedido_itens_linha.
      { onConflict: "pedido_id,produto_id,linha" },
    );
    // NÃO engolir falha de gravação de item: um pedido salvo sem itens vira
    // "fantasma" na UI (aparece sem produto) e cai em OC por falta de cobertura.
    // Falhar o webhook (status=erro → retry) é melhor que persistir pedido vazio.
    if (itemErr) throw itemErr;
  }
  // Remove órfãos (ex.: kit-pai sobrevivente de processamento legado, agora
  // que expandimos pra componentes). FK em siso_pedido_item_realocacoes /
  // siso_pedido_item_mov_links protege contra apagar item já em separação.
  if (tinyIdsNovos.length > 0) {
    const { error: delItErr } = await sb
      .from("siso_pedido_itens")
      .delete()
      .eq("pedido_id", pedido.id)
      .not("produto_id", "in", `(${tinyIdsNovos.join(",")})`);
    if (delItErr) {
      logger.warn("processor.wms", "falha ao remover itens órfãos do pedido", {
        pedidoId: pedido.id,
        err: delItErr.message,
      });
    }
  }

  // 7. (Fase 1.4 — 2026-05-28) REMOVIDO: escrita do snapshot
  //    siso_pedido_item_estoques. A tabela foi dropada — todo consumidor lê
  //    estoque VIVO de siso_estoque / da R viva do ledger. Reservas abaixo.

  // 7b. Troca de equivalência: aplica os swaps nos itens recém-upsertados —
  //     auto vira troca 'aprovada' + substituto no item; com aprovação vira
  //     troca 'pendente' + R forte (reserva_troca) no substituto.
  if (planoTroca && !requerSku) {
    await aplicarTrocasRoteamento({
      pedidoId: pedido.id,
      galpaoId: planoGalpao,
      swaps: planoTroca.swaps,
      forcarPendente: trocaRemota,
    });
  }

  // 8. Criar reservas all-or-nothing (apenas propria/transferencia — OC não reserva).
  //    P085: se qualquer item falhar, throw → webhook vira 'erro' (Tiny retenta);
  //    NÃO enfileira lancar_estoque com pedido meio-aprovado.
  //    Com plano de troca: R reserva_pedido pros itens cobertos pelo ORIGINAL +
  //    swaps AUTO (substituto), no galpão do plano (casa ou remoto). Swaps
  //    pendentes já têm R reserva_troca (7b). Remoto força tudo pendente → sem
  //    auto-swaps aqui.
  // Futura: TTL longo derivado da dataPrevista (+14d) — etiqueta buffered pode
  // estar segurada semanas à frente; o 30d default expiraria antes (oversold).
  const ttlFutura = separacaoFutura
    ? ttlHorasReservaFutura(pedido.dataEnvio ?? null)
    : undefined;
  if (requerSku) {
    // Pedido parqueado aguardando SKU — não cria reservas. Serão criadas no
    // reprocessamento nativo após o operador definir o SKU.
  } else if (planoTroca) {
    const autoSwaps = trocaRemota ? [] : planoTroca.swaps.filter((s) => s.auto);
    const rotasTroca = [
      ...planoTroca.cobertosOriginal.map((c) => ({
        produto_id: c.produto_uuid,
        galpao_id: planoGalpao,
        localizacao_id: c.localizacao_id,
        qty: c.qty,
      })),
      ...autoSwaps.map((s) => ({
        produto_id: s.produto_substituto_id,
        galpao_id: planoGalpao,
        localizacao_id: s.localizacao_id,
        qty: s.qty,
      })),
    ];
    if (rotasTroca.length > 0) {
      await criarReservasRotaAtomico({ pedidoId: pedido.id, rotas: rotasTroca, ttlHoras: ttlFutura });
    }
  } else if (rota.decisao === "propria" || rota.decisao === "transferencia") {
    await criarReservasRotaAtomico({
      pedidoId: pedido.id,
      rotas: rota.rotas.map((r) => ({
        produto_id: r.produto_id,
        galpao_id: r.galpao_id,
        localizacao_id: r.localizacao_id,
        qty: r.qty,
      })),
      ttlHoras: ttlFutura,
    });
  }

  // 9. Eventos de histórico + fila
  registrarEvento({
    pedidoId: pedido.id,
    evento: "recebido",
    detalhes: { sugestao, empresa: galpaoOrigemNome, ecommerce: pedido.nomeEcommerce, via: "wms" },
  }).catch(() => {});

  if (autoAprova) {
    registrarEvento({
      pedidoId: pedido.id,
      evento: "auto_aprovado",
      detalhes: { decisao: isAuto ? "propria" : (futuraTransferencia ? "transferencia" : "oc"), motivo, futura: separacaoFutura, via: "wms" },
    }).catch(() => {});

    // Futura que separa direto (propria/transferência) NÃO enfileira lancar_estoque:
    // não gera NF nem baixa estoque agora (a R segura o estoque; o pick na pista
    // futura faz R→L+S; a NF nasce só na promoção). Crucial p/ a re-processabilidade
    // da promoção: enfileirar o job ligaria o early-return de idempotência
    // (jobComprometido) e travaria a promoção. Futura OC ENFILEIRA (decisao='oc') —
    // o worker resolve a compra SEM gerar NF (gate em executarMarcadoresOnly, §Fase 3).
    const enfileiraJob = !futuraSeparaDireto;

    if (enfileiraJob) {
      // Idempotência de re-entrega: OC não seta estoque_lancado=true, então o
      // early-return acima (que checa estoque_lancado) não cobre. Esta guarda
      // protege a janela pendente/executando; re-entregas pós-concluido já são
      // bloqueadas antes pelo dedup_key UNIQUE de siso_webhook_logs.
      // (espelha worker:683-689)
      const { data: jobExistente } = await sb
        .from("siso_fila_execucao")
        .select("id")
        .eq("pedido_id", pedido.id)
        .eq("tipo", "lancar_estoque")
        .in("status", ["pendente", "executando"])
        .maybeSingle();

      if (!jobExistente) {
        await sb.from("siso_fila_execucao").insert({
          pedido_id: pedido.id,
          tipo: "lancar_estoque",
          filial_execucao: galpaoOrigemNome,
          empresa_id: empresaOrigemId,
          decisao: isAuto ? "propria" : "oc",
        });
      }

      kickWorker().catch((err) => {
        logger.error("processor.wms", "kickWorker falhou", {
          pedidoId: pedido.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  await sb
    .from("siso_webhook_logs")
    .update({
      status: "concluido",
      empresa_id: empresaOrigemId,
      processado_em: new Date().toISOString(),
    })
    .eq("id", webhookLogId);

  logger.info("processor.wms", "webhook processado via WMS", {
    pedidoId: pedido.id,
    sugestao,
    status,
    motivo,
  });

  return { ok: true, pedidoId: pedido.id, status, sugestao };
}
