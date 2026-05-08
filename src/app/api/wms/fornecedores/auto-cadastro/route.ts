import { NextRequest, NextResponse } from "next/server";
import { autoCriarFornecedoresDosPrefixosSku } from "@/lib/wms/fornecedores";
import { requireAdmin } from "@/lib/wms/auth";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json(await autoCriarFornecedoresDosPrefixosSku());
}
