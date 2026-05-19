/**
 * POST /api/wms/vendas/criar
 *
 * Cria um pedido de venda manual inserido por um vendedor (ou admin/operador).
 * Dois caminhos:
 *
 *  - modo="separacao": pedido entra no fluxo wave picking normal pulando NF
 *    (status='executando', status_separacao='aguardando_separacao').
 *
 *  - modo="baixa_direta": pra cada item, gera mov 'S' no ledger WMS via
 *    wms_inserir_movimentacao (origem_tipo='venda_manual'). Pedido fica
 *    status='concluido' status_separacao=NULL. Vendedor escolhe quadrupla
 *    (produto + dona + galpão + localização) exata pra cada item.
 *
 * Rollback de baixa direta: se mov N falhar, estorna as anteriores via
 * estornarMovimentacao + deleta o pedido recém-criado.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import type { CriarVendaDiretaRequest } from "@/types";

interface ItemValidado {
  produto_id: string; // uuid em siso_produtos
  tiny_produto_id: number; // bigint do mapping siso_produto_empresas
  sku: string;
  descricao: string;
  quantidade: number;
  // Só pra baixa_direta:
  galpao_id?: string;
  localizacao_id?: string;
  empresa_dona_id?: string;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida ou expirada" }, { status: 401 });
  }

  let body: CriarVendaDiretaRequest;
  try {
    body = (await request.json()) as CriarVendaDiretaRequest;
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { cliente_nome, cliente_cpf_cnpj, canal_venda, empresa_origem_id, modo, items, idempotency_key } = body;

  if (!cliente_nome?.trim()) {
    return NextResponse.json({ erro: "cliente_nome é obrigatório" }, { status: 400 });
  }
  if (!empresa_origem_id) {
    return NextResponse.json({ erro: "empresa_origem_id é obrigatório" }, { status: 400 });
  }
  if (modo !== "separacao" && modo !== "baixa_direta") {
    return NextResponse.json({ erro: "modo deve ser 'separacao' ou 'baixa_direta'" }, { status: 400 });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ erro: "items vazio" }, { status: 400 });
  }
  for (const [i, item] of items.entries()) {
    if (!item.produto_id) {
      return NextResponse.json({ erro: `items[${i}].produto_id ausente` }, { status: 400 });
    }
    if (!item.quantidade || item.quantidade <= 0) {
      return NextResponse.json({ erro: `items[${i}].quantidade inválida` }, { status: 400 });
    }
    if (modo === "baixa_direta") {
      if (!item.galpao_id || !item.localizacao_id || !item.empresa_dona_id) {
        return NextResponse.json(
          { erro: `items[${i}]: baixa_direta exige galpao_id, localizacao_id e empresa_dona_id` },
          { status: 400 },
        );
      }
    }
  }

  const supabase = createServiceClient();

  // Idempotência: se mesmo idempotency_key já foi processado, retorna o pedido existente
  if (idempotency_key) {
    const { data: existente } = await supabase
      .from("siso_pedidos")
      .select("id, numero, status, status_separacao")
      .eq("payload_original->>idempotency_key", idempotency_key)
      .eq("origem_pedido", "manual")
      .maybeSingle();
    if (existente) {
      return NextResponse.json({
        pedido_id: existente.id,
        numero: existente.numero,
        status: existente.status,
        status_separacao: existente.status_separacao,
        idempotente: true,
      });
    }
  }

  // Resolve mapping produto_wms → tiny_produto_id (necessário pra siso_pedido_itens.produto_id)
  const produtoIds = items.map((i) => i.produto_id);
  const { data: mapeamentos, error: mapErr } = await supabase
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresa_origem_id)
    .in("produto_id", produtoIds);

  if (mapErr) {
    logger.error("vendas.criar", "Erro lendo siso_produto_empresas", { error: mapErr.message });
    return NextResponse.json({ erro: "Erro lendo mapeamento de produtos" }, { status: 500 });
  }

  const mapMap = new Map<string, number>(
    (mapeamentos ?? []).map((m) => [String(m.produto_id), Number(m.tiny_produto_id)]),
  );

  // Resolve dados dos produtos (sku, descricao)
  const { data: produtos, error: prodErr } = await supabase
    .from("siso_produtos")
    .select("id, sku, descricao")
    .in("id", produtoIds);

  if (prodErr) {
    logger.error("vendas.criar", "Erro lendo siso_produtos", { error: prodErr.message });
    return NextResponse.json({ erro: "Erro lendo catálogo de produtos" }, { status: 500 });
  }

  const prodMap = new Map<string, { sku: string; descricao: string }>(
    (produtos ?? []).map((p) => [String(p.id), { sku: p.sku, descricao: p.descricao }]),
  );

  // Validate items: mapping exists + produto exists
  const itensValidados: ItemValidado[] = [];
  for (const item of items) {
    const prod = prodMap.get(item.produto_id);
    const tinyId = mapMap.get(item.produto_id);
    if (!prod) {
      return NextResponse.json(
        { erro: `Produto ${item.produto_id} não encontrado no catálogo` },
        { status: 400 },
      );
    }
    if (!tinyId) {
      return NextResponse.json(
        {
          erro: `Produto ${prod.sku} não está cadastrado na empresa origem — peça pro admin sincronizar via Tiny`,
          sku: prod.sku,
        },
        { status: 400 },
      );
    }
    itensValidados.push({
      produto_id: item.produto_id,
      tiny_produto_id: tinyId,
      sku: prod.sku,
      descricao: prod.descricao,
      quantidade: item.quantidade,
      galpao_id: item.galpao_id,
      localizacao_id: item.localizacao_id,
      empresa_dona_id: item.empresa_dona_id,
    });
  }

  // Resolve empresa origem + nome do galpão preferencial
  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select("id, nome")
    .eq("id", empresa_origem_id)
    .single();

  if (!empresa) {
    return NextResponse.json({ erro: "empresa_origem_id inválido" }, { status: 400 });
  }

  // Resolve galpão pra separação:
  //   - baixa_direta: usa galpão do primeiro item (não importa muito, é só pra display)
  //   - separação: primeiro galpão preferencial da empresa
  let separacaoGalpaoId: string | null = null;
  let galpaoNome: string | null = null;
  if (modo === "baixa_direta" && itensValidados[0]?.galpao_id) {
    separacaoGalpaoId = itensValidados[0].galpao_id;
  } else {
    const { data: pref } = await supabase
      .from("siso_empresa_galpoes_preferenciais")
      .select("galpao_id, siso_galpoes!inner(id, nome)")
      .eq("empresa_id", empresa_origem_id)
      .limit(1)
      .maybeSingle();
    if (pref) {
      separacaoGalpaoId = pref.galpao_id;
    }
  }
  if (separacaoGalpaoId) {
    const { data: g } = await supabase
      .from("siso_galpoes")
      .select("nome")
      .eq("id", separacaoGalpaoId)
      .single();
    galpaoNome = g?.nome ?? null;
  }

  if (!separacaoGalpaoId || !galpaoNome) {
    return NextResponse.json(
      { erro: "Empresa origem sem galpão preferencial e nenhum galpão informado nos items" },
      { status: 400 },
    );
  }

  // Gera ID do pedido com prefixo MAN-
  const pedidoId = `MAN-${crypto.randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
  const numero = pedidoId;
  const agora = new Date().toISOString();

  // 1) Insert siso_pedidos
  const pedidoRow = {
    id: pedidoId,
    numero,
    data: agora,
    filial_origem: galpaoNome,
    empresa_origem_id,
    cliente_nome,
    cliente_cpf_cnpj: cliente_cpf_cnpj ?? null,
    canal_venda: canal_venda ?? null,
    vendedor_id: user.id,
    vendedor_nome: user.nome,
    origem_pedido: "manual",
    tipo_resolucao: "manual",
    decisao_final: "propria",
    nome_ecommerce: null,
    separacao_galpao_id: separacaoGalpaoId,
    marcadores: ["LVR", "VENDA_DIRETA"],
    payload_original: idempotency_key ? { idempotency_key, manual: true } : { manual: true },
    ...(modo === "separacao"
      ? { status: "executando", status_separacao: "aguardando_separacao" }
      : { status: "concluido", status_separacao: null, processado_em: agora }),
  };

  const { error: pedidoErr } = await supabase.from("siso_pedidos").insert(pedidoRow);
  if (pedidoErr) {
    logger.error("vendas.criar", "Falha ao inserir pedido", { error: pedidoErr.message, pedidoId });
    return NextResponse.json({ erro: "Falha ao criar pedido", detalhe: pedidoErr.message }, { status: 500 });
  }

  // 2) Insert siso_pedido_itens (bulk)
  const itensRows = itensValidados.map((i) => ({
    pedido_id: pedidoId,
    produto_id: i.tiny_produto_id,
    sku: i.sku,
    descricao: i.descricao,
    quantidade_pedida: i.quantidade,
    cwb_atende: galpaoNome === "CWB",
    sp_atende: galpaoNome === "SP",
  }));

  const { error: itensErr } = await supabase.from("siso_pedido_itens").insert(itensRows);
  if (itensErr) {
    // Rollback pedido
    await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
    logger.error("vendas.criar", "Falha ao inserir itens", { error: itensErr.message, pedidoId });
    return NextResponse.json({ erro: "Falha ao inserir itens", detalhe: itensErr.message }, { status: 500 });
  }

  // 3) Se baixa_direta, gera movs 'S' no ledger com rollback manual
  const movsCriadas: string[] = [];
  if (modo === "baixa_direta") {
    for (const item of itensValidados) {
      try {
        const mov = await inserirMovimentacao({
          quadrupla: {
            produto_id: item.produto_id,
            empresa_dona_id: item.empresa_dona_id!,
            galpao_id: item.galpao_id!,
            localizacao_id: item.localizacao_id!,
          },
          tipo: "S",
          qty: item.quantidade,
          origem_tipo: "venda_manual",
          origem_id: pedidoId,
          origem_detalhes: {
            pedido_id: pedidoId,
            sku: item.sku,
            vendedor_id: user.id,
            vendedor_nome: user.nome,
            cliente_nome,
            canal_venda: canal_venda ?? null,
          },
          usuario_id: user.id,
          observacoes: `Venda manual ${pedidoId} — ${cliente_nome}`,
        });
        movsCriadas.push(mov.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("vendas.criar", "Falha em mov de baixa direta — fazendo rollback", {
          pedidoId,
          sku: item.sku,
          erro: msg,
          movs_pra_estornar: movsCriadas,
        });

        // Rollback das movs anteriores
        for (const movId of movsCriadas) {
          try {
            await estornarMovimentacao({
              mov_id: movId,
              usuario_id: user.id,
              observacoes: `Rollback de venda manual ${pedidoId} (falha em outro item)`,
            });
          } catch (estornoErr) {
            logger.error("vendas.criar", "Falha no rollback de mov — DADOS POSSIVELMENTE INCONSISTENTES", {
              pedidoId,
              mov_id: movId,
              erro: estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
            });
          }
        }

        // Apaga itens e pedido
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);

        return NextResponse.json(
          {
            erro: `Falha ao baixar ${item.sku}: ${msg}`,
            sku: item.sku,
            movs_estornadas: movsCriadas.length,
          },
          { status: 409 },
        );
      }
    }
  }

  // 4) Audit
  registrarEvento({
    pedidoId,
    evento: "venda_criada_manual",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      modo,
      cliente_nome,
      empresa_origem_id,
      galpao: galpaoNome,
      items_count: itensValidados.length,
      canal_venda: canal_venda ?? null,
    },
  }).catch(() => {});

  if (modo === "baixa_direta") {
    registrarEvento({
      pedidoId,
      evento: "venda_baixa_direta_executada",
      usuarioId: user.id,
      usuarioNome: user.nome,
      detalhes: { movs_count: movsCriadas.length },
    }).catch(() => {});
  }

  return NextResponse.json({
    pedido_id: pedidoId,
    numero,
    status: modo === "separacao" ? "executando" : "concluido",
    status_separacao: modo === "separacao" ? "aguardando_separacao" : null,
    movs_criadas: movsCriadas.length > 0 ? movsCriadas : undefined,
  });
}
