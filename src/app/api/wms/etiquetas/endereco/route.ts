import { NextRequest, NextResponse } from "next/server";
import { enviarImpressaoZpl, resolverImpressora, resolverImpressoraProduto } from "@/lib/printnode";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { gerarZplEnderecoGrande, gerarZplEnderecoPequena } from "@/lib/wms/zpl-endereco";
import { wmsErrorResponse } from "@/lib/wms/api-errors";

export async function POST(req: NextRequest) {
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  if (!userCan(session, "operacoes.imprimir")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const tipo = body?.tipo;
  const galpaoId = body?.galpao_id;
  const codigos = Array.isArray(body?.codigos)
    ? body.codigos.filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if ((tipo !== "pequena" && tipo !== "grande") || typeof galpaoId !== "string" || codigos.length === 0) {
    return NextResponse.json({ error: "tipo, galpao_id e codigos são obrigatórios" }, { status: 400 });
  }
  if (session.galpaoId && session.galpaoId !== galpaoId) {
    return NextResponse.json({ error: "Galpão não autorizado" }, { status: 403 });
  }
  try {
    const printer = tipo === "pequena"
      ? await resolverImpressoraProduto(session.id, galpaoId)
      : await resolverImpressora(session.id, galpaoId);
    if (!printer) {
      return NextResponse.json({ error: "Nenhuma impressora configurada para esse tamanho" }, { status: 409 });
    }
    const zpl = tipo === "pequena"
      ? gerarZplEnderecoPequena(codigos)
      : gerarZplEnderecoGrande(codigos);
    const { jobId } = await enviarImpressaoZpl({
      apiKey: printer.apiKey,
      printerId: printer.printerId,
      zpl,
      titulo: `Endereço ${tipo} — ${codigos.join(", ")}`,
    });
    return NextResponse.json({ ok: true, jobId, total: codigos.length, printerNome: printer.printerNome });
  } catch (error) {
    return wmsErrorResponse({
      source: "wms.etiquetas.endereco",
      error,
      requestPath: "/api/wms/etiquetas/endereco",
      requestMethod: "POST",
    });
  }
}
