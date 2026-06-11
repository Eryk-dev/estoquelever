import { NextRequest, NextResponse } from "next/server";
import { classificarDevolucao, type Classificacao } from "@/lib/wms/devolucoes";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { logger } from "@/lib/logger";

/**
 * POST /api/wms/devolucoes/[id]/classificar
 *
 * Classifica uma devolução pendente em uma das 4 categorias e dispara as
 * movs no ledger via lib (`classificarDevolucao`). Em 3D não há mais
 * empresa dona — a empresa vendedora original viaja como tag em
 * `empresa_referencia_id` (resolvida automaticamente da mov original
 * quando omitida no body).
 *
 * Body:
 *   {
 *     classificacao: 'integro' | 'avariado' | 'garantia' | 'troca_sku',
 *     produto_id, galpao_id, localizacao_id, qty,
 *     empresa_referencia_id?,  // vendedora da NF original (opcional — auto-resolve)
 *     fornecedor_id?,          // obrigatório quando classificacao='garantia'
 *     observacoes?
 *   }
 */
interface ClassificarBody {
  classificacao: Classificacao;
  produto_id: string;
  galpao_id: string;
  localizacao_id: string;
  qty: number;
  empresa_referencia_id?: string;
  fornecedor_id?: string;
  observacoes?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth + perm granular (finding 6.2)
  const session = await getSessionUser(req);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!userCan(session, "operacoes.devolucoes_classificar")) {
    return NextResponse.json({ error: "forbidden — requer operacoes.devolucoes_classificar" }, { status: 403 });
  }
  const auth = { user: session };

  const { id } = await params;
  const body = (await req.json()) as ClassificarBody;
  try {
    await classificarDevolucao({
      devolucao_id: id,
      classificacao: body.classificacao,
      produto_id: body.produto_id,
      galpao_id: body.galpao_id,
      localizacao_id: body.localizacao_id,
      qty: body.qty,
      empresa_referencia_id: body.empresa_referencia_id,
      fornecedor_id: body.fornecedor_id,
      observacoes: body.observacoes,
      usuario_id: auth.user.id,
    });

    // [P2-CST-01] A E de devolução íntegra entra numa loc vendável (destino
    // escolhido pelo operador, tipicamente picking). A RPC wms_classificar_devolucao
    // NÃO passa pelo gancho de mov E do ledger.ts, então o reconciliador-oc
    // nunca rodaria — pedidos OC parados por falta ficariam presos mesmo com a
    // peça de volta na prateleira. Disparamos aqui (espelha guarda/confirmar):
    // fire-and-forget, não-fatal. 'avariado' vai pra quarentena (não vendável)
    // e 'garantia' sai pro fornecedor — nesses o reconciliador é no-op
    // (saldoLivre em picking = 0), mas só disparamos no 'integro' por clareza.
    if (body.classificacao === "integro") {
      void (async () => {
        try {
          const { reconciliarEntradaEstoque } = await import(
            "@/lib/wms/reconciliador-oc"
          );
          await reconciliarEntradaEstoque({
            produtoId: body.produto_id,
            galpaoId: body.galpao_id,
          });
        } catch (recErr) {
          logger.warn(
            "wms.devolucoes.classificar",
            "reconciliador pós-classificação falhou (não-fatal)",
            {
              devolucao_id: id,
              err: recErr instanceof Error ? recErr.message : String(recErr),
            },
          );
        }
      })();
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    // [P054] concorrência/lock → 409 (não 400). "não encontrada" segue 4xx.
    const msg = e instanceof Error ? e.message : String(e);
    const isConflict =
      !msg.includes("não encontrada") &&
      (msg.includes("já classificada") ||
        msg.includes("em classificação") ||
        msg.includes("could not obtain lock") ||
        msg.includes("deadlock"));
    return wmsErrorResponse({
      source: "wms.devolucoes.classificar",
      error: e,
      status: isConflict ? 409 : 400,
      requestPath: `/api/wms/devolucoes/${id}/classificar`,
      requestMethod: "POST",
      metadata: { devolucao_id: id, classificacao: body.classificacao },
    });
  }
}
