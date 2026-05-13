import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { obterPendencia } from "@/lib/wms/guarda";
import { imprimirEtiquetasProduto } from "@/lib/wms/etiqueta-produto-service";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/wms/guarda/[id]/imprimir
 *
 * Body: { qty?: number, localizacao_codigo?: string }
 *   - qty: default = qty_pendente da pendência
 *   - localizacao_codigo: default = sugestão de putaway ou origem
 *     (operador pode passar a loc destino já escolhida pra a etiqueta
 *     refletir onde a peça vai)
 *
 * Imprime N etiquetas (1 por unidade). Não muda status da pendência —
 * reimprimir é seguro/idempotente. O ledger não é tocado aqui.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const qtyOverride =
    body && typeof body.qty === "number" ? Number(body.qty) : undefined;
  const localizacaoCodigoOverride =
    body && typeof body.localizacao_codigo === "string"
      ? body.localizacao_codigo.trim()
      : undefined;

  try {
    const pend = await obterPendencia(id);
    if (!pend) {
      return NextResponse.json(
        { error: "pendência não encontrada" },
        { status: 404 },
      );
    }
    if (pend.status === "cancelada") {
      return NextResponse.json(
        { error: "pendência cancelada — não imprime etiquetas" },
        { status: 400 },
      );
    }
    if (!pend.produto) {
      return NextResponse.json(
        { error: "produto não encontrado pra pendência" },
        { status: 500 },
      );
    }

    const qty =
      qtyOverride && qtyOverride > 0
        ? Math.min(qtyOverride, pend.qty_pendente)
        : pend.qty_pendente;
    if (qty <= 0) {
      return NextResponse.json(
        { error: "qty deve ser > 0 (pendência já guardada)" },
        { status: 400 },
      );
    }

    // Resolve o código da loc pra etiqueta. Prioridade:
    //   1) override explícito do body
    //   2) loc destino decidida no recebimento (pend.localizacao_destino)
    //   3) sugestão dinâmica (loc com saldo>0 do mesmo SKU ≠ RECEBIMENTO)
    //   4) loc de origem como último recurso ("—" se nada)
    let localizacaoCodigo = localizacaoCodigoOverride;
    if (!localizacaoCodigo && pend.localizacao_destino?.codigo) {
      localizacaoCodigo = pend.localizacao_destino.codigo;
    }
    if (!localizacaoCodigo) {
      const sb = createServiceClient();
      const { data: existentes } = await sb
        .from("siso_estoque")
        .select("localizacao:siso_localizacoes(codigo, tipo)")
        .match({
          produto_id: pend.produto_id,
          empresa_dona_id: pend.empresa_dona_id,
          galpao_id: pend.galpao_id,
        })
        .gt("saldo", 0)
        .neq("localizacao_id", pend.localizacao_origem_id)
        .order("saldo", { ascending: false })
        .limit(1);
      type LocExistente = { localizacao?: { codigo?: string; tipo?: string } };
      const lista = (existentes ?? []) as LocExistente[];
      const candidato = lista[0];
      localizacaoCodigo =
        candidato?.localizacao?.codigo ??
        pend.localizacao_origem?.codigo ??
        "—";
    }

    const result = await imprimirEtiquetasProduto({
      usuarioId: auth.user.id,
      galpaoId: pend.galpao_id,
      titulo: `Etiquetas ${pend.produto.sku} (${qty} un)`,
      linhas: [
        {
          etiqueta: {
            sku: pend.produto.sku,
            descricao: pend.produto.descricao,
            localizacao: localizacaoCodigo,
          },
          qty,
        },
      ],
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "falha ao imprimir" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ...result, ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.guarda.imprimir",
      error: e,
      requestPath: `/api/wms/guarda/${id}/imprimir`,
      requestMethod: "POST",
      metadata: { pendencia_id: id },
    });
  }
}
