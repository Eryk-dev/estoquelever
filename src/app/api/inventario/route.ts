import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/inventario
 *
 * List inventory sessions with computed item counts.
 * Query params:
 *   - status: filter by inventory status (optional)
 *
 * Galpão filtering: if user has galpaoId, only shows inventarios
 * where galpao_id matches.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  const supabase = createServiceClient();

  try {
    // Build query with joins
    let query = supabase
      .from("siso_inventarios")
      .select(
        "id, empresa_id, galpao_id, usuario_id, modo, tipo_estoque, manter_localizacao_antiga, status, observacoes, created_at, processado_em, concluido_em, deposito_id, empresa:siso_empresas(nome), galpao:siso_galpoes(nome), usuario:siso_usuarios(nome)",
      )
      .order("created_at", { ascending: false });

    // Filter by galpao if user has one
    if (session.galpaoId) {
      query = query.eq("galpao_id", session.galpaoId);
    }

    // Optional status filter
    if (statusFilter) {
      query = query.eq("status", statusFilter);
    }

    const { data: inventarios, error } = await query;

    if (error) {
      logger.error("inventario-list", "Erro ao listar inventários", {
        error: error.message,
      });
      return NextResponse.json(
        { error: "Erro ao listar inventários" },
        { status: 500 },
      );
    }

    if (!inventarios || inventarios.length === 0) {
      return NextResponse.json({ inventarios: [] });
    }

    // Compute item counts via separate COUNT queries per inventario
    const inventarioIds = inventarios.map((inv) => inv.id);

    const [totalResult, sucessoResult, erroResult] = await Promise.all([
      supabase
        .from("siso_inventario_itens")
        .select("inventario_id")
        .in("inventario_id", inventarioIds),
      supabase
        .from("siso_inventario_itens")
        .select("inventario_id")
        .in("inventario_id", inventarioIds)
        .eq("status", "sucesso"),
      supabase
        .from("siso_inventario_itens")
        .select("inventario_id")
        .in("inventario_id", inventarioIds)
        .eq("status", "erro"),
    ]);

    // Build count maps
    const totalMap = new Map<string, number>();
    const sucessoMap = new Map<string, number>();
    const erroMap = new Map<string, number>();

    for (const row of totalResult.data ?? []) {
      totalMap.set(row.inventario_id, (totalMap.get(row.inventario_id) ?? 0) + 1);
    }
    for (const row of sucessoResult.data ?? []) {
      sucessoMap.set(row.inventario_id, (sucessoMap.get(row.inventario_id) ?? 0) + 1);
    }
    for (const row of erroResult.data ?? []) {
      erroMap.set(row.inventario_id, (erroMap.get(row.inventario_id) ?? 0) + 1);
    }

    const result = inventarios.map((inv) => ({
      ...inv,
      total_itens: totalMap.get(inv.id) ?? 0,
      itens_sucesso: sucessoMap.get(inv.id) ?? 0,
      itens_erro: erroMap.get(inv.id) ?? 0,
    }));

    return NextResponse.json({ inventarios: result });
  } catch (err) {
    logger.error("inventario-list", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * POST /api/inventario
 *
 * Create a new inventory session.
 * Resolves galpao_id from empresa and deposito_id from tiny connection.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { empresa_id, modo, tipo_estoque, manter_localizacao_antiga, observacoes } = body;

    // Validate required fields
    if (!empresa_id) {
      return NextResponse.json(
        { error: "empresa_id é obrigatório" },
        { status: 400 },
      );
    }
    if (!modo) {
      return NextResponse.json(
        { error: "modo é obrigatório" },
        { status: 400 },
      );
    }
    if (modo === "loc_estoque" && !tipo_estoque) {
      return NextResponse.json(
        { error: "tipo_estoque obrigatório quando modo = loc_estoque" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // Resolve galpao_id from empresa
    const { data: empresa, error: empresaError } = await supabase
      .from("siso_empresas")
      .select("galpao_id")
      .eq("id", empresa_id)
      .single();

    if (empresaError || !empresa) {
      return NextResponse.json(
        { error: "Empresa não encontrada" },
        { status: 400 },
      );
    }

    // Resolve deposito_id from tiny connection
    const { data: connection } = await supabase
      .from("siso_tiny_connections")
      .select("deposito_id")
      .eq("empresa_id", empresa_id)
      .eq("ativo", true)
      .maybeSingle();

    if (!connection?.deposito_id) {
      return NextResponse.json(
        { error: "Depósito não configurado para esta empresa" },
        { status: 400 },
      );
    }

    // Insert inventory session
    const { data: inventario, error: insertError } = await supabase
      .from("siso_inventarios")
      .insert({
        empresa_id,
        galpao_id: empresa.galpao_id,
        usuario_id: session.id,
        deposito_id: connection.deposito_id,
        modo,
        tipo_estoque: modo === "loc_estoque" ? tipo_estoque : null,
        manter_localizacao_antiga: manter_localizacao_antiga ?? false,
        observacoes: observacoes || null,
        status: "em_andamento",
      })
      .select("id, empresa_id, galpao_id, deposito_id, modo, status")
      .single();

    if (insertError) {
      logger.error("inventario-create", "Erro ao criar inventário", {
        error: insertError.message,
      });
      return NextResponse.json(
        { error: "Erro ao criar inventário" },
        { status: 500 },
      );
    }

    logger.info("inventario-create", "Inventário criado", {
      inventarioId: inventario.id,
      empresaId: empresa_id,
      modo,
    });

    return NextResponse.json(inventario, { status: 201 });
  } catch (err) {
    logger.error("inventario-create", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
