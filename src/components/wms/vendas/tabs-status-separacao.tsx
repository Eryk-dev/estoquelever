"use client";

// Substituto WMS-nativo do TabBar legado de `/separacao`.
// 6 tabs grossas com label + contador grande. Preserva o paradigma
// legado (mesma ordem e mesmos status) no DNA visual do WMS.

type TabId =
  | "aguardando_compra"
  | "aguardando_nf"
  | "aguardando_separacao"
  | "em_separacao"
  | "separado"
  | "encaixotado"
  | "embalado"
  | "conferido"
  | "pendente_realocacao"
  | "cancelado";

interface TabsStatusSeparacaoProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  /** Limita as tabs exibidas (ex.: separação futura para em `separado` — sem
   *  aguardando_nf/embalado/conferido). Default: todas. */
  visibleTabs?: TabId[];
  counts: {
    aguardando_compra: number;
    aguardando_nf: number;
    /** Soma validacao_oc + aguardando_separacao real */
    aguardando_separacao: number;
    em_separacao: number;
    separado: number;
    /** Só usado na pista futura: pedidos já 100% encaixotados. */
    encaixotado: number;
    embalado: number;
    conferido: number;
    pendente_realocacao: number;
    /** Pedidos cancelados (cliente/comprador/operador) — aba após Conferidos. */
    cancelado: number;
  };
}

const TABS: { id: TabId; label: string }[] = [
  { id: "aguardando_compra", label: "Compras" },
  { id: "aguardando_nf", label: "Aguard. NF" },
  { id: "aguardando_separacao", label: "Pra separar" },
  { id: "em_separacao", label: "Em separação" },
  { id: "separado", label: "Separados" },
  { id: "encaixotado", label: "Encaixotados" },
  { id: "embalado", label: "Embalados" },
  { id: "conferido", label: "Conferidos" },
  { id: "cancelado", label: "Cancelados" },
  { id: "pendente_realocacao", label: "Realocação" },
];

function TabsStatusSeparacao({
  active,
  onChange,
  counts,
  visibleTabs,
}: TabsStatusSeparacaoProps) {
  // `encaixotado` é exclusivo da pista futura (entra via visibleTabs/FUTURA_TABS).
  // O caminho default (separação normal) NÃO mostra essa aba.
  const tabs = visibleTabs
    ? TABS.filter((t) => visibleTabs.includes(t.id))
    : TABS.filter((t) => t.id !== "encaixotado");
  return (
    <div className="wms-stab" role="tablist">
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            className={`wms-stab-btn${isActive ? " is-active" : ""}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            type="button"
          >
            <span className="wms-stab-btn-lbl">{t.label}</span>
            <span className="wms-stab-btn-n">{counts[t.id]}</span>
          </button>
        );
      })}
    </div>
  );
}

export { TabsStatusSeparacao };
export type {
  TabsStatusSeparacaoProps,
  TabId as TabIdStatusSeparacao,
};
