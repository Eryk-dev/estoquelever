"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { ReceberLote } from "@/components/wms/recebimento/receber-lote";
import { buildManualPayload } from "@/components/wms/recebimento/receber-lote-adapters";
import type { ReceberLoteConfig, ReceberLoteItem } from "@/components/wms/recebimento/receber-lote-types";

interface CompraManualItem {
  id: string;
  produto_id: string;
  sku: string;
  descricao: string;
  qty_comprada: number;
  qty_recebida: number;
  custo_unitario: number | null;
}

interface CompraManual {
  id: string;
  status: string;
  observacao: string | null;
  criado_em: string;
  recebido_em: string | null;
  galpao_id: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: CompraManualItem[];
}

interface CompraManualDetailResponse {
  compra: CompraManual;
}

export default function ReceberManualDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery<CompraManualDetailResponse>({
    queryKey: ["receber-manual-detail", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/compras-manuais/${id}`);
      if (r.status === 404) throw new Error("not_found");
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    enabled: !!id,
    retry: false,
  });

  const compra = data?.compra;

  const itensIniciais = useMemo<ReceberLoteItem[]>(() => {
    if (!compra?.itens) return [];
    return compra.itens
      .filter((it) => it.qty_comprada - it.qty_recebida > 0)
      .map((it) => ({
        uid: it.id,
        produto: null,
        sku: it.sku,
        descricao: it.descricao,
        imagem_url: null,
        backendItemId: it.id,
        qty: String(it.qty_comprada - it.qty_recebida),
        qtyEsperada: it.qty_comprada - it.qty_recebida,
        custo: it.custo_unitario != null ? String(it.custo_unitario) : "",
        locIdOverride: null,
        locCodigoOverride: null,
        imprimir: false,
        motivoDivergencia: null,
      }));
  }, [compra]);

  const config = useMemo<ReceberLoteConfig | null>(() => {
    if (!compra) return null;
    return {
      fluxo: "manual",
      canAddItems: false,
      productEditable: false,
      qtyEditable: true,
      custoVisible: true,
      custoObrigatorio: false,
      locPickVisible: false,
      locObrigatoria: false,
      divergenciaVisible: false,
      imprimirVisible: false,
      mlBlockVisible: true,
      planoSidebarVisible: false,
      leftFormVisible: false,
      permissaoReceber: "compras.executar",
      headerChips: [
        { label: "Fornecedor", value: compra.fornecedor?.nome ?? "—" },
        { label: "Empresa", value: compra.empresa?.nome ?? "—" },
      ],
    };
  }, [compra]);

  async function submit(itens: ReceberLoteItem[]) {
    const r = await sisoFetch(`/api/wms/compras-manuais/${id}/receber`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildManualPayload(itens)),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function onSuccess() {
    toast.success("Recebimento registrado");
    qc.invalidateQueries({ queryKey: ["wms-compras"] });
    router.push("/wms/compras?tab=receber");
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title="Compra Manual —" subtitle="Carregando…" />
        <div className="px-4 pt-8 text-sm text-zinc-500">Carregando…</div>
      </>
    );
  }

  if (error || !compra || !config) {
    const msg =
      (error as Error | null)?.message === "not_found"
        ? "Compra não encontrada."
        : "Erro ao carregar compra.";
    return (
      <>
        <PageHeader title="Compra Manual —" subtitle={msg} />
        <div className="px-4 pt-8 text-sm text-red-500">{msg}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Compra ${compra.id.slice(0, 8)}`}
        subtitle={`${compra.fornecedor?.nome ?? "—"} · ${compra.empresa?.nome ?? "—"}`}
      />
      <div className="px-4 pb-12 max-w-4xl mx-auto pt-4">
        <ReceberLote
          config={config}
          galpaoId={compra.galpao_id}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
        />
      </div>
    </>
  );
}
