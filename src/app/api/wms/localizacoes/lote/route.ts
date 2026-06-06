import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { requireAuth } from "@/lib/wms/auth";
import { userCan } from "@/lib/permissions";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { gerarCodigosLote } from "@/lib/wms/localizacoes";
import type { TipoLocalizacao } from "@/lib/wms/types";

const TIPOS_VALIDOS: TipoLocalizacao[] = [
  "picking",
  "overstock",
  "recebimento",
  "expedicao",
  "quarentena",
];

type LoteBody = {
  galpao_id?: string;
  prefixo?: string;
  h_inicio?: number;
  h_fim?: number;
  v_inicio?: number;
  v_fim?: number;
  tipo?: string;
  preview?: boolean;
};

function amostraDe(codigos: string[]): {
  primeiras: string[];
  ultimas: string[];
} {
  if (codigos.length <= 10) {
    return { primeiras: codigos.slice(), ultimas: [] };
  }
  return {
    primeiras: codigos.slice(0, 5),
    ultimas: codigos.slice(-5),
  };
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  if (!userCan(auth.user, "localizacoes.editar")) {
    return NextResponse.json(
      { error: "requer permissão localizacoes.editar" },
      { status: 403 },
    );
  }

  let body: LoteBody;
  try {
    body = (await req.json()) as LoteBody;
  } catch {
    return NextResponse.json({ error: "body inválido" }, { status: 400 });
  }

  if (!body.galpao_id) {
    return NextResponse.json(
      { error: "galpao_id obrigatório" },
      { status: 400 },
    );
  }
  const tipo = (body.tipo ?? "picking") as TipoLocalizacao;
  if (!TIPOS_VALIDOS.includes(tipo)) {
    return NextResponse.json(
      { error: `tipo inválido (use: ${TIPOS_VALIDOS.join(", ")})` },
      { status: 400 },
    );
  }
  const preview = body.preview === true;

  let codigos: string[];
  let total: number;
  try {
    const r = gerarCodigosLote({
      prefixo: body.prefixo ?? "",
      h_inicio: body.h_inicio ?? 0,
      h_fim: body.h_fim ?? 0,
      v_inicio: body.v_inicio ?? 0,
      v_fim: body.v_fim ?? 0,
    });
    codigos = r.codigos;
    total = r.total;
  } catch (e) {
    return wmsErrorResponse({
      source: "wms.localizacoes.lote",
      error: e,
      status: 400,
      category: "validation",
      requestPath: "/api/wms/localizacoes/lote",
      requestMethod: "POST",
      metadata: { galpao_id: body.galpao_id },
    });
  }

  const sb = createServiceClient();
  const amostra = amostraDe(codigos);

  // Conta duplicatas pré-existentes (preview e criar usam o mesmo número).
  const { data: existentes, error: errSel } = await sb
    .from("siso_localizacoes")
    .select("codigo")
    .eq("galpao_id", body.galpao_id)
    .in("codigo", codigos);
  if (errSel) {
    return wmsErrorResponse({
      source: "wms.localizacoes.lote",
      error: errSel,
      requestPath: "/api/wms/localizacoes/lote",
      requestMethod: "POST",
      metadata: { galpao_id: body.galpao_id, total },
    });
  }
  const jaExistiamPre = existentes?.length ?? 0;
  const criariaPre = total - jaExistiamPre;

  if (preview) {
    return NextResponse.json({
      total,
      criadas: criariaPre,
      ja_existiam: jaExistiamPre,
      amostra,
    });
  }

  if (criariaPre === 0) {
    return NextResponse.json({
      total,
      criadas: 0,
      ja_existiam: jaExistiamPre,
      amostra,
    });
  }

  const rows = codigos.map((codigo) => ({
    galpao_id: body.galpao_id,
    codigo,
    tipo,
  }));

  const { data: inseridas, error: errIns } = await sb
    .from("siso_localizacoes")
    .upsert(rows, {
      ignoreDuplicates: true,
      onConflict: "galpao_id,codigo",
    })
    .select("codigo");
  if (errIns) {
    return wmsErrorResponse({
      source: "wms.localizacoes.lote",
      error: errIns,
      requestPath: "/api/wms/localizacoes/lote",
      requestMethod: "POST",
      metadata: { galpao_id: body.galpao_id, total },
    });
  }

  const criadas = inseridas?.length ?? 0;
  const jaExistiam = total - criadas;

  return NextResponse.json({
    total,
    criadas,
    ja_existiam: jaExistiam,
    amostra,
  });
}
