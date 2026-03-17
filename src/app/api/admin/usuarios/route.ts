import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";

const VALID_CARGOS = ["admin", "operador", "operador_cwb", "operador_sp", "comprador"];

/**
 * GET /api/admin/usuarios
 * Lists all users with their galpão associations (without exposing PIN).
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

  // Fetch galpão associations for all users
  const { data: allGalpoes } = await supabase
    .from("siso_usuario_galpoes")
    .select("usuario_id, galpao_id, siso_galpoes(id, nome)");

  // Build a map of usuario_id → galpões
  const galpaoMap = new Map<string, { id: string; nome: string }[]>();
  for (const ug of allGalpoes ?? []) {
    const g = ug.siso_galpoes as unknown as { id: string; nome: string } | null;
    if (!g) continue;
    if (!galpaoMap.has(ug.usuario_id)) galpaoMap.set(ug.usuario_id, []);
    galpaoMap.get(ug.usuario_id)!.push({ id: g.id, nome: g.nome });
  }

  // Ensure cargos is always populated (backward compat for rows not yet migrated)
  const normalized = (data ?? []).map((u) => ({
    ...u,
    cargos: u.cargos?.length ? u.cargos : [u.cargo],
    galpoes: galpaoMap.get(u.id) ?? [],
  }));

  return NextResponse.json(normalized);
}

/**
 * POST /api/admin/usuarios
 * Creates a new user with optional galpão associations.
 * Body: { nome, pin, cargos, galpao_ids? } or legacy { nome, pin, cargo }
 */
export async function POST(request: NextRequest) {
  let body: { nome?: string; pin?: string; cargo?: string; cargos?: string[]; galpao_ids?: string[] };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { nome, pin, galpao_ids } = body;
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

  // Insert galpão associations
  if (galpao_ids && galpao_ids.length > 0 && data) {
    const rows = galpao_ids.map((gid) => ({ usuario_id: data.id, galpao_id: gid }));
    await supabase.from("siso_usuario_galpoes").insert(rows);
  }

  return NextResponse.json(data, { status: 201 });
}

/**
 * PUT /api/admin/usuarios
 * Updates a user. If galpao_ids is provided, replaces all galpão associations.
 * Body: { id, nome?, pin?, cargos?, cargo?, ativo?, galpao_ids?, printnode_printer_id?, printnode_printer_nome? }
 */
export async function PUT(request: NextRequest) {
  let body: {
    id?: string;
    nome?: string;
    pin?: string;
    cargo?: string;
    cargos?: string[];
    ativo?: boolean;
    galpao_ids?: string[];
    printnode_printer_id?: number | null;
    printnode_printer_nome?: string | null;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const { id, cargos: rawCargos, cargo: rawCargo, galpao_ids, ...rest } = body;
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

  // Replace galpão associations if provided
  if (galpao_ids !== undefined) {
    // Delete existing
    await supabase.from("siso_usuario_galpoes").delete().eq("usuario_id", id);
    // Insert new
    if (galpao_ids.length > 0) {
      const rows = galpao_ids.map((gid) => ({ usuario_id: id, galpao_id: gid }));
      await supabase.from("siso_usuario_galpoes").insert(rows);
    }
  }

  return NextResponse.json(data);
}

/**
 * DELETE /api/admin/usuarios?id=<uuid>
 * Deletes a user permanently (galpão associations cascade).
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
