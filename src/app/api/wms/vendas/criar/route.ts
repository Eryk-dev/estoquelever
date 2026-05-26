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
import { userCan } from "@/lib/permissions";
import {
  resolverDisponibilidadeVenda,
  type DisponibilidadeSugestao,
} from "@/lib/wms/vendas-disponibilidade";
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
  // Resolvidos via resolverDisponibilidadeVenda (null se não tem saldo).
  // Em 3D estoque é fungível dentro do galpão — não há mais empresa dona.
  localizacao_id: string | null;
  localizacao_codigo: string | null;
  disponivel: number;
  /** Lista ordenada de locs com saldo — usada pra split em baixa_direta. */
  sugestoes: DisponibilidadeSugestao[];
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
    vendedor_id_alvo,
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

  // ─── Vendedor efetivo (em nome de) ──────────────────────────────────────
  // Default: usuário da sessão é o vendedor. Se `vendedor_id_alvo` foi enviado
  // e é diferente do user.id, valida permissão `vendas.criar_em_nome_de` e
  // resolve nome do alvo. Admin/operador_* têm essa perm por default.
  let vendedorIdEfetivo: string = user.id;
  let vendedorNomeEfetivo: string = user.nome;
  let emNomeDe: { id: string; nome: string } | null = null;

  if (vendedor_id_alvo && vendedor_id_alvo !== user.id) {
    if (!userCan(user, "vendas.criar_em_nome_de")) {
      return NextResponse.json(
        { erro: "sem permissão pra criar em nome de outro vendedor" },
        { status: 403 },
      );
    }
    const { data: alvo, error: alvoErr } = await supabase
      .from("siso_usuarios")
      .select("id, nome, ativo")
      .eq("id", vendedor_id_alvo)
      .maybeSingle();
    if (alvoErr) {
      logger.error("vendas.criar", "Erro lendo vendedor_id_alvo", {
        error: alvoErr.message,
        vendedor_id_alvo,
      });
      return NextResponse.json(
        { erro: "Erro lendo vendedor alvo" },
        { status: 500 },
      );
    }
    if (!alvo) {
      return NextResponse.json(
        { erro: "vendedor_id_alvo inválido" },
        { status: 400 },
      );
    }
    if (alvo.ativo === false) {
      return NextResponse.json(
        { erro: "vendedor_id_alvo está inativo" },
        { status: 400 },
      );
    }
    vendedorIdEfetivo = alvo.id;
    vendedorNomeEfetivo = alvo.nome;
    emNomeDe = { id: alvo.id, nome: alvo.nome };
  }

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
        // Verifica se produto existe em OUTRAS empresas — sugere
        const { data: outrasEmpresas } = await supabase
          .from("siso_produto_empresas")
          .select("empresa_id, siso_empresas!inner(nome)")
          .eq("produto_id", item.produto_id);
        const sugestoes = (outrasEmpresas ?? [])
          .map((e: { siso_empresas?: { nome?: string } | { nome?: string }[] }) => {
            const emp = Array.isArray(e.siso_empresas) ? e.siso_empresas[0] : e.siso_empresas;
            return emp?.nome ?? null;
          })
          .filter((nome): nome is string => Boolean(nome));
        const msg =
          sugestoes.length > 0
            ? `Produto ${prod.sku} não está cadastrado na empresa origem (${empresa.nome}). Disponível em: ${sugestoes.join(", ")}. Selecione uma dessas ou peça pro admin sincronizar.`
            : `Produto ${prod.sku} não está cadastrado em nenhuma empresa — peça pro admin sincronizar via Tiny`;
        throw new Error(msg);
      }
      const dispon = await resolverDisponibilidadeVenda(supabase as never, {
        produto_id: item.produto_id,
        galpao_id,
      });
      return {
        produto_id: item.produto_id,
        tiny_produto_id: tinyId,
        sku: prod.sku,
        descricao: prod.descricao,
        quantidade: item.quantidade,
        localizacao_id: dispon.sugestao?.localizacao_id ?? null,
        localizacao_codigo: dispon.sugestao?.localizacao_codigo ?? null,
        disponivel: dispon.total_disponivel,
        sugestoes: dispon.sugestoes,
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
  //
  // vendedor_id/vendedor_nome refletem o vendedor efetivo (em nome de):
  // se vendedor_id_alvo foi enviado e a permissão `vendas.criar_em_nome_de`
  // foi validada, o pedido fica atribuído ao alvo. payload_original registra
  // quem **criou** (criado_por_*) pra audit, separadamente do vendedor exibido.
  const payloadBase: Record<string, unknown> = {
    manual: true,
    modo_solicitado: modo,
    degradado,
    ...(emNomeDe
      ? {
          criado_por_id: user.id,
          criado_por_nome: user.nome,
          vendedor_alvo_id: emNomeDe.id,
          vendedor_alvo_nome: emNomeDe.nome,
        }
      : {}),
  };

  const pedidoRow = {
    id: pedidoId,
    numero,
    data: agora,
    filial_origem: galpaoNome,
    empresa_origem_id,
    cliente_nome,
    cliente_cpf_cnpj: cliente_cpf_cnpj ?? null,
    canal_venda: canal_venda ?? null,
    vendedor_id: vendedorIdEfetivo,
    vendedor_nome: vendedorNomeEfetivo,
    origem_pedido: "manual",
    tipo_resolucao: "manual",
    decisao_final: "propria",
    nome_ecommerce: null,
    separacao_galpao_id: galpao_id,
    marcadores: ["LVR", "VENDA_DIRETA"],
    payload_original: idempotency_key
      ? { ...payloadBase, idempotency_key }
      : payloadBase,
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
    // Legacy compat: cwb_atende/sp_atende são mantidos pra queries legadas
    // de painéis. Popula com case-insensitive match no nome do galpão.
    // Pra galpões fora de {CWB, SP}, ambos ficam false (sinaliza "outro").
    cwb_atende: /^cwb\b/i.test(galpaoNome ?? ""),
    sp_atende: /^sp\b/i.test(galpaoNome ?? ""),
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

  // 3) Se modoEfetivo === 'baixa_direta', gera movs 'S' no ledger com rollback manual.
  //    Cada item pode ser dividido em N movs se a qty pedida não cabe numa única
  //    loc — iteramos sobre item.sugestoes[] (já ordenadas por preferência:
  //    picking > overstock > recebimento, depois maior disponivel) até completar
  //    a qty pedida ou esgotar sugestoes.
  const movsCriadas: string[] = [];

  // Helper de rollback: estorna movs criadas + deleta itens e pedido.
  const rollbackBaixaDireta = async (motivo: string) => {
    for (const movId of movsCriadas) {
      try {
        await estornarMovimentacao({
          mov_id: movId,
          usuario_id: user.id,
          motivo: `Rollback de venda manual ${pedidoId} (${motivo})`,
        });
      } catch (estornoErr) {
        logger.error(
          "vendas.criar",
          "Falha no rollback de mov — DADOS POSSIVELMENTE INCONSISTENTES",
          {
            pedidoId,
            mov_id: movId,
            erro:
              estornoErr instanceof Error ? estornoErr.message : String(estornoErr),
          },
        );
      }
    }
    await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
    await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
  };

  if (modoEfetivo === "baixa_direta") {
    // origem_id é uuid no schema (siso_movimentacoes.origem_id) — geramos um uuid
    // compartilhado entre todos os itens da mesma venda pra agrupá-los no ledger.
    // O pedidoId 'MAN-...' (text) vai como tag em origem_detalhes.pedido_id_manual.
    const origemVendaId = crypto.randomUUID();
    for (const item of itensResolvidos) {
      // Sanity: se chegou aqui é porque modoEfetivo === 'baixa_direta', logo
      // não-degradação garante quantidade <= disponivel. Se sugestoes vazio,
      // é bug interno (disponivel deveria ser zero e degradação teria ocorrido).
      if (!item.sugestoes || item.sugestoes.length === 0) {
        logger.error(
          "vendas.criar",
          "Item sem sugestoes em baixa_direta — inconsistência",
          { pedidoId, sku: item.sku, disponivel: item.disponivel },
        );
        await rollbackBaixaDireta("sugestoes vazia");
        return NextResponse.json(
          { erro: `Falha interna: nenhuma loc resolvida pra ${item.sku}` },
          { status: 500 },
        );
      }

      // Distribui qty entre locs até completar
      let restante = item.quantidade;
      for (const sug of item.sugestoes) {
        if (restante <= 0) break;
        const qtyDestaLoc = Math.min(restante, sug.disponivel);
        if (qtyDestaLoc <= 0) continue;

        try {
          const mov = await inserirMovimentacao({
            tripla: {
              produto_id: item.produto_id,
              galpao_id: galpao_id,
              localizacao_id: sug.localizacao_id,
            },
            tipo: "S",
            qty: qtyDestaLoc,
            origem_tipo: "venda_manual",
            origem_id: origemVendaId,
            origem_detalhes: {
              sku: item.sku,
              vendedor_id: vendedorIdEfetivo,
              vendedor_nome: vendedorNomeEfetivo,
              canal_venda: canal_venda ?? null,
              loc_codigo: sug.localizacao_codigo,
              pedido_id_manual: pedidoId,
              // Split-info: qty pedida e split atual (debug ledger)
              qty_item_total: item.quantidade,
              qty_desta_loc: qtyDestaLoc,
              ...(emNomeDe
                ? {
                    criado_por_id: user.id,
                    criado_por_nome: user.nome,
                  }
                : {}),
            },
            empresa_vendedora_id: empresa_origem_id,
            cliente_nome,
            // pedido_id é TEXT por design (migration 20260526) — aceita
            // `MAN-...` igual aceita Tiny ID. Popular aqui restaura o link
            // formal mov ↔ pedido (que ficava só em origem_detalhes antes do
            // P6); facilita reports tipo "movs do pedido X" sem ter que
            // varrer JSON.
            pedido_id: pedidoId,
            usuario_id: user.id,
            motivo: `Venda manual ${pedidoId} — ${cliente_nome}`,
          });
          movsCriadas.push(mov.id);
          restante -= qtyDestaLoc;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            "vendas.criar",
            "Falha em mov de baixa direta — fazendo rollback",
            {
              pedidoId,
              sku: item.sku,
              loc: sug.localizacao_codigo,
              qty_desta_loc: qtyDestaLoc,
              erro: msg,
              movs_pra_estornar: movsCriadas,
            },
          );
          await rollbackBaixaDireta("falha em outro item");
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

      if (restante > 0) {
        // Cobertura insuficiente entre as sugestoes — não deveria ocorrer
        // porque a degradação acima trata isso. Defensive: rollback + erro.
        logger.error(
          "vendas.criar",
          "Sugestoes insuficientes em baixa_direta — degradação falhou",
          {
            pedidoId,
            sku: item.sku,
            qty_pedida: item.quantidade,
            qty_atendida: item.quantidade - restante,
            disponivel_total: item.disponivel,
          },
        );
        await rollbackBaixaDireta("sugestoes insuficientes");
        return NextResponse.json(
          {
            erro: `Falha interna: cobertura insuficiente pra ${item.sku} (pedida=${item.quantidade}, atendida=${item.quantidade - restante})`,
            sku: item.sku,
          },
          { status: 500 },
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
      ...(emNomeDe
        ? {
            em_nome_de: { id: emNomeDe.id, nome: emNomeDe.nome },
          }
        : {}),
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
