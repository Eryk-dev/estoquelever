import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";

/**
 * GET /api/pedidos/[id]/observacoes
 * Returns all observations for a given order, newest last.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
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
 * POST /api/pedidos/[id]/observacoes
 * Create a new observation. Body: { usuarioId, usuarioNome, texto }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: pedidoId } = await params;
  const body = await request.json();
  const { usuarioId, usuarioNome, texto } = body as {
    usuarioId?: string;
    usuarioNome?: string;
    texto?: string;
  };

  if (!usuarioId || !usuarioNome || !texto?.trim()) {
    return NextResponse.json(
      { error: "usuarioId, usuarioNome e texto são obrigatórios" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("siso_pedido_observacoes")
    .insert({
      pedido_id: pedidoId,
      usuario_id: usuarioId,
      usuario_nome: usuarioNome,
      texto: texto.trim(),
    })
    .select()
    .single();

  if (error) {
    logger.error("observacoes", "Failed to create observation", {
      pedidoId,
      usuarioId,
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
