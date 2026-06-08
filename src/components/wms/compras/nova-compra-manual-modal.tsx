"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { ProdutoCombo, useGalpoes } from "@/components/wms/ui/modals";
import { Modal, Field, Icon } from "@/components/wms/ui/wms-ui";
import type { Produto } from "@/lib/wms/types";

interface FornecedorLite {
  id: string;
  nome: string;
}
interface LinhaItem {
  produto: Produto | null;
  qty: string;
  custo: string;
}

export function NovaCompraManualModal({
  galpaoAtivo,
  onClose,
}: {
  galpaoAtivo: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: galpoes } = useGalpoes();

  const empresas = useMemo(() => {
    const map = new Map<string, { id: string; nome: string }>();
    (galpoes ?? []).forEach((g) =>
      g.empresas.forEach((e) => map.set(e.id, { id: e.id, nome: e.nome })),
    );
    return Array.from(map.values()).sort((a, b) => a.nome.localeCompare(b.nome));
  }, [galpoes]);

  const { data: fornData } = useQuery({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/fornecedores");
      if (!r.ok) throw new Error("falha ao listar fornecedores");
      return (await r.json()) as { rows: FornecedorLite[] };
    },
  });
  const fornecedores = fornData?.rows ?? [];

  const [galpaoId, setGalpaoId] = useState(galpaoAtivo ?? "");
  const [empresaId, setEmpresaId] = useState("");
  const [fornecedorId, setFornecedorId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [linhas, setLinhas] = useState<LinhaItem[]>([
    { produto: null, qty: "", custo: "" },
  ]);

  // criar fornecedor inline
  const [novoForn, setNovoForn] = useState("");
  const criarFornMut = useMutation({
    mutationFn: async (nome: string) => {
      const r = await sisoFetch("/api/wms/compras-manuais/fornecedor", {
        method: "POST",
        body: JSON.stringify({ nome }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "falha ao criar fornecedor");
      }
      return (await r.json()) as FornecedorLite;
    },
    onSuccess: (f) => {
      toast.success(`Fornecedor "${f.nome}" criado`);
      qc.invalidateQueries({ queryKey: ["compras-manuais-fornecedores"] });
      setFornecedorId(f.id);
      setNovoForn("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // criar produto inline
  const [novoProdSku, setNovoProdSku] = useState("");
  const [novoProdDesc, setNovoProdDesc] = useState("");
  const criarProdMut = useMutation({
    mutationFn: async (vars: { sku: string; descricao: string }) => {
      const r = await sisoFetch("/api/wms/compras-manuais/produto", {
        method: "POST",
        body: JSON.stringify(vars),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "falha ao criar produto");
      }
      return (await r.json()) as Produto;
    },
    onSuccess: (p) => {
      toast.success(`Produto "${p.sku}" criado`);
      setLinhas((prev) => [...prev, { produto: p, qty: "", custo: "" }]);
      setNovoProdSku("");
      setNovoProdDesc("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const criarMut = useMutation({
    mutationFn: async () => {
      const itens = linhas
        .filter((l) => l.produto && Number(l.qty) > 0)
        .map((l) => ({
          produto_id: l.produto!.id,
          qty_comprada: Number(l.qty),
          custo_unitario: l.custo ? Number(l.custo) : undefined,
        }));
      if (itens.length === 0)
        throw new Error("adicione ao menos 1 item com qty > 0");
      const r = await sisoFetch("/api/wms/compras-manuais", {
        method: "POST",
        body: JSON.stringify({
          fornecedor_id: fornecedorId,
          empresa_compradora_id: empresaId,
          galpao_id: galpaoId,
          observacao: observacao || undefined,
          itens,
        }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "falha ao criar compra");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success("Compra manual criada");
      qc.invalidateQueries({ queryKey: ["compras-manuais"] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const podeEnviar =
    !!galpaoId && !!empresaId && !!fornecedorId && !criarMut.isPending;

  return (
    <Modal
      title="Nova compra manual"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button className="wms-btn wms-btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            disabled={!podeEnviar}
            onClick={() => criarMut.mutate()}
          >
            {criarMut.isPending ? "Criando…" : "Criar compra"}
          </button>
        </>
      }
    >
      <Field label="Galpão" required>
        <select
          className="wms-select"
          value={galpaoId}
          onChange={(e) => setGalpaoId(e.target.value)}
        >
          <option value="">selecione…</option>
          {(galpoes ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.nome}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Empresa compradora" required>
        <select
          className="wms-select"
          value={empresaId}
          onChange={(e) => setEmpresaId(e.target.value)}
        >
          <option value="">selecione…</option>
          {empresas.map((e) => (
            <option key={e.id} value={e.id}>
              {e.nome}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Fornecedor" required>
        <select
          className="wms-select"
          value={fornecedorId}
          onChange={(e) => setFornecedorId(e.target.value)}
        >
          <option value="">selecione…</option>
          {fornecedores.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            className="wms-input"
            placeholder="ou criar fornecedor…"
            value={novoForn}
            onChange={(e) => setNovoForn(e.target.value)}
          />
          <button
            className="wms-btn wms-btn-ghost"
            disabled={!novoForn.trim() || criarFornMut.isPending}
            onClick={() => criarFornMut.mutate(novoForn.trim())}
          >
            Criar
          </button>
        </div>
      </Field>

      <Field label="Itens" required>
        {/* key={i} é seguro: todos os valores da linha vêm controlados via o array `linhas`; só o search state transitório do ProdutoCombo poderia deslocar visualmente numa remoção em meio-busca, sem impacto nos dados. */}
        {linhas.map((l, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 6,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <ProdutoCombo
                value={l.produto}
                onChange={(p) =>
                  setLinhas((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, produto: p } : x)),
                  )
                }
              />
            </div>
            <input
              className="wms-input wms-mono"
              style={{ width: 64 }}
              placeholder="qty"
              inputMode="numeric"
              min={1}
              value={l.qty}
              onChange={(e) =>
                setLinhas((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, qty: e.target.value } : x,
                  ),
                )
              }
            />
            <input
              className="wms-input wms-mono"
              style={{ width: 80 }}
              placeholder="custo"
              inputMode="decimal"
              value={l.custo}
              onChange={(e) =>
                setLinhas((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, custo: e.target.value } : x,
                  ),
                )
              }
            />
            <button
              className="wms-btn-icon"
              onClick={() =>
                setLinhas((prev) => prev.filter((_, j) => j !== i))
              }
              aria-label="remover"
              type="button"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        <button
          className="wms-btn wms-btn-ghost wms-btn-sm"
          type="button"
          onClick={() =>
            setLinhas((prev) => [...prev, { produto: null, qty: "", custo: "" }])
          }
        >
          + item
        </button>

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 8,
            alignItems: "center",
          }}
        >
          <input
            className="wms-input wms-mono"
            style={{ width: 120 }}
            placeholder="novo SKU…"
            value={novoProdSku}
            onChange={(e) => setNovoProdSku(e.target.value)}
          />
          <input
            className="wms-input"
            style={{ flex: 1 }}
            placeholder="descrição…"
            value={novoProdDesc}
            onChange={(e) => setNovoProdDesc(e.target.value)}
          />
          <button
            className="wms-btn wms-btn-ghost wms-btn-sm"
            type="button"
            disabled={
              !novoProdSku.trim() ||
              !novoProdDesc.trim() ||
              criarProdMut.isPending
            }
            onClick={() =>
              criarProdMut.mutate({
                sku: novoProdSku.trim(),
                descricao: novoProdDesc.trim(),
              })
            }
          >
            Criar produto
          </button>
        </div>
      </Field>

      <Field label="Observação">
        <input
          className="wms-input"
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
