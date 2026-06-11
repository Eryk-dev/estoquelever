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
  | "embalado"
  | "conferido"
  | "pendente_realocacao";

interface TabsStatusSeparacaoProps {
  active: TabId;
  onChange: (tab: TabId) => void;
  counts: {
    aguardando_compra: number;
    aguardando_nf: number;
    /** Soma validacao_oc + aguardando_separacao real */
    aguardando_separacao: number;
    em_separacao: number;
    separado: number;
    embalado: number;
    conferido: number;
    pendente_realocacao: number;
  };
}

const TABS: { id: TabId; label: string }[] = [
  { id: "aguardando_compra", label: "Compras" },
  { id: "aguardando_nf", label: "Aguard. NF" },
  { id: "aguardando_separacao", label: "Pra separar" },
  { id: "em_separacao", label: "Em separação" },
  { id: "separado", label: "Separados" },
  { id: "embalado", label: "Embalados" },
  { id: "conferido", label: "Conferidos" },
  { id: "pendente_realocacao", label: "Realocação" },
];

function TabsStatusSeparacao({
  active,
  onChange,
  counts,
}: TabsStatusSeparacaoProps) {
  return (
    <div className="wms-stab" role="tablist">
      {TABS.map((t) => {
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
