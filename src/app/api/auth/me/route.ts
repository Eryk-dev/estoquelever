import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

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

  // Valida sessão (sem checar expiração — alinhar com session.ts: a coluna
  // expira_em existe mas a checagem é feita no validador legacy; aqui apenas
  // confirma que a sessão existe e pega usuario_id).
  const { data: sessao, error: sessaoError } = await supabase
    .from("siso_sessoes")
    .select("usuario_id")
    .eq("id", sessionId)
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
    .select("galpao_id, siso_galpoes(id, nome, ativo)")
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
      return { id: g.id, nome: g.nome };
    })
    .filter((galpao): galpao is { id: string; nome: string } => galpao !== null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  // Roles + permissões ativas (RBAC dinâmico — 2026-05-21)
  const { data: rolesRows, error: rolesError } = await supabase
    .from("siso_usuario_roles")
    .select("siso_roles(id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo))")
    .eq("usuario_id", usuario.id);

  if (rolesError) {
    logger.error("auth/me", "Failed to load roles for me", {
      usuarioId: usuario.id,
      error: rolesError.message,
    });
  }

  const roles: Array<{ id: string; codigo: string; nome: string }> = [];
  const permsSet = new Set<string>();
  for (const row of rolesRows ?? []) {
    const r = (row as unknown as {
      siso_roles: {
        id: string;
        codigo: string;
        nome: string;
        ativo: boolean;
        siso_role_permissoes: Array<{ permissao_codigo: string }>;
      } | null;
    }).siso_roles;
    if (!r || !r.ativo) continue;
    roles.push({ id: r.id, codigo: r.codigo, nome: r.nome });
    for (const rp of r.siso_role_permissoes ?? []) permsSet.add(rp.permissao_codigo);
  }

  // Fallback de compat: sem siso_usuario_roles ainda, busca por cargos[]
  if (roles.length === 0 && (usuario.cargos?.length || usuario.cargo)) {
    const codigos = usuario.cargos?.length ? usuario.cargos : [usuario.cargo];
    const { data: fallbackRoles, error: fallbackErr } = await supabase
      .from("siso_roles")
      .select("id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo)")
      .in("codigo", codigos);
    if (fallbackErr) {
      logger.error("auth/me", "Failed to load fallback roles by cargos", {
        usuarioId: usuario.id,
        cargos: codigos,
        error: fallbackErr.message,
      });
    }
    for (const r of fallbackRoles ?? []) {
      if (!r.ativo) continue;
      roles.push({ id: r.id, codigo: r.codigo, nome: r.nome });
      const rps = (r as unknown as { siso_role_permissoes: Array<{ permissao_codigo: string }> })
        .siso_role_permissoes;
      for (const rp of rps ?? []) permsSet.add(rp.permissao_codigo);
    }
  }

  return NextResponse.json({
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
      cargos: usuario.cargos?.length ? usuario.cargos : [usuario.cargo],
      roles,
      permissoes: Array.from(permsSet),
      galpoes,
    },
  });
}
