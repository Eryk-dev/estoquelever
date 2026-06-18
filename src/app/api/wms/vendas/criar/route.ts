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
 * Baixa direta: as N movs 'S' saem numa única transação via RPC
 * wms_vender_baixa_direta_atomico (tudo-ou-nada no banco). Se a RPC lançar,
 * a rota só limpa o cabeçalho de pedido recém-criado (sem movs órfãs).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";
import { reservarAtomico, estornarReservaIndividual } from "@/lib/wms/reservas";
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
  // Auth + perm (finding 7.1)
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida ou expirada" }, { status: 401 });
  }
  if (!userCan(user, "vendas.criar")) {
    return NextResponse.json({ erro: "forbidden — requer vendas.criar" }, { status: 403 });
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

  // Dedupe por produto_id somando a qty. O índice único
  // idx_siso_pedido_itens_pedido_produto (pedido_id, produto_id) rejeita duas
  // linhas do mesmo produto no mesmo pedido — o operador pode ter adicionado o
  // mesmo SKU em linhas separadas. Junta numa só (1 row/produto) ANTES de
  // resolver disponibilidade, pra reserva/baixa/insert verem qty consolidada.
  const itemsDeduped = Array.from(
    items
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

  // Idempotência (P3 #7.7): se mesmo idempotency_key já foi processado, retorna
  // o pedido existente — desde que **não esteja cancelado**. Após cancelamento,
  // a key fica liberada pra criar nova venda (rollback recovery).
  if (idempotency_key) {
    const { data: existente } = await supabase
      .from("siso_pedidos")
      .select("id, numero, status, status_separacao")
      .eq("payload_original->>idempotency_key", idempotency_key)
      .eq("origem_pedido", "manual")
      .neq("status", "cancelado")
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
  const produtoIds = itemsDeduped.map((i) => i.produto_id);
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

  // [Fix-D #7.8] Resolve disponibilidade com erros estruturados (não throw).
  // Antes: throw dentro do Promise.all virava 500 + mensagem perdia estrutura.
  // Agora: cada item retorna { ok: true, data } ou { ok: false, error } e
  // o primeiro erro vira 400 com payload {codigo, sku, empresas_disponiveis}.
  type ResolverError = {
    codigo: "PRODUTO_NAO_ENCONTRADO" | "PRODUTO_NAO_MAPEADO";
    sku: string | null;
    produto_id: string;
    mensagem: string;
    empresas_disponiveis?: Array<{ id: string; nome: string }>;
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
        // Verifica se produto existe em OUTRAS empresas — sugere
        const { data: outrasEmpresas } = await supabase
          .from("siso_produto_empresas")
          .select("empresa_id, siso_empresas!inner(id, nome)")
          .eq("produto_id", item.produto_id);
        const empresas = (outrasEmpresas ?? [])
          .map(
            (e: {
              siso_empresas?:
                | { id?: string; nome?: string }
                | Array<{ id?: string; nome?: string }>;
            }) => {
              const emp = Array.isArray(e.siso_empresas) ? e.siso_empresas[0] : e.siso_empresas;
              return emp?.id && emp?.nome ? { id: emp.id, nome: emp.nome } : null;
            },
          )
          .filter((e): e is { id: string; nome: string } => Boolean(e));
        const msg =
          empresas.length > 0
            ? `Produto ${prod.sku} não está cadastrado na empresa origem (${empresa.nome}). Disponível em: ${empresas.map((e) => e.nome).join(", ")}. Selecione uma dessas ou peça pro admin sincronizar.`
            : `Produto ${prod.sku} não está cadastrado em nenhuma empresa — peça pro admin sincronizar via Tiny`;
        return {
          ok: false,
          error: {
            codigo: "PRODUTO_NAO_MAPEADO",
            sku: prod.sku,
            produto_id: item.produto_id,
            mensagem: msg,
            empresas_disponiveis: empresas,
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
          quantidade: item.quantidade,
          localizacao_id: dispon.sugestao?.localizacao_id ?? null,
          localizacao_codigo: dispon.sugestao?.localizacao_codigo ?? null,
          disponivel: dispon.total_disponivel,
          sugestoes: dispon.sugestoes,
        },
      };
    }),
  );

  // Se algum erro, retorna 400 estruturado com o primeiro (op corrige um por vez)
  const primeiroErro = resolvedResults.find((r) => !r.ok);
  if (primeiroErro && !primeiroErro.ok) {
    return NextResponse.json(
      {
        codigo: primeiroErro.error.codigo,
        sku: primeiroErro.error.sku,
        produto_id: primeiroErro.error.produto_id,
        erro: primeiroErro.error.mensagem,
        empresas_disponiveis: primeiroErro.error.empresas_disponiveis,
      },
      { status: 400 },
    );
  }

  const itensResolvidos: ItemResolvido[] = resolvedResults
    .filter((r): r is { ok: true; data: ItemResolvido } => r.ok)
    .map((r) => r.data);

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
    marcadores: ["LVR", "VENDA_DIRETA", "WMS"],
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
    // [Fix-D T10] cwb_atende/sp_atende removed (zero readers confirmados)
    // de painéis. Popula com case-insensitive match no nome do galpão.
    // Pra galpões fora de {CWB, SP}, ambos ficam false (sinaliza "outro").
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

  // 2b) Modo separacao: cria R atomicamente.
  // Sem isso, marketplace concorrente pode pegar saldo entre a venda manual
  // e o picking, e a baixa do vendedor falha por reservado>saldo.
  // Itens sem localizacao_id (sem saldo no galpão) ou com saldo parcial
  // (quantidade > disponivel — caso típico de degradação) são pulados —
  // pedido segue como aguardando_separacao sem reserva pra esses itens
  // (operador resolve no picking). RPC wms_reservar_atomico falharia por
  // saldo insuficiente nesses casos, então não vale a tentativa.
  const reservasCriadas: string[] = [];
  if (modoEfetivo === "separacao") {
    try {
      for (const item of itensResolvidos) {
        if (!item.localizacao_id) continue; // sem saldo — segue sem reserva
        if (item.quantidade > item.disponivel) continue; // saldo insuficiente — pula
        const reservaId = await reservarAtomico({
          tripla: {
            produto_id: item.produto_id,
            galpao_id: galpao_id,
            localizacao_id: item.localizacao_id,
          },
          qty: item.quantidade,
          pedido_id: pedidoId,
          ttl_horas: 24 * 30, // 30 dias, alinhado com aprovar e webhook-processor-wms
          usuario_id: user.id,
        });
        reservasCriadas.push(reservaId);
      }
    } catch (rErr) {
      const msg = rErr instanceof Error ? rErr.message : String(rErr);
      logger.error("vendas.criar", "Falha ao criar R em modo separacao — rollback", {
        pedidoId,
        erro: msg,
        reservas_pra_estornar: reservasCriadas,
      });
      // Rollback: estorna parciais + apaga pedido+itens
      for (const rid of reservasCriadas) {
        try {
          await estornarReservaIndividual({
            reserva_id: rid,
            motivo: "rollback_aprovacao",
            usuario_id: user.id,
          });
        } catch (estornoErr) {
          logger.error("vendas.criar", "Falha no rollback de R — DADOS POSSIVELMENTE INCONSISTENTES", {
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
  }

  // 3) Se modoEfetivo === 'baixa_direta', monta o payload das N movs 'S' e baixa
  //    tudo numa ÚNICA transação via RPC wms_vender_baixa_direta_atomico (advisory
  //    lock por tripla + tudo-ou-nada). Cada item pode ser dividido em N movs se a
  //    qty pedida não cabe numa única loc — iteramos sobre item.sugestoes[] (já
  //    ordenadas por preferência: picking > overstock > recebimento, depois maior
  //    disponivel) até completar a qty pedida ou esgotar sugestoes. A RPC faz o
  //    rollback no banco; a rota só limpa o cabeçalho de pedido se a RPC lançou.
  let movsBaixadas = 0;
  if (modoEfetivo === "baixa_direta") {
    // origem_id é uuid no schema (siso_movimentacoes.origem_id) — geramos um uuid
    // compartilhado entre todos os itens da mesma venda pra agrupá-los no ledger.
    // O pedidoId 'MAN-...' (text) vai como tag em origem_detalhes.pedido_id_manual.
    const origemVendaId = crypto.randomUUID();
    const movsPayload: Array<Record<string, unknown>> = [];
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
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
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
        movsPayload.push({
          produto_id: item.produto_id,
          galpao_id: galpao_id,
          localizacao_id: sug.localizacao_id,
          qty: qtyDestaLoc,
          sku: item.sku,
          vendedor_id: vendedorIdEfetivo,
          vendedor_nome: vendedorNomeEfetivo,
          canal_venda: canal_venda ?? null,
          loc_codigo: sug.localizacao_codigo,
          // Split-info: qty pedida e split atual (debug ledger)
          qty_item_total: item.quantidade,
          qty_desta_loc: qtyDestaLoc,
          ...(emNomeDe
            ? {
                criado_por_id: user.id,
                criado_por_nome: user.nome,
              }
            : {}),
        });
        restante -= qtyDestaLoc;
      }

      if (restante > 0) {
        // Cobertura insuficiente entre as sugestoes — não deveria ocorrer
        // porque a degradação acima trata isso. Defensive: limpa cabeçalho + erro.
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
        await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
        await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
        return NextResponse.json(
          {
            erro: `Falha interna: cobertura insuficiente pra ${item.sku} (pedida=${item.quantidade}, atendida=${item.quantidade - restante})`,
            sku: item.sku,
          },
          { status: 500 },
        );
      }
    }

    const { data: bdData, error: bdErr } = await supabase.rpc("wms_vender_baixa_direta_atomico", {
      p_origem_venda_id: origemVendaId,
      p_pedido_id_manual: pedidoId,
      p_empresa_vendedora_id: empresa_origem_id,
      p_cliente_nome: cliente_nome,
      p_movs: movsPayload,
      p_usuario_id: user.id,
    });
    if (bdErr) {
      // Tudo-ou-nada: a RPC rolou back as movs. Limpa o cabeçalho de pedido
      // criado antes (sem movs órfãs no ledger).
      logger.error("vendas.criar", "Falha ao baixar venda baixa_direta — RPC", {
        pedidoId,
        erro: bdErr.message,
      });
      await supabase.from("siso_pedido_itens").delete().eq("pedido_id", pedidoId);
      await supabase.from("siso_pedidos").delete().eq("id", pedidoId);
      return NextResponse.json(
        { erro: `Falha ao baixar venda: ${bdErr.message}` },
        { status: 409 },
      );
    }
    movsBaixadas = ((bdData as { mov_ids?: string[] } | null)?.mov_ids ?? []).length;
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
      detalhes: { movs_count: movsBaixadas },
    }).catch(() => {});
  }

  const response: CriarVendaDiretaResponse = {
    pedido_id: pedidoId,
    numero,
    status: modoEfetivo === "separacao" ? "executando" : "concluido",
    status_separacao: modoEfetivo === "separacao" ? "aguardando_separacao" : null,
    movs_criadas: movsBaixadas > 0 ? movsBaixadas : undefined,
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
