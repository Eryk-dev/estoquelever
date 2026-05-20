import { createServiceClient } from "@/lib/supabase-server";
import { buscarProdutoPorSku, getEstoque, getProdutoDetalhe, type TinyDeposito } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { getEmpresasDoGrupo } from "@/lib/grupo-resolver";
import { getFornecedorBySku } from "@/lib/sku-fornecedor";

function pickDeposito(
  depositos: TinyDeposito[] | undefined,
  depositoId: number | null,
): TinyDeposito | null {
  if (!depositos?.length) return null;
  if (depositoId != null) {
    return depositos.find((deposito) => deposito.id === depositoId) ?? null;
  }
  return depositos[0];
}

async function getDepositoIdByEmpresa(empresaId: string): Promise<number | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("siso_tiny_connections")
    .select("deposito_id")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .single();

  return data?.deposito_id ?? null;
}

/** Agregado por galpão — dinâmico, sem hardcode de CWB/SP. */
export interface CompraEquivalenteGalpaoEstoque {
  galpao_id: string;
  galpao_nome: string;
  saldo: number;
  reservado: number;
  disponivel: number;
  deposito_id: number | null;
  deposito_nome: string | null;
  localizacao: string | null;
  atende: boolean;
}

export interface EquivalentSyncResult {
  produtoIdOrigem: number;
  produtoIdSuporte: number | null;
  sku: string;
  descricao: string;
  fornecedor: string | null;
  imagemUrl: string | null;
  gtin: string | null;
  /** Mapa dinâmico keyed por nome do galpão (UPPER). */
  estoques: Record<string, CompraEquivalenteGalpaoEstoque>;
  estoquesPorEmpresa: Array<{
    empresa_id: string;
    produto_id: number;
    deposito_id: number | null;
    deposito_nome: string | null;
    saldo: number;
    reservado: number;
    disponivel: number;
    localizacao: string | null;
    galpao_id: string;
    galpao_nome: string;
  }>;
}

export async function carregarDadosEquivalentePorSku(params: {
  empresaOrigemId: string;
  grupoId: string | null;
  galpaoOrigemId: string;
  galpaoOrigemNome: string;
  sku: string;
  /** Quantidade mínima pra considerar `atende=true`. Default 1. */
  qtdMinimaAtende?: number;
}): Promise<EquivalentSyncResult> {
  const { empresaOrigemId, grupoId, galpaoOrigemId, galpaoOrigemNome, sku } = params;
  const qtdMinimaAtende = params.qtdMinimaAtende ?? 1;

  const empresasDoGrupo = grupoId
    ? await getEmpresasDoGrupo(grupoId)
    : [];

  const empresasParaConsultar = empresasDoGrupo.length > 0
    ? empresasDoGrupo
    : [{
        empresaId: empresaOrigemId,
        empresaNome: galpaoOrigemNome,
        galpaoId: galpaoOrigemId,
        galpaoNome: galpaoOrigemNome,
        tier: 1,
      }];

  // Galpões ativos (caso o pedido não tenha cobertura em todos do grupo, ainda incluímos no payload com zero).
  const supabase = createServiceClient();
  const { data: galpoesAtivos } = await supabase
    .from("siso_galpoes")
    .select("id, nome")
    .eq("ativo", true);

  const { token: origemToken } = await getValidTokenByEmpresa(empresaOrigemId);
  const produtoOrigem = await runWithEmpresa(empresaOrigemId, () =>
    buscarProdutoPorSku(origemToken, sku),
  );

  if (!produtoOrigem) {
    throw new Error(`SKU equivalente não encontrado na empresa de origem: ${sku}`);
  }

  const detalheOrigem = await runWithEmpresa(empresaOrigemId, () =>
    getProdutoDetalhe(origemToken, produtoOrigem.id),
  );

  const empresaTokens = new Map<string, string>();
  const empresaDepositos = new Map<string, number | null>();
  empresaTokens.set(empresaOrigemId, origemToken);
  empresaDepositos.set(empresaOrigemId, await getDepositoIdByEmpresa(empresaOrigemId));

  for (const empresa of empresasParaConsultar) {
    if (empresa.empresaId === empresaOrigemId) continue;
    try {
      const { token } = await getValidTokenByEmpresa(empresa.empresaId);
      empresaTokens.set(empresa.empresaId, token);
      empresaDepositos.set(empresa.empresaId, await getDepositoIdByEmpresa(empresa.empresaId));
    } catch {
      continue;
    }
  }

  let produtoIdSuporte: number | null = null;
  const estoquesPorEmpresa: EquivalentSyncResult["estoquesPorEmpresa"] = [];

  for (const empresa of empresasParaConsultar) {
    const token = empresaTokens.get(empresa.empresaId);
    if (!token) continue;

    let produtoIdNaEmpresa: number;
    if (empresa.empresaId === empresaOrigemId) {
      produtoIdNaEmpresa = produtoOrigem.id;
    } else {
      const produtoBusca = await runWithEmpresa(empresa.empresaId, () =>
        buscarProdutoPorSku(token, sku),
      );
      if (!produtoBusca) continue;
      produtoIdNaEmpresa = produtoBusca.id;
      if (!produtoIdSuporte) produtoIdSuporte = produtoIdNaEmpresa;
    }

    const estoque = await runWithEmpresa(empresa.empresaId, () =>
      getEstoque(token, produtoIdNaEmpresa),
    );
    const deposito = pickDeposito(
      estoque.depositos,
      empresaDepositos.get(empresa.empresaId) ?? null,
    );

    const saldo = deposito?.saldo ?? 0;
    const reservado = deposito?.reservado ?? 0;
    const disponivel = saldo - reservado;

    estoquesPorEmpresa.push({
      empresa_id: empresa.empresaId,
      produto_id: produtoIdNaEmpresa,
      deposito_id: deposito?.id ?? null,
      deposito_nome: deposito?.nome ?? null,
      saldo,
      reservado,
      disponivel,
      localizacao: estoque.localizacao ?? null,
      galpao_id: empresa.galpaoId,
      galpao_nome: empresa.galpaoNome,
    });
  }

  // Aggregate por galpão (inlined — agregarEstoquePorGalpao removido em Fase 5)
  const porGalpao = new Map<
    string,
    { galpaoId: string; galpaoNome: string; disponivel: number; saldo: number; reservado: number }
  >();
  for (const estoque of estoquesPorEmpresa) {
    const existing = porGalpao.get(estoque.galpao_id);
    if (existing) {
      existing.disponivel += estoque.disponivel;
      existing.saldo += estoque.saldo;
      existing.reservado += estoque.reservado;
    } else {
      porGalpao.set(estoque.galpao_id, {
        galpaoId: estoque.galpao_id,
        galpaoNome: estoque.galpao_nome,
        disponivel: estoque.disponivel,
        saldo: estoque.saldo,
        reservado: estoque.reservado,
      });
    }
  }

  const estoques: Record<string, CompraEquivalenteGalpaoEstoque> = {};

  // Inicializa com todos os galpões ativos zerados pra UI render previsível.
  for (const g of galpoesAtivos ?? []) {
    const key = (g.nome as string).toUpperCase();
    estoques[key] = {
      galpao_id: g.id as string,
      galpao_nome: g.nome as string,
      saldo: 0,
      reservado: 0,
      disponivel: 0,
      deposito_id: null,
      deposito_nome: null,
      localizacao: null,
      atende: false,
    };
  }

  for (const [galpaoId, agregado] of porGalpao) {
    const key = agregado.galpaoNome.toUpperCase();
    const estoque = estoquesPorEmpresa.find((item) => item.galpao_id === galpaoId);
    estoques[key] = {
      galpao_id: galpaoId,
      galpao_nome: agregado.galpaoNome,
      saldo: agregado.saldo,
      reservado: agregado.reservado,
      disponivel: agregado.disponivel,
      deposito_id: estoque?.deposito_id ?? null,
      deposito_nome: estoque?.deposito_nome ?? null,
      localizacao: estoque?.localizacao ?? null,
      atende: agregado.disponivel >= qtdMinimaAtende,
    };
  }

  const fornecedor = getFornecedorBySku(sku);

  return {
    produtoIdOrigem: produtoOrigem.id,
    produtoIdSuporte,
    sku: produtoOrigem.codigo,
    descricao: produtoOrigem.descricao,
    fornecedor: fornecedor.fornecedor,
    imagemUrl: detalheOrigem.imagemUrl,
    gtin: detalheOrigem.gtin,
    estoques,
    estoquesPorEmpresa,
  };
}
