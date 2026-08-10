import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { loadUserRolesAndPermissions } from "@/lib/roles-loader";

/**
 * GET /api/auth/me
 *
 * Retorna o usuário atual com dados frescos do banco (cargos, ativo,
 * galpões via siso_usuario_galpoes). Usado pelo AuthProvider.refreshUser()
 * pra atualizar o seletor de galpão depois de criar/editar galpão sem
 * forçar re-login.
 *
 * Header: X-Session-Id obrigatório.
 */
export async function GET(request: NextRequest) {
  const sessionId = request.headers.get("X-Session-Id");
  if (!sessionId) {
    return NextResponse.json({ error: "Sem sessão" }, { status: 401 });
  }

  const supabase = createServiceClient();

  // Valida sessão + checa expiração (alinhado com session.ts).
  const { data: sessao, error: sessaoError } = await supabase
    .from("siso_sessoes")
    .select("usuario_id")
    .eq("id", sessionId)
    .gt("expira_em", new Date().toISOString())
    .maybeSingle();

  if (sessaoError || !sessao) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { data: usuario, error: userError } = await supabase
    .from("siso_usuarios")
    .select("id, nome, cargo, cargos, ativo")
    .eq("id", sessao.usuario_id)
    .single();

  if (userError || !usuario) {
    return NextResponse.json({ error: "Usuário não encontrado" }, { status: 404 });
  }

  if (!usuario.ativo) {
    return NextResponse.json({ error: "Usuário desativado" }, { status: 403 });
  }

  // Galpões via siso_usuario_galpoes — fonte de verdade pro seletor.
  const { data: userGalpoes } = await supabase
    .from("siso_usuario_galpoes")
    .select("galpao_id, pode_editar, siso_galpoes(id, nome, ativo)")
    .eq("usuario_id", usuario.id);

  const galpoes = (userGalpoes ?? [])
    .map((ug) => {
      const g = ug.siso_galpoes as unknown as {
        id: string;
        nome: string;
        ativo: boolean;
      } | null;
      // Filtra galpões desativados — operador não deve ver galpão off
      if (!g || !g.ativo) return null;
      return { id: g.id, nome: g.nome, pode_editar: ug.pode_editar ?? true };
    })
    .filter((galpao): galpao is { id: string; nome: string; pode_editar: boolean } => galpao !== null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  // Roles + permissões ativas (RBAC dinâmico — 2026-05-21)
  const { roles, permissoes: permsSet } = await loadUserRolesAndPermissions(
    supabase,
    usuario,
    "auth/me",
  );

  return NextResponse.json({
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      // cargo/cargos vem direto do DB — o trigger trg_sync_cargos_after_roles
      // mantém em sincronia com siso_usuario_roles, então é equivalente a
      // roles.map(r => r.codigo). Mantemos por compat com consumidores legados.
      cargo: usuario.cargo,
      cargos: usuario.cargos?.length ? usuario.cargos : [usuario.cargo],
      roles,
      permissoes: Array.from(permsSet),
      galpoes,
    },
  });
}
