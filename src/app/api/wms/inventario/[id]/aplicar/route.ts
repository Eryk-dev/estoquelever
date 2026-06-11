import { NextRequest, NextResponse } from "next/server";
import { aplicarSessao } from "@/lib/wms/inventario";
import { requireAuth } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

// Aplicar uma sessão escreve movs no ledger e mexe no saldo real.
// [P2-INV-04] Gate por inventario.supervisionar (o botão na UI usa a MESMA
// perm). Antes exigia requireAdmin → supervisor não-admin tomava 403 garantido
// num botão que a UI mostrava pra ele.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "inventario.supervisionar")) {
    return NextResponse.json(
      { error: "requer permissão inventario.supervisionar" },
      { status: 403 },
    );
  }

  const { id } = await params;
  try {
    const r = await aplicarSessao(id, auth.user.id);

    // [P2-CST-01 — lado inventário] Um ganho de inventário gera mov E mas DENTRO
    // da RPC (não passa pelo gancho de mov E do ledger), então o reconciliador-oc
    // não dispara sozinho. Sem isso, pedidos OC parados cujo saldo agora cobre
    // ficam presos. Espelha o padrão de guarda/[id]/confirmar: fire-and-forget,
    // não-fatal. Só quando movs foram realmente geradas (re-aplicação idempotente
    // = 0 movs → nada a reconciliar).
    if (r.movsGeradas > 0) {
      void (async () => {
        try {
          const sb = createServiceClient();
          const { data: sess } = await sb
            .from("siso_inventario_sessoes")
            .select("galpao_id")
            .eq("id", id)
            .maybeSingle();
          const galpaoId = (sess as { galpao_id?: string } | null)?.galpao_id;
          if (!galpaoId) return;
          // Divergências aplicadas de ganho (delta>0) nesta sessão.
          const { data: ganhos } = await sb
            .from("siso_inventario_divergencias")
            .select("produto_id")
            .eq("sessao_id", id)
            .eq("status", "aplicada")
            .gt("delta", 0);
          const produtos = [
            ...new Set(
              ((ganhos ?? []) as Array<{ produto_id: string }>).map((g) => g.produto_id),
            ),
          ];
          if (produtos.length === 0) return;
          const { reconciliarEntradaEstoque } = await import(
            "@/lib/wms/reconciliador-oc"
          );
          for (const produtoId of produtos) {
            await reconciliarEntradaEstoque({ produtoId, galpaoId });
          }
        } catch (recErr) {
          logger.warn(
            "wms.inventario.aplicar",
            "reconciliador pós-ganho de inventário falhou (não-fatal)",
            {
              sessao_id: id,
              err: recErr instanceof Error ? recErr.message : String(recErr),
            },
          );
        }
      })();
    }

    return NextResponse.json(r);
  } catch (e) {
    // [INV-02/INV-04] PostgrestError não é Error instance — String(e) virava
    // "[object Object]" e o erro orientado da RPC (que nomeia a divergência
    // culpada / manda liberar reservas) nunca caía no 409. wmsErrorResponse
    // revela a mensagem em 4xx, então o supervisor vê qual linha rejeitar.
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "object" &&
            e !== null &&
            typeof (e as { message?: unknown }).message === "string"
          ? (e as { message: string }).message
          : String(e);
    const isSaldo = /saldo|insuficiente|reservado|inviável/i.test(msg);
    return wmsErrorResponse({
      source: "wms.inventario.aplicar",
      error: e,
      status: isSaldo ? 409 : 400,
      requestPath: `/api/wms/inventario/${id}/aplicar`,
      requestMethod: "POST",
      metadata: { sessao_id: id },
    });
  }
}
