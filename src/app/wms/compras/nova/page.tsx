"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { PageHeader, Field } from "@/components/wms/ui/wms-ui";
import {
  ReceberLote,
  type ReceberLoteSubmitCtx,
} from "@/components/wms/recebimento/receber-lote";
import { buildCompraPayload } from "@/components/wms/recebimento/receber-lote-adapters";
import type {
  ReceberLoteConfig,
  ReceberLoteItem,
} from "@/components/wms/recebimento/receber-lote-types";
import type { Produto } from "@/lib/wms/types";

interface FornecedorLite {
  id: string;
  nome: string;
}

interface ContextoResp {
  galpoes: { id: string; nome: string }[];
  empresas: { id: string; nome: string }[];
}

const CONFIG_COMPRA: ReceberLoteConfig = {
  fluxo: "manual",
  canAddItems: true,
  productEditable: true,
  qtyEditable: true,
  custoVisible: true,
  custoObrigatorio: false,
  locPickVisible: false,
  locObrigatoria: false,
  divergenciaVisible: false,
  imprimirVisible: false,
  mlBlockVisible: true,
  planoSidebarVisible: false,
  leftFormVisible: true,
  guardaTogglesVisible: false,
  permissaoReceber: "compras.executar",
  confirmLabel: "Criar compra",
};

const ITENS_INICIAIS: ReceberLoteItem[] = [];

export default function NovaCompraManualPage() {
  const router = useRouter();
  const qc = useQueryClient();

  const [galpaoId, setGalpaoId] = useState("");
  const [empresaId, setEmpresaId] = useState("");
  const [fornecedorId, setFornecedorId] = useState("");
  const [observacao, setObservacao] = useState("");

  // criar fornecedor inline
  const [novoFornNome, setNovoFornNome] = useState("");

  const { data: contexto } = useQuery<ContextoResp>({
    queryKey: ["compras-manuais-contexto"],
    queryFn: () =>
      wmsApi<ContextoResp>("/api/wms/compras-manuais/contexto"),
    staleTime: 5 * 60_000,
  });
  const galpoes = contexto?.galpoes ?? [];
  const empresas = contexto?.empresas ?? [];

  const { data: fornData } = useQuery<{ rows: FornecedorLite[] }>({
    queryKey: ["compras-manuais-fornecedores"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/fornecedores");
      if (!r.ok) throw new Error("falha ao listar fornecedores");
      return (await r.json()) as { rows: FornecedorLite[] };
    },
    staleTime: 5 * 60_000,
  });
  const fornecedores = fornData?.rows ?? [];

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
      setNovoFornNome("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  // criar produto inline
  const [showNovoProd, setShowNovoProd] = useState(false);
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
      toast.success(`Produto ${p.sku} criado — busque pelo SKU na linha do item`);
      setNovoProdSku("");
      setNovoProdDesc("");
      setShowNovoProd(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const itensIniciais = useMemo(() => ITENS_INICIAIS, []);

  function renderLeftFormExtra() {
    return (
      <>
        <Field label="Galpão" required>
          <select
            className="wms-select"
            value={galpaoId}
            onChange={(e) => setGalpaoId(e.target.value)}
          >
            <option value="">selecione…</option>
            {galpoes.map((g) => (
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
              value={novoFornNome}
              onChange={(e) => setNovoFornNome(e.target.value)}
            />
            <button
              className="wms-btn wms-btn-ghost"
              type="button"
              disabled={!novoFornNome.trim() || criarFornMut.isPending}
              onClick={() => criarFornMut.mutate(novoFornNome.trim())}
            >
              {criarFornMut.isPending ? "Criando…" : "Criar"}
            </button>
          </div>
        </Field>

        <div style={{ marginTop: 4 }}>
          <button
            className="wms-btn-link"
            type="button"
            onClick={() => setShowNovoProd((v) => !v)}
          >
            {showNovoProd ? "− Cancelar cadastro" : "+ Cadastrar produto novo"}
          </button>
          {showNovoProd && (
            <div
              style={{
                marginTop: 8,
                padding: "12px",
                border: "1px solid var(--wms-border)",
                borderRadius: 6,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <Field label="SKU" required>
                <input
                  className="wms-input wms-mono"
                  placeholder="ex: ABC-001"
                  value={novoProdSku}
                  onChange={(e) => setNovoProdSku(e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Descrição" required>
                <input
                  className="wms-input"
                  placeholder="ex: Filtro de óleo 1.0"
                  value={novoProdDesc}
                  onChange={(e) => setNovoProdDesc(e.target.value)}
                />
              </Field>
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
                {criarProdMut.isPending ? "Cadastrando…" : "Cadastrar"}
              </button>
            </div>
          )}
        </div>

        <Field label="Observação">
          <input
            className="wms-input"
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
          />
        </Field>
      </>
    );
  }

  function validarExtra() {
    return !!(galpaoId && empresaId && fornecedorId);
  }

  async function submit(itens: ReceberLoteItem[], _ctx: ReceberLoteSubmitCtx) {
    const payload = buildCompraPayload(itens, {
      fornecedorId,
      empresaId,
      galpaoId,
      observacao: observacao || null,
    });
    if (payload.itens.length === 0) {
      throw new Error("adicione ao menos 1 item com qty > 0");
    }
    const r = await sisoFetch("/api/wms/compras-manuais", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? "falha ao criar compra");
    }
    return r.json();
  }

  function onSuccess() {
    toast.success("Compra criada");
    qc.invalidateQueries({ queryKey: ["wms-compras"] });
    router.push("/wms/compras?tab=receber");
  }

  return (
    <>
      <PageHeader
        title="Nova compra manual"
        subtitle="Crie uma compra avulsa de fornecedor"
        backHref="/wms/compras"
        backLabel="Compras"
      />
      <div className="px-4 pb-12 max-w-5xl mx-auto pt-4">
        <ReceberLote
          config={CONFIG_COMPRA}
          galpaoId={galpaoId}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
          onError={(e) => toast.error(e.message)}
          renderLeftFormExtra={renderLeftFormExtra}
          validarExtra={validarExtra}
        />
      </div>
    </>
  );
}
