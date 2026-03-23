import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/transferencia
 *
 * List transfer sessions with computed item counts.
 * Query params:
 *   - status: filter by transfer status (optional)
 *
 * Galpao filtering: user sees transfers where their galpao
 * is either origin OR destination.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");

  const supabase = createServiceClient();

  try {
    let query = supabase
      .from("siso_transferencias")
      .select(
        "id, empresa_origem_id, empresa_destino_id, galpao_origem_id, galpao_destino_id, usuario_id, deposito_origem_id, deposito_destino_id, status, observacoes, created_at, processado_em, concluido_em, empresa_origem:siso_empresas!empresa_origem_id(nome), empresa_destino:siso_empresas!empresa_destino_id(nome), galpao_origem:siso_galpoes!galpao_origem_id(nome), galpao_destino:siso_galpoes!galpao_destino_id(nome), usuario:siso_usuarios(nome)",
      )
      .order("created_at", { ascending: false });

    // Filter by galpao — user sees where their galpao is origin OR destination
    if (session.galpaoId) {
      query = query.or(
        `galpao_origem_id.eq.${session.galpaoId},galpao_destino_id.eq.${session.galpaoId}`,
      );
    }

    if (statusFilter) {
      query = query.eq("status", statusFilter);
    }

    const { data: transferencias, error } = await query;

    if (error) {
      logger.error("transferencia-list", "Erro ao listar transferencias", {
        error: error.message,
      });
      return NextResponse.json(
        { error: "Erro ao listar transferencias" },
        { status: 500 },
      );
    }

    if (!transferencias || transferencias.length === 0) {
      return NextResponse.json({ transferencias: [] });
    }

    // Compute item counts
    const transferenciaIds = transferencias.map((t) => t.id);

    const [totalResult, sucessoResult, erroResult] = await Promise.all([
      supabase
        .from("siso_transferencia_itens")
        .select("transferencia_id")
        .in("transferencia_id", transferenciaIds),
      supabase
        .from("siso_transferencia_itens")
        .select("transferencia_id")
        .in("transferencia_id", transferenciaIds)
        .eq("status", "sucesso"),
      supabase
        .from("siso_transferencia_itens")
        .select("transferencia_id")
        .in("transferencia_id", transferenciaIds)
        .eq("status", "erro"),
    ]);

    const totalMap = new Map<string, number>();
    const sucessoMap = new Map<string, number>();
    const erroMap = new Map<string, number>();

    for (const row of totalResult.data ?? []) {
      totalMap.set(
        row.transferencia_id,
        (totalMap.get(row.transferencia_id) ?? 0) + 1,
      );
    }
    for (const row of sucessoResult.data ?? []) {
      sucessoMap.set(
        row.transferencia_id,
        (sucessoMap.get(row.transferencia_id) ?? 0) + 1,
      );
    }
    for (const row of erroResult.data ?? []) {
      erroMap.set(
        row.transferencia_id,
        (erroMap.get(row.transferencia_id) ?? 0) + 1,
      );
    }

    const result = transferencias.map((t) => ({
      ...t,
      total_itens: totalMap.get(t.id) ?? 0,
      itens_sucesso: sucessoMap.get(t.id) ?? 0,
      itens_erro: erroMap.get(t.id) ?? 0,
    }));

    return NextResponse.json({ transferencias: result });
  } catch (err) {
    logger.error("transferencia-list", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * POST /api/transferencia
 *
 * Create a new transfer session.
 * Validates: origem != destino, resolves galpoes + depositos from empresas.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessao invalida" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { empresa_origem_id, empresa_destino_id, observacoes } = body;

    if (!empresa_origem_id) {
      return NextResponse.json(
        { error: "empresa_origem_id e obrigatorio" },
        { status: 400 },
      );
    }
    if (!empresa_destino_id) {
      return NextResponse.json(
        { error: "empresa_destino_id e obrigatorio" },
        { status: 400 },
      );
    }
    if (empresa_origem_id === empresa_destino_id) {
      return NextResponse.json(
        { error: "Origem e destino devem ser diferentes" },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // Resolve galpoes from empresas
    const [origemResult, destinoResult] = await Promise.all([
      supabase
        .from("siso_empresas")
        .select("galpao_id")
        .eq("id", empresa_origem_id)
        .single(),
      supabase
        .from("siso_empresas")
        .select("galpao_id")
        .eq("id", empresa_destino_id)
        .single(),
    ]);

    if (origemResult.error || !origemResult.data) {
      return NextResponse.json(
        { error: "Empresa origem nao encontrada" },
        { status: 400 },
      );
    }
    if (destinoResult.error || !destinoResult.data) {
      return NextResponse.json(
        { error: "Empresa destino nao encontrada" },
        { status: 400 },
      );
    }

    // Resolve deposito_ids from tiny connections
    const [connOrigem, connDestino] = await Promise.all([
      supabase
        .from("siso_tiny_connections")
        .select("deposito_id")
        .eq("empresa_id", empresa_origem_id)
        .eq("ativo", true)
        .maybeSingle(),
      supabase
        .from("siso_tiny_connections")
        .select("deposito_id")
        .eq("empresa_id", empresa_destino_id)
        .eq("ativo", true)
        .maybeSingle(),
    ]);

    if (!connOrigem.data?.deposito_id) {
      return NextResponse.json(
        { error: "Deposito nao configurado para empresa origem" },
        { status: 400 },
      );
    }
    if (!connDestino.data?.deposito_id) {
      return NextResponse.json(
        { error: "Deposito nao configurado para empresa destino" },
        { status: 400 },
      );
    }

    const { data: transferencia, error: insertError } = await supabase
      .from("siso_transferencias")
      .insert({
        empresa_origem_id,
        empresa_destino_id,
        galpao_origem_id: origemResult.data.galpao_id,
        galpao_destino_id: destinoResult.data.galpao_id,
        usuario_id: session.id,
        deposito_origem_id: connOrigem.data.deposito_id,
        deposito_destino_id: connDestino.data.deposito_id,
        observacoes: observacoes || null,
        status: "em_andamento",
      })
      .select(
        "id, empresa_origem_id, empresa_destino_id, galpao_origem_id, galpao_destino_id, deposito_origem_id, deposito_destino_id, status",
      )
      .single();

    if (insertError) {
      logger.error("transferencia-create", "Erro ao criar transferencia", {
        error: insertError.message,
      });
      return NextResponse.json(
        { error: "Erro ao criar transferencia" },
        { status: 500 },
      );
    }

    logger.info("transferencia-create", "Transferencia criada", {
      transferenciaId: transferencia.id,
      empresaOrigemId: empresa_origem_id,
      empresaDestinoId: empresa_destino_id,
    });

    return NextResponse.json(transferencia, { status: 201 });
  } catch (err) {
    logger.error("transferencia-create", "Erro inesperado", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
