export interface OcDoc {
  id: string;
  fornecedor: string | null;
  galpao_nome: string | null;
  qty_pendente: number;
  criado_em: string | null;
}

export interface ManualDoc {
  id: string;
  fornecedor: string | null;
  galpao_nome: string | null;
  qty_pendente: number;
  criado_em: string | null;
  custo_total: number;
}

export type OrigemDoc = "oc" | "manual";

export interface ReceberDoc {
  origem: OrigemDoc;
  id: string;
  qty_pendente: number;
  criado_em: string | null;
  /** custo total do documento (só manual tem; OC vem da NF downstream) */
  custo_total: number | null;
  /** galpão do próprio documento — exibido na linha quando o grupo é misto. */
  galpao_nome: string | null;
  /** rota da page rica de recebimento */
  href: string;
}

export interface ReceberFornecedorGrupo {
  fornecedor: string;
  galpao_nome: string | null;
  documentos: ReceberDoc[];
}

/**
 * Une documentos de OC e de compra manual numa lista de grupos por fornecedor,
 * cada documento com origem + href pra page rica. Ordena grupos por fornecedor
 * (pt-BR) e documentos por criado_em asc (mais antigo primeiro = mais urgente).
 */
export function mergeReceberDocs(
  ocs: OcDoc[],
  manuais: ManualDoc[],
): ReceberFornecedorGrupo[] {
  const map = new Map<string, ReceberFornecedorGrupo>();

  function grupo(fornecedor: string | null): ReceberFornecedorGrupo {
    const key = fornecedor ?? "Sem fornecedor";
    let g = map.get(key);
    if (!g) {
      g = { fornecedor: key, galpao_nome: null, documentos: [] };
      map.set(key, g);
    }
    return g;
  }

  for (const oc of ocs) {
    grupo(oc.fornecedor).documentos.push({
      origem: "oc",
      id: oc.id,
      qty_pendente: oc.qty_pendente,
      criado_em: oc.criado_em,
      custo_total: null,
      galpao_nome: oc.galpao_nome,
      href: `/wms/receber/oc/${oc.id}`,
    });
  }
  for (const m of manuais) {
    grupo(m.fornecedor).documentos.push({
      origem: "manual",
      id: m.id,
      qty_pendente: m.qty_pendente,
      criado_em: m.criado_em,
      custo_total: m.custo_total,
      galpao_nome: m.galpao_nome,
      href: `/wms/receber/manual/${m.id}`,
    });
  }

  const grupos = [...map.values()];
  for (const g of grupos) {
    g.documentos.sort((a, b) => (a.criado_em ?? "").localeCompare(b.criado_em ?? ""));
    // P3-09: galpão do grupo só vale quando TODOS os docs apontam pro mesmo
    // galpão. Docs do mesmo fornecedor com galpões distintos → 'Vários galpões'
    // (o galpão real fica em cada linha de doc via galpao_nome).
    const galpoes = [
      ...new Set(g.documentos.map((d) => d.galpao_nome).filter((n): n is string => !!n)),
    ];
    g.galpao_nome =
      galpoes.length === 0 ? null : galpoes.length === 1 ? galpoes[0] : "Vários galpões";
  }
  grupos.sort((a, b) => a.fornecedor.localeCompare(b.fornecedor, "pt-BR"));
  return grupos;
}
