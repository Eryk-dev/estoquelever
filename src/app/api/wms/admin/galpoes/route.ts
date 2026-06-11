import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

/**
 * GET /api/admin/galpoes
 *
 * Retorna galpões com empresas aninhadas (status conexão Tiny, grupo legacy,
 * preferenciais novos). Os campos `grupo`/`tier`/`grupoEmpresaId` ainda existem
 * pra retrocompat do SISO legacy (/configuracoes). O WMS lê `preferenciais`,
 * que é a fonte de verdade pós-migration 20260514_wms_empresa_galpoes_preferenciais.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const supabase = createServiceClient();

  // Hint explícito `siso_empresas!siso_empresas_galpao_id_fkey` desambígua
  // PostgREST: existem 2 rotas entre siso_galpoes e siso_empresas (direta via
  // siso_empresas.galpao_id E many-to-many via siso_empresa_galpoes_preferenciais).
  // Aqui queremos a direta (espelho do primeiro preferencial).
  const { data: galpoes, error } = await supabase
    .from("siso_galpoes")
    .select(`
      id, nome, descricao, ativo, cidade, estado, pais,
      printnode_printer_id, printnode_printer_nome, printnode_account_id,
      printnode_printer_id_produto, printnode_printer_nome_produto, printnode_account_id_produto,
      criado_em, atualizado_em,
      siso_empresas!siso_empresas_galpao_id_fkey (
        id, nome, cnpj, ativo, criado_em, atualizado_em,
        siso_grupo_empresas (
          id, tier,
          siso_grupos ( id, nome )
        ),
        siso_empresa_galpoes_preferenciais (
          galpao_id,
          siso_galpoes!siso_empresa_galpoes_preferenciais_galpao_id_fkey ( id, nome )
        ),
        siso_tiny_connections (
          id, ativo, ultimo_teste_ok, is_authorized:access_token,
          deposito_id, deposito_nome
        )
      )
    `)
    .order("nome");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Transform: flatten connection status, flatten preferenciais.
  const result = (galpoes ?? []).map((g) => ({
    ...g,
    siso_empresas: ((g.siso_empresas as unknown[]) ?? []).map((raw) => {
      const e = raw as Record<string, unknown>;
      const conns = (e.siso_tiny_connections as Array<Record<string, unknown>>) ?? [];
      const conn = conns[0];
      const grupoRels = (e.siso_grupo_empresas as Array<{
        id: string;
        tier: number;
        siso_grupos: { id: string; nome: string };
      }>) ?? [];
      const grupoRel = grupoRels[0];

      const prefRels = (e.siso_empresa_galpoes_preferenciais as Array<{
        galpao_id: string;
        siso_galpoes: { id: string; nome: string } | null;
      }>) ?? [];
      const preferenciais = prefRels
        .map((p) => ({
          id: p.galpao_id,
          nome: p.siso_galpoes?.nome ?? "",
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome));

      return {
        id: e.id,
        nome: e.nome,
        cnpj: e.cnpj,
        ativo: e.ativo,
        preferenciais,
        grupo: grupoRel ? { id: grupoRel.siso_grupos.id, nome: grupoRel.siso_grupos.nome } : null,
        tier: grupoRel?.tier ?? null,
        grupoEmpresaId: grupoRel?.id ?? null,
        conexao: conn
          ? {
              id: conn.id,
              ativo: conn.ativo,
              conectado: !!conn.is_authorized,
              ultimoTesteOk: conn.ultimo_teste_ok,
              depositoId: conn.deposito_id,
              depositoNome: conn.deposito_nome,
            }
          : null,
      };
    }),
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/admin/galpoes
 *
 * Cria galpão e auto-vincula a TODOS os admins ativos via
 * siso_usuario_galpoes. Semântica: admin vê tudo sem precisar reconfigurar
 * acesso. Operadores comuns continuam restritos a galpões designados
 * manualmente em /admin/usuarios.
 *
 * O frontend deve chamar refreshUser() após criação pra atualizar o seletor
 * do sidebar sem re-login.
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!userCan(session, "sistema.galpoes_empresas")) {
    return NextResponse.json({ error: "Acesso negado" }, { status: 403 });
  }

  const body = await request.json();
  const { nome, descricao, cidade, estado, pais } = body;

  if (!nome?.trim()) {
    return NextResponse.json({ error: "Nome é obrigatório" }, { status: 400 });
  }

  const estadoNorm = typeof estado === "string" ? estado.trim().toUpperCase() : null;
  if (estadoNorm && !/^[A-Z]{2}$/.test(estadoNorm)) {
    return NextResponse.json(
      { error: "Estado deve ter 2 letras (ex: PR, SP)" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("siso_galpoes")
    .insert({
      nome: nome.trim(),
      descricao: descricao?.trim() || null,
      cidade: typeof cidade === "string" ? cidade.trim() || null : null,
      estado: estadoNorm || null,
      pais: typeof pais === "string" && pais.trim() ? pais.trim().toUpperCase() : "BR",
    })
    .select("id, nome")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Já existe um galpão com esse nome" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Auto-vincula a todos os admins ativos. Erro aqui não bloqueia o galpão
  // criado — apenas registra no payload pro frontend mostrar warning.
  let admins_vinculados = 0;
  let admins_erro: string | null = null;
  try {
    const { data: admins } = await supabase
      .from("siso_usuarios")
      .select("id, cargo, cargos")
      .eq("ativo", true);

    const adminIds = (admins ?? [])
      .filter((u) => {
        const cargos = (u as { cargo: string; cargos: string[] | null }).cargos
          ?? [(u as { cargo: string }).cargo];
        return cargos.includes("admin");
      })
      .map((u) => (u as { id: string }).id);

    if (adminIds.length > 0) {
      const rows = adminIds.map((usuario_id) => ({
        usuario_id,
        galpao_id: data.id,
      }));
      const { error: ugError } = await supabase
        .from("siso_usuario_galpoes")
        .upsert(rows, { onConflict: "usuario_id,galpao_id" });
      if (ugError) {
        admins_erro = ugError.message;
      } else {
        admins_vinculados = adminIds.length;
      }
    }
  } catch (e) {
    admins_erro = e instanceof Error ? e.message : "Falha vinculando admins";
  }

  return NextResponse.json(
    { ...data, admins_vinculados, admins_erro },
    { status: 201 },
  );
}
