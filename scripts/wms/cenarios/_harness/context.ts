import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, HttpClient, StagingFixtures } from "./types";
import * as A from "./asserts";

/**
 * Deriva um tiny_produto_id determinístico a partir do SKU + sufixo de empresa.
 * Range: 10_000_000_000 .. 99_999_999_999 (11 dígitos, fora do range Tiny real
 * que geralmente é 9-10 dígitos, e compatível com bigint).
 * Determinístico permite re-rodar cenários e cair sempre no mesmo ID.
 *
 * IMPORTANTE: o suffix garante que cada empresa tenha tiny_produto_id próprio
 * pro mesmo SKU (espelhando o fato real de que cada conta Tiny tem seu próprio
 * id pro mesmo produto). Sem isso, o stub Tiny falha em .maybeSingle() quando
 * múltiplas empresas mapeiam o mesmo tiny_produto_id.
 */
function tinyProdutoIdFromSku(sku: string, empresaSuffix: string = ""): number {
  const key = `${sku}::${empresaSuffix}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 90_000_000_000 + 10_000_000_000;
}

export function createContext(opts: {
  sb: SupabaseClient;
  http: HttpClient;
  staging: StagingFixtures;
  correlationId: string;
}): Ctx {
  const { sb, http, staging, correlationId } = opts;

  const log: Ctx["log"] = (msg, meta) => console.log(`[${correlationId.slice(0, 8)}] ${msg}`, meta ?? "");

  function skuUnico(prefix: string): string {
    return `TEST-${prefix}-${randomBytes(3).toString("hex")}`;
  }

  // Resolve test-runner usuario_id sob demanda. Endpoints como
  // /separacao/iniciar exigem operador_id explícito no body — diferente do
  // auth-context do frontend que injeta automaticamente.
  let _testRunnerId: string | null = null;
  async function getOperadorId(): Promise<string> {
    if (_testRunnerId) return _testRunnerId;
    const { data } = await sb
      .from("siso_usuarios")
      .select("id")
      .eq("nome", process.env.TEST_RUNNER_NOME ?? "test-runner")
      .maybeSingle();
    const id = (data as { id?: string } | null)?.id;
    if (!id) throw new Error(`getOperadorId: usuário test-runner não encontrado`);
    _testRunnerId = id;
    return id;
  }

  async function aguardar(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function criarProduto(p: { sku: string; descricao: string; gtin?: string }): Promise<string> {
    const { data: produto, error } = await sb.from("siso_produtos").insert({
      sku: p.sku,
      descricao: p.descricao,
      gtin: p.gtin ?? null,
      ativo: true,
    }).select("id").single();
    if (error) throw new Error(`criarProduto ${p.sku}: ${error.message}`);

    // Mapping pras 2 empresas de teste — tiny-stub usa isso pra
    // resolver tiny_produto_id → produto_id interno em GET /estoque/{id}.
    // Cada empresa tem tiny_produto_id próprio (mesmo SKU, IDs distintos),
    // refletindo a realidade do Tiny e evitando colisão em .maybeSingle().
    const tinyIdNetair = tinyProdutoIdFromSku(p.sku, "netair");
    const tinyIdNetparts = tinyProdutoIdFromSku(p.sku, "netparts");
    const { error: mapErr } = await sb.from("siso_produto_empresas").upsert(
      [
        { produto_id: produto.id, empresa_id: staging.empresas.netair.id, tiny_produto_id: tinyIdNetair },
        { produto_id: produto.id, empresa_id: staging.empresas.netparts.id, tiny_produto_id: tinyIdNetparts },
      ],
      { onConflict: "produto_id,empresa_id" },
    );
    if (mapErr) throw new Error(`criarProduto mapping ${p.sku}: ${mapErr.message}`);

    return p.sku;
  }

  async function criarLocalizacao(p: { galpao: "CWB" | "SP"; codigo: string; tipo?: "picking" | "overstock" | "quarentena" | "expedicao" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: existente } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.codigo).maybeSingle();
    if (existente) return existente.id;
    const { data, error } = await sb.from("siso_localizacoes").insert({
      galpao_id,
      codigo: p.codigo,
      tipo: p.tipo ?? "picking",
      ativo: true,
    }).select("id").single();
    if (error) throw new Error(`criarLocalizacao ${p.codigo}: ${error.message}`);
    return data.id;
  }

  async function criarFornecedor(p: { nome: string; prefixo_sku?: string }): Promise<string> {
    const { data: existente } = await sb.from("siso_fornecedores").select("id").eq("nome", p.nome).maybeSingle();
    if (existente) return existente.id;
    const { data, error } = await sb.from("siso_fornecedores").insert({
      nome: p.nome,
      prefixo_sku: p.prefixo_sku ?? null,
      ativo: true,
    }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async function semearSaldo(p: { produto: string; galpao: "CWB" | "SP"; loc: string; qty: number; custo?: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.produto).single();
    if (!prod) throw new Error(`semearSaldo: produto ${p.produto} não existe`);
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    if (!loc) throw new Error(`semearSaldo: loc ${p.galpao}/${p.loc} não existe`);

    const { error } = await sb.rpc("wms_inserir_movimentacao", {
      p_produto_id: prod.id,
      p_galpao_id: galpao_id,
      p_localizacao_id: loc.id,
      p_tipo: "E",
      p_quantidade: p.qty,
      p_origem_tipo: "inventario_inicial",
      p_origem_id: null,
      p_custo_unitario: p.custo ?? null,
      p_motivo: `harness seed [${correlationId.slice(0, 8)}]`,
    });
    if (error) throw new Error(`semearSaldo rpc: ${error.message}`);

    // RPC só recalcula custo_medio em origem_tipo nf_compra|devolucao_cliente_integra|lancamento_retroativo.
    // 'inventario_inicial' não dispara recálculo, então cenários que dependem
    // de custo_medio (replenishment, devoluções etc.) precisam que o cache seja
    // populado direto pelo seed.
    if (p.custo !== undefined && p.custo !== null) {
      await sb.from("siso_custo_medio").upsert(
        { produto_id: prod.id, custo_medio: p.custo, atualizado_em: new Date().toISOString() },
        { onConflict: "produto_id" },
      );
    }
  }

  // ── pedido + separação ──
  // O webhook tiny só aceita tipos "inclusao_pedido" | "atualizacao_pedido" com
  // codigoSituacao "aprovado" | "cancelado". O processor depois chama Tiny via
  // tinyFetch (que roteia pro tiny-stub quando TINY_DISABLED=true), e o stub
  // lê de siso_stub_pedidos. Pra cenários funcionarem ponta-a-ponta, o webhook
  // helper precisa seed siso_stub_pedidos antes do POST. Esta versão faz isso.
  async function webhook(p: { empresa: string; items: { sku: string; qty: number }[]; tipo?: "nota_fiscal" | "inclusao_pedido" | "atualizacao_pedido"; pedidoFakeId?: number }) {
    const fakeId = p.pedidoFakeId ?? Math.floor(Math.random() * 90_000_000) + 9_000_000_000;
    const tipoFinal = p.tipo ?? "inclusao_pedido";

    // Resolve empresa suffix do CNPJ pra escolher o tiny_produto_id certo
    // (cada empresa tem seu próprio ID Tiny pro mesmo SKU).
    const empresaSuffix =
      p.empresa === staging.empresas.netair.cnpj
        ? "netair"
        : p.empresa === staging.empresas.netparts.cnpj
          ? "netparts"
          : "netair";

    // Seed do stub Tiny pro pedidoFakeId (se existir a tabela)
    try {
      const { data: empresa } = await sb.from("siso_empresas").select("id").eq("cnpj", p.empresa).single();
      if (empresa) {
        await sb.from("siso_stub_pedidos").upsert({
          id: fakeId,
          empresa_id: empresa.id,
          cenario: "harness",
          payload: {
            id: fakeId,
            numeroPedido: String(fakeId),
            data: new Date().toISOString().slice(0, 10),
            situacao: { id: 9, valor: "Aprovado" },
            // ecommerce marca o pedido como marketplace (webhook-processor exige)
            ecommerce: { nome: "Harness Test", numeroPedidoEcommerce: `H-${fakeId}` },
            cliente: { cpfCnpj: p.empresa, nome: "Cliente Teste" },
            itens: p.items.map((it, i) => ({
              id: fakeId * 10 + i,
              // sku field é o que o webhook-processor lê (TinyPedidoItem.produto.sku);
              // codigo é mantido como alias por compat com APIs antigas.
              produto: { id: tinyProdutoIdFromSku(it.sku, empresaSuffix), sku: it.sku, codigo: it.sku, descricao: `Produto teste ${it.sku}` },
              quantidade: it.qty,
              valorUnitario: 1,
            })),
          },
        });
      }
    } catch {
      // siso_stub_pedidos pode não existir no schema; ignora e segue
    }

    const body = {
      tipo: tipoFinal,
      dados: {
        id: String(fakeId),
        codigoSituacao: "aprovado",
        cliente: { cnpj: p.empresa, nome: "Cliente Teste" },
        itens: p.items.map((it, i) => ({
          id: String(fakeId * 10 + i),
          produto: { id: String(tinyProdutoIdFromSku(it.sku, empresaSuffix)), sku: it.sku, codigo: it.sku, descricao: it.sku },
          quantidade: it.qty,
        })),
      },
      cnpj: p.empresa,
    };
    await http.post("/api/wms/webhook/tiny", body);
    // Espera até o pedido aparecer. Webhook é fire-and-forget e o processor
    // faz vários round-trips Tiny (mesmo no stub, com sleeps), então pode
    // levar 10s+ até a row chegar em siso_pedidos.
    const maxWaitMs = 20_000;
    const pollMs = 250;
    for (let attempt = 0; attempt < maxWaitMs / pollMs; attempt++) {
      const { data } = await sb.from("siso_pedidos").select("id").eq("id", fakeId).maybeSingle();
      if (data) return { id: String(data.id) };
      await aguardar(pollMs);
    }
    throw new Error(`webhook: pedido com id=${fakeId} não apareceu em ${maxWaitMs}ms`);
  }

  async function aprovar(pedidoId: string, decisao?: "propria" | "transferencia" | "oc") {
    // Default a decisao quando o cenário não passa — o webhook-processor já gravou
    // sugestao em siso_pedidos, então recuperamos pra mandar como decisao explícita
    // (a rota /aprovar exige `decisao` obrigatório).
    let decisaoFinal: "propria" | "transferencia" | "oc" | undefined = decisao;
    if (!decisaoFinal) {
      const { data } = await sb
        .from("siso_pedidos")
        .select("sugestao")
        .eq("id", pedidoId)
        .maybeSingle();
      const sug = (data as { sugestao?: string } | null)?.sugestao;
      if (sug === "propria" || sug === "transferencia" || sug === "oc") {
        decisaoFinal = sug;
      }
    }
    // Rota espera camelCase `pedidoId` + `decisao` (snake_case foi rejeitado em 400).
    await http.post("/api/wms/pedidos/aprovar", { pedidoId, decisao: decisaoFinal });
  }

  async function iniciarSeparacao(pedidoId: string) {
    const operador_id = await getOperadorId();
    await http.post("/api/wms/separacao/iniciar", { pedido_ids: [pedidoId], operador_id });
  }

  async function bipar(p: { pedido: string; item: string; qty: number; loc?: string }) {
    // Fluxo wave picking: marca cada item como "picado" via /marcar-item.
    // Isso seta separacao_marcado=true, gera mov de saída no ledger e permite
    // que /concluir transicione em_separacao → separado (que é o que o
    // cenário 01 espera). `bipar` (com /separacao/bipar) seria barcode
    // scanning, mas o RPC associado pula direto pra "embalado" e ignora o
    // separacao_marcado que concluir verifica — não bate com o fluxo do
    // cenário, então usamos marcar-item aqui.
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("separacao_galpao_id")
      .eq("id", p.pedido)
      .maybeSingle();
    const galpaoId = (ped as { separacao_galpao_id?: string } | null)?.separacao_galpao_id;
    const headers: Record<string, string> = galpaoId ? { "X-Galpao-Id": galpaoId } : {};

    // Resolve pedido_item_id pelo SKU
    const { data: items } = await sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", p.pedido);
    const item = (items as Array<{ id: string | number; sku: string }> | null)?.find((i) => i.sku === p.item);
    if (!item) throw new Error(`bipar: item ${p.item} não encontrado no pedido ${p.pedido}`);

    await http.post(
      "/api/wms/separacao/marcar-item",
      { pedido_item_id: item.id, marcado: true },
      headers,
    );
  }

  async function parcial(p: { pedido: string; item: string; qty: number; loc_zerou: boolean }) {
    // Rota espera pedido_item_id (não pedido_id+sku). Resolve via siso_pedido_itens
    // pelo SKU. Também usa galpao header e session — getSessionUser exige X-Session-Id
    // que já vem do http client. Quantidade vai como `quantidade_pega` (int).
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("separacao_galpao_id")
      .eq("id", p.pedido)
      .maybeSingle();
    const galpaoId = (ped as { separacao_galpao_id?: string } | null)?.separacao_galpao_id;
    const headers: Record<string, string> = galpaoId ? { "X-Galpao-Id": galpaoId } : {};

    const { data: items } = await sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", p.pedido);
    const item = (items as Array<{ id: string | number; sku: string }> | null)?.find((i) => i.sku === p.item);
    if (!item) throw new Error(`parcial: item ${p.item} não encontrado no pedido ${p.pedido}`);

    await http.post(
      "/api/wms/separacao/parcial",
      {
        pedido_item_id: item.id,
        quantidade_pega: p.qty,
        loc_zerou: p.loc_zerou,
      },
      headers,
    );
  }

  async function desfazerParcial(p: { pedido: string; item: string }) {
    await http.post("/api/wms/separacao/desfazer-parcial", { pedido_id: p.pedido, sku: p.item });
  }

  async function encaminhar(p: { pedido: string; item: string; galpao_destino: "CWB" | "SP" }) {
    // Rota espera `pedido_ids: string[]` + `galpao_destino_id`. O `item` (sku)
    // não é usado pela API — encaminhar opera por pedido inteiro, não por item.
    const galpao_id = staging.galpoes[p.galpao_destino.toLowerCase() as "cwb" | "sp"].id;
    await http.post("/api/wms/separacao/encaminhar", {
      pedido_ids: [p.pedido],
      galpao_destino_id: galpao_id,
    });
  }

  async function concluirSeparacao(pedidoId: string) {
    await http.post("/api/wms/separacao/concluir", { pedido_ids: [pedidoId] });
  }

  async function embalar(pedidoId: string) {
    // /separacao/bipar-embalagem processa um SKU por chamada (com qty). Como
    // o cenário não passa SKU pra embalar(pedidoId), levantamos os itens do
    // pedido e bipamos cada um pela quantidade pedida.
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("separacao_galpao_id")
      .eq("id", pedidoId)
      .maybeSingle();
    const galpaoId = (ped as { separacao_galpao_id?: string } | null)?.separacao_galpao_id ?? null;
    const headers: Record<string, string> = galpaoId ? { "X-Galpao-Id": galpaoId } : {};

    const { data: items } = await sb
      .from("siso_pedido_itens")
      .select("sku, quantidade_pedida")
      .eq("pedido_id", pedidoId);
    const list = (items ?? []) as Array<{ sku: string; quantidade_pedida: number }>;
    for (const it of list) {
      await http.post(
        "/api/wms/separacao/bipar-embalagem",
        { sku: it.sku, galpao_id: galpaoId, quantidade: it.quantidade_pedida },
        headers,
      );
    }
  }

  async function expedir(pedidoId: string) {
    await http.post("/api/wms/separacao/expedir", { pedido_ids: [pedidoId] });
  }

  // ── waits ──
  async function aguardarStatus(pedidoId: string, status: string, expected?: { decisao?: string }, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_pedidos").select("status, sugestao").eq("id", pedidoId).maybeSingle();
      const row = data as { status?: string; sugestao?: string } | null;
      if (row?.status === status && (!expected?.decisao || row.sugestao === expected.decisao)) return;
      await aguardar(150);
    }
    const { data } = await sb.from("siso_pedidos").select("status, sugestao").eq("id", pedidoId).maybeSingle();
    throw new Error(`aguardarStatus: ${pedidoId} esperava ${status}/${expected?.decisao} em ${timeout}ms; estado final: ${JSON.stringify(data)}`);
  }

  /**
   * Simula o webhook tipo "nota_fiscal" que o Tiny dispararia após autorização
   * da NF pelo SEFAZ. Necessário pra destravar pedidos em `aguardando_nf`
   * durante testes — em prod isso vem assíncrono do próprio Tiny.
   */
  async function _simularNfWebhook(pedidoId: string): Promise<boolean> {
    const { data: ped } = await sb
      .from("siso_pedidos")
      .select("nota_fiscal_id, empresa_origem_id, chave_acesso_nf")
      .eq("id", pedidoId)
      .maybeSingle();
    const row = ped as { nota_fiscal_id?: string | null; empresa_origem_id?: string | null; chave_acesso_nf?: string | null } | null;
    if (!row?.nota_fiscal_id || !row.empresa_origem_id) return false;

    const { data: emp } = await sb
      .from("siso_empresas")
      .select("cnpj")
      .eq("id", row.empresa_origem_id)
      .maybeSingle();
    const cnpj = (emp as { cnpj?: string } | null)?.cnpj;
    if (!cnpj) return false;

    const body = {
      tipo: "nota_fiscal",
      cnpj,
      dados: {
        idNotaFiscalTiny: Number(row.nota_fiscal_id),
        numero: "1",
        serie: "1",
        chaveAcesso: row.chave_acesso_nf ?? `FAKE-CHAVE-${row.nota_fiscal_id}`,
        urlDanfe: `https://staging.local/danfe-${row.nota_fiscal_id}.pdf`,
        dataEmissao: new Date().toISOString(),
        valorNota: 1,
      },
    };
    try {
      await http.post("/api/wms/webhook/tiny", body);
      return true;
    } catch {
      return false;
    }
  }

  async function aguardarStatusSeparacao(pedidoId: string, status: string, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 8_000;
    const deadline = Date.now() + timeout;
    let nfFired = false;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_pedidos").select("status_separacao").eq("id", pedidoId).maybeSingle();
      const atual = (data as { status_separacao?: string } | null)?.status_separacao;
      if (atual === status) return;
      // Destrava aguardando_nf → aguardando_separacao simulando NF webhook
      // (em prod isso viria assíncrono do Tiny).
      if (!nfFired && atual === "aguardando_nf" && status !== "aguardando_nf") {
        nfFired = await _simularNfWebhook(pedidoId);
      }
      await aguardar(150);
    }
    const { data } = await sb.from("siso_pedidos").select("status_separacao").eq("id", pedidoId).maybeSingle();
    throw new Error(`aguardarStatusSeparacao: ${pedidoId} esperava ${status} em ${timeout}ms; real: ${(data as { status_separacao?: string } | null)?.status_separacao}`);
  }

  async function aguardarRealocacao(pedidoId: string, sku: string, locEsperada: string, opts: { timeout_ms?: number } = {}) {
    // `siso_pedido_item_realocacoes` não tem `pedido_id` (só `pedido_item_id`).
    // Resolve via JOIN com siso_pedido_itens.
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    // Pré-resolve os pedido_item_ids deste pedido + sku
    const { data: itens } = await sb
      .from("siso_pedido_itens")
      .select("id")
      .eq("pedido_id", pedidoId)
      .eq("sku", sku);
    const itemIds = (itens ?? []).map((i: { id: number | string }) => i.id);
    if (itemIds.length === 0) {
      throw new Error(`aguardarRealocacao: nenhum item do pedido ${pedidoId} pra sku ${sku}`);
    }
    while (Date.now() < deadline) {
      const { data } = await sb
        .from("siso_pedido_item_realocacoes")
        .select("id, localizacao:siso_localizacoes!inner(codigo)")
        .in("pedido_item_id", itemIds)
        .eq("status", "aguardando_picking");
      const match = (data as Array<{ localizacao: { codigo: string } }> | null)?.find((r) => r.localizacao.codigo === locEsperada);
      if (match) return;
      await aguardar(150);
    }
    throw new Error(`aguardarRealocacao: ${pedidoId}/${sku} esperava realoc em ${locEsperada} em ${timeout}ms`);
  }

  async function aguardarFilaVazia(opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 10_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { count } = await sb
        .from("siso_fila_execucao")
        .select("id", { count: "exact", head: true })
        .in("status", ["pendente", "executando"]);
      if ((count ?? 0) === 0) return;
      await aguardar(250);
    }
    const { data } = await sb.from("siso_fila_execucao").select("id, status, tipo").in("status", ["pendente", "executando"]);
    throw new Error(`aguardarFilaVazia: ${timeout}ms estourou; jobs pendentes: ${JSON.stringify(data)}`);
  }

  // ── compras + recebimento ──
  // Fluxo OC real:
  //  1. validacao_oc → /validar-oc-item acao=esgotado → aguardando_compra
  //  2. /compras/comprar → marca comprado → compras-release dispara →
  //     aguardando_nf
  //  3. NF webhook simulado → aguardando_separacao
  //  4. /compras/receber → marca compra_quantidade_recebida (não mexe ledger)
  //  5. Estoque físico chega via /wms/receber (entrada_direta) → loc tem saldo
  //  6. operador bipa picking
  async function validarOcItens(p: { pedido_id: string; sku: string; acao: "esgotado" | "encontrei" }) {
    const { data: items } = await sb
      .from("siso_pedido_itens")
      .select("id, sku")
      .eq("pedido_id", p.pedido_id);
    const filtered = (items as Array<{ id: string; sku: string }> | null)?.filter((i) => i.sku === p.sku) ?? [];
    if (filtered.length === 0) throw new Error(`validarOcItens: sku ${p.sku} não está no pedido ${p.pedido_id}`);
    await http.post("/api/wms/separacao/validar-oc-item", {
      item_ids: filtered.map((i) => String(i.id)),
      acao: p.acao,
    });
  }

  async function comprar(p: { sku: string; qty: number; fornecedor?: string; pedido_id?: string }) {
    // Se pedido_id foi passado, primeiro transiciona validacao_oc → aguardando_compra
    // pela rota /validar-oc-item (acao=esgotado). Em prod isso vem do operador
    // após não achar fisicamente no picking — pulamos pra direto.
    if (p.pedido_id) {
      await validarOcItens({ pedido_id: p.pedido_id, sku: p.sku, acao: "esgotado" });
    }
    await http.post<{ ok: boolean; resultados: unknown[] }>("/api/wms/compras/comprar", {
      itens: [{ sku: p.sku, quantidade_comprada: p.qty }],
    });
    // Busca a OC criada pra esse fornecedor+sku (uma row em siso_ordens_compra
    // foi criada pelo validar-oc-item via linkItemToOC). Retorna o id pra
    // receberCompra.
    const { data: itemRow } = await sb
      .from("siso_pedido_itens")
      .select("ordem_compra_id")
      .eq("sku", p.sku)
      .eq("compra_status", "comprado")
      .order("comprado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ordemId = (itemRow as { ordem_compra_id?: string } | null)?.ordem_compra_id ?? null;
    return { ordem_id: ordemId ?? "" };
  }

  async function receberCompra(p: { ordem_id: string; items: { sku: string; qty: number }[] }) {
    // /compras/receber: marca itens recebido (compra_status=recebido). Não
    // mexe no ledger — estoque físico chega via /wms/receber em separado.
    await http.post("/api/wms/compras/receber", {
      itens: p.items.map((it) => ({ sku: it.sku, quantidade_recebida: it.qty })),
    });
  }

  async function prepararEmbalagem(p: { pedido_id: string }) {
    await http.post("/api/wms/compras/preparar-embalagem", { pedido_id: p.pedido_id });
  }

  async function receber(p: { items: { sku: string; qty: number; loc_destino?: string }[]; galpao: "CWB" | "SP"; entrada_direta?: boolean }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const itens = await Promise.all(
      p.items.map(async (it) => {
        const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
        let loc_destino_id: string | null = null;
        if (it.loc_destino) {
          const { data: l } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", it.loc_destino).single();
          loc_destino_id = l?.id ?? null;
        }
        return { produto_id: prod!.id, qty: it.qty, custo_unitario: 10, localizacao_destino_id: loc_destino_id };
      }),
    );
    // Resolve default fornecedor (TestSupplier-Default seeded em seed.ts)
    const { data: fornecedor } = await sb
      .from("siso_fornecedores")
      .select("id")
      .eq("nome", "TestSupplier-Default")
      .single();
    const res = await http.post<{ ok: boolean; pendencia_ids: string[]; localizacao_recebimento_id: string | null; lote_id: string; mov_ids: string[] }>(
      "/api/wms/receber",
      {
        galpao_id,
        itens,
        empresa_compradora_id: staging.empresas.netair.id,
        fornecedor_id: fornecedor!.id,
        entrada_direta: p.entrada_direta ?? false,
      },
    );
    // Normaliza pra forma exposta pelo Ctx (pendencias é o alias usado pelos cenários).
    return { ...res, pendencias: res.pendencia_ids };
  }

  async function guardar(p: { pendencia_id: string; loc_destino: string; qty?: number }) {
    const { data: pend } = await sb.from("siso_wms_pendencias_guarda").select("galpao_id, qty_pendente").eq("id", p.pendencia_id).single();
    const pendRow = pend as { galpao_id: string; qty_pendente?: number };
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", pendRow.galpao_id).eq("codigo", p.loc_destino).single();
    // Rota usa `qty` (não `quantidade`); default = qty_pendente atual.
    await http.post(`/api/wms/guarda/${p.pendencia_id}/confirmar`, {
      localizacao_destino_id: loc!.id,
      qty: p.qty ?? pendRow.qty_pendente,
    });
  }

  async function desfazerGuarda(p: { pendencia_id: string; motivo?: string }) {
    const motivo = p.motivo ?? "teste cenário desfazer";
    return http.post<{ movsEstornadas: number }>(
      `/api/wms/guarda/${p.pendencia_id}/desfazer`,
      { motivo },
    );
  }

  async function aguardarPendenciaGuarda(pendenciaId: string, status: string, opts: { timeout_ms?: number } = {}) {
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb.from("siso_wms_pendencias_guarda").select("status").eq("id", pendenciaId).maybeSingle();
      if ((data as { status?: string } | null)?.status === status) return;
      await aguardar(150);
    }
    throw new Error(`aguardarPendenciaGuarda: ${pendenciaId} esperava ${status} em ${timeout}ms`);
  }

  // ── movs operacionais ──
  async function transferirGalpao(p: { origem: "CWB" | "SP"; destino: "CWB" | "SP"; items: { sku: string; qty: number }[] }) {
    const galpao_origem_id = staging.galpoes[p.origem.toLowerCase() as "cwb" | "sp"].id;
    const galpao_destino_id = staging.galpoes[p.destino.toLowerCase() as "cwb" | "sp"].id;
    // Pré-resolve loc origem (qualquer loc com saldo > 0 do produto) e loc
    // destino (a loc RECEBIMENTO do galpão destino — comportamento padrão).
    // Em 3D não há mais transferência por header; é par S+E direto.
    const itens: { produto_id: string; qty: number }[] = [];
    let locOrigemId: string | null = null;
    for (const it of p.items) {
      const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
      itens.push({ produto_id: prod!.id, qty: it.qty });
      if (!locOrigemId) {
        const { data: linha } = await sb
          .from("siso_estoque")
          .select("localizacao_id, saldo")
          .eq("produto_id", prod!.id)
          .eq("galpao_id", galpao_origem_id)
          .gt("saldo", 0)
          .order("saldo", { ascending: false })
          .limit(1)
          .maybeSingle();
        locOrigemId = (linha as { localizacao_id?: string } | null)?.localizacao_id ?? null;
      }
    }
    if (!locOrigemId) throw new Error("transferirGalpao: nenhuma loc com saldo no galpão origem");

    const locDestinoId = staging.galpoes[p.destino.toLowerCase() as "cwb" | "sp"].recebimento_loc_id;
    const res = await http.post<{ ok: boolean; origem_id: string }>("/api/wms/transferir-galpao", {
      galpao_origem_id,
      localizacao_origem_id: locOrigemId,
      galpao_destino_id,
      localizacao_destino_id: locDestinoId,
      itens,
    });
    // Compat com cenários que esperam {id} — usa origem_id como handle.
    return { id: res.origem_id };
  }

  async function replenishment(p: { sku: string; galpao: "CWB" | "SP"; origem_loc: string; destino_loc: string; qty: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: orig } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.origem_loc).single();
    const { data: dest } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.destino_loc).single();
    await http.post("/api/wms/replenishment", {
      galpao_id,
      localizacao_origem_id: orig!.id,
      localizacao_destino_id: dest!.id,
      itens: [{ produto_id: prod!.id, qty: p.qty }],
    });
  }

  async function ajusteManual(p: { sku: string; galpao: "CWB" | "SP"; loc: string; delta: number; motivo: string }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    await http.post("/api/wms/ajuste", {
      tripla: {
        produto_id: prod!.id,
        galpao_id,
        localizacao_id: loc!.id,
      },
      qty: Math.abs(p.delta),
      direcao: p.delta >= 0 ? "entrada" : "saida",
      motivo: p.motivo,
    });
  }

  async function lancamentoRetroativo(p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; tipo: "E" | "S"; custo?: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    // Rota espera body { tripla, qty, motivo (≥3) }. Endpoint não retorna id da
    // pendência criada, mas o cenário precisa do id pra reconciliar — buscamos
    // do banco logo após o POST (a row mais recente do produto+loc+galpão).
    await http.post("/api/wms/lancamento-retroativo", {
      tripla: { produto_id: prod!.id, galpao_id, localizacao_id: loc!.id },
      qty: p.qty,
      motivo: `harness retroativo [${correlationId.slice(0, 8)}]`,
      custo_unitario: p.custo,
    });
    // O lançamento retroativo é uma mov 'E' em siso_movimentacoes com
    // origem_tipo='lancamento_retroativo'. Busca a mais recente do trio.
    const { data: row } = await sb
      .from("siso_movimentacoes")
      .select("id")
      .eq("produto_id", prod!.id)
      .eq("galpao_id", galpao_id)
      .eq("localizacao_id", loc!.id)
      .eq("origem_tipo", "lancamento_retroativo")
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    const id = (row as { id?: string } | null)?.id;
    if (!id) throw new Error("lancamentoRetroativo: mov recém-criada não encontrada");
    return { id, produto_id: prod!.id, galpao_id, localizacao_id: loc!.id };
  }

  async function reconciliarRetroativo(id: string, compra_mov_id?: string) {
    // Rota exige `compra_mov_id`. Se não vier, busca a mov de compra mais
    // recente desse produto (fluxo de cenários: lança retroativo, depois
    // chega NF/receber).
    let compraMovId = compra_mov_id;
    if (!compraMovId) {
      // Pega o produto_id da mov retroativa
      const { data: retro } = await sb
        .from("siso_movimentacoes")
        .select("produto_id")
        .eq("id", id)
        .maybeSingle();
      const produtoId = (retro as { produto_id?: string } | null)?.produto_id;
      if (produtoId) {
        const { data: compra } = await sb
          .from("siso_movimentacoes")
          .select("id")
          .eq("produto_id", produtoId)
          .in("origem_tipo", ["nf_compra"])
          .order("criado_em", { ascending: false })
          .limit(1)
          .maybeSingle();
        compraMovId = (compra as { id?: string } | null)?.id;
      }
    }
    if (!compraMovId) throw new Error("reconciliarRetroativo: compra_mov_id não encontrada");
    await http.post(`/api/wms/lancamento-retroativo/${id}/reconciliar`, { compra_mov_id: compraMovId });
  }

  // ── vendas ──
  async function criarVendaDireta(p: { galpao: "CWB" | "SP"; empresa: "netair" | "netparts"; items: { sku: string; qty: number }[]; modo: "separacao" | "baixa_direta" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const empresa_origem_id = staging.empresas[p.empresa].id;
    const itens = await Promise.all(p.items.map(async (it) => {
      const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
      return { produto_id: prod!.id, quantidade: it.qty };
    }));
    return http.post<{ id: string; degradado: boolean; motivo_degradacao?: string; skus_sem_saldo?: string[] }>(
      "/api/wms/vendas/criar",
      {
        cliente_nome: "Cliente Teste Harness",
        cliente_cpf_cnpj: null,
        canal_venda: "balcao",
        galpao_id,
        empresa_origem_id,
        items: itens,
        modo: p.modo,
      },
    );
  }

  async function cancelarVenda(p: { pedido_id: string; motivo?: string }) {
    const motivo = (p.motivo ?? "teste cenário — cancelamento de venda").trim();
    return http.post<{ ok: boolean; movsEstornadas: number; reservasLiberadas: number }>(
      `/api/wms/vendas/${p.pedido_id}/cancelar`,
      { motivo },
    );
  }

  async function disponibilidadeVenda(p: { sku: string; galpao: "CWB" | "SP"; empresa: "netair" | "netparts" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const empresa_origem_id = staging.empresas[p.empresa].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    return http.get<{ localizacao_id?: string; disponivel: number }>(
      `/api/wms/vendas/disponibilidade?produto_id=${prod!.id}&galpao_id=${galpao_id}&empresa_origem_id=${empresa_origem_id}`,
    );
  }

  // ── reservas ──
  async function reservar(p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; ttl_horas?: number; ttl_segundos?: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    // wms_reservar_atomico.p_ttl_horas é integer. Pra TTL em segundos, força
    // ttl_horas=0 (expira_em = now()) e o caller faz aguardar() antes do cleanup.
    const ttl_horas = p.ttl_horas !== undefined ? p.ttl_horas : (p.ttl_segundos !== undefined ? 0 : 48);
    const { data, error } = await sb.rpc("wms_reservar_atomico", {
      p_produto_id: prod!.id,
      p_galpao_id: galpao_id,
      p_localizacao_id: loc!.id,
      p_quantidade: p.qty,
      p_ttl_horas: ttl_horas,
      p_pedido_id: null,
    });
    if (error) throw new Error(`reservar: ${error.message}`);
    return { mov_id: data as string };
  }

  async function cleanupReservas() {
    return http.get<{ liberadas: number }>("/api/wms/reservas/cleanup", {
      "x-worker-secret": process.env.WORKER_SECRET ?? "test-worker-secret",
    });
  }

  // ── devoluções ──
  async function classificarDevolucao(p: { devolucao_id: string; classificacao: "A" | "B" | "C" | "D" }) {
    // Mapeamento legado A/B/C/D → strings que a rota aceita (3D).
    const mapa = {
      A: "integro",
      B: "avariado",
      C: "garantia",
      D: "troca_sku",
    } as const;
    const classificacaoStr = mapa[p.classificacao];

    // Rota exige produto_id, galpao_id, localizacao_id, qty no body.
    // Inferimos do payload da devolução pendente em DB (cenários injetam isso
    // no `payload_webhook` ou em colunas; rotina é flexível pra ambos).
    const { data: dev } = await sb
      .from("siso_devolucoes_pendentes")
      .select("payload_webhook, empresa_id")
      .eq("id", p.devolucao_id)
      .maybeSingle();
    const payload = (dev as { payload_webhook?: Record<string, unknown> } | null)
      ?.payload_webhook ?? {};
    const produto_id = (payload as { produto_id?: string }).produto_id;
    const galpao_id = (payload as { galpao_id?: string }).galpao_id;
    const localizacao_id = (payload as { localizacao_id?: string }).localizacao_id;
    const qty = (payload as { qty?: number }).qty;
    if (!produto_id || !galpao_id || !localizacao_id || !qty) {
      throw new Error(
        `classificarDevolucao: payload_webhook precisa de produto_id/galpao_id/localizacao_id/qty (recebido: ${JSON.stringify(payload)})`,
      );
    }
    await http.post(`/api/wms/devolucoes/${p.devolucao_id}/classificar`, {
      classificacao: classificacaoStr,
      produto_id,
      galpao_id,
      localizacao_id,
      qty,
    });
  }

  async function desclassificarDevolucao(p: { devolucao_id: string; motivo?: string }) {
    const motivo = (p.motivo ?? "teste cenário 43 — desclassifica").trim();
    return http.post<{ ok: boolean; movsEstornadas: number }>(
      `/api/wms/devolucoes/${p.devolucao_id}/desclassificar`,
      { motivo },
    );
  }

  // ── inventário ──
  async function criarSessaoInventario(p: { galpao: "CWB" | "SP"; locs: string[]; modo?: "blind" | "aberto"; tipo?: "cycle_count" | "completo" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: locs } = await sb.from("siso_localizacoes").select("id, codigo").eq("galpao_id", galpao_id).in("codigo", p.locs);
    // Rota espera `localizacoes: [{ localizacao_id, motivo? }]` (LocSessaoInput[]),
    // não array de ids planos. `modo` → `modo_contagem` per route body shape.
    const localizacoes = (locs ?? []).map((l: { id: string }) => ({
      localizacao_id: l.id,
      motivo: "manual" as const,
    }));
    const res = await http.post<{ id: string }>("/api/wms/inventario", {
      galpao_id,
      localizacoes,
      modo_contagem: p.modo ?? "blind",
      tipo: p.tipo ?? "cycle_count",
    });
    await http.post(`/api/wms/inventario/${res.id}/iniciar`);
    return res;
  }

  async function entrarParty(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/party`);
  }

  async function proximaLoc(sessaoId: string) {
    return http.post<{ localizacao_id: string | null; pool_vazio?: boolean }>(`/api/wms/inventario/${sessaoId}/proxima-loc`);
  }

  async function bipeInventario(p: { sessao_id: string; sku: string; loc: string; qty: number }) {
    const { data: sess } = await sb.from("siso_inventario_sessoes").select("galpao_id").eq("id", p.sessao_id).single();
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", (sess as { galpao_id: string }).galpao_id).eq("codigo", p.loc).single();
    // Rota lê `qty_contada` (não `quantidade`) — schema 3D.
    await http.post(`/api/wms/inventario/${p.sessao_id}/contagens`, {
      produto_id: prod!.id,
      localizacao_id: loc!.id,
      qty_contada: p.qty,
    });
  }

  async function finalizarLocInventario(p: { sessao_id: string; loc: string }) {
    // O parâmetro [locId] da rota é o id da row em `siso_inventario_localizacoes`
    // (não em `siso_localizacoes`). Resolve via JOIN no codigo.
    const { data: sess } = await sb.from("siso_inventario_sessoes").select("galpao_id").eq("id", p.sessao_id).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", (sess as { galpao_id: string }).galpao_id).eq("codigo", p.loc).single();
    const { data: invLoc } = await sb
      .from("siso_inventario_localizacoes")
      .select("id")
      .eq("sessao_id", p.sessao_id)
      .eq("localizacao_id", loc!.id)
      .maybeSingle();
    const invLocId = (invLoc as { id?: string } | null)?.id;
    if (!invLocId) throw new Error(`finalizarLocInventario: row em siso_inventario_localizacoes não encontrada (sessao=${p.sessao_id}, loc=${p.loc})`);
    await http.post(`/api/wms/inventario/${p.sessao_id}/localizacoes/${invLocId}/finalizar`);
  }

  async function aprovarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aprovar`);
  }

  async function aplicarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aplicar`);
  }

  async function estornarInventario(sessaoId: string, motivo = "teste cenário 41") {
    return http.post<{ ok: boolean; movsEstornadas: number }>(
      `/api/wms/inventario/${sessaoId}/estornar`,
      { motivo },
    );
  }

  // ── asserts (proxies) ──
  const assertSaldo: Ctx["assertSaldo"] = (sku, g, l, q) => A.assertSaldo(sb, sku, g, l, q);
  const assertReservado: Ctx["assertReservado"] = (sku, g, l, q) => A.assertReservado(sb, sku, g, l, q);
  const assertMovsCount: Ctx["assertMovsCount"] = (sku, c) => A.assertMovsCount(sb, sku, c);
  const assertPedidoStatus: Ctx["assertPedidoStatus"] = (id, s) => A.assertPedidoStatus(sb, id, s);
  const assertCustoMedio: Ctx["assertCustoMedio"] = (sku, c, tol) => A.assertCustoMedio(sb, sku, c, tol);
  const assertSemReservasOrfas: Ctx["assertSemReservasOrfas"] = () => A.assertSemReservasOrfas(sb);

  return {
    sb, http, staging, log, skuUnico, correlationId, aguardar,
    criarProduto, criarLocalizacao, criarFornecedor, semearSaldo,
    webhook, aprovar, iniciarSeparacao, bipar, parcial, desfazerParcial, encaminhar,
    concluirSeparacao, embalar, expedir,
    aguardarStatus, aguardarStatusSeparacao, aguardarRealocacao, aguardarFilaVazia,
    comprar, receberCompra, prepararEmbalagem, receber, guardar, desfazerGuarda, aguardarPendenciaGuarda,
    transferirGalpao, replenishment, ajusteManual, lancamentoRetroativo, reconciliarRetroativo,
    criarVendaDireta, disponibilidadeVenda, cancelarVenda,
    reservar, cleanupReservas,
    classificarDevolucao, desclassificarDevolucao,
    criarSessaoInventario, entrarParty, proximaLoc, bipeInventario, finalizarLocInventario, aprovarInventario, aplicarInventario, estornarInventario,
    assertSaldo, assertReservado, assertMovsCount, assertPedidoStatus, assertCustoMedio, assertSemReservasOrfas,
  } as Ctx;
}
