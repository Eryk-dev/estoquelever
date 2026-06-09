"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader } from "@/components/wms/ui/wms-ui";
import { ReceberLote } from "@/components/wms/recebimento/receber-lote";
import { buildTransferenciaPayload } from "@/components/wms/recebimento/receber-lote-adapters";
import type {
  ReceberLoteConfig,
  ReceberLoteItem,
} from "@/components/wms/recebimento/receber-lote-types";

interface TransferenciaItem {
  id: string;
  produto_id: string;
  qty: number;
  sku: string | null;
  descricao: string | null;
  localizacao_destino_id: string | null;
  mov_entrada_id: string | null;
}

interface TransferenciaInfo {
  id: string;
  galpao_origem_id: string;
  galpao_destino_id: string;
  status: string;
  criada_em?: string;
  observacoes?: string;
  origem_nome: string | null;
  destino_nome: string | null;
  itens: TransferenciaItem[];
}

interface TransferenciaDetailResponse {
  transferencia: TransferenciaInfo;
}

export default function ReceberTransferenciaDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, error } = useQuery<TransferenciaDetailResponse>({
    queryKey: ["receber-transferencia-detail", id],
    queryFn: async () => {
      const r = await sisoFetch(`/api/wms/receber/transferencia/${id}`);
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

  const transferencia = data?.transferencia;

  // Itens já vêm filtrados pra pendentes (mov_entrada_id IS NULL) no backend.
  const itensIniciais = useMemo<ReceberLoteItem[]>(() => {
    if (!transferencia?.itens) return [];
    return transferencia.itens.map((it) => ({
      uid: it.id,
      produto: null,
      sku: it.sku ?? "",
      descricao: it.descricao ?? "",
      imagem_url: null,
      backendItemId: it.id,
      qty: String(it.qty),
      qtyEsperada: it.qty,
      custo: "",
      locIdOverride: null,
      locCodigoOverride: null,
      imprimir: false,
      motivoDivergencia: null,
      produtoWmsId: null,
    }));
  }, [transferencia]);

  const config = useMemo<ReceberLoteConfig | null>(() => {
    if (!transferencia) return null;
    return {
      fluxo: "transferencia",
      canAddItems: false,
      productEditable: false,
      qtyEditable: false,
      custoVisible: false,
      custoObrigatorio: false,
      locPickVisible: true,
      locObrigatoria: true,
      divergenciaVisible: false,
      imprimirVisible: false,
      mlBlockVisible: true,
      planoSidebarVisible: false,
      leftFormVisible: false,
      permissaoReceber: "operacoes.receber",
      locAllowCreate: false,
      headerChips: [
        { label: "Origem", value: transferencia.origem_nome ?? "—" },
        { label: "Destino", value: transferencia.destino_nome ?? "—" },
      ],
    };
  }, [transferencia]);

  async function submit(itens: ReceberLoteItem[]) {
    const r = await sisoFetch(`/api/wms/transferencias/${id}/receber`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTransferenciaPayload(itens)),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  function onSuccess() {
    toast.success("Recebimento registrado");
    router.push("/wms/receber/transferencia");
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title="Transferência —" subtitle="Carregando…" />
        <div className="px-4 pt-8 text-sm text-zinc-500">Carregando…</div>
      </>
    );
  }

  if (error || !transferencia || !config) {
    const msg =
      (error as Error | null)?.message === "not_found"
        ? "Transferência não encontrada."
        : "Erro ao carregar transferência.";
    return (
      <>
        <PageHeader title="Transferência —" subtitle={msg} />
        <div className="px-4 pt-8 text-sm text-red-500">{msg}</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Transferência ${transferencia.id.slice(0, 8)}`}
        subtitle={`${transferencia.origem_nome ?? "—"} → ${transferencia.destino_nome ?? "—"} · ${transferencia.status}`}
      />
      <div className="px-4 pb-12 max-w-4xl mx-auto pt-4">
        <ReceberLote
          config={config}
          galpaoId={transferencia.galpao_destino_id}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
          onError={(e) => toast.error(e.message)}
        />
      </div>
    </>
  );
}
