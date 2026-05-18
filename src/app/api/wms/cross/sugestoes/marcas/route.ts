import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim().toUpperCase();

  const supabase = createServiceClient();
  const baseQuery = supabase
    .from("siso_produto_veiculos")
    .select("marca");

  const { data } = q
    ? await baseQuery.ilike("marca", `${q}%`).limit(50)
    : await baseQuery.limit(50);

  const marcas = Array.from(new Set((data ?? []).map((r: { marca: string }) => r.marca))).sort();
  return NextResponse.json({ marcas });
}
