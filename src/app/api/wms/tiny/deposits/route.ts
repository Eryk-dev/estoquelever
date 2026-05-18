import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getValidToken } from "@/lib/tiny-oauth";
import { listarDepositos } from "@/lib/tiny-api";

/**
 * GET /api/tiny/deposits?connectionId=xxx
 * Fetches the list of deposits from Tiny for a given connection.
 * Returns an array of { id, nome }.
 */
export async function GET(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connectionId");

  if (!connectionId) {
    return NextResponse.json({ error: "Missing connectionId" }, { status: 400 });
  }

  // Verify the connection exists and is authorized
  const supabase = createServiceClient();
  const { data: conn, error: connError } = await supabase
    .from("siso_tiny_connections")
    .select("id, filial, is_authorized:access_token")
    .eq("id", connectionId)
    .single();

  if (connError || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  try {
    const token = await getValidToken(connectionId);
    const depositos = await listarDepositos(token);

    return NextResponse.json(
      depositos.map((d) => ({ id: d.id, nome: d.nome })),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
