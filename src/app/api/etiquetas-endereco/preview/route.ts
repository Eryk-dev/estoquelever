import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { gerarEnderecos, EnderecoRange } from "@/lib/zpl-endereco";
import { logger } from "@/lib/logger";

/**
 * POST /api/etiquetas-endereco/preview
 *
 * Generate a preview of address labels from a range specification.
 * Returns the list of addresses, total count, and label counts for both sizes.
 *
 * Auth: any logged-in user (no role restriction).
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

    // Validate start <= end for numeric ranges
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

    const range: EnderecoRange = {
      corredorInicio: corredor_inicio,
      corredorFim: corredor_fim,
      horizontalInicio: horizontal_inicio,
      horizontalFim: horizontal_fim,
      verticalInicio: vertical_inicio,
      verticalFim: vertical_fim,
    };

    const enderecos = gerarEnderecos(range);
    const total = enderecos.length;
    const total_labels_pequena = Math.ceil(total / 2);
    const total_labels_grande = total;

    return NextResponse.json({
      enderecos,
      total,
      total_labels_pequena,
      total_labels_grande,
    });
  } catch (err) {
    logger.error("etiquetas-endereco", "Erro ao gerar preview", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Erro ao gerar preview" },
      { status: 500 },
    );
  }
}
