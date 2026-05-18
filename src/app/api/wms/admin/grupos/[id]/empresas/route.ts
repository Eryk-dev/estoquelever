import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { clearGrupoCache } from "@/lib/grupo-resolver";

/**
 * POST /api/admin/grupos/[id]/empresas
 * Add empresa to grupo with tier.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: grupoId } = await params;
  const body = await request.json();
  const { empresa_id, tier } = body;

  if (!empresa_id) {
    return NextResponse.json({ error: "empresa_id é obrigatório" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_grupo_empresas")
    .insert({
      grupo_id: grupoId,
      empresa_id,
      tier: tier ?? 1,
    })
    .select("id, empresa_id, tier")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "Empresa já pertence a um grupo" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  clearGrupoCache();
  return NextResponse.json(data, { status: 201 });
}
