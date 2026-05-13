import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearEmpresaCache } from "@/lib/empresa-lookup";

/**
 * PUT /api/admin/empresas/[id]
 *
 * Body:
 *   - nome?: string
 *   - ativo?: boolean
 *   - galpoes_preferenciais?: string[] — replace-all dos preferenciais. Quando
 *     presente (inclusive []) substitui o conjunto inteiro. Quando ausente
 *     mantém o atual.
 *   - galpao_id?: string — DEPRECADO; equivalente a
 *     `galpoes_preferenciais: [galpao_id]`. Ignorado se galpoes_preferenciais
 *     também vier.
 *
 * Trigger sincroniza siso_empresas.galpao_id pra primeiro preferencial (ou
 * NULL quando lista vazia).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (typeof body.nome === "string") update.nome = body.nome.trim();
  if (typeof body.ativo === "boolean") update.ativo = body.ativo;

  const supabase = createServiceClient();
  const { error: updateError } = await supabase
    .from("siso_empresas")
    .update(update)
    .eq("id", id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Replace-all dos preferenciais, se vier.
  const preferenciais = extractPreferenciais(body);
  if (preferenciais !== undefined) {
    // Delete tudo + insere novos. Trigger AFTER cuida do galpao_id espelho.
    const { error: delError } = await supabase
      .from("siso_empresa_galpoes_preferenciais")
      .delete()
      .eq("empresa_id", id);
    if (delError) {
      return NextResponse.json(
        { error: `Falha limpando preferenciais antigos: ${delError.message}` },
        { status: 500 },
      );
    }
    if (preferenciais.length > 0) {
      const rows = preferenciais.map((galpao_id) => ({
        empresa_id: id,
        galpao_id,
      }));
      const { error: insError } = await supabase
        .from("siso_empresa_galpoes_preferenciais")
        .insert(rows);
      if (insError) {
        return NextResponse.json(
          { error: `Falha gravando preferenciais novos: ${insError.message}` },
          { status: 500 },
        );
      }
    }
  }

  // Re-fetch pra devolver estado consistente.
  const { data, error: fetchError } = await supabase
    .from("siso_empresas")
    .select("id, nome, galpao_id, ativo")
    .eq("id", id)
    .single();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  clearEmpresaCache();
  return NextResponse.json(data);
}

function extractPreferenciais(body: Record<string, unknown>): string[] | undefined {
  if (Array.isArray(body.galpoes_preferenciais)) {
    return [
      ...new Set(
        body.galpoes_preferenciais.filter((x) => typeof x === "string"),
      ),
    ] as string[];
  }
  if (typeof body.galpao_id === "string" && body.galpao_id) {
    return [body.galpao_id];
  }
  return undefined;
}
