import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  gerarEnderecos,
  gerarZplPequena,
  gerarZplGrande,
  EnderecoRange,
} from "@/lib/zpl-endereco";
import { getConfig } from "@/lib/config";
import { enviarImpressaoZpl, resolverImpressora } from "@/lib/printnode";
import { logger } from "@/lib/logger";

/**
 * POST /api/etiquetas-endereco/imprimir
 *
 * Generate address labels and send them to a thermal printer via PrintNode.
 *
 * - tipo "pequena": 2 addresses per label. Requires printer_id in body.
 * - tipo "grande": 1 address per label. Uses printer_id from body, or falls
 *   back to resolverImpressora(userId, galpaoId).
 *
 * Auth: any logged-in user.
 */
export async function POST(request: Request) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "Sessão inválida" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      corredor_inicio,
      corredor_fim,
      horizontal_inicio,
      horizontal_fim,
      vertical_inicio,
      vertical_fim,
      tipo,
      printer_id,
    } = body;

    // Validate required fields
    if (!corredor_inicio || !corredor_fim) {
      return NextResponse.json(
        { error: "Corredor início e fim são obrigatórios" },
        { status: 400 },
      );
    }

    if (
      horizontal_inicio == null ||
      horizontal_fim == null ||
      vertical_inicio == null ||
      vertical_fim == null
    ) {
      return NextResponse.json(
        { error: "Horizontal e vertical início/fim são obrigatórios" },
        { status: 400 },
      );
    }

    if (horizontal_inicio > horizontal_fim) {
      return NextResponse.json(
        { error: "Horizontal início deve ser <= fim" },
        { status: 400 },
      );
    }
    if (vertical_inicio > vertical_fim) {
      return NextResponse.json(
        { error: "Vertical início deve ser <= fim" },
        { status: 400 },
      );
    }

    if (tipo !== "pequena" && tipo !== "grande") {
      return NextResponse.json(
        { error: "Tipo deve ser 'pequena' ou 'grande'" },
        { status: 400 },
      );
    }

    // Generate addresses
    const range: EnderecoRange = {
      corredorInicio: corredor_inicio,
      corredorFim: corredor_fim,
      horizontalInicio: horizontal_inicio,
      horizontalFim: horizontal_fim,
      verticalInicio: vertical_inicio,
      verticalFim: vertical_fim,
    };

    const enderecos = gerarEnderecos(range);

    if (enderecos.length === 0) {
      return NextResponse.json(
        { error: "Nenhum endereço gerado com os parâmetros informados" },
        { status: 400 },
      );
    }

    // Generate ZPL
    const zpl =
      tipo === "pequena"
        ? gerarZplPequena(enderecos)
        : gerarZplGrande(enderecos);

    const total_labels =
      tipo === "pequena" ? Math.ceil(enderecos.length / 2) : enderecos.length;

    // Resolve printer
    let printerId: number | undefined = printer_id;

    if (!printerId && tipo === "grande") {
      const resolved = await resolverImpressora(
        session.id,
        session.galpaoId ?? "",
      );
      if (resolved) {
        printerId = resolved.printerId;
      }
    }

    if (!printerId) {
      return NextResponse.json(
        { error: "Nenhuma impressora configurada" },
        { status: 400 },
      );
    }

    // Get PrintNode API key
    const apiKey = await getConfig("printnode_api_key");
    if (!apiKey) {
      return NextResponse.json(
        { error: "PrintNode API key não configurada" },
        { status: 400 },
      );
    }

    // Send print job
    const { jobId } = await enviarImpressaoZpl({
      apiKey,
      printerId,
      zpl,
      titulo: `Etiquetas Endereço ${tipo} — ${total_labels} labels`,
    });

    logger.info("etiquetas-endereco", "Etiquetas enviadas para impressão", {
      tipo,
      total_labels: String(total_labels),
      printerId: String(printerId),
      jobId: String(jobId),
      usuario: session.nome,
    });

    return NextResponse.json({ ok: true, job_id: jobId, total_labels });
  } catch (err) {
    logger.error("etiquetas-endereco", "Erro ao imprimir etiquetas", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro ao imprimir etiquetas" },
      { status: 500 },
    );
  }
}
