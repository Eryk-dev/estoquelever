"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, Field } from "@/components/wms/ui/wms-ui";
import {
  ReceberLote,
  type ReceberLoteSubmitCtx,
} from "@/components/wms/recebimento/receber-lote";
import {
  buildManualPayload,
  splitOcExtras,
} from "@/components/wms/recebimento/receber-lote-adapters";
import type {
  ReceberLoteConfig,
  ReceberLoteItem,
} from "@/components/wms/recebimento/receber-lote-types";

interface CompraManualItem {
  id: string;
  produto_id: string; // uuid WMS direto
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
  galpao_id: string;
  fornecedor: { id: string; nome: string } | null;
  empresa: { id: string; nome: string } | null;
  itens: CompraManualItem[];
}

interface CompraManualDetailResponse {
  compra: CompraManual;
}

interface ContextoResp {
  galpoes: { id: string; nome: string }[];
}

interface ManualResp {
  movs_geradas?: number;
  status?: string;
  pendencia_ids?: string[];
  mov_ids?: string[];
}

interface ExtrasResp {
  pendencia_ids?: string[];
  lote_id?: string;
}

const JSONH = { "Content-Type": "application/json" };

export default function ReceberManualDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  // State só pra controlar nf (não usado, mas mantém paridade com OC — manual sem campo NF)
  const [_nf] = useState(""); // eslint-disable-line @typescript-eslint/no-unused-vars

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

  // Contexto: resolve nome do galpão (o GET da compra não traz galpao_nome)
  const { data: contexto } = useQuery<ContextoResp>({
    queryKey: ["compras-manuais-contexto"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/compras-manuais/contexto");
      if (!r.ok) return { galpoes: [], empresas: [] };
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const compra = data?.compra;

  const galpaoNome = useMemo(() => {
    if (!compra || !contexto) return null;
    return contexto.galpoes.find((g) => g.id === compra.galpao_id)?.nome ?? null;
  }, [compra, contexto]);

  // Linhas pré-carregadas da compra. produtoWmsId = produto_id (já é uuid WMS).
  const itensIniciais = useMemo<ReceberLoteItem[]>(() => {
    if (!compra?.itens) return [];
    return compra.itens
      .filter((it) => it.qty_comprada - it.qty_recebida > 0)
      .map((it) => {
        const faltante = it.qty_comprada - it.qty_recebida;
        return {
          uid: it.id,
          produto: null,
          sku: it.sku,
          descricao: it.descricao,
          imagem_url: null,
          produtoWmsId: it.produto_id, // uuid WMS direto — sem resolução necessária
          backendItemId: it.id,
          qty: String(faltante),
          qtyEsperada: faltante,
          custo: it.custo_unitario != null ? String(it.custo_unitario) : "",
          locIdOverride: null,
          locCodigoOverride: null,
          imprimir: false,
          motivoDivergencia: null,
        };
      });
  }, [compra]);

  const config = useMemo<ReceberLoteConfig | null>(() => {
    if (!compra) return null;
    return {
      fluxo: "manual",
      canAddItems: true,
      productEditable: true,
      qtyEditable: true,
      custoVisible: true,
      custoObrigatorio: false,
      locPickVisible: true,
      locObrigatoria: false,
      putawaySuggest: true,
      locAllowCreate: true,
      divergenciaVisible: false, // backend manual não tem motivo_divergencia
      imprimirVisible: true,
      mlBlockVisible: true,
      planoSidebarVisible: true,
      leftFormVisible: true,
      guardaTogglesVisible: true,
      permissaoReceber: "compras.executar",
      confirmLabel: "Confirmar recebimento",
    };
  }, [compra]);

  // ── Left form travado: infos da compra fixas ────────────────────────────
  function renderLeftFormExtra() {
    if (!compra) return null;
    return (
      <>
        <div className="wms-row-2">
          <Field label="Fornecedor">
            <input className="wms-input" value={compra.fornecedor?.nome ?? "—"} disabled />
          </Field>
          <Field label="Empresa">
            <input className="wms-input" value={compra.empresa?.nome ?? "—"} disabled />
          </Field>
        </div>

        <div className="wms-row-2">
          <Field label="Galpão">
            <input
              className="wms-input"
              value={galpaoNome ?? compra.galpao_id.slice(0, 8)}
              disabled
            />
          </Field>
          <Field label="Origem">
            <input className="wms-input" value="Compra manual" disabled />
          </Field>
        </div>

        {compra.observacao && (
          <Field label="Observação">
            <input className="wms-input" value={compra.observacao} disabled />
          </Field>
        )}
      </>
    );
  }

  // ── submit: linhas da compra + extras (entrada avulsa) ──────────────────
  async function submit(itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) {
    if (!compra) throw new Error("Compra não carregada");
    const { ocItens: manualItens, extras } = splitOcExtras(itens);

    // Guard ANTES de qualquer POST: se há extras mas não há fornecedor cadastrado
    // (FK nullable), aborta (evita receber a compra e deixar o extra órfão).
    if (extras.length > 0 && !compra.fornecedor?.id) {
      throw new Error(
        "Fornecedor da compra não cadastrado — receba o item extra pelo avulso",
      );
    }

    // Extras exigem custo > 0 (entrada avulsa, mesmo racional do OC)
    const extraSemCusto = extras.some((it) => !(Number(it.custo) > 0));
    if (extras.length > 0 && extraSemCusto) {
      throw new Error(
        "Informe o custo do(s) item(ns) extra(s) — obrigatório pra entrada avulsa",
      );
    }

    const r1 = await sisoFetch(`/api/wms/compras-manuais/${id}/receber`, {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify(
        buildManualPayload(manualItens, { entradaDireta: ctx.entradaDireta }),
      ),
    });
    if (!r1.ok) {
      const b = await r1.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r1.status}`);
    }
    const manualResp = (await r1.json()) as ManualResp;

    let extrasResp: ExtrasResp | null = null;
    if (extras.length > 0) {
      const r2 = await sisoFetch("/api/wms/receber", {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({
          galpao_id: compra.galpao_id,
          fornecedor_id: compra.fornecedor!.id,
          origem_tipo: "ajuste_manual",
          motivo: `Item extra no recebimento da compra ${String(id).slice(0, 8)}`,
          entrada_direta: ctx.entradaDireta,
          itens: extras.map((it) => ({
            produto_id: it.produto!.id,
            qty: Number(it.qty),
            custo_unitario: it.custo ? Number(it.custo) : undefined,
            localizacao_destino_id: it.locIdOverride ?? undefined,
          })),
        }),
      });
      if (!r2.ok) {
        const b = await r2.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${r2.status}`);
      }
      extrasResp = (await r2.json()) as ExtrasResp;
    }

    return { manualResp, extrasResp, itensResolvidos: itens };
  }

  function onSuccess(out: unknown, _itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) {
    const { manualResp, extrasResp, itensResolvidos } = out as {
      manualResp: ManualResp;
      extrasResp: ExtrasResp | null;
      itensResolvidos: ReceberLoteItem[];
    };

    // ── Impressão fire-and-forget dos itens marcados ──────────────────────
    // Mesmo padrão do OC: monta `linhas` localmente (produto_id uuid WMS + loc).
    const linhas = itensResolvidos
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
            const body = (await r.json().catch(() => ({}))) as { error?: string };
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
        .catch((err) => {
          toast.warning(`Recebimento ok, falha impressão: ${err.message}`);
        });
    }

    // ── Toast rico + navegação ────────────────────────────────────────────
    const movsGeradas = manualResp.movs_geradas ?? 0;
    const extrasCount = extrasResp?.pendencia_ids?.length ?? 0;
    const partes = [`${movsGeradas} item(ns) recebido(s)`];
    if (manualResp.status === "recebido") partes.push("compra concluída");
    if (extrasCount > 0)
      partes.push(`${extrasCount} item(ns) extra(s) avulso(s)`);
    toast.success(partes.join(" · "));

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
        subtitle={`${compra.fornecedor?.nome ?? "—"} · ${compra.empresa?.nome ?? "—"}${galpaoNome ? ` · ${galpaoNome}` : ""}`}
      />
      <div className="px-4 pb-12 max-w-5xl mx-auto pt-4">
        <ReceberLote
          config={config}
          galpaoId={compra.galpao_id}
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
