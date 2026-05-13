import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

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

  return NextResponse.json({
    usuario: {
      id: usuario.id,
      nome: usuario.nome,
      cargo: usuario.cargo,
      cargos: usuario.cargos?.length ? usuario.cargos : [usuario.cargo],
      galpoes,
    },
  });
}
