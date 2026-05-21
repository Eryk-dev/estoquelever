// src/components/wms/home/cards-detalhe.tsx
"use client";

import Link from "next/link";
import { Avatar } from "@/components/wms/ui/avatar";
import type {
  CicloInventario,
  FornecedorCompras,
  GuardaItem,
} from "@/lib/wms/dashboard-tarefas";

const MAX_AVATARES = 5;

function formatarTempo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function CardGuardaItem({ item }: { item: GuardaItem }) {
  return (
    <Link href={`/wms/guarda/${item.id}`} className="wms-card-detalhe">
      <div className="wms-card-detalhe-head">
        <span
          className={`wms-card-badge ${
            item.status === "em_guarda"
              ? "wms-card-badge-ativo"
              : "wms-card-badge-pendente"
          }`}
        >
          {item.status === "em_guarda" ? "em guarda" : "pendente"}
        </span>
        <span className="wms-card-detalhe-tempo">
          {formatarTempo(item.criada_em)}
        </span>
      </div>
      <div className="wms-card-detalhe-sku">{item.produto_sku}</div>
      {item.produto_descricao ? (
        <div className="wms-card-detalhe-desc">{item.produto_descricao}</div>
      ) : null}
      <div className="wms-card-detalhe-foot">
        <span className="wms-card-detalhe-qty">
          {item.qty_pendente}
          {item.qty_pendente !== item.qty_inicial ? (
            <span className="wms-card-detalhe-qty-inicial">
              {" "}
              / {item.qty_inicial}
            </span>
          ) : null}
        </span>
        {item.galpao_nome ? (
          <span className="wms-card-detalhe-meta">{item.galpao_nome}</span>
        ) : null}
        {item.iniciada_por ? (
          <Avatar
            size="xs"
            nome={item.iniciada_por.nome}
            fotoUrl={item.iniciada_por.foto_url}
          />
        ) : null}
      </div>
    </Link>
  );
}

export function CardInventarioCiclo({ ciclo }: { ciclo: CicloInventario }) {
  return (
    <Link
      href={`/wms/inventario/${ciclo.id}`}
      className="wms-card-detalhe wms-card-detalhe-tall"
    >
      <div className="wms-card-detalhe-head">
        <span className="wms-card-badge wms-card-badge-ativo">
          {ciclo.tipo === "completo" ? "completo" : "cycle count"}
        </span>
        {ciclo.galpao_nome ? (
          <span className="wms-card-detalhe-meta">{ciclo.galpao_nome}</span>
        ) : null}
      </div>
      <div className="wms-card-detalhe-sku">{ciclo.nome}</div>
      <div className="wms-progresso">
        <div className="wms-progresso-bar">
          <div
            className="wms-progresso-bar-fill"
            style={{ width: `${ciclo.progresso_pct}%` }}
          />
        </div>
        <div className="wms-progresso-label">
          <strong>{ciclo.progresso_pct}%</strong>
          <span>
            {ciclo.locs_contadas}/{ciclo.locs_total} locs
          </span>
        </div>
      </div>
      <div className="wms-card-detalhe-foot">
        <span className="wms-card-detalhe-meta">
          {ciclo.locs_pendentes} pendentes
        </span>
        {ciclo.operadores.length > 0 ? (
          <div className="wms-card-tarefa-avatares">
            {ciclo.operadores.slice(0, MAX_AVATARES).map((e) => (
              <Avatar
                key={e.id}
                size="xs"
                nome={e.nome}
                fotoUrl={e.foto_url}
              />
            ))}
            {ciclo.operadores.length > MAX_AVATARES ? (
              <div className="wms-card-tarefa-overflow">
                +{ciclo.operadores.length - MAX_AVATARES}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export function CardComprasFornecedor({
  fornecedor,
}: {
  fornecedor: FornecedorCompras;
}) {
  return (
    <Link href="/wms/compras" className="wms-card-detalhe">
      <div className="wms-card-detalhe-head">
        <span className="wms-card-badge wms-card-badge-neutro">fornecedor</span>
      </div>
      <div className="wms-card-detalhe-sku">{fornecedor.fornecedor}</div>
      <div className="wms-card-tarefa-dupla">
        <div>
          <div className="wms-card-tarefa-contador">{fornecedor.a_comprar}</div>
          <div className="wms-card-tarefa-legenda">a comprar</div>
        </div>
        <div className="wms-card-tarefa-sep">/</div>
        <div>
          <div className="wms-card-tarefa-contador">{fornecedor.a_receber}</div>
          <div className="wms-card-tarefa-legenda">a receber</div>
        </div>
      </div>
    </Link>
  );
}
