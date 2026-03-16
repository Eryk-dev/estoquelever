import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

const VALID_CARGOS = ["admin", "operador_cwb", "operador_sp", "comprador"];

/**
 * GET /api/admin/usuarios
 * Lists all users (without exposing PIN).
 */
export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .select("id, nome, cargo, cargos, ativo, criado_em, atualizado_em, printnode_printer_id, printnode_printer_nome")
    .order("criado_em", { ascending: true });

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  // Ensure cargos is always populated (backward compat for rows not yet migrated)
  const normalized = (data ?? []).map((u) => ({
    ...u,
    cargos: u.cargos?.length ? u.cargos : [u.cargo],
  }));

  return NextResponse.json(normalized);
}

/**
 * POST /api/admin/usuarios
 * Creates a new user.
 * Body: { nome, pin, cargos } or legacy { nome, pin, cargo }
 */
export async function POST(request: NextRequest) {
  let body: { nome?: string; pin?: string; cargo?: string; cargos?: string[] };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { nome, pin } = body;
  const cargos = body.cargos?.length ? body.cargos : body.cargo ? [body.cargo] : [];

  if (!nome || !pin || cargos.length === 0) {
    return NextResponse.json(
      { erro: "nome, pin e pelo menos um cargo são obrigatórios" },
      { status: 400 },
    );
  }

  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return NextResponse.json(
      { erro: "PIN deve ter exatamente 4 dígitos" },
      { status: 400 },
    );
  }

  for (const c of cargos) {
    if (!VALID_CARGOS.includes(c)) {
      return NextResponse.json(
        { erro: `Cargo inválido: ${c}. Use: ${VALID_CARGOS.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .insert({ nome, pin, cargo: cargos[0], cargos })
    .select("id, nome, cargo, cargos, ativo, criado_em")
    .single();

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

/**
 * PUT /api/admin/usuarios
 * Updates a user.
 * Body: { id, nome?, pin?, cargos?, cargo?, ativo?, printnode_printer_id?, printnode_printer_nome? }
 */
export async function PUT(request: NextRequest) {
  let body: {
    id?: string;
    nome?: string;
    pin?: string;
    cargo?: string;
    cargos?: string[];
    ativo?: boolean;
    printnode_printer_id?: number | null;
    printnode_printer_nome?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { id, cargos: rawCargos, cargo: rawCargo, ...rest } = body;
  if (!id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }

  if (rest.pin && (rest.pin.length !== 4 || !/^\d{4}$/.test(rest.pin))) {
    return NextResponse.json(
      { erro: "PIN deve ter exatamente 4 dígitos" },
      { status: 400 },
    );
  }

  // Build update object
  const updates: Record<string, unknown> = { ...rest, atualizado_em: new Date().toISOString() };

  // Handle cargos update (prefer cargos array, fallback to single cargo)
  const newCargos = rawCargos?.length ? rawCargos : rawCargo ? [rawCargo] : null;
  if (newCargos) {
    for (const c of newCargos) {
      if (!VALID_CARGOS.includes(c)) {
        return NextResponse.json(
          { erro: `Cargo inválido: ${c}. Use: ${VALID_CARGOS.join(", ")}` },
          { status: 400 },
        );
      }
    }
    updates.cargos = newCargos;
    updates.cargo = newCargos[0]; // keep legacy column in sync
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .update(updates)
    .eq("id", id)
    .select("id, nome, cargo, cargos, ativo, atualizado_em")
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
