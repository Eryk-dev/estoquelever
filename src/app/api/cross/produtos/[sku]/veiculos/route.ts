import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  const body = await request.json().catch(() => ({}));
  const marca = (body.marca ?? "").toString().trim().toUpperCase();
  const modelo = (body.modelo ?? "").toString().trim().toUpperCase();
  const variante = body.variante ? String(body.variante).trim() : null;
  const ano_inicio = body.ano_inicio ? Number(body.ano_inicio) : null;
  const ano_fim = body.ano_fim ? Number(body.ano_fim) : null;

  if (!marca || !modelo) {
    return NextResponse.json(
      { error: "marca e modelo são obrigatórios" },
      { status: 400 },
    );
  }
  if (ano_inicio !== null && (ano_inicio < 1900 || ano_inicio > 2100)) {
    return NextResponse.json({ error: "ano_inicio inválido" }, { status: 400 });
  }
  if (ano_fim !== null && (ano_fim < 1900 || ano_fim > 2100)) {
    return NextResponse.json({ error: "ano_fim inválido" }, { status: 400 });
  }
  if (ano_inicio !== null && ano_fim !== null && ano_inicio > ano_fim) {
    return NextResponse.json(
      { error: "ano_inicio não pode ser maior que ano_fim" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  const { data: produto } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku")
    .eq("sku", sku)
    .maybeSingle();
  if (!produto) {
    return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });
  }

  const { data: inserido, error: insErr } = await supabase
    .from("siso_produto_veiculos")
    .insert({
      produto_sku: sku,
      marca,
      modelo,
      ano_inicio,
      ano_fim,
      variante,
      adicionado_por: session.id,
    })
    .select("id")
    .single();

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json(
        { error: "Veículo já cadastrado para este produto" },
        { status: 409 },
      );
    }
    logger.error("cross-veiculo-add", "Erro ao inserir veículo", {
      sku,
      error: insErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  logger.info("cross-veiculo-add", "Veículo adicionado", {
    usuario: session.id,
    sku,
    marca,
    modelo,
  });
  return NextResponse.json({ ok: true, id: inserido.id });
}
