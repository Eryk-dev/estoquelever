import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

/**
 * Histórico de recebimentos avulsos (lotes criados via POST /api/wms/receber).
 *
 * Fonte: siso_movimentacoes tipo='E' agrupadas por origem_id (= lote_id do
 * receberEstoque). Movs novas carregam origem_detalhes.fluxo='avulso'
 * (carimbo 2026-07-06); pra linhas legadas o filtro é por exclusão — outros
 * fluxos que reusam os mesmos origem_tipos deixam marcadores próprios em
 * origem_detalhes, e o avulso sempre exige fornecedor_id.
 */

// origem_tipos que o avulso pode gravar (origemToBackend + retroativo por data).
const ORIGENS_AVULSO = [
  "nf_compra",
  "ajuste_manual",
  "devolucao_cliente_integra",
  "lancamento_retroativo",
];

// Chaves de origem_detalhes gravadas por OUTROS fluxos que reusam os mesmos
// origem_tipos — presença de qualquer uma exclui a mov do histórico legado.
const MARCADORES_OUTROS_FLUXOS = [
  "ordem_compra_id", // receber-oc (nf_compra + over-receive)
  "origem", // compras-manuais ('compra_manual')
  "item_id", // validar-oc-item (achado em pick)
  "pedido_item_id", // compras/receber (caminho pedido)
  "direcao", // ajustarEstoque (/wms/ajuste)
  "contexto", // over-receive de OC
];

interface MovRow {
  id: string;
  origem_id: string;
  origem_tipo: string;
  origem_detalhes: Record<string, unknown> | null;
  quantidade: number | string;
  custo_unitario: number | string | null;
  motivo: string | null;
  criado_em: string;
  fornecedor_id: string | null;
  produto: { sku: string; descricao: string } | null;
  galpao: { nome: string } | null;
  localizacao: { codigo: string } | null;
  fornecedor: { nome: string } | null;
  compradora: { nome: string } | null;
  usuario: { nome: string } | null;
}

interface LoteItem {
  mov_id: string;
  sku: string | null;
  descricao: string | null;
  qty: number;
  custo_unitario: number | null;
  localizacao: string | null;
  estornado: boolean;
}

interface Lote {
  lote_id: string;
  criado_em: string;
  origem_tipo: string;
  entrada_direta: boolean;
  nf_referencia: string | null;
  data_recebimento: string | null;
  motivo: string | null;
  galpao: string | null;
  fornecedor: string | null;
  compradora: string | null;
  usuario: string | null;
  itens: LoteItem[];
  total_qty: number;
  total_valor: number;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const sp = req.nextUrl.searchParams;
  const galpaoId = sp.get("galpao_id");
  const limit = Math.min(Number(sp.get("limit") ?? 500), 2000);

  try {
    const sb = createServiceClient();
    let q = sb
      .from("siso_movimentacoes")
      .select(
        `
          id,
          origem_id,
          origem_tipo,
          origem_detalhes,
          quantidade,
          custo_unitario,
          motivo,
          criado_em,
          fornecedor_id,
          produto:siso_produtos(sku, descricao),
          galpao:siso_galpoes(nome),
          localizacao:siso_localizacoes(codigo),
          fornecedor:siso_fornecedores(nome),
          compradora:siso_empresas!empresa_compradora_id(nome),
          usuario:siso_usuarios(nome)
        `,
      )
      .eq("tipo", "E")
      .in("origem_tipo", ORIGENS_AVULSO)
      .not("origem_id", "is", null)
      .order("criado_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);
    if (galpaoId) q = q.eq("galpao_id", galpaoId);

    const { data, error } = await q;
    if (error) throw error;

    const rows = (data as unknown as MovRow[]).filter((r) => {
      const det = r.origem_detalhes ?? {};
      if (det.fluxo === "avulso") return true;
      if (MARCADORES_OUTROS_FLUXOS.some((k) => k in det)) return false;
      // Legado sem carimbo: avulso sempre tem fornecedor (a API exige).
      return r.fornecedor_id != null;
    });

    // Flag de estorno: mov E estornada tem uma mov posterior com estorno_de.
    const movIds = rows.map((r) => r.id);
    const estornadas = new Set<string>();
    if (movIds.length > 0) {
      const { data: est, error: estErr } = await sb
        .from("siso_movimentacoes")
        .select("estorno_de")
        .in("estorno_de", movIds);
      if (estErr) throw estErr;
      for (const e of (est ?? []) as { estorno_de: string }[]) {
        estornadas.add(e.estorno_de);
      }
    }

    const lotes = new Map<string, Lote>();
    for (const r of rows) {
      const det = r.origem_detalhes ?? {};
      let lote = lotes.get(r.origem_id);
      if (!lote) {
        lote = {
          lote_id: r.origem_id,
          criado_em: r.criado_em,
          origem_tipo: r.origem_tipo,
          entrada_direta: det.entrada_direta === true,
          nf_referencia: (det.nf_referencia as string | undefined) ?? null,
          data_recebimento:
            (det.data_recebimento as string | undefined) ?? null,
          motivo: r.motivo,
          galpao: r.galpao?.nome ?? null,
          fornecedor: r.fornecedor?.nome ?? null,
          compradora: r.compradora?.nome ?? null,
          usuario: r.usuario?.nome ?? null,
          itens: [],
          total_qty: 0,
          total_valor: 0,
        };
        lotes.set(r.origem_id, lote);
      }
      const estornado = estornadas.has(r.id);
      const qty = Number(r.quantidade);
      const custo =
        r.custo_unitario != null ? Number(r.custo_unitario) : null;
      lote.itens.push({
        mov_id: r.id,
        sku: r.produto?.sku ?? null,
        descricao: r.produto?.descricao ?? null,
        qty,
        custo_unitario: custo,
        localizacao: r.localizacao?.codigo ?? null,
        estornado,
      });
      if (!estornado) {
        lote.total_qty += qty;
        lote.total_valor += custo != null ? qty * custo : 0;
      }
    }

    return NextResponse.json({
      lotes: Array.from(lotes.values()),
      // true = janela de movs cheia; lotes mais antigos podem existir
      // (aumentar ?limit= pra ver mais).
      limite_atingido: (data?.length ?? 0) >= limit,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.receber.historico",
      error: e,
      requestPath: "/api/wms/receber/historico",
      requestMethod: "GET",
      metadata: { galpao_id: galpaoId, limit },
    });
  }
}
