import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listarImpressoras } from "@/lib/printnode";

/**
 * GET /api/wms/admin/printnode/printers
 *
 * Lista impressoras agregadas de TODAS as contas PrintNode ativas. O frontend
 * usa o resultado pra montar um dropdown agrupado por conta (optgroup).
 *
 * Resposta:
 *   [
 *     {
 *       accountId: string,
 *       accountLabel: string,
 *       printers: [{ id, name, computer, state }],
 *       error: string | null
 *     },
 *     ...
 *   ]
 *
 * Contas com erro de auth NÃO derrubam a resposta — vêm no array com `error`
 * preenchido e `printers: []`, pra UI mostrar o problema sem esconder o resto.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }
  if (!userCan(session, "sistema.conexoes")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  const { data: contas, error } = await supabase
    .from("siso_printnode_contas")
    .select("id, label, api_key")
    .eq("ativo", true)
    .order("label");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!contas || contas.length === 0) {
    return NextResponse.json([]);
  }

  const grupos = await Promise.all(
    contas.map(async (c) => {
      try {
        const printers = await listarImpressoras(c.api_key);
        return {
          accountId: c.id,
          accountLabel: c.label,
          printers,
          error: null as string | null,
        };
      } catch (err) {
        return {
          accountId: c.id,
          accountLabel: c.label,
          printers: [] as Awaited<ReturnType<typeof listarImpressoras>>,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return NextResponse.json(grupos);
}
