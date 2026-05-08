import { NextRequest, NextResponse } from "next/server";
import { listarRegras, criarRegra } from "@/lib/wms/emprestimos";
import { getSessionUser } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ rows: await listarRegras() });
}

export async function POST(req: NextRequest) {
  if (!(await getSessionUser(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  try {
    return NextResponse.json(await criarRegra(body), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
}
