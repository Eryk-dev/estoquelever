import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/wms/pedidos/[id]/observacoes
 * Returns all observations for a given order, newest last.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth + perm (finding 1.7)
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "pedidos.ver")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: pedidoId } = await params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("siso_pedido_observacoes")
    .select("*")
    .eq("pedido_id", pedidoId)
    .order("criado_em", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = (data ?? []).map((row) => ({
    id: row.id,
    pedidoId: row.pedido_id,
    usuarioId: row.usuario_id,
    usuarioNome: row.usuario_nome,
    texto: row.texto,
    criadoEm: row.criado_em,
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/wms/pedidos/[id]/observacoes
 * Create a new observation. Body: { texto } — usuarioId/usuarioNome are
 * derived from the session (impersonation protection).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth + perm (finding 1.7)
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userCan(session, "pedidos.ver")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: pedidoId } = await params;
  const body = await request.json();
  const { texto } = body as { texto?: string };

  if (!texto?.trim()) {
    return NextResponse.json({ error: "texto é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_pedido_observacoes")
    .insert({
      pedido_id: pedidoId,
      usuario_id: session.id,     // from session — ignore body
      usuario_nome: session.nome, // from session — ignore body
      texto: texto.trim(),
    })
    .select()
    .single();

  if (error) {
    logger.error("observacoes", "Failed to create observation", {
      pedidoId,
      usuarioId: session.id,
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    id: data.id,
    pedidoId: data.pedido_id,
    usuarioId: data.usuario_id,
    usuarioNome: data.usuario_nome,
    texto: data.texto,
    criadoEm: data.criado_em,
  });
}
