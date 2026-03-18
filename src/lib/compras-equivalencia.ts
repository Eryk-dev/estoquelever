import { createServiceClient } from "@/lib/supabase-server";
import { buscarProdutoPorSku, getEstoque, getProdutoDetalhe, type TinyDeposito } from "@/lib/tiny-api";
import { getValidTokenByEmpresa } from "@/lib/tiny-oauth";
import { runWithEmpresa } from "@/lib/tiny-queue";
import { agregarEstoquePorGalpao, getEmpresasDoGrupo } from "@/lib/grupo-resolver";
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

export interface EquivalentSyncResult {
  produtoIdOrigem: number;
  produtoIdSuporte: number | null;
  sku: string;
  descricao: string;
  fornecedor: string | null;
  imagemUrl: string | null;
  gtin: string | null;
  cwbAtende: boolean;
  spAtende: boolean;
  estoqueCwbDepositoId: number | null;
  estoqueCwbDepositoNome: string | null;
  estoqueCwbSaldo: number;
  estoqueCwbReservado: number;
  estoqueCwbDisponivel: number;
  estoqueSpDepositoId: number | null;
  estoqueSpDepositoNome: string | null;
  estoqueSpSaldo: number;
  estoqueSpReservado: number;
  estoqueSpDisponivel: number;
  localizacaoCwb: string | null;
  localizacaoSp: string | null;
  estoquesPorEmpresa: Array<{
    empresa_id: string;
    produto_id: number;
    deposito_id: number | null;
    deposito_nome: string | null;
    saldo: number;
    reservado: number;
    disponivel: number;
    localizacao: string | null;
    galpao_nome: string;
  }>;
}

export async function carregarDadosEquivalentePorSku(params: {
  empresaOrigemId: string;
  grupoId: string | null;
  galpaoOrigemId: string;
  galpaoOrigemNome: string;
  sku: string;
}): Promise<EquivalentSyncResult> {
  const { empresaOrigemId, grupoId, galpaoOrigemId, galpaoOrigemNome, sku } = params;

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
      galpao_nome: empresa.galpaoNome,
    });
  }

  const porGalpao = agregarEstoquePorGalpao(
    estoquesPorEmpresa.map((estoque) => ({
      empresaId: estoque.empresa_id,
      galpaoId: empresasParaConsultar.find((empresa) => empresa.empresaId === estoque.empresa_id)?.galpaoId ?? galpaoOrigemId,
      galpaoNome: estoque.galpao_nome,
      disponivel: estoque.disponivel,
      saldo: estoque.saldo,
      reservado: estoque.reservado,
      depositoId: estoque.deposito_id,
      depositoNome: estoque.deposito_nome,
    })),
  );

  let cwb = { disponivel: 0, saldo: 0, reservado: 0 };
  let sp = { disponivel: 0, saldo: 0, reservado: 0 };
  let cwbDepositoId: number | null = null;
  let cwbDepositoNome: string | null = null;
  let cwbLocalizacao: string | null = null;
  let spDepositoId: number | null = null;
  let spDepositoNome: string | null = null;
  let spLocalizacao: string | null = null;

  for (const [, agregado] of porGalpao) {
    if (agregado.galpaoNome === "CWB") {
      cwb = agregado;
      const estoque = estoquesPorEmpresa.find((item) => item.galpao_nome === "CWB");
      cwbDepositoId = estoque?.deposito_id ?? null;
      cwbDepositoNome = estoque?.deposito_nome ?? null;
      cwbLocalizacao = estoque?.localizacao ?? null;
    }
    if (agregado.galpaoNome === "SP") {
      sp = agregado;
      const estoque = estoquesPorEmpresa.find((item) => item.galpao_nome === "SP");
      spDepositoId = estoque?.deposito_id ?? null;
      spDepositoNome = estoque?.deposito_nome ?? null;
      spLocalizacao = estoque?.localizacao ?? null;
    }
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
    cwbAtende: cwb.disponivel > 0,
    spAtende: sp.disponivel > 0,
    estoqueCwbDepositoId: cwbDepositoId,
    estoqueCwbDepositoNome: cwbDepositoNome,
    estoqueCwbSaldo: cwb.saldo,
    estoqueCwbReservado: cwb.reservado,
    estoqueCwbDisponivel: cwb.disponivel,
    estoqueSpDepositoId: spDepositoId,
    estoqueSpDepositoNome: spDepositoNome,
    estoqueSpSaldo: sp.saldo,
    estoqueSpReservado: sp.reservado,
    estoqueSpDisponivel: sp.disponivel,
    localizacaoCwb: cwbLocalizacao,
    localizacaoSp: spLocalizacao,
    estoquesPorEmpresa,
  };
}
