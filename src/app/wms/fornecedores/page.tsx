"use client";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, Pagination, Field } from "@/components/wms/ui/wms-ui";
import type { Fornecedor } from "@/lib/wms/fornecedores";

export default function FornecedoresPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = (user?.cargos ?? [user?.cargo]).includes("admin");
  const [showForm, setShowForm] = useState(false);
  const [novo, setNovo] = useState({ nome: "", cnpj: "", prefixo_sku: "" });
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["wms-fornecedores"],
    queryFn: () => wmsApi<{ rows: Fornecedor[] }>("/api/wms/fornecedores"),
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<Fornecedor>("/api/wms/fornecedores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: novo.nome,
          cnpj: novo.cnpj || undefined,
          prefixo_sku: novo.prefixo_sku || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success("Fornecedor criado");
      setNovo({ nome: "", cnpj: "", prefixo_sku: "" });
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const autoCadastro = useMutation({
    mutationFn: () =>
      wmsApi<{ criados: number; existentes: number }>(
        "/api/wms/fornecedores/auto-cadastro",
        { method: "POST" },
      ),
    onSuccess: (d) => {
      toast.success(`${d.criados} criados, ${d.existentes} já existiam`);
      queryClient.invalidateQueries({ queryKey: ["wms-fornecedores"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pagedRows = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rows, page],
  );

  return (
    <>
      <PageHeader
        title="Fornecedores"
        subtitle={`${rows.length} fornecedor(es) cadastrado(s)`}
      >
        {isAdmin && (
          <button
            type="button"
            className="wms-btn wms-btn-ghost"
            disabled={autoCadastro.isPending}
            onClick={() => autoCadastro.mutate()}
            title="Auto-cadastrar do mapeamento canônico de prefixos SKU"
          >
            <Icon name="sparkle" size={12} />
            Auto-cadastrar mapeamento canônico
          </button>
        )}
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Novo fornecedor
        </button>
      </PageHeader>

      {showForm && (
        <div
          style={{
            background: "var(--wms-c-panel)",
            border: "1px solid var(--wms-c-border)",
            borderRadius: "var(--wms-r-3)",
            padding: 16,
            marginBottom: 16,
          }}
        >
          <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
            Novo fornecedor
          </h3>
          <div className="wms-row-3">
            <Field label="Nome" required>
              <input
                className="wms-input"
                value={novo.nome}
                onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
                placeholder="ex.: Tiger"
              />
            </Field>
            <Field label="CNPJ">
              <input
                className="wms-input wms-mono"
                value={novo.cnpj}
                onChange={(e) => setNovo({ ...novo, cnpj: e.target.value })}
                placeholder="00.000.000/0000-00"
              />
            </Field>
            <Field label="Prefixo SKU">
              <input
                className="wms-input wms-mono"
                value={novo.prefixo_sku}
                onChange={(e) =>
                  setNovo({ ...novo, prefixo_sku: e.target.value })
                }
                placeholder="TGR"
              />
            </Field>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              paddingTop: 12,
              borderTop: "1px solid var(--wms-c-border)",
            }}
          >
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              onClick={() => setShowForm(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={!novo.nome || criar.isPending}
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar fornecedor"}
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="wms-loading-pane">Carregando fornecedores…</div>
      )}
      {isError && (
        <div className="wms-empty-block">
          <h3>Erro</h3>
          <p>{(error as Error).message}</p>
        </div>
      )}
      {!isLoading && rows.length === 0 && (
        <div className="wms-empty-block">
          <h3>Nenhum fornecedor cadastrado</h3>
          {isAdmin && (
            <p>
              Use o botão{" "}
              <strong>Auto-cadastrar mapeamento canônico</strong> para semear os
              fornecedores do mapeamento de prefixos SKU.
            </p>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Prefixo SKU</th>
                  <th>CNPJ</th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.nome}</strong>
                    </td>
                    <td className="wms-mono">{f.prefixo_sku ?? "—"}</td>
                    <td className="wms-mono wms-td-mute">{f.cnpj ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            total={rows.length}
            pageSize={PAGE_SIZE}
            page={page}
            onPageChange={setPage}
            label="fornecedores"
          />
        </>
      )}
    </>
  );
}
