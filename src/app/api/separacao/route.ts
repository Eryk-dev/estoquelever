import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

/**
 * GET /api/separacao
 *
 * List orders assigned to the operator's galpão with items and bip state.
 *
 * Query params:
 *   status  — filter by status_separacao (aguardando_nf, pendente, em_separacao, embalado, expedido)
 *   galpao_id — required for admin users (who have no implicit galpão)
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  const galpaoIdParam = searchParams.get("galpao_id");

  // Resolve galpaoId: operators use their own, admins must pass ?galpao_id
  let galpaoId: string;
  if (session.galpaoId) {
    galpaoId = session.galpaoId;
  } else {
    // Admin or other role without implicit galpão
    if (!galpaoIdParam) {
      return NextResponse.json(
        { error: "galpao_id é obrigatório para admin" },
        { status: 400 },
      );
    }
    galpaoId = galpaoIdParam;
  }

  const supabase = createServiceClient();

  try {
    // 1. Fetch pedidos with nested items
    let query = supabase
      .from("siso_pedidos")
      .select(
        `id, numero, data, cliente_nome, id_pedido_ecommerce, nome_ecommerce,
         forma_envio_descricao, status_separacao, sugestao, decisao_final,
         separacao_operador_id, separacao_iniciada_em,
         embalagem_concluida_em, etiqueta_url, etiqueta_status, url_danfe, chave_acesso_nf,
         siso_pedido_itens(produto_id, sku, gtin, descricao, quantidade_pedida, quantidade_bipada, bipado_completo)`,
      )
      .eq("separacao_galpao_id", galpaoId)
      .neq("status", "cancelado")
      .order("data", { ascending: true });

    if (statusFilter) {
      query = query.eq("status_separacao", statusFilter);
    }

    const { data: pedidos, error: pedidosError } = await query;

    if (pedidosError) {
      logger.error("separacao-list", "Failed to fetch pedidos", {
        error: pedidosError.message,
      });
      return NextResponse.json(
        { error: pedidosError.message },
        { status: 500 },
      );
    }

    if (!pedidos || pedidos.length === 0) {
      return NextResponse.json([]);
    }

    // 2. Get empresas in this galpão (for localizacao resolution)
    const { data: empresas } = await supabase
      .from("siso_empresas")
      .select("id")
      .eq("galpao_id", galpaoId);

    const empresaIds = empresas?.map((e) => e.id) ?? [];

    // 3. Batch-fetch localizacao from siso_pedido_item_estoques
    const pedidoIds = pedidos.map((p) => p.id);
    let locMap = new Map<string, string>(); // "pedidoId:produtoId" → localizacao

    if (empresaIds.length > 0 && pedidoIds.length > 0) {
      const { data: estoques } = await supabase
        .from("siso_pedido_item_estoques")
        .select("pedido_id, produto_id, localizacao")
        .in("pedido_id", pedidoIds)
        .in("empresa_id", empresaIds)
        .not("localizacao", "is", null);

      if (estoques) {
        locMap = new Map(
          estoques.map((e) => [
            `${e.pedido_id}:${e.produto_id}`,
            e.localizacao as string,
          ]),
        );
      }
    }

    // 4. Shape response — merge localizacao into items
    const result = pedidos.map((p) => {
      const itens = (
        p.siso_pedido_itens as unknown as Array<{
          produto_id: number;
          sku: string;
          gtin: string | null;
          descricao: string;
          quantidade_pedida: number;
          quantidade_bipada: number;
          bipado_completo: boolean;
        }>
      ).map((item) => ({
        produto_id: item.produto_id,
        sku: item.sku,
        gtin: item.gtin,
        descricao: item.descricao,
        quantidade_pedida: item.quantidade_pedida,
        quantidade_bipada: item.quantidade_bipada ?? 0,
        bipado_completo: item.bipado_completo ?? false,
        localizacao: locMap.get(`${p.id}:${item.produto_id}`) ?? null,
      }));

      return {
        id: p.id,
        numero: p.numero,
        data: p.data,
        cliente_nome: p.cliente_nome,
        id_pedido_ecommerce: p.id_pedido_ecommerce,
        nome_ecommerce: p.nome_ecommerce,
        forma_envio_descricao: p.forma_envio_descricao,
        status_separacao: p.status_separacao,
        decisao: (p as Record<string, unknown>).decisao_final ?? (p as Record<string, unknown>).sugestao ?? null,
        separacao_operador_id: p.separacao_operador_id,
        separacao_iniciada_em: p.separacao_iniciada_em,
        embalagem_concluida_em: p.embalagem_concluida_em,
        etiqueta_url: p.etiqueta_url,
        etiqueta_status: p.etiqueta_status,
        url_danfe: p.url_danfe,
        chave_acesso_nf: p.chave_acesso_nf,
        itens,
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    logger.error("separacao-list", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
