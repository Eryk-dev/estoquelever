"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wmsApi } from "@/lib/wms/api-client";
import { Icon, PageHeader, fmtNum } from "@/components/wms/ui/wms-ui";
import type { EmprestimoRegra, SaldoDevedor } from "@/lib/wms/emprestimos";

interface EmpresaRow {
  id: string;
  nome: string;
}

interface GalpaoRow {
  id: string;
  empresas?: EmpresaRow[];
}

export default function EmprestimosPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [credora, setCredora] = useState<string>("");
  const [devedora, setDevedora] = useState<string>("");

  const { data: galpoes } = useQuery({
    queryKey: ["galpoes"],
    queryFn: async () => {
      const raw = await wmsApi<
        Array<{
          id: string;
          nome: string;
          siso_empresas?: Array<{ id: string; nome: string; ativo?: boolean }>;
        }>
      >("/api/admin/galpoes");
      return raw.map<GalpaoRow>((g) => ({
        id: g.id,
        nome: g.nome,
        empresas: (g.siso_empresas ?? [])
          .filter((e) => e.ativo !== false)
          .map((e) => ({ id: e.id, nome: e.nome })),
      }));
    },
  });
  const empresas: EmpresaRow[] = (galpoes ?? []).flatMap(
    (g) => g.empresas ?? [],
  );

  const regrasQuery = useQuery({
    queryKey: ["wms-regras"],
    queryFn: () =>
      wmsApi<{ rows: EmprestimoRegra[] }>("/api/wms/emprestimo-regras"),
  });

  const saldosQuery = useQuery({
    queryKey: ["wms-saldos-devedores"],
    queryFn: () =>
      wmsApi<{ rows: SaldoDevedor[] }>("/api/wms/emprestimos/saldos"),
  });

  const criar = useMutation({
    mutationFn: () =>
      wmsApi<EmprestimoRegra>("/api/wms/emprestimo-regras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresa_credora_id: credora,
          empresa_devedora_id: devedora,
        }),
      }),
    onSuccess: () => {
      toast.success("Regra criada");
      setCredora("");
      setDevedora("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const empresaNome = (id: string) =>
    empresas.find((e) => e.id === id)?.nome ?? id;

  const regras = regrasQuery.data?.rows ?? [];
  const saldos = saldosQuery.data?.rows ?? [];

  return (
    <>
      <PageHeader
        title="Empréstimos entre empresas"
        subtitle="Matriz N×N · saldos devedores em peças · limites por par e por produto"
      >
        <button
          type="button"
          className="wms-btn wms-btn-primary"
          onClick={() => setShowForm((s) => !s)}
        >
          <Icon name="plus" size={12} />
          Nova regra
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
            Nova regra credora → devedora
          </h3>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <select
              className="wms-select"
              value={credora}
              onChange={(e) => setCredora(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            >
              <option value="">— credora —</option>
              {empresas.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
            <Icon name="arrow-right" size={14} />
            <select
              className="wms-select"
              value={devedora}
              onChange={(e) => setDevedora(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            >
              <option value="">— devedora —</option>
              {empresas.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.nome}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="wms-btn wms-btn-primary"
              disabled={
                !credora || !devedora || credora === devedora || criar.isPending
              }
              onClick={() => criar.mutate()}
            >
              <Icon name="check" size={11} />
              {criar.isPending ? "Criando…" : "Criar regra"}
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-ghost"
              onClick={() => setShowForm(false)}
            >
              Cancelar
            </button>
          </div>
          {credora && devedora && credora === devedora && (
            <div
              className="wms-hint-card wms-hint-danger"
              style={{ marginTop: 10 }}
            >
              <Icon name="alert" />
              <span>Credora e devedora não podem ser a mesma empresa.</span>
            </div>
          )}
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h3 className="wms-sec-h">Regras de empréstimo</h3>
        {regrasQuery.isLoading && (
          <div className="wms-loading-pane">Carregando regras…</div>
        )}
        {regrasQuery.isError && (
          <div className="wms-empty-block">
            <h3>Erro</h3>
            <p>{(regrasQuery.error as Error).message}</p>
          </div>
        )}
        {!regrasQuery.isLoading && regras.length === 0 && (
          <div className="wms-empty-block">
            <h3>Nenhuma regra cadastrada</h3>
            <p>
              Crie a primeira regra para permitir empréstimos entre empresas.
            </p>
          </div>
        )}
        {regras.length > 0 && (
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Credora</th>
                  <th></th>
                  <th>Devedora</th>
                  <th className="wms-tar">Limite global</th>
                  <th className="wms-tar">Limites por SKU</th>
                  <th className="wms-tar">Ações</th>
                </tr>
              </thead>
              <tbody>
                {regras.map((r) => (
                  <RegraRow key={r.id} regra={r} empresaNome={empresaNome} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h3 className="wms-sec-h">Saldos devedores</h3>
        <p className="wms-td-mute" style={{ fontSize: 12, marginBottom: 8 }}>
          Saldo líquido bidirecional credora ↔ devedora por produto, calculado
          via{" "}
          <span className="wms-mono">wms_saldos_devedores()</span>.
        </p>
        {saldosQuery.isLoading && (
          <div className="wms-loading-pane">Carregando saldos…</div>
        )}
        {saldosQuery.isError && (
          <div className="wms-empty-block">
            <h3>Erro</h3>
            <p>{(saldosQuery.error as Error).message}</p>
          </div>
        )}
        {!saldosQuery.isLoading && saldos.length === 0 && (
          <div className="wms-empty-block">
            <h3>Sem saldos devedores</h3>
            <p>Nenhum empréstimo pendente entre empresas no momento.</p>
          </div>
        )}
        {saldos.length > 0 && (
          <div className="wms-tbl">
            <table>
              <thead>
                <tr>
                  <th>Credora</th>
                  <th>Devedora</th>
                  <th>Produto</th>
                  <th className="wms-tar">Saldo líquido</th>
                </tr>
              </thead>
              <tbody>
                {saldos.map((s, i) => (
                  <tr key={i}>
                    <td className="wms-td-mute">{empresaNome(s.credora)}</td>
                    <td className="wms-td-mute">{empresaNome(s.devedora)}</td>
                    <td className="wms-mono" style={{ fontSize: 12 }}>
                      {s.produto_id}
                    </td>
                    <td className="wms-tar wms-mono">
                      {fmtNum(Number(s.saldo_liquido))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function RegraRow({
  regra,
  empresaNome,
}: {
  regra: EmprestimoRegra;
  empresaNome: (id: string) => string;
}) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [limite, setLimite] = useState<string>(
    regra.limite_max_por_produto?.toString() ?? "",
  );

  const atualizar = useMutation({
    mutationFn: () =>
      wmsApi<EmprestimoRegra>(`/api/wms/emprestimo-regras/${regra.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limite_max_por_produto: limite === "" ? null : Number(limite),
        }),
      }),
    onSuccess: () => {
      toast.success("Limite atualizado");
      setEditando(false);
      queryClient.invalidateQueries({ queryKey: ["wms-regras"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <tr>
      <td>{empresaNome(regra.empresa_credora_id)}</td>
      <td className="wms-td-mute">
        <Icon name="arrow-right" size={11} />
      </td>
      <td>{empresaNome(regra.empresa_devedora_id)}</td>
      <td className="wms-tar wms-mono">
        {editando ? (
          <input
            className="wms-input wms-mono wms-tar"
            type="number"
            value={limite}
            onChange={(e) => setLimite(e.target.value)}
            placeholder="sem limite"
            style={{ width: 120, marginLeft: "auto" }}
          />
        ) : regra.limite_max_por_produto != null ? (
          fmtNum(regra.limite_max_por_produto)
        ) : (
          <span className="wms-td-mute">sem limite</span>
        )}
      </td>
      <td className="wms-tar wms-mono wms-td-mute">
        {Object.keys(regra.limites_por_produto ?? {}).length}
      </td>
      <td className="wms-td-actions">
        {editando ? (
          <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-primary"
              disabled={atualizar.isPending}
              onClick={() => atualizar.mutate()}
            >
              Salvar
            </button>
            <button
              type="button"
              className="wms-btn wms-btn-sm wms-btn-ghost"
              onClick={() => setEditando(false)}
            >
              Cancelar
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="wms-btn-icon"
            title="Editar limite global"
            onClick={() => setEditando(true)}
          >
            <Icon name="edit" size={11} />
          </button>
        )}
      </td>
    </tr>
  );
}
