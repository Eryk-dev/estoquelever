import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { PERMISSIONS, MODULOS_ORDEM, MODULOS_LABEL } from "@/lib/permissions";

/**
 * GET /api/wms/admin/permissoes
 *
 * Retorna o catálogo de permissões do registry em `src/lib/permissions.ts`,
 * agrupado por módulo. Usado pela UI de gestão de roles pra mostrar a matriz
 * de checkboxes.
 *
 * Auth: qualquer sessão válida. O catálogo é "público" pra autenticados —
 * a UI usa pra renderizar opções; o backend valida acesso real de cada
 * permissão em outros endpoints (e.g. PUT /api/wms/admin/roles/[id]/permissoes
 * só permite quem tem `sistema.roles`).
 */
export async function GET(request: Request) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });

  const grouped: Record<string, Array<{ codigo: string; label: string }>> = {};
  for (const codigo of Object.keys(PERMISSIONS) as Array<keyof typeof PERMISSIONS>) {
    const p = PERMISSIONS[codigo];
    if (!grouped[p.modulo]) grouped[p.modulo] = [];
    grouped[p.modulo].push({ codigo, label: p.label });
  }

  const modulos = MODULOS_ORDEM.map((m) => ({
    id: m,
    label: MODULOS_LABEL[m],
    permissoes: grouped[m] ?? [],
  }));

  return NextResponse.json({ modulos, total: Object.keys(PERMISSIONS).length });
}
