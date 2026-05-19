"use client";

import { useMemo, useState } from "react";
import { use } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { PageHeader, StatusBadge, Modal, Field, Icon } from "@/components/wms/ui/wms-ui";
import { formatRelativeTime, getMarketplaceName } from "@/lib/domain-helpers";

interface PedidoDetalhe {
  id: string;
  numero: string;
  data: string;
  filial_origem: string | null;
  cliente_nome: string;
  cliente_cpf_cnpj: string | null;
  nome_ecommerce: string | null;
  status: string;
  status_separacao: string | null;
  vendedor_id: string | null;
  vendedor_nome: string | null;
  origem_pedido: "webhook" | "manual";
  canal_venda: string | null;
  criado_em: string;
  marcadores: string[];
}

interface ItemDetalhe {
  id: string;
  sku: string;
  descricao: string;
  quantidade_pedida: number;
  quantidade_bipada: number;
  bipado_completo: boolean;
}

interface HistEvento {
  id: string;
  evento: string;
  usuario_nome: string | null;
  detalhes: Record<string, unknown>;
  criado_em: string;
}

interface DetalheResponse {
  pedido: PedidoDetalhe;
  itens: ItemDetalhe[];
  historico: HistEvento[];
}

interface UsuarioOpt {
  id: string;
  nome: string;
  cargos: string[];
}

export default function VendaDetalhePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { user } = useAuth();
  const qc = useQueryClient();
  const cargos = useMemo(() => user?.cargos ?? (user?.cargo ? [user.cargo] : []), [user]);
  const canReassign = cargos.includes("admin") || cargos.some((c) => c.startsWith("operador"));
  const [reassignOpen, setReassignOpen] = useState(false);

  const { data, isLoading, refetch } = useQuery<DetalheResponse>({
    queryKey: ["venda-detalhe", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/vendas/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error("Falha ao carregar pedido");
      return r.json();
    },
  });

  if (isLoading) {
    return <div className="p-6 text-xs text-zinc-500">Carregando…</div>;
  }
  if (!data) {
    return <div className="p-6 text-xs text-red-600">Pedido não encontrado.</div>;
  }

  const { pedido, itens, historico } = data;
  const origemLabel =
    pedido.origem_pedido === "manual"
      ? "Manual"
      : (getMarketplaceName(pedido.nome_ecommerce ?? "") || pedido.nome_ecommerce || "—");

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={`#${pedido.numero}`}
        subtitle={`${pedido.cliente_nome} · ${origemLabel} · ${formatRelativeTime(pedido.criado_em)}`}
        backHref="/wms/vendas"
        backLabel="Voltar para vendas"
      >
        <StatusBadge status={pedido.status_separacao ?? pedido.status} />
      </PageHeader>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Info row */}
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
        >
          <InfoCell label="Vendedor">
            <div className="flex items-center gap-2">
              <span>{pedido.vendedor_nome ?? <span className="text-zinc-400">— atribuir</span>}</span>
              {canReassign && (
                <button className="wms-btn-link" onClick={() => setReassignOpen(true)}>
                  <Icon name="edit" size={10} /> Editar
                </button>
              )}
            </div>
          </InfoCell>
          <InfoCell label="Canal">{pedido.canal_venda ?? "—"}</InfoCell>
          <InfoCell label="Galpão">{pedido.filial_origem ?? "—"}</InfoCell>
          <InfoCell label="CPF/CNPJ">{pedido.cliente_cpf_cnpj ?? "—"}</InfoCell>
        </div>

        {/* Items */}
        <div>
          <strong style={{ fontSize: 12 }}>Itens ({itens.length})</strong>
          <table className="mt-2 w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3 font-medium">SKU</th>
                <th className="py-2 pr-3 font-medium">Descrição</th>
                <th className="py-2 pr-3 font-medium text-right">Qty pedida</th>
                <th className="py-2 pr-3 font-medium text-right">Qty bipada</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-3 font-mono">{it.sku}</td>
                  <td className="py-2 pr-3">{it.descricao}</td>
                  <td className="py-2 pr-3 text-right">{it.quantidade_pedida}</td>
                  <td className="py-2 pr-3 text-right">
                    {it.bipado_completo ? (
                      <span className="text-emerald-600">{it.quantidade_bipada}</span>
                    ) : (
                      it.quantidade_bipada
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Histórico */}
        <div>
          <strong style={{ fontSize: 12 }}>Histórico</strong>
          <ul className="mt-2 space-y-1.5 text-xs">
            {historico.map((h) => (
              <li key={h.id} className="flex gap-2 text-zinc-600 dark:text-zinc-400">
                <span className="text-zinc-400">{formatRelativeTime(h.criado_em)}</span>
                <span className="font-medium">{h.evento}</span>
                {h.usuario_nome && <span className="text-zinc-500">por {h.usuario_nome}</span>}
              </li>
            ))}
            {historico.length === 0 && (
              <li className="text-zinc-400">Sem eventos registrados.</li>
            )}
          </ul>
        </div>
      </div>

      {reassignOpen && (
        <ReassignModal
          pedidoId={id}
          atualVendedorId={pedido.vendedor_id}
          onClose={() => setReassignOpen(false)}
          onSaved={() => {
            setReassignOpen(false);
            refetch();
            qc.invalidateQueries({ queryKey: ["vendas-lista"] });
          }}
        />
      )}
    </div>
  );
}

function InfoCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-xs text-zinc-900 dark:text-zinc-100">{children}</div>
    </div>
  );
}

function ReassignModal({
  pedidoId,
  atualVendedorId,
  onClose,
  onSaved,
}: {
  pedidoId: string;
  atualVendedorId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vendedorId, setVendedorId] = useState(atualVendedorId ?? "");
  const [enviando, setEnviando] = useState(false);

  const { data: vendedores } = useQuery<UsuarioOpt[]>({
    queryKey: ["reassign-vendedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/usuarios");
      if (!r.ok) return [];
      const j = (await r.json()) as { usuarios?: UsuarioOpt[] };
      return (j.usuarios ?? []).filter((u) => u.cargos?.includes("vendedor"));
    },
  });

  const submit = async () => {
    setEnviando(true);
    try {
      const r = await sisoFetch(`/api/wms/vendas/${encodeURIComponent(pedidoId)}/vendedor`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendedor_id: vendedorId || null }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { erro?: string };
        toast.error(j.erro ?? "Erro ao atribuir vendedor");
        return;
      }
      toast.success("Vendedor atribuído");
      onSaved();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Atribuir vendedor"
      onClose={onClose}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="wms-btn" onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button className="wms-btn wms-btn-primary" onClick={submit} disabled={enviando}>
            Salvar
          </button>
        </div>
      }
    >
      <Field label="Vendedor">
        <select
          value={vendedorId}
          onChange={(e) => setVendedorId(e.target.value)}
          className="wms-input"
        >
          <option value="">— sem vendedor —</option>
          {(vendedores ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.nome}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
