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
    .filter(Boolean) as { id: string; nome: string }[];

  // Create server-side session
  let sessionId: string | undefined;
  const { data: sessao, error: sessaoError } = await supabase
    .from("siso_sessoes")
    .insert({ usuario_id: usuario.id })
    .select("id")
    .single();

  if (sessaoError || !sessao) {
    logger.warn("auth/login", "Failed to create session, continuing without", {
      usuarioId: usuario.id,
      error: sessaoError?.message,
    });
  } else {
    sessionId = sessao.id;
  }

  return NextResponse.json({
    ok: true,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
      cargos: usuario.cargos?.length ? usuario.cargos : [usuario.cargo],
      galpoes,
    },
    ...(sessionId && { sessionId }),
  });
}
