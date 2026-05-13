import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAdmin } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { replenishmentIntraGalpao } from "@/lib/wms/movimentacoes";
import { desativarLocalizacao } from "@/lib/wms/localizacoes";

/**
 * Move TODO o saldo > 0 da loc origem pra loc destino (mesmo galpão),
 * agrupado por empresa_dona, e desativa a origem.
 *
 * Não é 100% atômico — cada par S+E é atômico via wms_inserir_movimentacao,
 * mas se falhar mid-flight, alguns SKUs já moveram e a loc origem não foi
 * desativada. Rodar de novo é seguro: o que já foi movido fica em saldo=0
 * na origem e é ignorado.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const { id: origemId } = await params;
  let body: { destino_id?: string };
  try {
    body = (await req.json()) as { destino_id?: string };
  } catch {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }
  const destinoId = body.destino_id;
  if (!destinoId) {
    return NextResponse.json(
      { error: "destino_id obrigatório" },
      { status: 400 },
    );
  }
  if (destinoId === origemId) {
    return NextResponse.json(
      { error: "destino não pode ser a mesma loc" },
      { status: 400 },
    );
  }

  const sb = createServiceClient();

  try {
    // Carrega origem + destino pra validar mesmo galpão e ambas ativas.
    const { data: locs, error: errLocs } = await sb
      .from("siso_localizacoes")
      .select("id, galpao_id, codigo, ativo")
      .in("id", [origemId, destinoId]);
    if (errLocs) throw errLocs;
    const origem = locs?.find((l) => l.id === origemId);
    const destino = locs?.find((l) => l.id === destinoId);
    if (!origem || !destino) {
      return NextResponse.json(
        { error: "localização origem ou destino não encontrada" },
        { status: 404 },
      );
    }
    if (!destino.ativo) {
      return NextResponse.json(
        { error: "loc destino está inativa" },
        { status: 400 },
      );
    }
    if (origem.galpao_id !== destino.galpao_id) {
      return NextResponse.json(
        { error: "loc origem e destino precisam estar no mesmo galpão" },
        { status: 400 },
      );
    }

    // Carrega saldos > 0 da origem, agrupa por empresa_dona.
    const { data: estoques, error: errEst } = await sb
      .from("siso_estoque")
      .select("produto_id, empresa_dona_id, saldo")
      .eq("localizacao_id", origemId)
      .gt("saldo", 0);
    if (errEst) throw errEst;

    const porDona = new Map<string, { produto_id: string; qty: number }[]>();
    for (const e of estoques ?? []) {
      const lista = porDona.get(e.empresa_dona_id) ?? [];
      lista.push({ produto_id: e.produto_id, qty: Number(e.saldo) });
      porDona.set(e.empresa_dona_id, lista);
    }

    // Move cada grupo (empresa_dona) — 1 chamada de replenishment por dona.
    let donasMovidas = 0;
    let itensMovidos = 0;
    for (const [empresa_id, itens] of porDona.entries()) {
      await replenishmentIntraGalpao({
        empresa_id,
        galpao_id: origem.galpao_id,
        localizacao_origem_id: origemId,
        localizacao_destino_id: destinoId,
        itens,
        usuario_id: auth.user.id,
      });
      donasMovidas += 1;
      itensMovidos += itens.length;
    }

    // Desativa a origem. Reusa o helper que valida saldo=0 (já é o caso agora).
    await desativarLocalizacao(origemId);

    return NextResponse.json({
      ok: true,
      origem_codigo: origem.codigo,
      destino_codigo: destino.codigo,
      donas_movidas: donasMovidas,
      itens_movidos: itensMovidos,
    });
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.localizacoes.substituir-e-excluir",
      error: e,
      status: 400,
      requestPath: `/api/wms/localizacoes/${origemId}/substituir-e-excluir`,
      requestMethod: "POST",
      metadata: { origem_id: origemId, destino_id: destinoId },
    });
  }
}
