import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { createServiceClient } from "@/lib/supabase-server";
import { gerarPalpitesPorOem } from "@/lib/cross/equivalencias";
import { wmsErrorResponse } from "@/lib/wms/api-errors";
import { logger } from "@/lib/logger";

/**
 * PATCH /api/wms/cross/produtos/[sku]/oem  { oem: string[] }
 * Salva os códigos OEM (manual) do produto. Após salvar, dispara palpites
 * de cross por OEM compartilhado (fire-and-forget). `produtos.editar`.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sku: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "produtos.editar")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { sku: skuRaw } = await params;
  const sku = decodeURIComponent(skuRaw).trim();

  let body: { oem?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!Array.isArray(body.oem)) {
    return NextResponse.json({ error: "Envie oem: string[]" }, { status: 400 });
  }
  // Sanitiza: trim, remove vazios, dedup preservando ordem.
  const vistos = new Set<string>();
  const oem: string[] = [];
  for (const item of body.oem) {
    const v = String(item ?? "").trim();
    if (v && !vistos.has(v)) {
      vistos.add(v);
      oem.push(v);
    }
  }

  try {
    const sb = createServiceClient();
    const { data: prod } = await sb
      .from("siso_produtos")
      .select("id")
      .eq("sku", sku)
      .maybeSingle();
    if (!prod) return NextResponse.json({ error: "produto não encontrado" }, { status: 404 });

    const { error } = await sb
      .from("siso_produtos")
      .update({ oem: oem.length > 0 ? oem : null, atualizado_em: new Date().toISOString() })
      .eq("sku", sku);
    if (error) throw error;

    // Palpites por OEM compartilhado — não bloqueia a resposta.
    void gerarPalpitesPorOem(sku, oem, session.id).catch((err) => {
      logger.warn("cross-oem", "Falha ao gerar palpites por OEM (não crítico)", {
        sku,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({ ok: true, oem });
  } catch (error) {
    return wmsErrorResponse({ source: "wms.cross.oem", error, message: "erro salvando OEM" });
  }
}
