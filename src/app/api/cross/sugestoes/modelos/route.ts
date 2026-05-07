import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const marca = (searchParams.get("marca") ?? "").trim().toUpperCase();
  const q = (searchParams.get("q") ?? "").trim().toUpperCase();

  if (!marca) return NextResponse.json({ modelos: [] });

  const supabase = createServiceClient();
  let baseQuery = supabase
    .from("siso_produto_veiculos")
    .select("modelo")
    .eq("marca", marca);

  if (q) baseQuery = baseQuery.ilike("modelo", `${q}%`);

  const { data } = await baseQuery.limit(100);
  const modelos = Array.from(new Set((data ?? []).map((r: { modelo: string }) => r.modelo))).sort();
  return NextResponse.json({ modelos });
}
