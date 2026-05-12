"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";

/**
 * Switcher de galpão no topo da sidebar do WMS.
 *
 * Esconde quando:
 * - usuário tem ≤ 1 galpão; OU
 * - cargo é galpão-bound (operador_cwb/sp) sem admin override.
 */
export function SidebarGalpaoSwitcher() {
  const { user, activeGalpaoId, setActiveGalpao } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const galpoes = user.galpoes ?? [];
  if (galpoes.length <= 1) return null;

  const cargos = user.cargos ?? [user.cargo];
  const isAdmin = cargos.includes("admin");
  const hasGalpaoBound = cargos.some(
    (c) => c === "operador_cwb" || c === "operador_sp",
  );
  if (hasGalpaoBound && !isAdmin) return null;

  const activeGalpao = galpoes.find((g) => g.id === activeGalpaoId) ?? null;
  const label = activeGalpao?.nome ?? "Todos os galpões";

  return (
    <div className="wms-sb-gs" ref={rootRef}>
      <button
        type="button"
        className={`wms-sb-gs-btn ${open ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`wms-sb-gs-dot ${activeGalpao ? "" : "wms-sb-gs-dot-all"}`}
          style={activeGalpao ? { background: dotColor(activeGalpao.nome) } : undefined}
          aria-hidden
        />
        <span className="wms-sb-gs-lbl">{label}</span>
        <svg
          className="wms-sb-gs-caret"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
        >
          <path
            d="M2 3.5L5 6.5L8 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="wms-sb-gs-pop"
          role="listbox"
          aria-label="Selecionar galpão"
        >
          {galpoes.map((g) => {
            const sel = activeGalpaoId === g.id;
            return (
              <button
                key={g.id}
                type="button"
                role="option"
                aria-selected={sel}
                className={`wms-sb-gs-opt ${sel ? "is-sel" : ""}`}
                onClick={() => {
                  setActiveGalpao(g.id);
                  setOpen(false);
                }}
              >
                <span
                  className="wms-sb-gs-dot"
                  style={{ background: dotColor(g.nome) }}
                  aria-hidden
                />
                <span className="wms-sb-gs-opt-lbl">{g.nome}</span>
                {sel && <CheckIcon />}
              </button>
            );
          })}
          {isAdmin && (
            <>
              <div className="wms-sb-gs-sep" />
              <button
                type="button"
                role="option"
                aria-selected={activeGalpaoId === null}
                className={`wms-sb-gs-opt ${activeGalpaoId === null ? "is-sel" : ""}`}
                onClick={() => {
                  setActiveGalpao(null);
                  setOpen(false);
                }}
              >
                <span className="wms-sb-gs-dot wms-sb-gs-dot-all" aria-hidden />
                <span className="wms-sb-gs-opt-lbl">Todos os galpões</span>
                {activeGalpaoId === null && <CheckIcon />}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      className="wms-sb-gs-check"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
    >
      <path
        d="M2.5 6.5L4.5 8.5L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function dotColor(galpaoNome: string): string {
  const n = galpaoNome.toUpperCase();
  if (n === "CWB") return "#4338ca";
  if (n === "SP") return "#c2410c";
  return "#7c3aed";
}
