import type { Produto } from "@/lib/wms/types";
import type { PermissaoCodigo } from "@/lib/permissions";

/** Item que o componente rico gerencia (superset dos 4 fluxos). */
export interface ReceberLoteItem {
  uid: string;
  /** produto resolvido (avulso) OU display-only (fluxos pré-definidos) */
  produto: Produto | null;
  /** display quando produto não é uuid-resolvível (OC usa tiny_produto_id) */
  sku: string;
  descricao: string;
  imagem_url: string | null;
  /** id da linha no backend do fluxo (item_id OC/manual, transferencia_item_id) */
  backendItemId: string | null;
  qty: string;
  /** qty esperada/pendente (read-only ref pra divergência e default) */
  qtyEsperada: number | null;
  custo: string;
  locIdOverride: string | null;
  locCodigoOverride: string | null;
  imprimir: boolean;
  motivoDivergencia: string | null;
}

export type FluxoReceber = "avulso" | "oc" | "manual" | "transferencia";

export interface ReceberLoteConfig {
  fluxo: FluxoReceber;
  canAddItems: boolean;
  productEditable: boolean;
  qtyEditable: boolean;
  custoVisible: boolean;
  custoObrigatorio: boolean;
  locPickVisible: boolean;
  locObrigatoria: boolean;
  divergenciaVisible: boolean;
  imprimirVisible: boolean;
  mlBlockVisible: boolean;
  planoSidebarVisible: boolean;
  leftFormVisible: boolean;
  /** roda a query de sugestão de loc (/api/wms/receber?produto_id=). Só avulso. */
  putawaySuggest?: boolean;
  /** permite criar loc inline no LocalizacaoCombo. Default true (preserva avulso).
   *  false em transferência (operador escolhe loc EXISTENTE, nunca cria). */
  locAllowCreate?: boolean;
  /** código de permissão pra liberar o Confirmar (ex: 'operacoes.receber') */
  permissaoReceber: PermissaoCodigo;
  /** chip read-only do header (fornecedor/galpão) nos fluxos pré-definidos */
  headerChips?: { label: string; value: string }[];
}
