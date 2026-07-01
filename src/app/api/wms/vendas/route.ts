/**
 * GET /api/wms/vendas
 *
 * Lista pedidos de venda direta — agrega:
 *   - Pedidos manuais (origem_pedido='manual')
 *   - Pedidos de marketplaces rastreados (Mercado Livre, Shopee)
 *
 * Auto-filtro "Meus pedidos" se cargos.includes('vendedor') E vendedor_id
 * não foi passado explicitamente.
 *
 * Query params:
 *   tab        = pendentes | em_separacao | baixados | concluidos (default pendentes)
 *   vendedor_id (string|"__todos__") — vendedor filter; "__todos__" desliga auto-filtro
 *   marketplace = "Mercado Livre" | "Shopee" | "manual" — filtro de origem
 *   galpao_id  — filtra por separacao_galpao_id
 *   data_de / data_ate (ISO date)
 *   busca      — número, cliente_nome, id_pedido_ecommerce
 *   page (default 1) / page_size (default 50, max 200)
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const tab = (sp.get("tab") ?? "pendentes") as
    | "pendentes"
    | "em_separacao"
    | "baixados"
    | "concluidos"
    | "full";

  const vendedorParam = sp.get("vendedor_id");
  const marketplace = sp.get("marketplace");
  const galpaoId = sp.get("galpao_id");
  const dataDe = sp.get("data_de");
  const dataAte = sp.get("data_ate");
  const busca = sp.get("busca")?.trim();
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, parseInt(sp.get("page_size") ?? String(PAGE_SIZE_DEFAULT), 10)),
  );

  // Filtro de visibilidade (não auth). Proxy via permissões:
  //   - isAdmin: tem sistema.usuarios (só admin no seed).
  //   - isVendedor: tem vendas.criar mas NÃO é admin — preserva semântica
  //     do cargo 'vendedor' (auto-filtro "Meus pedidos" + hide custo).
  const isAdmin = userCan(user, "sistema.usuarios");
  const isVendedor = !isAdmin && userCan(user, "vendas.criar");
  const hideCusto = isVendedor && !isAdmin;

  // Auto-filtro "Meus pedidos" — vendedor sem param explícito vê só os dele
  let vendedorFilter: string | null = null;
  if (vendedorParam === "__todos__") {
    vendedorFilter = null; // explicitly all
  } else if (vendedorParam) {
    vendedorFilter = vendedorParam;
  } else if (isVendedor) {
    vendedorFilter = user.id;
  }

  const supabase = createServiceClient();

  let query = supabase
    .from("siso_pedidos")
    .select(
      `id, numero, data, filial_origem, empresa_origem_id, cliente_nome, cliente_cpf_cnpj,
       nome_ecommerce, id_pedido_ecommerce, sugestao, sugestao_motivo, status, tipo_resolucao,
       decisao_final, separacao_galpao_id, status_separacao, marcadores, criado_em,
       processado_em, embalagem_concluida_em, etiqueta_url,
       vendedor_id, vendedor_nome, origem_pedido, canal_venda`,
      { count: "exact" },
    )
    .or("origem_pedido.eq.manual,nome_ecommerce.in.(\"Mercado Livre\",\"Shopee\")")
    // Aba "Full" mostra os pedidos Full; as abas de STATUS excluem Full
    // (zero-regressão — a lane de picking deles é /wms/separacao-full).
    .eq("separacao_full", tab === "full");

  // Filtro por tab
  switch (tab) {
    case "pendentes":
      query = query
        .in("status", ["pendente", "executando"])
        .is("embalagem_concluida_em", null);
      break;
    case "em_separacao":
      query = query.in("status_separacao", [
        "aguardando_nf",
        "aguardando_separacao",
        "em_separacao",
        "separado",
        "embalado",
        "conferido",
      ]);
      break;
    case "baixados":
      query = query
        .eq("origem_pedido", "manual")
        .eq("status", "concluido")
        .is("status_separacao", null);
      break;
    case "concluidos":
      query = query.eq("status", "concluido");
      break;
    case "full":
      // Aba Full: todos os pedidos Full, qualquer status (o base já filtra
      // separacao_full=true). Sem filtro de status.
      break;
  }

  if (vendedorFilter) query = query.eq("vendedor_id", vendedorFilter);
  if (marketplace === "manual") query = query.eq("origem_pedido", "manual");
  else if (marketplace) query = query.eq("nome_ecommerce", marketplace);

  if (galpaoId) query = query.eq("separacao_galpao_id", galpaoId);
  if (dataDe) query = query.gte("data", dataDe);
  if (dataAte) query = query.lte("data", dataAte);
  if (busca) {
    const safe = busca.replace(/[%,]/g, "");
    query = query.or(
      `numero.ilike.%${safe}%,cliente_nome.ilike.%${safe}%,id_pedido_ecommerce.ilike.%${safe}%`,
    );
  }

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.order("criado_em", { ascending: false }).range(from, to);

  const { data, error, count } = await query;

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  // Hide custo (defense in depth — pedido row doesn't expose custo direct, but
  // garantia futura). Por ora não filtra nada — só sinaliza no payload.
  return NextResponse.json({
    pedidos: data ?? [],
    total: count ?? 0,
    page,
    page_size: pageSize,
    auto_filtro_meus: isVendedor && !vendedorParam,
    hide_custo: hideCusto,
  });
}
