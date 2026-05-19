/**
 * POST /api/wms/vendas/criar
 *
 * Cria um pedido de venda manual inserido por um vendedor (ou admin/operador).
 *
 * O vendedor escolhe **galpão único pro pedido** (contexto físico — ele está
 * num balcão). Empresa dona e localização específica são **resolvidas
 * automaticamente** server-side via `resolverDisponibilidadeVenda` (não vêm
 * mais do request).
 *
 * Modos:
 *
 *  - `modo="separacao"`: pedido entra no fluxo wave picking normal pulando
 *    NF (status='executando', status_separacao='aguardando_separacao').
 *    Operador resolve loc/qty no pick.
 *
 *  - `modo="baixa_direta"`: pra cada item, resolve quadrupla via
 *    `resolverDisponibilidadeVenda` e gera mov 'S' no ledger WMS
 *    (origem_tipo='venda_manual'). Pedido fica status='concluido'
 *    status_separacao=NULL.
 *
 * **Degradação**: se vendedor pediu `baixa_direta` mas qualquer item não tem
 * saldo suficiente no galpão escolhido, o pedido inteiro é criado em modo
 * separação (status_separacao='aguardando_separacao') — segue o fluxo de
 * fila como pedido de marketplace sem estoque. Resposta inclui
 * `degradado: true, motivo_degradacao: 'falta_saldo', skus_sem_saldo: [...]`.
 *
 * Rollback de baixa direta: se mov N falhar mid-flight, estorna as
 * anteriores via estornarMovimentacao + deleta o pedido recém-criado.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { inserirMovimentacao, estornarMovimentacao } from "@/lib/wms/ledger";
import { registrarEvento } from "@/lib/historico-service";
import { resolverDisponibilidadeVenda } from "@/lib/wms/vendas-disponibilidade";
import type {
  CriarVendaDiretaRequest,
  CriarVendaDiretaResponse,
  ModoVendaDireta,
} from "@/types";

interface ItemResolvido {
  produto_id: string; // uuid em siso_produtos
  tiny_produto_id: number; // bigint do mapping siso_produto_empresas
  sku: string;
  descricao: string;
  quantidade: number;
  // Resolvidos via resolverDisponibilidadeVenda (null se não tem saldo)
  empresa_dona_id: string | null;
  localizacao_id: string | null;
  localizacao_codigo: string | null;
  disponivel: number;
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

  const {
    cliente_nome,
    cliente_cpf_cnpj,
    canal_venda,
    empresa_origem_id,
    galpao_id,
    modo,
    items,
    idempotency_key,
  } = body;

  if (!cliente_nome?.trim()) {
    return NextResponse.json({ erro: "cliente_nome é obrigatório" }, { status: 400 });
  }
  if (!empresa_origem_id) {
    return NextResponse.json({ erro: "empresa_origem_id é obrigatório" }, { status: 400 });
  }
  if (!galpao_id) {
    return NextResponse.json({ erro: "galpao_id é obrigatório" }, { status: 400 });
  }
  if (modo !== "separacao" && modo !== "baixa_direta") {
    return NextResponse.json(
      { erro: "modo deve ser 'separacao' ou 'baixa_direta'" },
      { status: 400 },
    );
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
      } satisfies CriarVendaDiretaResponse);
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

  // Resolve empresa origem + nome do galpão escolhido
  const { data: empresa } = await supabase
    .from("siso_empresas")
    .select("id, nome")
    .eq("id", empresa_origem_id)
    .single();

  if (!empresa) {
    return NextResponse.json({ erro: "empresa_origem_id inválido" }, { status: 400 });
  }

  const { data: galpao } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("id", galpao_id)
    .single();

  if (!galpao) {
    return NextResponse.json({ erro: "galpao_id inválido" }, { status: 400 });
  }
  const galpaoNome = galpao.nome;

  // Resolve disponibilidade por item — paralelo
  const itensResolvidos: ItemResolvido[] = await Promise.all(
    items.map(async (item) => {
      const prod = prodMap.get(item.produto_id);
      const tinyId = mapMap.get(item.produto_id);
      if (!prod) {
        throw new Error(`Produto ${item.produto_id} não encontrado no catálogo`);
      }
      if (!tinyId) {
        throw new Error(
          `Produto ${prod.sku} não está cadastrado na empresa origem — peça pro admin sincronizar via Tiny`,
        );
      }
      const dispon = await resolverDisponibilidadeVenda(supabase as never, {
        produto_id: item.produto_id,
        galpao_id,
        empresa_origem_id,
      });
      return {
        produto_id: item.produto_id,
        tiny_produto_id: tinyId,
        sku: prod.sku,
        descricao: prod.descricao,
        quantidade: item.quantidade,
        empresa_dona_id: dispon.sugestao?.empresa_dona_id ?? null,
        localizacao_id: dispon.sugestao?.localizacao_id ?? null,
        localizacao_codigo: dispon.sugestao?.localizacao_codigo ?? null,
        disponivel: dispon.total_disponivel,
      };
    }),
  ).catch((err) => {
    throw err;
  });

  // Detecta falta de saldo: items cuja quantidade pedida excede o disponível
  // total no galpão escolhido (independente de qual loc/dona).
  const itensSemSaldo = itensResolvidos.filter((i) => i.quantidade > i.disponivel);
  const todasComSaldo = itensSemSaldo.length === 0;

  // Decisão final de modo (degradação automática)
  let modoEfetivo: ModoVendaDireta = modo;
  let degradado = false;
  if (modo === "baixa_direta" && !todasComSaldo) {
    modoEfetivo = "separacao";
    degradado = true;
    logger.warn("vendas.criar", "Baixa direta degradada pra separação por falta de saldo", {
      empresa_origem_id,
      galpao_id,
      skus_sem_saldo: itensSemSaldo.map((i) => i.sku),
    });
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
    separacao_galpao_id: galpao_id,
    marcadores: ["LVR", "VENDA_DIRETA"],
    payload_original: idempotency_key
      ? { idempotency_key, manual: true, modo_solicitado: modo, degradado }
      : { manual: true, modo_solicitado: modo, degradado },
    ...(modoEfetivo === "separacao"
      ? { status: "executando", status_separacao: "aguardando_separacao" }
      : { status: "concluido", status_separacao: null, processado_em: agora }),
  };

  const { error: pedidoErr } = await supabase.from("siso_pedidos").insert(pedidoRow);
  if (pedidoErr) {
    logger.error("vendas.criar", "Falha ao inserir pedido", { error: pedidoErr.message, pedidoId });
    return NextResponse.json(
      { erro: "Falha ao criar pedido", detalhe: pedidoErr.message },
      { status: 500 },
    );
  }

  // 2) Insert siso_pedido_itens (bulk)
  const itensRows = itensResolvidos.map((i) => ({
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
    await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
    logger.error("vendas.criar", "Falha ao inserir itens", { error: itensErr.message, pedidoId });
    return NextResponse.json(
      { erro: "Falha ao inserir itens", detalhe: itensErr.message },
      { status: 500 },
    );
  }

  // 3) Se modoEfetivo === 'baixa_direta', gera movs 'S' no ledger com rollback manual
  const movsCriadas: string[] = [];
  if (modoEfetivo === "baixa_direta") {
    for (const item of itensResolvidos) {
      // Aqui já garantimos que tem saldo (senão modoEfetivo seria 'separacao').
      // Mas localizacao_id/empresa_dona_id devem existir — se não, é bug interno.
      if (!item.empresa_dona_id || !item.localizacao_id) {
        logger.error("vendas.criar", "Item sem quadrupla resolvida em baixa_direta — inconsistência", {
          pedidoId,
          sku: item.sku,
        });
        for (const movId of movsCriadas) {
          try {
            await estornarMovimentacao({
              mov_id: movId,
              usuario_id: user.id,
              observacoes: `Rollback de venda manual ${pedidoId} (quadrupla inconsistente)`,
            });
          } catch {}
        }
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
        return NextResponse.json(
          { erro: `Falha interna: quadrupla não resolvida pra ${item.sku}` },
          { status: 500 },
        );
      }

      try {
        const mov = await inserirMovimentacao({
          quadrupla: {
            produto_id: item.produto_id,
            empresa_dona_id: item.empresa_dona_id,
            galpao_id: galpao_id,
            localizacao_id: item.localizacao_id,
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
            loc_codigo: item.localizacao_codigo,
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
      modo_solicitado: modo,
      modo_efetivo: modoEfetivo,
      degradado,
      cliente_nome,
      empresa_origem_id,
      galpao_id,
      galpao: galpaoNome,
      items_count: itensResolvidos.length,
      canal_venda: canal_venda ?? null,
      ...(degradado ? { skus_sem_saldo: itensSemSaldo.map((i) => i.sku) } : {}),
    },
  }).catch(() => {});

  if (modoEfetivo === "baixa_direta") {
    registrarEvento({
      pedidoId,
      evento: "venda_baixa_direta_executada",
      usuarioId: user.id,
      usuarioNome: user.nome,
      detalhes: { movs_count: movsCriadas.length },
    }).catch(() => {});
  }

  const response: CriarVendaDiretaResponse = {
    pedido_id: pedidoId,
    numero,
    status: modoEfetivo === "separacao" ? "executando" : "concluido",
    status_separacao: modoEfetivo === "separacao" ? "aguardando_separacao" : null,
    movs_criadas: movsCriadas.length > 0 ? movsCriadas.length : undefined,
    ...(degradado
      ? {
          degradado: true,
          motivo_degradacao: "falta_saldo" as const,
          skus_sem_saldo: itensSemSaldo.map((i) => i.sku),
        }
      : {}),
  };

  return NextResponse.json(response);
}
