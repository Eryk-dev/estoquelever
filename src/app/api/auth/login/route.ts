import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * POST /api/auth/login
 * Body: { nome: string, pin: string }
 * Returns: { ok: true, usuario: { id, nome, cargo } }
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
    .select("id, nome, pin, cargo, ativo")
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

  return NextResponse.json({
    ok: true,
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
    },
  });
}
