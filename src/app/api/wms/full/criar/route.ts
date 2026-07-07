/**
 * POST /api/wms/full/criar
 *
 * Cria um pedido **Full**: envio de estoque ao CDF do Mercado Livre, sem
 * pedido-fantasma no Tiny. Rota isolada de `/api/wms/vendas/criar` (zero risco
 * no hot-path de venda) — reusa as MESMAS primitivas de resolução/reserva.
 *
 * Sempre modo "separação" (nunca baixa_direta): reserva o que der (parcial se
 * faltar saldo) e o operador resolve o resto no picking da lane Full
 * (`/wms/separacao-full`). Sem NF, sem Tiny — `empresa_origem_id` é a conta ML
 * amarrada ao envio.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { userCan } from "@/lib/permissions";
import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
import { registrarEvento } from "@/lib/historico-service";
import {
  resolverDisponibilidadeVenda,
  type DisponibilidadeSugestao,
} from "@/lib/wms/vendas-disponibilidade";
import { MARCADOR_FULL } from "@/lib/wms/separacao-full";
import { expandirItensVenda } from "@/lib/wms/kits";

interface CriarFullRequestItem {
  produto_id: string;
  quantidade: number;
}

interface CriarFullRequest {
  empresa_origem_id: string;
  galpao_id: string;
  items: CriarFullRequestItem[];
  idempotency_key?: string;
  /**
   * "Separar na ordem da lista": preserva cada linha como digitada — 2 linhas
   * do MESMO produto viram 2 rows em siso_pedido_itens (coluna `linha` 1..N
   * por produto), espelhando a lista do envio Full do ML no checklist.
   * Default false = soma duplicatas numa linha só (comportamento clássico).
   */
  preservar_linhas?: boolean;
}

interface ItemResolvido {
  produto_id: string;
  tiny_produto_id: number;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  quantidade: number;
  disponivel: number;
  sugestoes: DisponibilidadeSugestao[];
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida ou expirada" }, { status: 401 });
  }
  if (!userCan(user, "vendas.criar")) {
    return NextResponse.json({ erro: "forbidden — requer vendas.criar" }, { status: 403 });
  }

  let body: CriarFullRequest;
  try {
    body = (await request.json()) as CriarFullRequest;
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { empresa_origem_id, galpao_id, items, idempotency_key } = body;
  const preservarLinhas = body.preservar_linhas === true;

  if (!empresa_origem_id) {
    return NextResponse.json({ erro: "empresa_origem_id é obrigatório" }, { status: 400 });
  }
  if (!galpao_id) {
    return NextResponse.json({ erro: "galpao_id é obrigatório" }, { status: 400 });
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

  // Desmembra kits ANTES de qualquer dedupe: linha de kit vira N linhas de
  // componente na posição da linha original (kit pai não tem saldo em
  // siso_estoque). Kit sem composição mantém a linha (warn no helper).
  const itemsExpandidos = await expandirItensVenda(items);

  // Agregado por produto — SEMPRE usado pra resolução e reserva (a R vive por
  // tripla (pedido, produto, galpão, loc), nunca por linha — gotcha #16).
  const itemsDeduped = Array.from(
    itemsExpandidos
      .reduce((acc, it) => {
        const prev = acc.get(it.produto_id);
        acc.set(it.produto_id, {
          produto_id: it.produto_id,
          quantidade: (prev?.quantidade ?? 0) + it.quantidade,
        });
        return acc;
      }, new Map<string, { produto_id: string; quantidade: number }>())
      .values(),
  );

  // Linhas que viram rows em siso_pedido_itens: com preservar_linhas cada
  // linha digitada sobrevive (2 itens iguais = 2 rows, `linha` 1..N por
  // produto); sem, o agregado (comportamento clássico, linha=1).
  const itemsLinhas = preservarLinhas ? itemsExpandidos : itemsDeduped;

  const supabase = createServiceClient();

  // Idempotência: mesmo idempotency_key já processado (e não cancelado) retorna
  // o Full existente em vez de duplicar.
  if (idempotency_key) {
    const { data: existente } = await supabase
      .from("siso_pedidos")
      .select("id, numero, status, status_separacao")
      .eq("payload_original->>idempotency_key", idempotency_key)
      .eq("separacao_full", true)
      .neq("status", "cancelado")
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
  const produtoIds = itemsDeduped.map((i) => i.produto_id);
  const { data: mapeamentos, error: mapErr } = await supabase
    .from("siso_produto_empresas")
    .select("produto_id, tiny_produto_id")
    .eq("empresa_id", empresa_origem_id)
    .in("produto_id", produtoIds);

  if (mapErr) {
    logger.error("full.criar", "Erro lendo siso_produto_empresas", { error: mapErr.message });
    return NextResponse.json({ erro: "Erro lendo mapeamento de produtos" }, { status: 500 });
  }

  const mapMap = new Map<string, number>(
    (mapeamentos ?? []).map((m) => [String(m.produto_id), Number(m.tiny_produto_id)]),
  );

  const { data: produtos, error: prodErr } = await supabase
    .from("siso_produtos")
    .select("id, sku, descricao, imagem_url")
    .in("id", produtoIds);

  if (prodErr) {
    logger.error("full.criar", "Erro lendo siso_produtos", { error: prodErr.message });
    return NextResponse.json({ erro: "Erro lendo catálogo de produtos" }, { status: 500 });
  }

  const prodMap = new Map<string, { sku: string; descricao: string; imagem_url: string | null }>(
    (produtos ?? []).map((p) => [
      String(p.id),
      { sku: p.sku, descricao: p.descricao, imagem_url: p.imagem_url ?? null },
    ]),
  );

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

  type ResolverError = {
    codigo: "PRODUTO_NAO_ENCONTRADO" | "PRODUTO_NAO_MAPEADO";
    sku: string | null;
    produto_id: string;
    mensagem: string;
  };
  type ResolvedResult =
    | { ok: true; data: ItemResolvido }
    | { ok: false; error: ResolverError };

  const resolvedResults: ResolvedResult[] = await Promise.all(
    itemsDeduped.map(async (item): Promise<ResolvedResult> => {
      const prod = prodMap.get(item.produto_id);
      const tinyId = mapMap.get(item.produto_id);
      if (!prod) {
        return {
          ok: false,
          error: {
            codigo: "PRODUTO_NAO_ENCONTRADO",
            sku: null,
            produto_id: item.produto_id,
            mensagem: `Produto ${item.produto_id} não encontrado no catálogo`,
          },
        };
      }
      if (!tinyId) {
        return {
          ok: false,
          error: {
            codigo: "PRODUTO_NAO_MAPEADO",
            sku: prod.sku,
            produto_id: item.produto_id,
            mensagem: `Produto ${prod.sku} não está cadastrado na empresa origem (${empresa.nome})`,
          },
        };
      }
      const dispon = await resolverDisponibilidadeVenda(supabase as never, {
        produto_id: item.produto_id,
        galpao_id,
      });
      return {
        ok: true,
        data: {
          produto_id: item.produto_id,
          tiny_produto_id: tinyId,
          sku: prod.sku,
          descricao: prod.descricao,
          imagem_url: prod.imagem_url,
          quantidade: item.quantidade,
          disponivel: dispon.total_disponivel,
          sugestoes: dispon.sugestoes,
        },
      };
    }),
  );

  const primeiroErro = resolvedResults.find((r) => !r.ok);
  if (primeiroErro && !primeiroErro.ok) {
    return NextResponse.json(
      {
        codigo: primeiroErro.error.codigo,
        sku: primeiroErro.error.sku,
        produto_id: primeiroErro.error.produto_id,
        erro: primeiroErro.error.mensagem,
      },
      { status: 400 },
    );
  }

  const itensResolvidos: ItemResolvido[] = resolvedResults
    .filter((r): r is { ok: true; data: ItemResolvido } => r.ok)
    .map((r) => r.data);

  const pedidoId = `FULL-${crypto.randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
  const numero = pedidoId;
  const agora = new Date().toISOString();

  const payloadBase: Record<string, unknown> = {
    full: true,
    ...(preservarLinhas ? { preservar_linhas: true } : {}),
  };

  const pedidoRow = {
    id: pedidoId,
    numero,
    data: agora,
    filial_origem: galpaoNome,
    // Full não tem cliente (é envio interno ao CDF do ML). `cliente_nome` é
    // NOT NULL no schema → sentinela amarrada à conta ML (empresa) do envio.
    cliente_nome: `FULL — ${empresa.nome}`,
    empresa_origem_id,
    origem_pedido: "manual",
    tipo_resolucao: "manual",
    decisao_final: "propria",
    nome_ecommerce: null,
    separacao_galpao_id: galpao_id,
    separacao_full: true,
    marcadores: ["WMS", MARCADOR_FULL],
    payload_original: idempotency_key
      ? { ...payloadBase, idempotency_key }
      : payloadBase,
    status: "executando",
    status_separacao: "aguardando_separacao",
  };

  const { error: pedidoErr } = await supabase.from("siso_pedidos").insert(pedidoRow);
  if (pedidoErr) {
    logger.error("full.criar", "Falha ao inserir pedido", { error: pedidoErr.message, pedidoId });
    return NextResponse.json(
      { erro: "Falha ao criar pedido", detalhe: pedidoErr.message },
      { status: 500 },
    );
  }

  // Itens gravam ordem_full sequencial (1..N) pela ordem de inserção — o
  // checklist ordena por isso por default na lane Full. `linha` conta a
  // ocorrência do produto (1..N) — só passa de 1 com preservar_linhas, e é o
  // que satisfaz o índice único (pedido_id, produto_id, linha).
  const resolvidoPorProduto = new Map(itensResolvidos.map((i) => [i.produto_id, i]));
  const linhaPorProduto = new Map<string, number>();
  const itensRows = itemsLinhas.map((l, idx) => {
    const i = resolvidoPorProduto.get(l.produto_id)!;
    const linha = (linhaPorProduto.get(l.produto_id) ?? 0) + 1;
    linhaPorProduto.set(l.produto_id, linha);
    return {
      pedido_id: pedidoId,
      produto_id: i.tiny_produto_id,
      sku: i.sku,
      descricao: i.descricao,
      imagem_url: i.imagem_url,
      quantidade_pedida: l.quantidade,
      ordem_full: idx + 1,
      linha,
    };
  });

  const { error: itensErr } = await supabase.from("siso_pedido_itens").insert(itensRows);
  if (itensErr) {
    await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
    logger.error("full.criar", "Falha ao inserir itens", { error: itensErr.message, pedidoId });
    return NextResponse.json(
      { erro: "Falha ao inserir itens", detalhe: itensErr.message },
      { status: 500 },
    );
  }

  // Reserva PARCIAL: ao contrário da venda manual (tudo-ou-nada por item), o
  // Full reserva o que der — pede 10, galpão só cobre 6 → reserva 6 e deixa 4
  // pendentes pro operador resolver no picking (spec FULL-01 AC3).
  const reservasCriadas: string[] = [];
  const itensParciais: Array<{ sku: string; quantidade_pedida: number; quantidade_reservada: number }> = [];
  try {
    for (const item of itensResolvidos) {
      let restante = item.quantidade;
      if (item.sugestoes && item.sugestoes.length > 0) {
        for (const sug of item.sugestoes) {
          if (restante <= 0) break;
          const qtyDestaLoc = Math.min(restante, sug.disponivel);
          if (qtyDestaLoc <= 0) continue;
          const reservaId = await reservarAtomico({
            tripla: {
              produto_id: item.produto_id,
              galpao_id,
              localizacao_id: sug.localizacao_id,
            },
            qty: qtyDestaLoc,
            pedido_id: pedidoId,
            ttl_horas: 24 * 30, // 30 dias, alinhado com aprovar e webhook-processor-wms
            usuario_id: user.id,
          });
          reservasCriadas.push(reservaId);
          restante -= qtyDestaLoc;
        }
      }
      if (restante > 0) {
        itensParciais.push({
          sku: item.sku,
          quantidade_pedida: item.quantidade,
          quantidade_reservada: item.quantidade - restante,
        });
      }
    }
  } catch (rErr) {
    const msg =
      rErr instanceof Error
        ? rErr.message
        : rErr && typeof rErr === "object" && "message" in rErr
          ? String((rErr as { message: unknown }).message)
          : String(rErr);
    logger.error("full.criar", "Falha ao criar R — rollback total", {
      pedidoId,
      erro: msg,
      reservas_pra_estornar: reservasCriadas,
    });
    for (const rid of reservasCriadas) {
      try {
        await estornarReservaIndividual({
          reserva_id: rid,
          motivo: "rollback_aprovacao",
          usuario_id: user.id,
        });
      } catch (estornoErr) {
        logger.error("full.criar", "Falha no rollback de R — DADOS POSSIVELMENTE INCONSISTENTES", {
          pedidoId,
          reserva_id: rid,
          erro: estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
        });
      }
    }
    await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
    await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
    return NextResponse.json(
      { erro: `Falha criando reservas: ${msg}`, reservas_estornadas: reservasCriadas.length },
      { status: 409 },
    );
  }

  registrarEvento({
    pedidoId,
    evento: "full_criado",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      empresa_origem_id,
      galpao_id,
      galpao: galpaoNome,
      items_count: itensResolvidos.length,
      ...(itensParciais.length > 0 ? { itens_parciais: itensParciais } : {}),
    },
  }).catch(() => {});

  return NextResponse.json({
    pedido_id: pedidoId,
    numero,
    status: "executando",
    status_separacao: "aguardando_separacao",
    parcial: itensParciais.length > 0,
    itens_parciais: itensParciais,
  });
}
