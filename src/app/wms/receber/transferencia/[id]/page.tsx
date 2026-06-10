"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, Field, fmtDateTime } from "@/components/wms/ui/wms-ui";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  ReceberLote,
  type ReceberLoteSubmitCtx,
} from "@/components/wms/recebimento/receber-lote";
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

const JSONH = { "Content-Type": "application/json" };

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
  // qty é FIXA (qtyEditable:false) — o número mostrado É o que vem; sem display "era pra vir".
  // produtoWmsId habilita a sugestão de putaway por item.
  const itensIniciais = useMemo<ReceberLoteItem[]>(() => {
    if (!transferencia?.itens) return [];
    return transferencia.itens.map((it) => ({
      uid: it.id,
      produto: null,
      sku: it.sku ?? "",
      descricao: it.descricao ?? "",
      imagem_url: null,
      backendItemId: it.id,
      produtoWmsId: it.produto_id, // uuid WMS direto do ledger 3D
      qty: String(it.qty),
      qtyEsperada: null, // qty fixa; sem "era pra vir"
      custo: "",
      locIdOverride: null,
      locCodigoOverride: null,
      imprimir: false,
      motivoDivergencia: null,
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
      locAllowCreate: false,
      putawaySuggest: true,
      divergenciaVisible: false,
      imprimirVisible: true,
      mlBlockVisible: true,
      planoSidebarVisible: true,
      leftFormVisible: true,
      guardaTogglesVisible: false,
      permissaoReceber: "operacoes.receber",
      confirmLabel: "Confirmar recebimento",
    };
  }, [transferencia]);

  // ── Left form travado: Origem, Destino, datas e observações ─────────────
  function renderLeftFormExtra() {
    if (!transferencia) return null;
    const criadaEm = transferencia.criada_em
      ? fmtDateTime(transferencia.criada_em)
      : null;
    return (
      <>
        <div className="wms-row-2">
          <Field label="Origem">
            <input
              className="wms-input"
              value={transferencia.origem_nome ?? "—"}
              disabled
            />
          </Field>
          <Field label="Destino">
            <input
              className="wms-input"
              value={transferencia.destino_nome ?? "—"}
              disabled
            />
          </Field>
        </div>

        {criadaEm && (
          <Field label="Criada em">
            <input className="wms-input" value={criadaEm} disabled />
          </Field>
        )}

        {transferencia.observacoes && (
          <Field label="Observações">
            <input
              className="wms-input"
              value={transferencia.observacoes}
              disabled
            />
          </Field>
        )}
      </>
    );
  }

  // ── Submit: buildTransferenciaPayload (contrato UNCHANGED) ──────────────
  // 409 TRANSFERENCIA_OUTRO_RECEBIMENTO é surfaced via throw.
  async function submit(itens: ReceberLoteItem[]) {
    const r = await sisoFetch(`/api/wms/transferencias/${id}/receber`, {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify(buildTransferenciaPayload(itens)),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  // ── onSuccess: print por linhas (transferência é E direto; sem pendência) ─
  // Monta `linhas` no front com sku/qty/loc dos próprios itens — zero backend.
  function onSuccess(
    _resp: unknown,
    itens: ReceberLoteItem[],
    ctx: ReceberLoteSubmitCtx,
  ) {
    const linhas = itens
      .filter((it) => {
        if (!it.imprimir) return false;
        if (Number(it.qty) <= 0) return false;
        const prodId = it.produto?.id ?? it.produtoWmsId;
        return !!prodId;
      })
      .map((it) => ({
        produto_id: (it.produto?.id ?? it.produtoWmsId)!,
        galpao_id: ctx.galpaoId,
        qty: Number(it.qty),
        localizacao_id: it.locIdOverride ?? undefined,
      }));

    if (linhas.length > 0) {
      sisoFetch("/api/wms/guarda/imprimir-lote", {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({ linhas }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as {
              error?: string;
            };
            toast.warning(
              `Recebimento ok, falha impressão: ${body.error ?? r.status}`,
            );
            return;
          }
          const res = (await r.json()) as {
            totalEtiquetas?: number;
            totalFolhas?: number;
            fallbackEnvelope?: boolean;
          };
          toast.success(
            `${res.totalEtiquetas ?? 0} etiquetas em ${res.totalFolhas ?? 0} folhas${res.fallbackEnvelope ? " (impressora de envio — configure uma de produto)" : ""}`,
          );
        })
        .catch((err: Error) => {
          toast.warning(`Recebimento ok, falha impressão: ${err.message}`);
        });
    }

    toast.success("Recebimento registrado");
    router.push("/wms/receber/transferencia");
  }

  if (isLoading) {
    return (
      <>
        <PageHeader
          title="Receber transferência"
          backHref="/wms/receber/transferencia"
          backLabel="Transferências"
        />
        <div className="px-4 pt-4 max-w-3xl mx-auto">
          <LoadingSpinner message="Carregando transferência…" />
        </div>
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
        <PageHeader
          title="Receber transferência"
          backHref="/wms/receber/transferencia"
          backLabel="Transferências"
        />
        <div className="px-4 pt-4 max-w-3xl mx-auto">
          <ErrorBanner message={msg} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`Receber transferência — ${transferencia.origem_nome ?? "—"} → ${transferencia.destino_nome ?? "—"}`}
        subtitle={
          <>
            <span className="wms-mono" style={{ fontSize: 11 }}>
              {transferencia.id.slice(0, 8)}
            </span>
            {" · "}
            {transferencia.status}
          </>
        }
        backHref="/wms/receber/transferencia"
        backLabel="Transferências"
      />
      <div className="px-4 pb-12 max-w-5xl mx-auto pt-4">
        <ReceberLote
          config={config}
          galpaoId={transferencia.galpao_destino_id}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
          onError={(e) => toast.error(e.message)}
          renderLeftFormExtra={renderLeftFormExtra}
        />
      </div>
    </>
  );
}
