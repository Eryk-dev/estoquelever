import { NextRequest, NextResponse } from "next/server";
import { autoCriarFornecedoresDosPrefixosSku } from "@/lib/wms/fornecedores";
import { getSessionUser } from "@/lib/session";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user || user.cargo !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  return NextResponse.json(await autoCriarFornecedoresDosPrefixosSku());
}
