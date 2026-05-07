import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ sku: string }>;
}

const OEM_REGEX = /^[A-Z0-9.\-]{4,30}$/i;

export async function POST(request: NextRequest, { params }: RouteParams) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  const body = await request.json().catch(() => ({}));
  const codigoRaw = (body.codigo ?? "").toString().trim();

  if (!OEM_REGEX.test(codigoRaw)) {
    return NextResponse.json(
      { error: "Código OEM inválido (4-30 chars: letras, dígitos, ponto, traço)" },
      { status: 400 },
    );
  }
  const codigo = codigoRaw.toUpperCase();

  const supabase = createServiceClient();

  const { data: produto } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku")
    .eq("sku", sku)
    .maybeSingle();
  if (!produto) {
    return NextResponse.json({ error: "Produto não encontrado" }, { status: 404 });
  }

  const { error: insErr } = await supabase.from("siso_produto_oems").insert({
    produto_sku: sku,
    oem_code: codigo,
    origem: "manual",
    adicionado_por: session.id,
  });

  if (insErr) {
    if (insErr.code === "23505") {
      return NextResponse.json(
        { error: "OEM já cadastrado neste produto" },
        { status: 409 },
      );
    }
    logger.error("cross-oem-add", "Erro ao inserir OEM", {
      sku,
      codigo,
      error: insErr.message,
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }

  // Cruzamento: este OEM existe em outro SKU?
  const { data: cruzamentos } = await supabase
    .from("siso_produto_oems")
    .select("produto_sku, siso_produtos_catalogo(nome)")
    .eq("oem_code", codigo)
    .neq("produto_sku", sku)
    .limit(5);

  const lista = (cruzamentos ?? []).map((c: any) => ({
    sku: c.produto_sku,
    nome: c.siso_produtos_catalogo?.nome ?? null,
  }));

  logger.info("cross-oem-add", "OEM adicionado", {
    usuario: session.id,
    sku,
    codigo,
    cruzamentos: lista.length,
  });

  return NextResponse.json({ ok: true, codigo, cruzamentos: lista });
}
