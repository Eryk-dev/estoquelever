import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { aggregateLiveStockBySku } from "@/lib/wms/live-stock";
import { recomputarSugestaoBatch } from "@/lib/wms/sugestao-dinamica";
import type { GalpaoEstoque } from "@/types";

/**
 * GET /api/pedidos/[id]/detalhe
 *
 * Returns consolidated data for a single pedido:
 * - Base pedido data with empresa/galpao names
 * - Items with stock per galpao
 * - Historico (audit trail)
 * - Observacoes (comments)
 *
 * Role-based access: verifies the user can see this pedido's galpao.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { id: pedidoId } = await params;
  const supabase = createServiceClient();

  try {
    // Fetch pedido base data with empresa/galpao JOIN
    const { data: pedido, error: pedidoError } = await supabase
      .from("siso_pedidos")
      .select(`
        *,
        siso_empresas(nome, galpao_id, siso_galpoes!siso_empresas_galpao_id_fkey(nome))
      `)
      .eq("id", pedidoId)
      .single();

    if (pedidoError || !pedido) {
      if (pedidoError?.code === "PGRST116") {
        return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
      }
      logger.error("pedido-detalhe", "Failed to fetch pedido", {
        pedidoId,
        error: pedidoError?.message,
      });
      return NextResponse.json({ error: pedidoError?.message ?? "Erro ao buscar pedido" }, { status: 500 });
    }

    // Role-based access check (filtro/auth híbrido). Proxy via permissões:
    //   - isAdmin: só admin tem sistema.usuarios → vê qualquer pedido.
    //   - isComprador: tem compras.executar mas não é admin → vê só decisao_final='oc'.
    const isAdmin = userCan(session, "sistema.usuarios");
    const isComprador = !isAdmin && userCan(session, "compras.executar");

    if (isComprador && pedido.decisao_final !== "oc") {
      return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
    }

    if (!isAdmin && !isComprador && session.galpaoId) {
      const empresa = pedido.siso_empresas as unknown as {
        nome: string;
        galpao_id: string;
        siso_galpoes: { nome: string };
      } | null;

      if (empresa && empresa.galpao_id !== session.galpaoId) {
        return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
      }
    }

    // Fetch items, historico, observacoes in parallel. Estoque vem live
    // de siso_estoque (3D) — agregado abaixo via aggregateLiveStockBySku.
    const [itensResult, historicoResult, observacoesResult] = await Promise.all([
      supabase
        .from("siso_pedido_itens")
        .select("id, pedido_id, produto_id, sku, descricao, quantidade_pedida, imagem_url, fornecedor_oc, compra_status, compra_quantidade_solicitada, compra_quantidade_comprada, compra_quantidade_recebida, separacao_marcado, bipado_completo")
        .eq("pedido_id", pedidoId),
      supabase
        .from("siso_pedido_historico")
        .select("id, evento, usuario_id, usuario_nome, detalhes, criado_em")
        .eq("pedido_id", pedidoId)
        .order("criado_em", { ascending: true }),
      supabase
        .from("siso_pedido_observacoes")
        .select("id, pedido_id, usuario_id, usuario_nome, texto, criado_em")
        .eq("pedido_id", pedidoId)
        .order("criado_em", { ascending: true }),
    ]);

    // Estoque LIVE por (sku, galpão) — reflete movimentações pós-webhook.
    const itensList = itensResult.data ?? [];
    const skus = Array.from(new Set(itensList.map((i) => i.sku).filter((s): s is string => !!s)));
    const stockBySku = await aggregateLiveStockBySku(supabase, skus);

    // Sugestão dinâmica pra pedidos ainda em decisão (pendente/erro).
    const ehDecidivel = pedido.status === "pendente" || pedido.status === "erro";
    const sugestoesAtuais =
      ehDecidivel && pedido.empresa_origem_id
        ? await recomputarSugestaoBatch(supabase, [
            {
              pedidoId: pedido.id,
              empresaOrigemId: pedido.empresa_origem_id,
              itens: itensList
                .filter((it) => !!it.sku)
                .map((it) => ({
                  sku: it.sku as string,
                  quantidade: Number(it.quantidade_pedida) || 0,
                })),
            },
          ])
        : null;
    const sugestaoAtual = sugestoesAtuais?.get(pedido.id);

    // Map empresa join
    const empresaData = pedido.siso_empresas as unknown as {
      nome: string;
      galpao_id: string;
      siso_galpoes: { nome: string };
    } | null;

    // Build items with stock
    const itens = itensList.map((item) => {
      const galpaoStock = item.sku ? stockBySku.get(item.sku) : undefined;
      const estoques: Record<string, GalpaoEstoque> = {};

      if (galpaoStock) {
        for (const [galpaoNome, stock] of galpaoStock) {
          estoques[galpaoNome] = {
            deposito: {
              id: 0,
              nome: galpaoNome,
              saldo: stock.saldo,
              reservado: stock.reservado,
              disponivel: stock.disponivel,
            },
            atende: stock.disponivel >= (item.quantidade_pedida ?? 0),
            localizacao: stock.localizacaoTop ?? undefined,
          };
        }
      }

      return {
        id: item.id,
        produto_id: item.produto_id,
        sku: item.sku ?? "",
        descricao: item.descricao ?? "",
        quantidade: item.quantidade_pedida ?? 0,
        imagem_url: item.imagem_url ?? null,
        fornecedor_oc: item.fornecedor_oc ?? null,
        compra_status: item.compra_status ?? null,
        compra_quantidade_solicitada: item.compra_quantidade_solicitada ?? null,
        compra_quantidade_comprada: item.compra_quantidade_comprada ?? null,
        compra_quantidade_recebida: item.compra_quantidade_recebida ?? null,
        separacao_marcado: item.separacao_marcado ?? false,
        bipado_completo: item.bipado_completo ?? false,
        localizacao: null,
        estoques,
      };
    });

    // Build historico
    const historico = (historicoResult.data ?? []).map((h) => ({
      id: h.id,
      evento: h.evento,
      usuario_id: h.usuario_id ?? null,
      usuario_nome: h.usuario_nome ?? null,
      detalhes: h.detalhes ?? null,
      criado_em: h.criado_em,
    }));

    // Build observacoes
    const observacoes = (observacoesResult.data ?? []).map((o) => ({
      id: o.id,
      usuario_id: o.usuario_id ?? null,
      usuario_nome: o.usuario_nome ?? null,
      texto: o.texto ?? "",
      criado_em: o.criado_em,
    }));

    // Build response
    const result = {
      id: pedido.id,
      numero: pedido.numero ?? "",
      id_pedido_ecommerce: pedido.id_pedido_ecommerce ?? "",
      nome_ecommerce: pedido.nome_ecommerce ?? "",
      cliente_nome: pedido.cliente_nome ?? "",
      cliente_cpf_cnpj: pedido.cliente_cpf_cnpj ?? "",
      data: pedido.data ?? "",
      status: pedido.status ?? "pendente",
      status_separacao: pedido.status_separacao ?? null,
      sugestao: sugestaoAtual?.sugestao ?? pedido.sugestao ?? "propria",
      sugestao_motivo: sugestaoAtual?.motivo ?? pedido.sugestao_motivo ?? null,
      decisao_final: pedido.decisao_final ?? null,
      tipo_resolucao: pedido.tipo_resolucao ?? null,
      operador: pedido.operador_nome ?? null,
      empresa_origem_id: pedido.empresa_origem_id ?? null,
      empresa_origem_nome: empresaData?.nome ?? null,
      filial_origem: empresaData?.siso_galpoes?.nome ?? pedido.filial_origem ?? null,
      forma_envio: pedido.forma_envio_descricao ?? null,
      forma_frete_id: pedido.forma_frete_id ?? null,
      transportador_id: pedido.transportador_id ?? null,
      encaminhado_de: pedido.encaminhado_de ?? null,
      processado_em: pedido.processado_em ?? null,
      separacao_operador_id: pedido.separacao_operador_id ?? null,
      separacao_iniciada_em: pedido.separacao_iniciada_em ?? null,
      separacao_concluida_em: pedido.separacao_concluida_em ?? null,
      embalagem_concluida_em: pedido.embalagem_concluida_em ?? null,
      etiqueta_status: pedido.etiqueta_status ?? null,
      etiqueta_url: pedido.etiqueta_url ?? null,
      agrupamento_expedicao_id: pedido.agrupamento_expedicao_id ?? null,
      compra_estoque_lancado_alerta: pedido.compra_estoque_lancado_alerta ?? null,
      marcadores: pedido.marcadores ?? [],
      separacao_tags: pedido.separacao_tags ?? [],
      erro: pedido.erro ?? null,
      criado_em: pedido.criado_em ?? "",
      itens,
      historico,
      observacoes,
    };

    return NextResponse.json(result);
  } catch (err) {
    logger.error("pedido-detalhe", "Unexpected error", {
      pedidoId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
