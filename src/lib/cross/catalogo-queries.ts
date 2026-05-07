import { createServiceClient } from "@/lib/supabase-server";
import { getEmpresasDoGrupo } from "@/lib/grupo-resolver";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { getEstoque } from "@/lib/tiny-api";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { logger } from "@/lib/logger";
import type {
  ResultadoBusca,
  RespostaBusca,
  TipoBusca,
  DetalheProduto,
  OemEntry,
  VeiculoEntry,
  EstoqueGalpao,
  Equivalente,
} from "@/lib/cross/types";

const RESULT_LIMIT = 50;

/**
 * Detecta o tipo de query observando a forma do texto.
 * - SKU: alfanumérico curto sem espaços, ex "NETAIR-1234"
 * - OEM: tipicamente uppercase + dígitos + traço, sem espaço, ex "94530230"
 * - Nome: tudo o mais
 */
function detectarTipo(query: string): "sku" | "oem" | "nome" {
  const trimmed = query.trim();
  if (trimmed.includes(" ")) return "nome";
  if (/^[A-Z0-9.\-]{4,30}$/i.test(trimmed)) return "sku";
  return "nome";
}

export async function searchProdutos(opts: {
  query: string;
  tipo: TipoBusca;
}): Promise<RespostaBusca> {
  const supabase = createServiceClient();
  const queryRaw = opts.query.trim();
  const queryUpper = queryRaw.toUpperCase();
  const tipoEfetivo = opts.tipo === "auto" ? detectarTipo(queryRaw) : opts.tipo;

  const resultados = new Map<string, ResultadoBusca>();

  if (opts.tipo === "auto" || opts.tipo === "sku") {
    const { data: porSku } = await supabase
      .from("siso_produtos_catalogo")
      .select("sku, nome, fornecedor, marca, imagem_url, oem, localizacao")
      .ilike("sku", `${queryRaw}%`)
      .limit(RESULT_LIMIT);

    for (const row of porSku ?? []) {
      const exato = row.sku.toUpperCase() === queryUpper;
      resultados.set(row.sku, {
        sku: row.sku,
        nome: row.nome,
        fornecedor: row.fornecedor,
        marca: row.marca,
        imagem_url: row.imagem_url,
        localizacao: row.localizacao,
        oems: row.oem ?? [],
        estoque_total: 0,
        cross_count: 0,
        match: exato ? "sku_exato" : "sku_prefixo",
      });
    }
  }

  if (opts.tipo === "auto" || opts.tipo === "oem") {
    const { data: porOem } = await supabase
      .from("siso_produtos_catalogo")
      .select("sku, nome, fornecedor, marca, imagem_url, oem, localizacao")
      .contains("oem", [queryUpper])
      .limit(RESULT_LIMIT);

    for (const row of porOem ?? []) {
      if (resultados.has(row.sku)) continue;
      resultados.set(row.sku, {
        sku: row.sku,
        nome: row.nome,
        fornecedor: row.fornecedor,
        marca: row.marca,
        imagem_url: row.imagem_url,
        localizacao: row.localizacao,
        oems: row.oem ?? [],
        estoque_total: 0,
        cross_count: 0,
        match: "oem",
      });
    }
  }

  if (opts.tipo === "auto" || opts.tipo === "nome") {
    const { data: porNome } = await supabase
      .from("siso_produtos_catalogo")
      .select("sku, nome, fornecedor, marca, imagem_url, oem, localizacao")
      .ilike("nome", `%${queryRaw}%`)
      .limit(RESULT_LIMIT);

    for (const row of porNome ?? []) {
      if (resultados.has(row.sku)) continue;
      resultados.set(row.sku, {
        sku: row.sku,
        nome: row.nome,
        fornecedor: row.fornecedor,
        marca: row.marca,
        imagem_url: row.imagem_url,
        localizacao: row.localizacao,
        oems: row.oem ?? [],
        estoque_total: 0,
        cross_count: 0,
        match: "nome",
      });
    }
  }

  // Ordenar: sku_exato → sku_prefixo → oem → nome
  const matchOrder: Record<ResultadoBusca["match"], number> = {
    sku_exato: 0,
    sku_prefixo: 1,
    oem: 2,
    nome: 3,
  };

  const lista = Array.from(resultados.values()).sort(
    (a, b) => matchOrder[a.match] - matchOrder[b.match],
  );

  const listaPaginada = lista.slice(0, RESULT_LIMIT);

  // Pré-calcula cross_count por SKU em paralelo (apenas pros que têm OEMs).
  // GIN index em oem torna cada count rápido (~10-30ms cada).
  await Promise.all(
    listaPaginada.map(async (r) => {
      if (r.oems.length === 0) {
        r.cross_count = 0;
        return;
      }
      const { count } = await supabase
        .from("siso_produtos_catalogo")
        .select("sku", { count: "exact", head: true })
        .overlaps("oem", r.oems)
        .neq("sku", r.sku);
      r.cross_count = count ?? 0;
    }),
  );

  return {
    query: queryRaw,
    tipo_detectado: tipoEfetivo,
    total: lista.length,
    resultados: listaPaginada,
  };
}

/**
 * Carrega OEMs com nome do usuário, calcula pode_remover.
 */
async function loadOems(
  sku: string,
  sessionUserId: string,
  isAdmin: boolean,
): Promise<OemEntry[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_produto_oems")
    .select("id, oem_code, origem, adicionado_por, adicionado_em, siso_usuarios(nome)")
    .eq("produto_sku", sku)
    .order("adicionado_em", { ascending: true });

  return (data ?? []).map((row: any) => ({
    id: row.id,
    codigo: row.oem_code,
    origem: row.origem,
    adicionado_por: row.adicionado_por,
    adicionado_por_nome: row.siso_usuarios?.nome ?? null,
    adicionado_em: row.adicionado_em,
    pode_remover:
      isAdmin || (row.origem === "manual" && row.adicionado_por === sessionUserId),
  }));
}

async function loadVeiculos(
  sku: string,
  sessionUserId: string,
  isAdmin: boolean,
): Promise<VeiculoEntry[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_produto_veiculos")
    .select(
      "id, marca, modelo, ano_inicio, ano_fim, variante, adicionado_por, adicionado_em, siso_usuarios(nome)",
    )
    .eq("produto_sku", sku)
    .order("marca", { ascending: true })
    .order("modelo", { ascending: true });

  return (data ?? []).map((row: any) => ({
    id: row.id,
    marca: row.marca,
    modelo: row.modelo,
    ano_inicio: row.ano_inicio,
    ano_fim: row.ano_fim,
    variante: row.variante,
    adicionado_por: row.adicionado_por,
    adicionado_por_nome: row.siso_usuarios?.nome ?? null,
    adicionado_em: row.adicionado_em,
    pode_remover: isAdmin || row.adicionado_por === sessionUserId,
  }));
}

/**
 * Contexto do grupo de empresas usado para múltiplas consultas de estoque.
 * Resolve uma única vez as empresas do grupo + mapa de depósitos para evitar
 * N+1 quando consultamos estoque de vários SKUs (ex.: equivalentes).
 */
interface GrupoContext {
  empresas: Awaited<ReturnType<typeof getEmpresasDoGrupo>>;
  depositoMap: Map<string, number | null>;
}

/**
 * Resolve uma única vez as empresas do grupo da empresa origem e o mapa
 * empresa_id → deposito_id. Reutilizável entre várias chamadas a
 * `loadEstoquePorGalpao` (ex.: produto principal + N equivalentes).
 */
async function resolveGrupoContext(
  empresaOrigemId: string,
): Promise<GrupoContext> {
  const supabase = createServiceClient();

  const { data: grupoRel } = await supabase
    .from("siso_grupo_empresas")
    .select("grupo_id")
    .eq("empresa_id", empresaOrigemId)
    .single();

  const empresas = grupoRel ? await getEmpresasDoGrupo(grupoRel.grupo_id) : [];

  const depositoMap = new Map<string, number | null>();
  if (empresas.length > 0) {
    const { data: connections } = await supabase
      .from("siso_tiny_connections")
      .select("empresa_id, deposito_id")
      .eq("ativo", true);

    for (const c of connections ?? []) {
      depositoMap.set(c.empresa_id, c.deposito_id);
    }
  }

  return { empresas, depositoMap };
}

/**
 * Busca estoque por galpão para um SKU consultando todas as empresas do grupo.
 * Recebe o `ctx` pré-resolvido (via `resolveGrupoContext`) para evitar N+1
 * quando chamado em loop (ex.: equivalentes).
 */
async function loadEstoquePorGalpao(
  sku: string,
  ctx: GrupoContext,
): Promise<Record<string, EstoqueGalpao>> {
  const { empresas, depositoMap } = ctx;
  if (empresas.length === 0) return {};

  const supabase = createServiceClient();
  const { data: catalogo } = await supabase
    .from("siso_produtos_catalogo")
    .select("tiny_id")
    .eq("sku", sku)
    .single();

  const tinyId = catalogo?.tiny_id;
  if (tinyId == null) return {};

  const por = new Map<
    string,
    { galpaoNome: string; saldo: number; reservado: number; disponivel: number }
  >();

  for (const emp of empresas) {
    try {
      const { token } = await getValidTokenByEmpresa(emp.empresaId);
      const estoque = await runWithEmpresa(emp.empresaId, () =>
        getEstoque(token, tinyId),
      );
      const depositoId = depositoMap.get(emp.empresaId) ?? null;
      const dep =
        depositoId != null
          ? estoque.depositos?.find((d) => d.id === depositoId) ?? null
          : estoque.depositos?.[0] ?? null;

      const saldo = dep?.saldo ?? 0;
      const reservado = dep?.reservado ?? 0;

      const existing = por.get(emp.galpaoNome);
      if (existing) {
        existing.saldo += saldo;
        existing.reservado += reservado;
        existing.disponivel += saldo - reservado;
      } else {
        por.set(emp.galpaoNome, {
          galpaoNome: emp.galpaoNome,
          saldo,
          reservado,
          disponivel: saldo - reservado,
        });
      }
    } catch (err) {
      logger.warn(
        "cross-catalogo",
        "Falha ao consultar estoque Tiny — empresa pulada",
        {
          sku,
          empresaId: emp.empresaId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      continue;
    }
  }

  const result: Record<string, EstoqueGalpao> = {};
  for (const [nome, v] of por) {
    result[nome] = {
      saldo: v.saldo,
      reservado: v.reservado,
      disponivel: v.disponivel,
      deposito_nome: null,
      localizacao: null,
    };
  }
  return result;
}

/**
 * Para um SKU, encontra todos os SKUs equivalentes (compartilham >= 1 OEM)
 * com estoque por galpão. Paraleliza buscas Tiny via Promise.all
 * (rate-limiter ainda serializa por empresa).
 */
async function loadEquivalentes(
  sku: string,
  oems: string[],
  ctx: GrupoContext,
): Promise<Equivalente[]> {
  if (oems.length === 0) return [];

  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_produtos_catalogo")
    .select("sku, nome, imagem_url, oem, localizacao")
    .overlaps("oem", oems)
    .neq("sku", sku)
    .limit(50);

  const equivalentes: Equivalente[] = await Promise.all(
    (data ?? []).map(async (row: any) => {
      const oemsCompartilhados = (row.oem ?? []).filter((o: string) =>
        oems.includes(o),
      );
      const estoque = await loadEstoquePorGalpao(row.sku, ctx);
      const total = Object.values(estoque).reduce(
        (s, e) => s + e.disponivel,
        0,
      );
      return {
        sku: row.sku,
        nome: row.nome,
        imagem_url: row.imagem_url,
        localizacao: row.localizacao,
        oems_compartilhados: oemsCompartilhados,
        estoque_por_galpao: Object.fromEntries(
          Object.entries(estoque).map(([k, v]) => [
            k,
            { saldo: v.saldo, reservado: v.reservado, disponivel: v.disponivel },
          ]),
        ),
        estoque_total: total,
      };
    }),
  );

  equivalentes.sort((a, b) => b.estoque_total - a.estoque_total);
  return equivalentes;
}

export async function getProdutoDetalheCompleto(opts: {
  sku: string;
  sessionUserId: string;
  isAdmin: boolean;
  empresaOrigemId: string;
}): Promise<DetalheProduto | null> {
  const supabase = createServiceClient();
  const { data: produto, error } = await supabase
    .from("siso_produtos_catalogo")
    .select("*")
    .eq("sku", opts.sku)
    .single();

  if (error || !produto) return null;

  // Resolve grupo context uma única vez — reutilizado pelo estoque do produto
  // principal e pelos N equivalentes (evita N+1 em siso_grupo_empresas e
  // siso_tiny_connections).
  const grupoCtx = await resolveGrupoContext(opts.empresaOrigemId);

  const [oems, veiculos, estoque_por_galpao] = await Promise.all([
    loadOems(opts.sku, opts.sessionUserId, opts.isAdmin),
    loadVeiculos(opts.sku, opts.sessionUserId, opts.isAdmin),
    loadEstoquePorGalpao(opts.sku, grupoCtx),
  ]);

  const equivalentes = await loadEquivalentes(opts.sku, produto.oem ?? [], grupoCtx);

  return {
    sku: produto.sku,
    nome: produto.nome,
    descricao: produto.descricao,
    fornecedor: produto.fornecedor,
    marca: produto.marca,
    imagem_url: produto.imagem_url,
    gtin: produto.gtin,
    sincronizado_em: produto.sincronizado_em,
    oems,
    veiculos,
    estoque_por_galpao,
    equivalentes,
  };
}
