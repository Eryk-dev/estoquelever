import { NextRequest, NextResponse } from "next/server";
import { requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { obterPendencia } from "@/lib/wms/guarda";
import { imprimirEtiquetasProduto } from "@/lib/wms/etiqueta-produto-service";
import type { EtiquetaProdutoInput } from "@/lib/wms/zpl-produto";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/wms/guarda/imprimir-lote
 *
 * Body: { pendencia_ids: string[] }
 *
 * Imprime o maço inteiro de etiquetas pra uma lista de pendências, na
 * ordem dada. Cada pendência contribui qty_pendente etiquetas. Usado pela
 * tela de Recebimento ao confirmar o lote: gera todas as pendências e
 * dispara o lote de etiquetas pro operador colar antes de guardar.
 *
 * Pendências canceladas/totalmente guardadas são puladas (com warning).
 * Localização na etiqueta = sugestão de putaway por SKU (loc com saldo>0
 * que não seja RECEBIMENTO) ou a própria RECEBIMENTO se não houver outra.
 */
export async function POST(req: NextRequest) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const ids: unknown = body?.pendencia_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "pendencia_ids (array não vazio) é obrigatório" },
      { status: 400 },
    );
  }
  const pendenciaIds = ids.filter((x): x is string => typeof x === "string");
  if (pendenciaIds.length === 0) {
    return NextResponse.json(
      { error: "pendencia_ids deve conter strings" },
      { status: 400 },
    );
  }

  try {
    const sb = createServiceClient();
    const linhas: { etiqueta: EtiquetaProdutoInput; qty: number }[] = [];
    const ignorados: string[] = [];
    let galpaoId: string | null = null;

    for (const id of pendenciaIds) {
      const pend = await obterPendencia(id);
      if (!pend || pend.status === "cancelada" || pend.qty_pendente <= 0) {
        ignorados.push(id);
        continue;
      }
      if (!pend.produto) {
        ignorados.push(id);
        continue;
      }
      // Todas as pendências do lote precisam ser do mesmo galpão pra usar
      // a mesma impressora. Misturar não faria sentido operacional.
      if (galpaoId && galpaoId !== pend.galpao_id) {
        return NextResponse.json(
          { error: "todas as pendências precisam ser do mesmo galpão" },
          { status: 400 },
        );
      }
      galpaoId = pend.galpao_id;

      // Loc na etiqueta = melhor candidato de destino (loc com saldo do
      // mesmo SKU que não seja a própria RECEBIMENTO). Se nada, marca "—".
      const { data: existentes } = await sb
        .from("siso_estoque")
        .select("localizacao:siso_localizacoes(codigo)")
        .match({
          produto_id: pend.produto_id,
          empresa_dona_id: pend.empresa_dona_id,
          galpao_id: pend.galpao_id,
        })
        .gt("saldo", 0)
        .neq("localizacao_id", pend.localizacao_origem_id)
        .order("saldo", { ascending: false })
        .limit(1);
      type Lin = { localizacao?: { codigo?: string } };
      const candidato = ((existentes ?? []) as Lin[])[0];
      const localizacao = candidato?.localizacao?.codigo ?? "—";

      linhas.push({
        etiqueta: {
          sku: pend.produto.sku,
          descricao: pend.produto.descricao,
          localizacao,
        },
        qty: pend.qty_pendente,
      });
    }

    if (linhas.length === 0) {
      return NextResponse.json(
        { error: "nenhuma etiqueta pra imprimir", ignorados },
        { status: 400 },
      );
    }

    const result = await imprimirEtiquetasProduto({
      usuarioId: auth.user.id,
      galpaoId: galpaoId!,
      titulo: `Etiquetas recebimento (${linhas.length} linhas)`,
      linhas,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "falha ao imprimir", ignorados },
        { status: 502 },
      );
    }
    return NextResponse.json({ ...result, ignorados, ok: true });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.guarda.imprimir-lote",
      error: e,
      requestPath: "/api/wms/guarda/imprimir-lote",
      requestMethod: "POST",
    });
  }
}
