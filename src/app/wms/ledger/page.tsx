"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import {
  Icon,
  PageHeader,
  Pagination,
  Modal,
  Field,
} from "@/components/wms/ui/wms-ui";
import { LedgerRow } from "@/components/wms/produto-drawer";
import { usePermissoes } from "@/lib/auth-context";
import type { Movimentacao } from "@/lib/wms/types";

interface LedgerRowData extends Movimentacao {
  produto?: { sku: string; descricao: string };
  galpao?: { nome: string };
  localizacao?: { codigo: string; tipo: string };
  compradora?: { nome: string } | null;
  vendedora?: { nome: string } | null;
  referencia?: { nome: string } | null;
  fornecedor?: { nome: string } | null;
}

interface EmpresaLite {
  id: string;
  nome: string;
}

interface FornecedorLite {
  id: string;
  nome: string;
}

const TIPO_OPTS: Array<[string, string]> = [
  ["all", "Todos"],
  ["E", "Entradas"],
  ["S", "Saídas"],
  ["R", "Reservas"],
  ["L", "Liberações"],
];

export default function LedgerPage() {
  const [tipo, setTipo] = useState<string>("all");
  const [origem, setOrigem] = useState<string>("all");
  const [compradoraId, setCompradoraId] = useState<string>("all");
  const [vendedoraId, setVendedoraId] = useState<string>("all");
  const [referenciaId, setReferenciaId] = useState<string>("all");
  const [fornecedorId, setFornecedorId] = useState<string>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 300;

  const empresasQuery = useQuery({
    queryKey: ["wms-empresas-lite"],
    queryFn: () => wmsApi<EmpresaLite[]>(`/api/wms/admin/empresas`),
  });
  const fornecedoresQuery = useQuery({
    queryKey: ["wms-fornecedores-lite"],
    queryFn: () =>
      wmsApi<{ rows: FornecedorLite[] }>(`/api/wms/fornecedores`),
  });
  const empresas = empresasQuery.data ?? [];
  const fornecedores = fornecedoresQuery.data?.rows ?? [];

  // Reset de página quando um filtro server-side muda (derive-during-render,
  // sem useEffect). Os filtros client-side (tipo, q) só refinam a página atual.
  const serverFiltersKey = `${origem}|${compradoraId}|${vendedoraId}|${referenciaId}|${fornecedorId}`;
  const [pageFor, setPageFor] = useState(serverFiltersKey);
  if (pageFor !== serverFiltersKey) {
    setPageFor(serverFiltersKey);
    setPage(1);
  }

  const ledgerQuery = useQuery({
    queryKey: [
      "wms-ledger",
      "global",
      origem,
      compradoraId,
      vendedoraId,
      referenciaId,
      fornecedorId,
      page,
    ],
    queryFn: () => {
      const sp = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (origem !== "all") sp.set("origem_tipo", origem);
      if (compradoraId !== "all")
        sp.set("empresa_compradora_id", compradoraId);
      if (vendedoraId !== "all") sp.set("empresa_vendedora_id", vendedoraId);
      if (referenciaId !== "all")
        sp.set("empresa_referencia_id", referenciaId);
      if (fornecedorId !== "all") sp.set("fornecedor_id", fornecedorId);
      return wmsApi<{ rows: LedgerRowData[]; total: number }>(
        `/api/wms/ledger?${sp}`,
      );
    },
  });
  const all = ledgerQuery.data?.rows ?? [];
  const total = ledgerQuery.data?.total ?? 0;

  const qc = useQueryClient();
  const { can } = usePermissoes();
  const podeEstornar = can("operacoes.ajuste_manual");

  // Mov de ajuste alvo de um estorno: derivado client-side a partir das linhas
  // carregadas (a rota expõe estorno_de). Cobertura = página atual.
  const jaEstornadas = useMemo(
    () =>
      new Set(
        all
          .map((m) => m.estorno_de)
          .filter((v): v is string => v != null),
      ),
    [all],
  );

  // Modal de confirmação de estorno (motivo obrigatório ≥3 chars).
  const [estornoAlvo, setEstornoAlvo] = useState<LedgerRowData | null>(null);
  const [estornoMotivo, setEstornoMotivo] = useState("");

  const estornar = useMutation({
    mutationFn: (input: { id: string; motivo: string }) =>
      wmsApi(`/api/wms/ajuste/${input.id}/estornar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivo: input.motivo }),
      }),
    onSuccess: () => {
      toast.success("Ajuste estornado");
      setEstornoAlvo(null);
      setEstornoMotivo("");
      qc.invalidateQueries({ queryKey: ["wms-ledger", "global"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filtered = useMemo(() => {
    let r = all;
    if (tipo !== "all") r = r.filter((m) => m.tipo === tipo);
    if (q) {
      const ql = q.toLowerCase();
      r = r.filter((m) => {
        const sku = m.produto?.sku?.toLowerCase() ?? "";
        const desc = m.produto?.descricao?.toLowerCase() ?? "";
        const obs = (m.observacoes ?? "").toLowerCase();
        return sku.includes(ql) || desc.includes(ql) || obs.includes(ql);
      });
    }
    return r;
  }, [all, tipo, q]);

  const origens = useMemo(
    () => Array.from(new Set(all.map((m) => m.origem_tipo))).sort(),
    [all],
  );

  return (
    <>
      <PageHeader
        title="Movimentações"
        subtitle={`Ledger imutável · ${total} registros${
          filtered.length !== all.length
            ? ` · ${filtered.length} nesta página após filtro`
            : ""
        }`}
      >
        <button className="wms-btn wms-btn-ghost" disabled>
          <Icon name="download" size={12} />
          Exportar
        </button>
      </PageHeader>

      <div className="wms-toolbar">
        <div className="wms-search-wrap">
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar SKU, produto ou observação…"
          />
          {q && (
            <button className="wms-search-clear" onClick={() => setQ("")}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
        <div className="wms-seg">
          {TIPO_OPTS.map(([id, l]) => (
            <button
              key={id}
              className={`wms-seg-btn ${tipo === id ? "is-active" : ""}`}
              onClick={() => setTipo(id)}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          className="wms-select"
          value={origem}
          onChange={(e) => setOrigem(e.target.value)}
          style={{ width: 200 }}
        >
          <option value="all">Todas origens</option>
          {origens.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={compradoraId}
          onChange={(e) => setCompradoraId(e.target.value)}
          style={{ width: 200 }}
          title="Empresa compradora (NF de entrada)"
        >
          <option value="all">Compradora: todas</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              Compradora: {e.nome}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={vendedoraId}
          onChange={(e) => setVendedoraId(e.target.value)}
          style={{ width: 200 }}
          title="Empresa vendedora (NF de saída)"
        >
          <option value="all">Vendedora: todas</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              Vendedora: {e.nome}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={referenciaId}
          onChange={(e) => setReferenciaId(e.target.value)}
          style={{ width: 200 }}
          title="Empresa referência (movs internas)"
        >
          <option value="all">Referência: todas</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              Referência: {e.nome}
            </option>
          ))}
        </select>
        <select
          className="wms-select"
          value={fornecedorId}
          onChange={(e) => setFornecedorId(e.target.value)}
          style={{ width: 200 }}
        >
          <option value="all">Fornecedor: todos</option>
          {fornecedores.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>
      </div>

      <div className="wms-ledger-list">
        {ledgerQuery.isLoading && (
          <div className="wms-loading-pane">Carregando…</div>
        )}
        {ledgerQuery.isError && (
          <div className="wms-td-empty wms-td-danger" style={{ padding: 32 }}>
            Erro: {(ledgerQuery.error as Error).message}
          </div>
        )}
        {!ledgerQuery.isLoading && filtered.length === 0 && (
          <div className="wms-td-empty" style={{ padding: 32 }}>
            Nenhuma movimentação.
          </div>
        )}
        {filtered.map((m) => {
          const podeEstornarLinha =
            podeEstornar &&
            m.origem_tipo === "ajuste_manual" &&
            m.estorno_de == null &&
            !jaEstornadas.has(m.id);
          return (
            <LedgerRow
              key={m.id}
              m={m}
              action={
                podeEstornarLinha ? (
                  <button
                    className="wms-btn wms-btn-sm wms-btn-ghost"
                    onClick={() => {
                      setEstornoAlvo(m);
                      setEstornoMotivo("");
                    }}
                    title="Estornar este ajuste manual"
                  >
                    <Icon name="history" size={11} />
                    Estornar
                  </button>
                ) : undefined
              }
            />
          );
        })}
      </div>

      <Pagination
        total={total}
        pageSize={PAGE_SIZE}
        page={page}
        onPageChange={setPage}
        label="registros"
      />

      {estornoAlvo && (
        <Modal
          title="Estornar ajuste manual"
          subtitle="Gera uma movimentação inversa no ledger. Não pode ser desfeito."
          onClose={() => {
            if (!estornar.isPending) setEstornoAlvo(null);
          }}
          footer={
            <>
              <button
                className="wms-btn wms-btn-ghost"
                onClick={() => setEstornoAlvo(null)}
                disabled={estornar.isPending}
              >
                Cancelar
              </button>
              <button
                className="wms-btn wms-btn-danger"
                onClick={() =>
                  estornar.mutate({
                    id: estornoAlvo.id,
                    motivo: estornoMotivo.trim(),
                  })
                }
                disabled={
                  estornar.isPending || estornoMotivo.trim().length < 3
                }
              >
                {estornar.isPending ? "Estornando…" : "Confirmar estorno"}
              </button>
            </>
          }
        >
          <div style={{ marginBottom: 12 }}>
            <span className="wms-mono">
              {estornoAlvo.produto?.sku ?? "—"}
            </span>{" "}
            <span className="wms-td-mute">
              {estornoAlvo.produto?.descricao ?? ""}
            </span>
          </div>
          <Field label="Motivo do estorno" required>
            <input
              autoFocus
              className="wms-input"
              placeholder="ex.: ajuste lançado por engano"
              value={estornoMotivo}
              onChange={(e) => setEstornoMotivo(e.target.value)}
            />
          </Field>
        </Modal>
      )}
    </>
  );
}
