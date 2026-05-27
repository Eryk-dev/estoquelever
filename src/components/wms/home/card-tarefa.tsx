// src/components/wms/home/card-tarefa.tsx
"use client";

import Link from "next/link";
import { Avatar } from "@/components/wms/ui/avatar";
import type { Executor } from "@/lib/wms/dashboard-tarefas";

const MAX_AVATARES_VISIVEIS = 5;

type Variante =
  | {
      variante: "simples";
      titulo: string;
      contador: number;
      legenda?: string;
      /** Linha secundária menor — usada pra split (ex: marketplace · manual). */
      legendaExtra?: string;
      executores?: Executor[];
    }
  | {
      variante: "dupla";
      titulo: string;
      contadores: [number, number];
      legendas: [string, string];
    };

export type CardTarefaProps = Variante & {
  href: string;
};

export function CardTarefa(props: CardTarefaProps) {
  const totalContador =
    props.variante === "simples"
      ? props.contador
      : props.contadores[0] + props.contadores[1];
  const empty = totalContador === 0;

  return (
    <Link
      href={props.href}
      className={`wms-card-tarefa ${empty ? "wms-card-tarefa-empty" : ""}`}
    >
      <div className="wms-card-tarefa-titulo">{props.titulo}</div>

      {props.variante === "simples" ? (
        <>
          <div className="wms-card-tarefa-contador">{props.contador}</div>
          {props.legenda ? (
            <div className="wms-card-tarefa-legenda">{props.legenda}</div>
          ) : null}
          {props.legendaExtra ? (
            <div className="wms-card-tarefa-legenda-extra">
              {props.legendaExtra}
            </div>
          ) : null}
        </>
      ) : (
        <div className="wms-card-tarefa-dupla">
          <div>
            <div className="wms-card-tarefa-contador">
              {props.contadores[0]}
            </div>
            <div className="wms-card-tarefa-legenda">{props.legendas[0]}</div>
          </div>
          <div className="wms-card-tarefa-sep">/</div>
          <div>
            <div className="wms-card-tarefa-contador">
              {props.contadores[1]}
            </div>
            <div className="wms-card-tarefa-legenda">{props.legendas[1]}</div>
          </div>
        </div>
      )}

      {props.variante === "simples" && props.executores && props.executores.length > 0 ? (
        <div className="wms-card-tarefa-avatares">
          {props.executores
            .slice(0, MAX_AVATARES_VISIVEIS)
            .map((e) => (
              <Avatar
                key={e.id}
                size="sm"
                nome={e.nome}
                fotoUrl={e.foto_url}
              />
            ))}
          {props.executores.length > MAX_AVATARES_VISIVEIS ? (
            <div className="wms-card-tarefa-overflow">
              +{props.executores.length - MAX_AVATARES_VISIVEIS}
            </div>
          ) : null}
        </div>
      ) : null}

      {empty ? (
        <div className="wms-card-tarefa-empty-label">Tudo em dia</div>
      ) : null}
    </Link>
  );
}
