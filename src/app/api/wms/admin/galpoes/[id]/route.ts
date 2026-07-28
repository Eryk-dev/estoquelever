import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * PUT /api/admin/galpoes/[id]
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();
  const {
    nome,
    descricao,
    ativo,
    cidade,
    estado,
    pais,
    printnode_printer_id,
    printnode_printer_nome,
    printnode_account_id,
    printnode_printer_id_produto,
    printnode_printer_nome_produto,
    printnode_account_id_produto,
    printnode_printer_id_excesso,
    printnode_printer_nome_excesso,
    printnode_account_id_excesso,
  } = body;

  const update: Record<string, unknown> = { atualizado_em: new Date().toISOString() };
  if (nome !== undefined) update.nome = nome.trim();
  if (descricao !== undefined) update.descricao = descricao?.trim() || null;
  if (ativo !== undefined) update.ativo = ativo;
  if (cidade !== undefined) update.cidade = typeof cidade === "string" && cidade.trim() ? cidade.trim() : null;
  if (estado !== undefined) {
    const norm = typeof estado === "string" ? estado.trim().toUpperCase() : null;
    if (norm && !/^[A-Z]{2}$/.test(norm)) {
      return NextResponse.json(
        { error: "Estado deve ter 2 letras (ex: PR, SP)" },
        { status: 400 },
      );
    }
    update.estado = norm || null;
  }
  if (pais !== undefined) {
    update.pais = typeof pais === "string" && pais.trim() ? pais.trim().toUpperCase() : "BR";
  }
  if (printnode_printer_id !== undefined) update.printnode_printer_id = printnode_printer_id;
  if (printnode_printer_nome !== undefined) update.printnode_printer_nome = printnode_printer_nome;
  if (printnode_account_id !== undefined) update.printnode_account_id = printnode_account_id;
  if (printnode_printer_id_produto !== undefined)
    update.printnode_printer_id_produto = printnode_printer_id_produto;
  if (printnode_printer_nome_produto !== undefined)
    update.printnode_printer_nome_produto = printnode_printer_nome_produto;
  if (printnode_account_id_produto !== undefined)
    update.printnode_account_id_produto = printnode_account_id_produto;
  if (printnode_printer_id_excesso !== undefined)
    update.printnode_printer_id_excesso = printnode_printer_id_excesso;
  if (printnode_printer_nome_excesso !== undefined)
    update.printnode_printer_nome_excesso = printnode_printer_nome_excesso;
  if (printnode_account_id_excesso !== undefined)
    update.printnode_account_id_excesso = printnode_account_id_excesso;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_galpoes")
    .update(update)
    .eq("id", id)
    .select("id, nome, ativo")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Nome já existe" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
