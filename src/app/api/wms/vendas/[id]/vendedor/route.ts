/**
 * PATCH /api/wms/vendas/[id]/vendedor
 *
 * Atribui (ou re-atribui, ou desatribui) um vendedor a um pedido.
 * Útil pra:
 *   - Admin atribuir pedidos ML/Shopee a um vendedor real (post-hoc)
 *   - Vendedor reivindicar um pedido que estava sem dono
 *
 * Permissão: admin/operador OU o vendedor atual do pedido.
 * Body: { vendedor_id: string | null }
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { registrarEvento } from "@/lib/historico-service";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(request);
  if (!user) {
    return NextResponse.json({ erro: "Sessão inválida" }, { status: 401 });
  }

  const { id } = await params;
  let body: { vendedor_id: string | null };
  try {
    body = (await request.json()) as { vendedor_id: string | null };
  } catch {
    return NextResponse.json({ erro: "JSON inválido" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Lê pedido atual pra checar permissão
  const { data: pedido } = await supabase
    .from("siso_pedidos")
    .select("id, vendedor_id, vendedor_nome, origem_pedido, nome_ecommerce")
    .eq("id", id)
    .maybeSingle();

  if (!pedido) {
    return NextResponse.json({ erro: "Pedido não encontrado" }, { status: 404 });
  }

  // Filtro de auth: admin + operadores podem re-atribuir qualquer vendedor;
  // vendedor "dono" do pedido também pode. Proxy via permissões:
  //   - isAdmin: sistema.usuarios.
  //   - isOperador: separacao.executar (operadores têm; admin tem; comprador/vendedor não).
  const isAdmin = userCan(user, "sistema.usuarios");
  const isOperador = userCan(user, "separacao.executar");
  const isOwner = pedido.vendedor_id === user.id;
  if (!isAdmin && !isOperador && !isOwner) {
    return NextResponse.json({ erro: "Sem permissão pra alterar vendedor" }, { status: 403 });
  }

  // Resolve nome do novo vendedor + valida cargo (finding 7.4)
  // Target precisa ter role vendedor OR operador* OR admin. Comprador NÃO
  // pode receber atribuição (não faz sentido — comprador não faz pedidos
  // de cliente).
  let novoNome: string | null = null;
  if (body.vendedor_id) {
    const { data: u } = await supabase
      .from("siso_usuarios")
      .select("id, nome, siso_usuario_roles(siso_roles(codigo))")
      .eq("id", body.vendedor_id)
      .maybeSingle();
    if (!u) {
      return NextResponse.json({ erro: "vendedor_id inválido" }, { status: 400 });
    }
    // Extract role codes from nested join shape
    const targetRoleCodes = ((u as unknown as {
      siso_usuario_roles: Array<{ siso_roles: { codigo: string } | null }>;
    }).siso_usuario_roles ?? [])
      .map((r) => r.siso_roles?.codigo)
      .filter((c): c is string => !!c);
    const allowedTarget = targetRoleCodes.some((c) =>
      c === "vendedor" || c === "admin" || c === "operador" || c === "operador_cwb" || c === "operador_sp",
    );
    if (!allowedTarget) {
      return NextResponse.json(
        {
          erro: `vendedor_id alvo não tem cargo vendedor/operador/admin (roles: ${targetRoleCodes.join(",") || "nenhuma"})`,
        },
        { status: 400 },
      );
    }
    novoNome = (u as { nome: string }).nome;
  }

  const { error: updErr } = await supabase
    .from("siso_pedidos")
    .update({ vendedor_id: body.vendedor_id, vendedor_nome: novoNome })
    .eq("id", id);

  if (updErr) {
    return NextResponse.json({ erro: updErr.message }, { status: 500 });
  }

  registrarEvento({
    pedidoId: id,
    evento: "venda_vendedor_atribuido",
    usuarioId: user.id,
    usuarioNome: user.nome,
    detalhes: {
      vendedor_id_anterior: pedido.vendedor_id,
      vendedor_id_novo: body.vendedor_id,
      vendedor_nome_anterior: pedido.vendedor_nome,
      vendedor_nome_novo: novoNome,
    },
  }).catch(() => {});

  return NextResponse.json({ ok: true, vendedor_id: body.vendedor_id, vendedor_nome: novoNome });
}
