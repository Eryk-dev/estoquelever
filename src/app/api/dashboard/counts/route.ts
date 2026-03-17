import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/dashboard/counts
 *
 * Lightweight endpoint returning pending counts for each module card.
 * The separação badge follows the active separation galpão.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const isAdmin = session.cargos.includes("admin");
  const activeGalpaoId = session.galpaoId;

  if (!isAdmin && !activeGalpaoId) {
    return NextResponse.json({ siso: 0, separacao: 0, compras: 0 });
  }

  let activeGalpaoNome: string | null = null;
  let allowedEmpresaIds: string[] | null = null;

  if (activeGalpaoId) {
    const [{ data: galpao }, { data: empresas }] = await Promise.all([
      supabase.from("siso_galpoes").select("nome").eq("id", activeGalpaoId).maybeSingle(),
      supabase.from("siso_empresas").select("id").eq("galpao_id", activeGalpaoId),
    ]);

    activeGalpaoNome = galpao?.nome ?? null;
    allowedEmpresaIds = (empresas ?? []).map((empresa) => empresa.id);
  }

  const sisoPromise = activeGalpaoNome
    ? Promise.all([
        supabase
          .from("siso_pedidos")
          .select("*", { count: "exact", head: true })
          .eq("status", "pendente")
          .eq("filial_origem", activeGalpaoNome)
          .neq("sugestao", "transferencia"),
        supabase
          .from("siso_pedidos")
          .select("*", { count: "exact", head: true })
          .eq("status", "pendente")
          .eq("sugestao", "transferencia")
          .neq("filial_origem", activeGalpaoNome),
      ]).then(([local, transferencia]) => (local.count ?? 0) + (transferencia.count ?? 0))
    : supabase
        .from("siso_pedidos")
        .select("*", { count: "exact", head: true })
        .eq("status", "pendente")
        .then(({ count }) => count ?? 0);

  let separacaoQuery = supabase
    .from("siso_pedidos")
    .select("*", { count: "exact", head: true })
    .in("status_separacao", [
      "aguardando_separacao",
      "em_separacao",
      "separado",
    ]);

  if (activeGalpaoId) {
    separacaoQuery = separacaoQuery.eq("separacao_galpao_id", activeGalpaoId);
  }

  let comprasQuery = supabase
    .from("siso_pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status_separacao", "aguardando_compra");

  if (allowedEmpresaIds) {
    if (allowedEmpresaIds.length === 0) {
      return NextResponse.json({
        siso: await sisoPromise,
        separacao: 0,
        compras: 0,
      });
    }
    comprasQuery = comprasQuery.in("empresa_origem_id", allowedEmpresaIds);
  }

  const [siso, separacao, compras] = await Promise.all([
    sisoPromise,
    separacaoQuery,
    comprasQuery,
  ]);

  return NextResponse.json({
    siso,
    separacao: separacao.count ?? 0,
    compras: compras.count ?? 0,
  });
}
