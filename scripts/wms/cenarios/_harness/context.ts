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
    await http.post("/api/wms/pedidos/aprovar", { pedido_id: pedidoId, decisao });
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
    await http.post("/api/wms/separacao/parcial", { pedido_id: p.pedido, sku: p.item, quantidade: p.qty, loc_zerou: p.loc_zerou });
  }

  async function desfazerParcial(p: { pedido: string; item: string }) {
    await http.post("/api/wms/separacao/desfazer-parcial", { pedido_id: p.pedido, sku: p.item });
  }

  async function encaminhar(p: { pedido: string; item: string; galpao_destino: "CWB" | "SP" }) {
    const galpao_id = staging.galpoes[p.galpao_destino.toLowerCase() as "cwb" | "sp"].id;
    await http.post("/api/wms/separacao/encaminhar", { pedido_id: p.pedido, sku: p.item, galpao_destino_id: galpao_id });
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
    const timeout = opts.timeout_ms ?? 5_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { data } = await sb
        .from("siso_pedido_item_realocacoes")
        .select("id, localizacao:siso_localizacoes!inner(codigo), produto:siso_produtos!inner(sku)")
        .eq("pedido_id", pedidoId)
        .eq("siso_produtos.sku", sku)
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
  async function comprar(p: { sku: string; qty: number; fornecedor?: string }) {
    const res = await http.post<{ ordem_id: string }>("/api/wms/compras/comprar", {
      sku: p.sku,
      quantidade: p.qty,
      fornecedor_nome: p.fornecedor ?? "TestSupplier-Default",
    });
    return res;
  }

  async function receberCompra(p: { ordem_id: string; items: { sku: string; qty: number }[] }) {
    await http.post(`/api/wms/compras/conferencia/${p.ordem_id}`, {
      itens: p.items.map((it) => ({ sku: it.sku, quantidade: it.qty })),
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
        return { produto_id: prod!.id, qty: it.qty, localizacao_destino_id: loc_destino_id };
      }),
    );
    const res = await http.post<{ pendencias: string[] }>("/api/wms/receber", {
      galpao_id,
      itens,
      entrada_direta: p.entrada_direta ?? false,
    });
    return res;
  }

  async function guardar(p: { pendencia_id: string; loc_destino: string; qty?: number }) {
    const { data: pend } = await sb.from("siso_wms_pendencias_guarda").select("galpao_id").eq("id", p.pendencia_id).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", (pend as { galpao_id: string }).galpao_id).eq("codigo", p.loc_destino).single();
    await http.post(`/api/wms/guarda/${p.pendencia_id}/confirmar`, {
      localizacao_destino_id: loc!.id,
      quantidade: p.qty,
    });
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
    const origem_id = staging.galpoes[p.origem.toLowerCase() as "cwb" | "sp"].id;
    const destino_id = staging.galpoes[p.destino.toLowerCase() as "cwb" | "sp"].id;
    const itens = await Promise.all(p.items.map(async (it) => {
      const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", it.sku).single();
      return { produto_id: prod!.id, qty: it.qty };
    }));
    return http.post<{ id: string }>("/api/wms/transferir-galpao", { origem_id, destino_id, itens });
  }

  async function replenishment(p: { sku: string; galpao: "CWB" | "SP"; origem_loc: string; destino_loc: string; qty: number }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: orig } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.origem_loc).single();
    const { data: dest } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.destino_loc).single();
    await http.post("/api/wms/replenishment", {
      produto_id: prod!.id,
      origem_localizacao_id: orig!.id,
      destino_localizacao_id: dest!.id,
      quantidade: p.qty,
    });
  }

  async function ajusteManual(p: { sku: string; galpao: "CWB" | "SP"; loc: string; delta: number; motivo: string }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    await http.post("/api/wms/ajuste", {
      produto_id: prod!.id,
      galpao_id,
      localizacao_id: loc!.id,
      delta: p.delta,
      motivo: p.motivo,
    });
  }

  async function lancamentoRetroativo(p: { sku: string; galpao: "CWB" | "SP"; loc: string; qty: number; tipo: "E" | "S" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: prod } = await sb.from("siso_produtos").select("id").eq("sku", p.sku).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", galpao_id).eq("codigo", p.loc).single();
    return http.post<{ id: string }>("/api/wms/lancamento-retroativo", {
      produto_id: prod!.id,
      galpao_id,
      localizacao_id: loc!.id,
      quantidade: p.qty,
      tipo: p.tipo,
    });
  }

  async function reconciliarRetroativo(id: string) {
    await http.post(`/api/wms/lancamento-retroativo/${id}/reconciliar`);
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
      { galpao_id, empresa_origem_id, items: itens, modo: p.modo },
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
    const ttl_horas = p.ttl_horas ?? (p.ttl_segundos ? p.ttl_segundos / 3600 : 48);
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
    return http.get<{ liberadas: number }>("/api/wms/reservas/cleanup");
  }

  // ── devoluções ──
  async function classificarDevolucao(p: { devolucao_id: string; classificacao: "A" | "B" | "C" | "D" }) {
    await http.post(`/api/wms/devolucoes/${p.devolucao_id}/classificar`, { classificacao: p.classificacao });
  }

  // ── inventário ──
  async function criarSessaoInventario(p: { galpao: "CWB" | "SP"; locs: string[]; modo?: "blind" | "aberto"; tipo?: "cycle_count" | "completo" }) {
    const galpao_id = staging.galpoes[p.galpao.toLowerCase() as "cwb" | "sp"].id;
    const { data: locs } = await sb.from("siso_localizacoes").select("id, codigo").eq("galpao_id", galpao_id).in("codigo", p.locs);
    const loc_ids = (locs ?? []).map((l: { id: string }) => l.id);
    const res = await http.post<{ id: string }>("/api/wms/inventario", {
      galpao_id,
      localizacoes_ids: loc_ids,
      modo: p.modo ?? "blind",
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
    await http.post(`/api/wms/inventario/${p.sessao_id}/contagens`, {
      produto_id: prod!.id,
      localizacao_id: loc!.id,
      quantidade: p.qty,
    });
  }

  async function finalizarLocInventario(p: { sessao_id: string; loc: string }) {
    const { data: sess } = await sb.from("siso_inventario_sessoes").select("galpao_id").eq("id", p.sessao_id).single();
    const { data: loc } = await sb.from("siso_localizacoes").select("id").eq("galpao_id", (sess as { galpao_id: string }).galpao_id).eq("codigo", p.loc).single();
    await http.post(`/api/wms/inventario/${p.sessao_id}/localizacoes/${loc!.id}/finalizar`);
  }

  async function aprovarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aprovar`);
  }

  async function aplicarInventario(sessaoId: string) {
    await http.post(`/api/wms/inventario/${sessaoId}/aplicar`);
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
    comprar, receberCompra, prepararEmbalagem, receber, guardar, aguardarPendenciaGuarda,
    transferirGalpao, replenishment, ajusteManual, lancamentoRetroativo, reconciliarRetroativo,
    criarVendaDireta, disponibilidadeVenda,
    reservar, cleanupReservas,
    classificarDevolucao,
    criarSessaoInventario, entrarParty, proximaLoc, bipeInventario, finalizarLocInventario, aprovarInventario, aplicarInventario,
    assertSaldo, assertReservado, assertMovsCount, assertPedidoStatus, assertCustoMedio, assertSemReservasOrfas,
  } as Ctx;
}
