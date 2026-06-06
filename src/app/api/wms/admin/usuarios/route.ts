import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

const VALID_CARGOS = ["admin", "operador", "operador_cwb", "operador_sp", "comprador", "vendedor"];

/**
 * GET /api/admin/usuarios
 * Lists all users with their galpão associations (without exposing PIN).
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_usuarios")
    .select("id, nome, cargo, cargos, ativo, foto_url, criado_em, atualizado_em, printnode_printer_id, printnode_printer_nome, printnode_account_id, printnode_printer_id_produto, printnode_printer_nome_produto, printnode_account_id_produto")
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
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

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
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

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
    printnode_account_id?: string | null;
    printnode_printer_id_produto?: number | null;
    printnode_printer_nome_produto?: string | null;
    printnode_account_id_produto?: string | null;
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

  // Anti-lockout (P136): não desativar o último admin ativo. Só dispara quando
  // ativo===false explicitamente (o PUT genérico também serve printnode/galpoes/cargos).
  // Nota: TOCTOU — duas desativações concorrentes de 2 admins distintos podem passar
  // ambas (sem lock de banco). Aceito no volume atual (decisão D: app-layer, sem advisory lock).
  if (rest.ativo === false) {
    const { data: alvoEhAdmin, error: errAlvo } = await supabase
      .from("siso_usuario_roles")
      .select("usuario_id, siso_roles!inner(codigo)")
      .eq("usuario_id", id)
      .eq("siso_roles.codigo", "admin")
      .maybeSingle();
    if (errAlvo) return NextResponse.json({ erro: errAlvo.message }, { status: 500 });

    if (alvoEhAdmin) {
      const { data: outrosAdmins, error: errOutros } = await supabase
        .from("siso_usuario_roles")
        .select("usuario_id, siso_usuarios!inner(ativo), siso_roles!inner(codigo)")
        .eq("siso_roles.codigo", "admin")
        .eq("siso_usuarios.ativo", true)
        .neq("usuario_id", id);
      if (errOutros) return NextResponse.json({ erro: errOutros.message }, { status: 500 });

      if (!outrosAdmins || outrosAdmins.length === 0) {
        return NextResponse.json(
          { erro: "Sistema precisa de pelo menos 1 admin ativo" },
          { status: 409 },
        );
      }
    }
  }

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
 * Soft-delete: marca ativo=false e renomeia pra liberar UNIQUE(nome). Preserva
 * auditoria — não tem como hard-delete usuário com histórico (FKs em
 * siso_movimentacoes, inventário, pedidos etc. sem ON DELETE).
 */
export async function DELETE(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.usuarios")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Remove vínculos de galpão (impede que usuário desativado ainda apareça em queries
  // que filtram por galpao). Tabela tem ON DELETE CASCADE — mas como não estamos mais
  // deletando, fazemos manualmente.
  await supabase.from("siso_usuario_galpoes").delete().eq("usuario_id", id);

  const sufixo = `_excluido_${Math.floor(Date.now() / 1000)}`;
  const { data: atual } = await supabase
    .from("siso_usuarios")
    .select("nome, ativo")
    .eq("id", id)
    .single();

  if (!atual) {
    return NextResponse.json({ erro: "usuário não encontrado" }, { status: 404 });
  }

  // Anti-lockout (P136): o soft-delete seta ativo=false — mesmo vetor de lockout do PUT.
  // Só protege quando o alvo está ATIVO e é o último admin ativo.
  // Nota: TOCTOU — ver comentário equivalente no PUT handler.
  if (atual.ativo === true) {
    const { data: alvoEhAdmin, error: errAlvo } = await supabase
      .from("siso_usuario_roles")
      .select("usuario_id, siso_roles!inner(codigo)")
      .eq("usuario_id", id)
      .eq("siso_roles.codigo", "admin")
      .maybeSingle();
    if (errAlvo) return NextResponse.json({ erro: errAlvo.message }, { status: 500 });

    if (alvoEhAdmin) {
      const { data: outrosAdmins, error: errOutros } = await supabase
        .from("siso_usuario_roles")
        .select("usuario_id, siso_usuarios!inner(ativo), siso_roles!inner(codigo)")
        .eq("siso_roles.codigo", "admin")
        .eq("siso_usuarios.ativo", true)
        .neq("usuario_id", id);
      if (errOutros) return NextResponse.json({ erro: errOutros.message }, { status: 500 });

      if (!outrosAdmins || outrosAdmins.length === 0) {
        return NextResponse.json(
          { erro: "Sistema precisa de pelo menos 1 admin ativo" },
          { status: 409 },
        );
      }
    }
  }

  // Idempotente: se já foi excluído (nome já tem o sufixo), não renomeia de novo.
  const novoNome = atual.nome.includes("_excluido_")
    ? atual.nome
    : `${atual.nome}${sufixo}`;

  const { error } = await supabase
    .from("siso_usuarios")
    .update({ nome: novoNome, ativo: false, atualizado_em: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
