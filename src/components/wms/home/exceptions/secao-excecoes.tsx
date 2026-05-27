"use client";

import { useState } from "react";
import { Icon } from "@/components/wms/ui/wms-ui";
import type { ExcecoesPayload } from "@/lib/wms/dashboard-tarefas";
import { CardDevolucoesPendentes } from "./card-devolucoes-pendentes";
import { CardTransferenciasEmTransito } from "./card-transferencias-em-transito";
import { CardInventarioRevisao } from "./card-inventario-revisao";
import { CardReservasOrfas } from "./card-reservas-orfas";
import { CardRetroativos } from "./card-retroativos";
import { CardRecebimentoOrfao } from "./card-recebimento-orfao";

interface Props {
  excecoes: ExcecoesPayload;
}

export function SecaoExcecoes({ excecoes }: Props) {
  const totalExcecoes =
    excecoes.devolucoes.count +
    excecoes.transferencias_transito.count +
    excecoes.inventario_revisao.count +
    excecoes.reservas_orfas.count +
    excecoes.retroativos.count +
    excecoes.recebimento_orfao.count;

  // Default expandido se há qualquer exceção. Estado local — operador pode
  // colapsar manualmente, perde no F5 (intencional — primeira impressão importa).
  const [open, setOpen] = useState(totalExcecoes > 0);

  return (
    <section
      className="wms-excecoes-secao"
      role="region"
      aria-labelledby="wms-excecoes-toggle-label"
    >
      <button
        type="button"
        className="wms-excecoes-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="wms-excecoes-grid"
      >
        <Icon name={open ? "chevron-d" : "chevron-r"} size={12} />
        <span
          id="wms-excecoes-toggle-label"
          className="wms-excecoes-toggle-label"
        >
          Exceções
        </span>
        <span
          className={
            totalExcecoes > 0
              ? "wms-excecoes-toggle-count wms-excecoes-toggle-count-warn"
              : "wms-excecoes-toggle-count"
          }
        >
          {totalExcecoes}
        </span>
      </button>
      {open ? (
        <div id="wms-excecoes-grid" className="wms-excecoes-grid">
          <CardDevolucoesPendentes
            count={excecoes.devolucoes.count}
            itens={excecoes.devolucoes.itens}
          />
          <CardTransferenciasEmTransito
            count={excecoes.transferencias_transito.count}
            itens={excecoes.transferencias_transito.itens}
          />
          <CardInventarioRevisao
            count={excecoes.inventario_revisao.count}
            itens={excecoes.inventario_revisao.itens}
          />
          <CardReservasOrfas
            count={excecoes.reservas_orfas.count}
            itens={excecoes.reservas_orfas.itens}
          />
          <CardRetroativos
            count={excecoes.retroativos.count}
            itens={excecoes.retroativos.itens}
          />
          <CardRecebimentoOrfao
            count={excecoes.recebimento_orfao.count}
            itens={excecoes.recebimento_orfao.itens}
          />
        </div>
      ) : null}
    </section>
  );
}

export function SecaoExcecoesSkeleton() {
  return (
    <section className="wms-excecoes-secao" aria-busy="true">
      <div className="wms-excecoes-toggle wms-excecoes-toggle-skeleton">
        <span className="wms-skeleton-line wms-skeleton-line-80" />
      </div>
      <div className="wms-excecoes-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="wms-excecao-card wms-excecao-card-skeleton">
            <span className="wms-skeleton-line wms-skeleton-line-60" />
            <span className="wms-skeleton-line wms-skeleton-line-40" />
          </div>
        ))}
      </div>
    </section>
  );
}
