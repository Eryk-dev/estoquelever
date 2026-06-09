"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { ReceberLote } from "@/components/wms/recebimento/receber-lote";
import { buildOcPayload } from "@/components/wms/recebimento/receber-lote-adapters";
import type { ReceberLoteConfig, ReceberLoteItem } from "@/components/wms/recebimento/receber-lote-types";

interface ItemOC {
  id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  esperado: number;
  ja_recebido: number;
  pendente: number;
  produto_id: number;
}

interface OCInfo {
  id: string;
  fornecedor: string | null;
  galpao_id: string;
  galpao_nome: string | null;
  observacao?: string;
  status?: string;
}

interface OCDetailResponse {
  oc: OCInfo;
  itens: ItemOC[];
}

export default function ReceberOCDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, error } = useQuery<OCDetailResponse>({
    queryKey: ["receber-oc-detail", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/receber/oc/${id}`);
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

  const oc = data?.oc;

  const itensIniciais = useMemo<ReceberLoteItem[]>(() => {
    if (!data?.itens) return [];
    return data.itens
      .filter((it) => it.pendente > 0)
      .map((it) => ({
        uid: it.id,
        produto: null,
        sku: it.sku,
        descricao: it.descricao,
        imagem_url: it.imagem_url,
        backendItemId: it.id,
        qty: String(it.pendente),
        qtyEsperada: it.pendente,
        custo: "",
        locIdOverride: null,
        locCodigoOverride: null,
        imprimir: false,
        motivoDivergencia: null,
        produtoWmsId: null,
      }));
  }, [data]);

  const config = useMemo<ReceberLoteConfig | null>(() => {
    if (!oc) return null;
    return {
      fluxo: "oc",
      canAddItems: false,
      productEditable: false,
      qtyEditable: true,
      custoVisible: true,
      custoObrigatorio: false,
      locPickVisible: false,
      locObrigatoria: false,
      divergenciaVisible: true,
      imprimirVisible: false,
      mlBlockVisible: true,
      planoSidebarVisible: false,
      leftFormVisible: false,
      permissaoReceber: ["operacoes.receber", "compras.executar"],
      headerChips: [
        { label: "Fornecedor", value: oc.fornecedor ?? "—" },
        { label: "Galpão", value: oc.galpao_nome ?? "—" },
      ],
    };
  }, [oc]);

  async function submit(itens: ReceberLoteItem[]) {
    const r = await sisoFetch(`/api/wms/receber/oc/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildOcPayload(itens, { entradaDireta: false })),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function onSuccess(resp: unknown) {
    const result = resp as { itens_recebidos?: number; oc_fechada?: boolean } | null;
    if (result?.itens_recebidos != null) {
      toast.success(
        `${result.itens_recebidos} item(s) recebido(s)${result.oc_fechada ? " · OC fechada" : ""}`,
      );
    } else {
      toast.success("Recebimento registrado");
    }
    router.push("/wms/compras?tab=receber");
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title="OC —" subtitle="Carregando…" />
        <div className="px-4 pt-8 text-sm text-zinc-500">Carregando…</div>
      </>
    );
  }

  if (error || !oc || !config) {
    const msg = (error as Error | null)?.message === "not_found"
      ? "OC não encontrada."
      : "Erro ao carregar OC.";
    return (
      <>
        <PageHeader title="OC —" subtitle={msg} />
        <div className="px-4 pt-8 text-sm text-red-500">{msg}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`OC ${oc.id.slice(0, 8)}`}
        subtitle={`${oc.fornecedor ?? "—"} · ${oc.galpao_nome ?? "—"}${oc.status ? ` · ${oc.status}` : ""}`}
      />
      <div className="px-4 pb-12 max-w-4xl mx-auto pt-4">
        <ReceberLote
          config={config}
          galpaoId={oc.galpao_id}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
        />
      </div>
    </>
  );
}
