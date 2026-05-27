import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth, requireWarehouseAccess } from "@/lib/wms/auth";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { logger } from "@/lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();
  const [sessao, operadores, locs, contagens, divergencias] = await Promise.all([
    sb
      .from("siso_inventario_sessoes")
      .select("*, galpao:siso_galpoes(nome)")
      .eq("id", id)
      .single(),
    sb
      .from("siso_inventario_operadores")
      .select("*, usuario:siso_usuarios(nome, foto_url)")
      .eq("sessao_id", id)
      .order("entrou_em", { ascending: true }),
    sb
      .from("siso_inventario_localizacoes")
      .select(
        "*, localizacao:siso_localizacoes(codigo, tipo, zona), bloqueada_por_user:siso_usuarios!siso_inventario_localizacoes_bloqueada_por_fkey(nome)",
      )
      .eq("sessao_id", id),
    sb
      .from("siso_inventario_contagens")
      .select(
        "*, contada_por_user:siso_usuarios(nome), produto:siso_produtos(sku, descricao)",
      )
      .eq("sessao_id", id)
      .order("criado_em", { ascending: false }),
    sb
      .from("siso_inventario_divergencias")
      .select(
        "*, produto:siso_produtos(sku, descricao), localizacao:siso_localizacoes(codigo)",
      )
      .eq("sessao_id", id),
  ]);
  return NextResponse.json({
    sessao: sessao.data,
    operadores: operadores.data ?? [],
    localizacoes: locs.data ?? [],
    contagens: contagens.data ?? [],
    divergencias: divergencias.data ?? [],
  });
}

// Allowlist explícito de campos que o cliente pode editar.
// Sem isso, body-spread direto permitia user pular workflow
// inteiro com PATCH { status: 'aplicada' }.
interface PatchSessaoBody {
  nome?: string;
  modo_contagem?: "aberto" | "blind";
  tolerancia_pct?: number;
  exige_aprovacao_acima_valor?: number;
  observacoes?: string;
}

function pickPatchFields(body: unknown): PatchSessaoBody {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const out: PatchSessaoBody = {};
  if (typeof b.nome === "string") out.nome = b.nome;
  if (b.modo_contagem === "aberto" || b.modo_contagem === "blind") {
    out.modo_contagem = b.modo_contagem;
  }
  if (typeof b.tolerancia_pct === "number") out.tolerancia_pct = b.tolerancia_pct;
  if (typeof b.exige_aprovacao_acima_valor === "number") {
    out.exige_aprovacao_acima_valor = b.exige_aprovacao_acima_valor;
  }
  if (typeof b.observacoes === "string") out.observacoes = b.observacoes;
  return out;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const body = await req.json();
  const allowed = pickPatchFields(body);
  if (Object.keys(allowed).length === 0) {
    return NextResponse.json(
      { error: "nenhum campo válido pra atualizar" },
      { status: 400 },
    );
  }
  const sb = createServiceClient();

  // P3 #4.7: modo_contagem só pode ser alterado em sessão 'planejada'.
  // Se a sessão já iniciou, mudar blind↔aberto no meio quebra a semântica
  // das contagens já feitas pelos operadores. SELECT inclui campos extras
  // (nome, tolerancia_pct, etc.) pra também alimentar o diff logging abaixo.
  const { data: sessao, error: fetchError } = await sb
    .from("siso_inventario_sessoes")
    .select("status, nome, modo_contagem, tolerancia_pct, exige_aprovacao_acima_valor, observacoes")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) {
    return wmsErrorResponse({
      source: "wms.inventario.patch",
      error: fetchError,
      requestPath: `/api/wms/inventario/${id}`,
      requestMethod: "PATCH",
      metadata: { sessao_id: id },
    });
  }
  if (!sessao) {
    return NextResponse.json({ error: "sessão não encontrada" }, { status: 404 });
  }
  if (
    allowed.modo_contagem &&
    allowed.modo_contagem !== (sessao as { modo_contagem: string }).modo_contagem &&
    (sessao as { status: string }).status !== "planejada"
  ) {
    return NextResponse.json(
      {
        error: "modo_contagem só pode ser alterado em sessão 'planejada' (ainda não iniciada)",
        code: "MODO_LOCKED",
        status_atual: (sessao as { status: string }).status,
      },
      { status: 409 },
    );
  }
  // `before` é usado pra logar diff dos campos que mudaram (logging best-effort).
  const before = sessao;

  const { error } = await sb
    .from("siso_inventario_sessoes")
    .update(allowed)
    .eq("id", id);
  if (error) {
    return wmsErrorResponse({
      source: "wms.inventario.patch",
      error,
      requestPath: `/api/wms/inventario/${id}`,
      requestMethod: "PATCH",
      metadata: { sessao_id: id },
    });
  }

  // Loga diff dos campos que mudaram. Tracking de quem editou + de/pra.
  if (before) {
    const diff: Record<string, [unknown, unknown]> = {};
    const beforeMap = before as Record<string, unknown>;
    const afterMap = allowed as Record<string, unknown>;
    for (const k of Object.keys(afterMap)) {
      const b = beforeMap[k];
      const a = afterMap[k];
      if (a !== undefined && a !== b) diff[k] = [b, a];
    }
    if (Object.keys(diff).length > 0) {
      logger.info("wms.inventario.patch", "sessão atualizada", {
        sessao_id: id,
        diff,
        usuario_id: auth.user.id,
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWarehouseAccess(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const sb = createServiceClient();

  // P3 #4.4: sessão aplicada não pode ser cancelada. Operadora teria
  // que ESTORNAR (POST /estornar). Cancelar deletaria a trilha sem
  // reverter as movs no ledger — saldo ficaria inconsistente.
  const { data: sessao } = await sb
    .from("siso_inventario_sessoes")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!sessao) {
    return NextResponse.json({ error: "sessão não encontrada" }, { status: 404 });
  }
  if ((sessao as { status: string }).status === "aplicada") {
    return NextResponse.json(
      {
        error:
          "sessão já foi aplicada (movs no ledger). Use POST /api/wms/inventario/[id]/estornar para reverter.",
        code: "SESSAO_APLICADA",
      },
      { status: 409 },
    );
  }
  if ((sessao as { status: string }).status === "cancelada") {
    // Já cancelada — idempotente.
    return NextResponse.json({ ok: true });
  }

  const { data: locs } = await sb
    .from("siso_inventario_localizacoes")
    .select("localizacao_id")
    .eq("sessao_id", id);
  const locIds = ((locs ?? []) as Array<{ localizacao_id: string }>).map(
    (l) => l.localizacao_id,
  );
  if (locIds.length > 0) {
    await sb
      .from("siso_localizacao_locks")
      .update({ finalizado_em: new Date().toISOString() })
      .in("localizacao_id", locIds)
      .is("finalizado_em", null);
  }
  await sb
    .from("siso_inventario_sessoes")
    .update({ status: "cancelada" })
    .eq("id", id);
  return NextResponse.json({ ok: true });
}
