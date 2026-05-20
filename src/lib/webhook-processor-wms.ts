/**
 * webhook-processor-wms — fluxo do Plano 2 (WMS_AS_SOURCE=true).
 *
 * Lê estoque direto de siso_estoque (zero chamadas Tiny pra getEstoque),
 * roteia via rotearPedidoDoBanco (algoritmo WMS-3) e cria reservas no
 * ledger no momento que o pedido é gravado.
 *
 * Chamado por processWebhook() em webhook-processor.ts quando wmsAsSource()
 * retorna true. Estrutura mantida espelhada ao fluxo legado pra não quebrar
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
import { reservarAtomico } from "./wms/reservas";
import { rotearPedidoDoBanco } from "./wms/roteamento";
import type { RotaResult } from "./wms/roteamento";
import type { TinyPedidoDetalhe } from "./tiny-api";

/** Map WMS decision → legacy Decisao shape. */
type LegacyDecisao = "propria" | "transferencia" | "oc";

interface ProcessWebhookWmsInput {
  webhookLogId: string;
  pedido: TinyPedidoDetalhe;
  empresaOrigemId: string;
  galpaoOrigemId: string;
  galpaoOrigemNome: string;
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

  const produtoIds = Array.from(wmsByTinyId.values());
  const { data: produtos } = await sb
    .from("siso_produtos")
    .select("id, sku, descricao, gtin, imagem_url")
    .in("id", produtoIds);

  const produtoById = new Map(produtos?.map((p) => [p.id, p]) ?? []);

  return pedido.itens.map((item) => {
    const produtoIdWms = wmsByTinyId.get(item.produto.id) ?? null;
    const produto = produtoIdWms ? produtoById.get(produtoIdWms) : null;
    return {
      tinyProdutoId: item.produto.id,
      produtoIdWms,
      sku: produto?.sku ?? item.produto.sku ?? "",
      descricao: produto?.descricao ?? item.produto.descricao ?? "",
      quantidade: item.quantidade,
      imagemUrl: produto?.imagem_url ?? null,
      gtin: produto?.gtin ?? null,
    };
  });
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

// ─── Main ──────────────────────────────────────────────────────────────────

export async function processWebhookWms(input: ProcessWebhookWmsInput): Promise<{
  ok: boolean;
  pedidoId: string;
  status: string;
  sugestao: LegacyDecisao;
}> {
  const sb = createServiceClient();
  const { webhookLogId, pedido, empresaOrigemId, galpaoOrigemId, galpaoOrigemNome } = input;

  // 1. Resolver itens (mapping Tiny → WMS produto)
  const itensResolvidos = await resolverItensWms(pedido, empresaOrigemId);
  const semMapeamento = itensResolvidos.filter((i) => !i.produtoIdWms);
  if (semMapeamento.length > 0) {
    logger.warn("processor.wms", "itens sem mapeamento WMS — pulando", {
      pedidoId: pedido.id,
      skus: semMapeamento.map((i) => i.sku),
    });
  }

  // 2. Ler estoques WMS
  const estoquesPorProduto = await lerEstoquesDoWms(itensResolvidos);

  // 3. Roteamento via algoritmo WMS
  const itensPraRotear = itensResolvidos
    .filter((i) => i.produtoIdWms)
    .map((i) => ({ produto_id: i.produtoIdWms as string, qty: i.quantidade }));

  const rota: RotaResult =
    itensPraRotear.length > 0
      ? await rotearPedidoDoBanco(empresaOrigemId, itensPraRotear)
      : { decisao: "oc", motivo: "sem_cobertura" };

  // 4. Mapear WMS decisao → legacy Decisao
  // Em 3D só temos propria | transferencia | oc — não há empréstimo.
  let sugestao: LegacyDecisao;
  let separacaoGalpaoId: string;
  let motivo: string;

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

  const isAuto = sugestao === "propria";
  const status = isAuto ? "executando" : "pendente";
  const tipoResolucao = isAuto ? "auto" : null;

  // 4b. Idempotência: se pedido já existe e foi processado, log e sai.
  //     (Cobre re-entregas de webhook em prod sem causar double-saída.)
  const { data: existente } = await sb
    .from("siso_pedidos")
    .select("estoque_lancado")
    .eq("id", pedido.id)
    .maybeSingle();

  if (existente?.estoque_lancado === true) {
    logger.info("processor.wms", "pedido já processado e estoque lançado — skip idempotente", {
      pedidoId: pedido.id,
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
  const vendedorIdFinal = pedidoPrev?.vendedor_id ?? null;
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
      decisao_final: isAuto ? "propria" : null,
      separacao_galpao_id: separacaoGalpaoId,
      status_separacao: isAuto ? "aguardando_nf" : null,
      prazo_envio: pedido.dataEnvio ? parseTinyDateTime(pedido.dataEnvio) : null,
      processado_em: null,
      marcadores: isAuto ? [galpaoOrigemNome, "LVR"] : ["LVR"],
      payload_original: pedido,
      vendedor_id: vendedorIdFinal,
      vendedor_nome: vendedorNomeFinal,
      origem_pedido: "webhook",
    },
    { onConflict: "id" },
  );
  if (pedidoErr) throw pedidoErr;

  // 6. Grava itens (siso_pedido_itens)
  for (const item of itensResolvidos) {
    const fornecedor = getFornecedorBySku(item.sku);
    await sb.from("siso_pedido_itens").upsert(
      {
        pedido_id: pedido.id,
        produto_id: item.tinyProdutoId,
        produto_id_tiny: item.tinyProdutoId,
        sku: item.sku,
        descricao: item.descricao,
        quantidade_pedida: item.quantidade,
        estoque_cwb_saldo: 0,
        estoque_cwb_reservado: 0,
        estoque_cwb_disponivel: 0,
        estoque_sp_saldo: 0,
        estoque_sp_reservado: 0,
        estoque_sp_disponivel: 0,
        cwb_atende: false,
        sp_atende: false,
        fornecedor_oc: fornecedor?.fornecedor ?? null,
        localizacao_cwb: null,
        localizacao_sp: null,
        imagem_url: item.imagemUrl,
        gtin: item.gtin,
      },
      { onConflict: "pedido_id,produto_id" },
    );
  }

  // 7. Grava siso_pedido_item_estoques — pool fungível por galpão.
  //    Mantemos uma linha por (pedido, produto, empresa_origem) só pra alimentar
  //    a UI legada — não há mais snapshot por dona em 3D.
  //    Itens sem mapeamento ficam de fora.
  const estoqueRows: Array<{
    pedido_id: string;
    produto_id: number;
    empresa_id: string;
    deposito_id: number | null;
    deposito_nome: string | null;
    saldo: number;
    reservado: number;
    disponivel: number;
    localizacao: string | null;
    produto_id_na_empresa: number | null;
  }> = [];

  for (const item of itensResolvidos) {
    if (!item.produtoIdWms) continue;
    const estoques = estoquesPorProduto.get(item.produtoIdWms) ?? [];
    // Em 3D agregamos uma linha por galpão. O "empresa_id" da tabela legada
    // recebe sempre a empresa origem do pedido como tag — saldo é fungível.
    for (const e of estoques) {
      estoqueRows.push({
        pedido_id: pedido.id,
        produto_id: item.tinyProdutoId,
        empresa_id: empresaOrigemId,
        deposito_id: null,
        deposito_nome: "WMS",
        saldo: e.saldo,
        reservado: e.reservado,
        disponivel: e.disponivel,
        localizacao: e.localizacao,
        produto_id_na_empresa: null,
      });
    }
  }

  if (estoqueRows.length > 0) {
    await sb
      .from("siso_pedido_item_estoques")
      .upsert(estoqueRows, { onConflict: "pedido_id,produto_id,empresa_id" });
  }

  // 8. Criar reservas (apenas pra propria/transferencia — OC não reserva)
  if (rota.decisao === "propria" || rota.decisao === "transferencia") {
    for (const r of rota.rotas) {
      try {
        // rotearPedidoDoBanco já retorna localizacao_id no RotaItem.
        await reservarAtomico({
          tripla: {
            produto_id: r.produto_id,
            galpao_id: r.galpao_id,
            localizacao_id: r.localizacao_id,
          },
          qty: r.qty,
          pedido_id: pedido.id,
          ttl_horas: 24 * 30, // 30 dias (vs default 48h da reserva de inventário)
        });
      } catch (err) {
        logger.warn("processor.wms", "falha ao reservar item — pedido salvo mesmo assim", {
          pedidoId: pedido.id,
          produtoId: r.produto_id,
          qty: r.qty,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // 9. Eventos de histórico + fila
  registrarEvento({
    pedidoId: pedido.id,
    evento: "recebido",
    detalhes: { sugestao, empresa: galpaoOrigemNome, ecommerce: pedido.nomeEcommerce, via: "wms" },
  }).catch(() => {});

  if (isAuto) {
    registrarEvento({
      pedidoId: pedido.id,
      evento: "auto_aprovado",
      detalhes: { decisao: "propria", motivo, via: "wms" },
    }).catch(() => {});

    await sb.from("siso_fila_execucao").insert({
      pedido_id: pedido.id,
      tipo: "lancar_estoque",
      filial_execucao: galpaoOrigemNome,
      empresa_id: empresaOrigemId,
      decisao: "propria",
    });

    kickWorker().catch((err) => {
      logger.error("processor.wms", "kickWorker falhou", {
        pedidoId: pedido.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
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
