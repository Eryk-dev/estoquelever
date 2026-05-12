"use client";

import { useAuth } from "@/lib/auth-context";

/**
 * Filtro global de galpão — barra sticky no topo da view (Decisão D3).
 * Reusa `useAuth.activeGalpaoId/setActiveGalpao` (persistente em localStorage
 * e enviado como header `X-Galpao-Id` no sisoFetch).
 *
 * Aplica em todas as telas do WMS unificado:
 * - Vendas: filtra pedidos/separação/compras por galpão de origem
 * - Visibilidade: filtra estoque/cobertura/movimentações
 * - Operações: pré-seleciona galpão em receber/transferir/realocar/devoluções
 * - Inventário/Cadastros: filtra sessões/localizações que têm dimensão galpão
 *
 * Aparece sempre exceto:
 * - quando user só tem 1 galpão (escolha fixa)
 * - quando user não é admin e cargo tem prefixo de galpão (operador_cwb/sp)
 *   — nesse caso o galpão vem pré-fixado pelo cargo, sem dropdown
 */
export function FiltroGalpaoGlobal() {
  const { user, activeGalpaoId, setActiveGalpao } = useAuth();

  if (!user) return null;
  const galpoes = user.galpoes ?? [];
  if (galpoes.length <= 1) return null;

  const cargos = user.cargos ?? [user.cargo];
  const isAdmin = cargos.includes("admin");

  // Operadores com cargo galpão-bound (operador_cwb/sp) têm galpão fixo
  const hasGalpaoBound = cargos.some(
    (c) => c === "operador_cwb" || c === "operador_sp",
  );
  if (hasGalpaoBound && !isAdmin) return null;

  return (
    <div className="wms-glf">
      <span className="wms-glf-lbl">Galpão</span>
      <div className="wms-glf-seg" role="tablist" aria-label="Filtro global de galpão">
        {isAdmin && (
          <button
            type="button"
            role="tab"
            aria-selected={activeGalpaoId === null}
            className={`wms-glf-seg-btn ${activeGalpaoId === null ? "is-active" : ""}`}
            onClick={() => setActiveGalpao(null)}
          >
            Todos
          </button>
        )}
        {galpoes.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={activeGalpaoId === g.id}
            className={`wms-glf-seg-btn ${activeGalpaoId === g.id ? "is-active" : ""}`}
            onClick={() => setActiveGalpao(g.id)}
          >
            <span
              className="wms-glf-dot"
              style={{ background: dotColor(g.nome) }}
              aria-hidden
            />
            {g.nome}
          </button>
        ))}
      </div>
      {activeGalpaoId !== null && (
        <span className="wms-glf-hint">
          Mostrando dados de <strong>{user.galpoes.find((g) => g.id === activeGalpaoId)?.nome}</strong>
        </span>
      )}
    </div>
  );
}

function dotColor(galpaoNome: string): string {
  const n = galpaoNome.toUpperCase();
  if (n === "CWB") return "#4338ca";
  if (n === "SP") return "#c2410c";
  return "#7c3aed";
}
