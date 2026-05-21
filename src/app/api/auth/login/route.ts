import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * POST /api/auth/login
 * Body: { nome: string, pin: string }
 * Returns: { ok: true, usuario: { id, nome, cargo, cargos, galpoes }, sessionId? }
 */
export async function POST(request: NextRequest) {
  let body: { nome?: string; pin?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, erro: "JSON inválido" }, { status: 400 });
  }

  const { nome, pin } = body;
  if (!nome || !pin) {
    return NextResponse.json(
      { ok: false, erro: "Nome e PIN são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data: usuario, error } = await supabase
    .from("siso_usuarios")
    .select("id, nome, pin, cargo, cargos, ativo")
    .eq("nome", nome)
    .single();

  if (error || !usuario) {
    return NextResponse.json(
      { ok: false, erro: "Usuário não encontrado" },
      { status: 401 },
    );
  }

  if (!usuario.ativo) {
    return NextResponse.json(
      { ok: false, erro: "Usuário desativado" },
      { status: 403 },
    );
  }

  if (usuario.pin !== pin) {
    return NextResponse.json(
      { ok: false, erro: "PIN incorreto" },
      { status: 401 },
    );
  }

  // Fetch user's allowed galpões from siso_usuario_galpoes
  const { data: userGalpoes } = await supabase
    .from("siso_usuario_galpoes")
    .select("galpao_id, siso_galpoes(id, nome)")
    .eq("usuario_id", usuario.id);

  const galpoes = (userGalpoes ?? [])
    .map((ug) => {
      const g = ug.siso_galpoes as unknown as { id: string; nome: string } | null;
      return g ? { id: g.id, nome: g.nome } : null;
    })
    .filter((galpao): galpao is { id: string; nome: string } => galpao !== null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  // Create server-side session
  let sessionId: string | undefined;
  const { data: sessao, error: sessaoError } = await supabase
    .from("siso_sessoes")
    .insert({ usuario_id: usuario.id })
    .select("id")
    .single();

  if (sessaoError || !sessao) {
    logger.error("auth/login", "Failed to create session", {
      usuarioId: usuario.id,
      error: sessaoError?.message,
    });
    return NextResponse.json(
      { ok: false, erro: "Nao foi possivel iniciar a sessao. Tente novamente." },
      { status: 500 },
    );
  }
  sessionId = sessao.id;

  // Roles + permissões ativas (RBAC dinâmico — 2026-05-21)
  const { data: rolesRows, error: rolesError } = await supabase
    .from("siso_usuario_roles")
    .select("siso_roles(id, codigo, nome, ativo, siso_role_permissoes(permissao_codigo))")
    .eq("usuario_id", usuario.id);

  if (rolesError) {
    logger.error("auth/login", "Failed to load roles for login", {
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
      logger.error("auth/login", "Failed to load fallback roles by cargos", {
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
    ok: true,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
      cargos: usuario.cargos?.length ? usuario.cargos : [usuario.cargo],
      roles,
      permissoes: Array.from(permsSet),
      galpoes,
    },
    ...(sessionId && { sessionId }),
  });
}
