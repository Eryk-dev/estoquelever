import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

/**
 * GET /api/admin/usuarios
 * Lists all users (without exposing PIN).
 */
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .select("id, nome, cargo, ativo, criado_em, atualizado_em, printnode_printer_id, printnode_printer_nome")
    .order("criado_em", { ascending: true });

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

/**
 * POST /api/admin/usuarios
 * Creates a new user.
 * Body: { nome, pin, cargo }
 */
export async function POST(request: NextRequest) {
  let body: { nome?: string; pin?: string; cargo?: string };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { nome, pin, cargo } = body;
  if (!nome || !pin || !cargo) {
    return NextResponse.json(
      { erro: "nome, pin e cargo são obrigatórios" },
      { status: 400 },
    );
  }

  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return NextResponse.json(
      { erro: "PIN deve ter exatamente 4 dígitos" },
      { status: 400 },
    );
  }

  const validCargos = ["admin", "operador_cwb", "operador_sp", "comprador"];
  if (!validCargos.includes(cargo)) {
    return NextResponse.json(
      { erro: `Cargo inválido. Use: ${validCargos.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .insert({ nome, pin, cargo })
    .select("id, nome, cargo, ativo, criado_em")
    .single();

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

/**
 * PUT /api/admin/usuarios
 * Updates a user.
 * Body: { id, nome?, pin?, cargo?, ativo? }
 */
export async function PUT(request: NextRequest) {
  let body: {
    id?: string;
    nome?: string;
    pin?: string;
    cargo?: string;
    ativo?: boolean;
    printnode_printer_id?: number | null;
    printnode_printer_nome?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { id, ...updates } = body;
  if (!id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }

  if (updates.pin && (updates.pin.length !== 4 || !/^\d{4}$/.test(updates.pin))) {
    return NextResponse.json(
      { erro: "PIN deve ter exatamente 4 dígitos" },
      { status: 400 },
    );
  }

  const validCargos = ["admin", "operador_cwb", "operador_sp", "comprador"];
  if (updates.cargo && !validCargos.includes(updates.cargo)) {
    return NextResponse.json(
      { erro: `Cargo inválido. Use: ${validCargos.join(", ")}` },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .update({ ...updates, atualizado_em: new Date().toISOString() })
    .eq("id", id)
    .select("id, nome, cargo, ativo, atualizado_em")
    .single();

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

/**
 * DELETE /api/admin/usuarios?id=<uuid>
 * Deletes a user permanently.
 */
export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { error } = await supabase.from("siso_usuarios").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
