import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const sb = createServiceClient();

  const limit = Number(sp.get("limit") ?? 100);
  const offset = Number(sp.get("offset") ?? 0);

  // 3D: empresa_dona caiu — saldo é fungível por galpão. Os novos campos
  // de metadado (empresa_compradora/vendedora/referencia, fornecedor,
  // motivo, cliente_nome, custos) entram explicitamente no SELECT.
  let q = sb
    .from("siso_movimentacoes")
    .select(
      `
        id,
        tipo,
        produto_id,
        galpao_id,
        localizacao_id,
        quantidade,
        saldo_anterior,
        saldo_posterior,
        reservado_anterior,
        reservado_posterior,
        origem_tipo,
        origem_id,
        origem_detalhes,
        empresa_compradora_id,
        empresa_vendedora_id,
        empresa_referencia_id,
        fornecedor_id,
        pedido_id,
        nota_fiscal_id,
        chave_acesso_nf,
        motivo,
        cliente_nome,
        custo_unitario,
        custo_medio_anterior,
        custo_medio_posterior,
        usuario_id,
        observacoes,
        estorno_de,
        criado_em,
        produto:siso_produtos(sku, descricao),
        compradora:siso_empresas!empresa_compradora_id(nome),
        vendedora:siso_empresas!empresa_vendedora_id(nome),
        referencia:siso_empresas!empresa_referencia_id(nome),
        fornecedor:siso_fornecedores(nome),
        galpao:siso_galpoes(nome),
        localizacao:siso_localizacoes(codigo, tipo)
      `,
      { count: "exact" },
    )
    // Ordem determinística (criado_em desc, id desc) pra suportar keyset.
    .order("criado_em", { ascending: false })
    .order("id", { ascending: false });

  // Paginação por cursor keyset (`before` = "<criado_em>|<id>" da última linha)
  // OU por offset clássico. Keyset evita duplicar/pular linhas quando novas movs
  // entram entre páginas. Quando não há `before`, cai no range por offset.
  const before = sp.get("before");
  if (before) {
    const sep = before.lastIndexOf("|");
    const beforeTs = sep >= 0 ? before.slice(0, sep) : before;
    const beforeId = sep >= 0 ? before.slice(sep + 1) : "";
    // (criado_em < ts) OR (criado_em = ts AND id < id) — tupla estrita.
    q = q.or(
      `criado_em.lt.${beforeTs},and(criado_em.eq.${beforeTs},id.lt.${beforeId})`,
    );
    q = q.limit(limit);
  } else {
    q = q.range(offset, offset + limit - 1);
  }

  const produtoId = sp.get("produto_id");
  const galpaoId = sp.get("galpao_id");
  const localizacaoId = sp.get("localizacao_id");
  const origemTipo = sp.get("origem_tipo");
  const empresaCompradoraId = sp.get("empresa_compradora_id");
  const empresaVendedoraId = sp.get("empresa_vendedora_id");
  const empresaReferenciaId = sp.get("empresa_referencia_id");
  const fornecedorId = sp.get("fornecedor_id");
  const desde = sp.get("desde");
  const ate = sp.get("ate");

  if (produtoId) q = q.eq("produto_id", produtoId);
  if (galpaoId) q = q.eq("galpao_id", galpaoId);
  if (localizacaoId) q = q.eq("localizacao_id", localizacaoId);
  if (origemTipo) q = q.eq("origem_tipo", origemTipo);
  if (empresaCompradoraId) q = q.eq("empresa_compradora_id", empresaCompradoraId);
  if (empresaVendedoraId) q = q.eq("empresa_vendedora_id", empresaVendedoraId);
  if (empresaReferenciaId) q = q.eq("empresa_referencia_id", empresaReferenciaId);
  if (fornecedorId) q = q.eq("fornecedor_id", fornecedorId);
  if (desde) q = q.gte("criado_em", desde);
  if (ate) q = q.lte("criado_em", ate);

  const { data, count, error } = await q;
  if (error) {
    return wmsErrorResponse({
      source: "wms.ledger",
      error,
      requestPath: "/api/wms/ledger",
      requestMethod: "GET",
    });
  }
  return NextResponse.json({ rows: data ?? [], total: count ?? 0 });
}
