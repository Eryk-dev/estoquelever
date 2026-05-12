"use client";

import { Icon } from "@/components/wms/ui/wms-ui";

// Banner consolidado de exceções de compras no DNA WMS.
// Substituto do <ExcecoesBanner> legado. Mostra 3 seções em sequência fixa:
// cancelamento → equivalente → indisponivel. Cancelamento pós-separado vira
// alerta no card + ação no detalhe (não é exceção de compras — D10).

interface ExcecaoItem {
  id: string;
  sku: string;
  descricao: string;
  imagem: string | null;
  quantidade: number;
  pedido_id: string;
  numero_pedido: string;
  compra_status:
    | "indisponivel"
    | "equivalente_pendente"
    | "cancelamento_pendente";
  compra_equivalente_sku: string | null;
  compra_equivalente_descricao: string | null;
  compra_equivalente_fornecedor: string | null;
  compra_equivalente_observacao: string | null;
  compra_cancelamento_motivo: string | null;
  fornecedor_oc: string | null;
}

interface ExcecoesBannerWmsProps {
  excecoes: ExcecaoItem[];
  /** Confirma o cancelamento (POST /api/compras/itens/{id}/cancelamento/confirmar) — chamado pelo pai */
  onConfirmarCancelamento: (itemId: string) => void;
  /** Confirma o equivalente (POST /api/compras/itens/{id}/equivalente/confirmar) */
  onConfirmarEquivalente: (itemId: string) => void;
  /** Devolve o item à fila (POST /api/compras/itens/{id}/devolver) */
  onDevolver: (itemId: string) => void;
  /** Indica qual ação está em flight (mostrar spinner) */
  pendingId?: string | null;
}

const fmtQty = (n: number) => new Intl.NumberFormat("pt-BR").format(n);

const rowStyle = (isLast: boolean): React.CSSProperties => ({
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "6px 0",
  borderBottom: isLast ? "none" : "1px solid var(--wms-c-border)",
});

const bodyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const subStyle: React.CSSProperties = {
  fontSize: 11,
};

const obsStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--wms-c-mute)",
};

const thumbStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 4,
  objectFit: "cover",
  flexShrink: 0,
};

function ExcecoesBannerWms({
  excecoes,
  onConfirmarCancelamento,
  onConfirmarEquivalente,
  onDevolver,
  pendingId,
}: ExcecoesBannerWmsProps) {
  if (excecoes.length === 0) return null;

  const cancelamentos = excecoes.filter(
    (e) => e.compra_status === "cancelamento_pendente",
  );
  const equivalentes = excecoes.filter(
    (e) => e.compra_status === "equivalente_pendente",
  );
  const indisponiveis = excecoes.filter(
    (e) => e.compra_status === "indisponivel",
  );

  return (
    <div className="wms-exc-banner">
      {cancelamentos.length > 0 ? (
        <div className="wms-exc-section is-cancel">
          <div className="wms-exc-h">
            <Icon name="alert" size={14} /> Cancelamentos pendentes (
            {cancelamentos.length})
          </div>
          {cancelamentos.map((item, idx) => {
            const isLast = idx === cancelamentos.length - 1;
            const isPending = pendingId === item.id;
            return (
              <div key={item.id} style={rowStyle(isLast)}>
                {item.imagem ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imagem} alt="" style={thumbStyle} />
                ) : null}
                <div style={bodyStyle}>
                  <div>
                    <span className="wms-mono">{item.sku}</span>{" "}
                    {item.descricao}
                  </div>
                  <div className="wms-td-mute" style={subStyle}>
                    Pedido #{item.numero_pedido} · qty {fmtQty(item.quantidade)}{" "}
                    · motivo: {item.compra_cancelamento_motivo || "—"}
                  </div>
                </div>
                <button
                  className="wms-btn wms-btn-sm wms-btn-danger"
                  disabled={isPending}
                  onClick={() => onConfirmarCancelamento(item.id)}
                  type="button"
                >
                  Confirmar cancelamento
                </button>
                <button
                  className="wms-btn wms-btn-sm wms-btn-ghost"
                  disabled={isPending}
                  onClick={() => onDevolver(item.id)}
                  type="button"
                >
                  Devolver à fila
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {equivalentes.length > 0 ? (
        <div className="wms-exc-section is-equiv">
          <div className="wms-exc-h">
            <Icon name="arrows" size={14} /> Equivalentes pendentes (
            {equivalentes.length})
          </div>
          {equivalentes.map((item, idx) => {
            const isLast = idx === equivalentes.length - 1;
            const isPending = pendingId === item.id;
            return (
              <div key={item.id} style={rowStyle(isLast)}>
                {item.imagem ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imagem} alt="" style={thumbStyle} />
                ) : null}
                <div style={bodyStyle}>
                  <div>
                    <span className="wms-mono">{item.sku}</span> →{" "}
                    <span className="wms-mono">
                      {item.compra_equivalente_sku}
                    </span>
                  </div>
                  <div className="wms-td-mute" style={subStyle}>
                    {item.compra_equivalente_descricao} · fornecedor:{" "}
                    {item.compra_equivalente_fornecedor || "—"} · Pedido #
                    {item.numero_pedido} · qty {fmtQty(item.quantidade)}
                  </div>
                  {item.compra_equivalente_observacao ? (
                    <div style={obsStyle}>
                      Obs: {item.compra_equivalente_observacao}
                    </div>
                  ) : null}
                </div>
                <button
                  className="wms-btn wms-btn-sm wms-btn-primary"
                  disabled={isPending}
                  onClick={() => onConfirmarEquivalente(item.id)}
                  type="button"
                >
                  Confirmar troca
                </button>
                <button
                  className="wms-btn wms-btn-sm wms-btn-ghost"
                  disabled={isPending}
                  onClick={() => onDevolver(item.id)}
                  type="button"
                >
                  Devolver à fila
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {indisponiveis.length > 0 ? (
        <div className="wms-exc-section is-indisp">
          <div className="wms-exc-h">
            <Icon name="x" size={14} /> Indisponíveis ({indisponiveis.length})
          </div>
          {indisponiveis.map((item, idx) => {
            const isLast = idx === indisponiveis.length - 1;
            const isPending = pendingId === item.id;
            return (
              <div key={item.id} style={rowStyle(isLast)}>
                {item.imagem ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imagem} alt="" style={thumbStyle} />
                ) : null}
                <div style={bodyStyle}>
                  <div>
                    <span className="wms-mono">{item.sku}</span>{" "}
                    {item.descricao}
                  </div>
                  <div className="wms-td-mute" style={subStyle}>
                    Pedido #{item.numero_pedido} · qty {fmtQty(item.quantidade)}
                    {item.fornecedor_oc
                      ? ` · fornecedor: ${item.fornecedor_oc}`
                      : ""}
                  </div>
                </div>
                <button
                  className="wms-btn wms-btn-sm wms-btn-ghost"
                  disabled={isPending}
                  onClick={() => onDevolver(item.id)}
                  type="button"
                >
                  Devolver à fila
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export { ExcecoesBannerWms };
export type { ExcecoesBannerWmsProps, ExcecaoItem };
