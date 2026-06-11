"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch } from "@/lib/auth-context";
import { PageHeader, Field } from "@/components/wms/ui/wms-ui";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ErrorBanner } from "@/components/ui/error-banner";
import {
  ReceberLote,
  type ReceberLoteSubmitCtx,
} from "@/components/wms/recebimento/receber-lote";
import {
  buildOcPayload,
  splitOcExtras,
} from "@/components/wms/recebimento/receber-lote-adapters";
import type {
  ReceberLoteConfig,
  ReceberLoteItem,
} from "@/components/wms/recebimento/receber-lote-types";

interface ItemOC {
  id: string;
  sku: string;
  descricao: string;
  imagem_url: string | null;
  esperado: number;
  ja_recebido: number;
  pendente: number;
  produto_id: number;
  produto_wms_id: string | null;
  preco_compra: number | null;
}

interface OCInfo {
  id: string;
  fornecedor: string | null;
  fornecedor_id: string | null;
  galpao_id: string;
  galpao_nome: string | null;
  observacao?: string;
  status?: string;
}

interface OCDetailResponse {
  oc: OCInfo;
  itens: ItemOC[];
}

interface OcResp {
  itens_recebidos?: number;
  pendencias_criadas?: string[];
  oc_fechada?: boolean;
}

interface ExtrasResp {
  pendencia_ids?: string[];
  lote_id?: string;
}

const JSONH = { "Content-Type": "application/json" };

const noopSubscribe = () => () => {};

export default function ReceberOCDetalhePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  // NF que chegou com a caixa (opcional). Carimba nota_fiscal_id nas movs E.
  const [nf, setNf] = useState("");

  // Volta pra onde o operador veio: aba Receber de compras quando o referrer
  // mostra que foi de lá; senão o hub de recebimento.
  const veioDeCompras = useSyncExternalStore(
    noopSubscribe,
    () => document.referrer.includes("/wms/compras"),
    () => false,
  );
  const backHref = veioDeCompras ? "/wms/compras?tab=receber" : "/wms/receber";
  const backLabel = veioDeCompras ? "Compras" : "Recebimento";

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

  // Linhas pré-carregadas da OC. Cada uma mostra "era pra vir N" (qtyEsperada)
  // e o operador edita a qty real. produtoWmsId habilita a sugestão de putaway.
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
        produtoWmsId: it.produto_wms_id ?? null,
        backendItemId: it.id,
        qty: String(it.pendente),
        qtyEsperada: it.pendente,
        custo: it.preco_compra != null && it.preco_compra > 0 ? String(it.preco_compra) : "",
        locIdOverride: null,
        locCodigoOverride: null,
        imprimir: false,
        motivoDivergencia: null,
      }));
  }, [data]);

  const config = useMemo<ReceberLoteConfig | null>(() => {
    if (!oc) return null;
    return {
      fluxo: "oc",
      canAddItems: true,
      productEditable: true,
      qtyEditable: true,
      custoVisible: true,
      custoObrigatorio: false,
      locPickVisible: true,
      locObrigatoria: false,
      putawaySuggest: true,
      locAllowCreate: true,
      divergenciaVisible: true,
      imprimirVisible: true,
      mlBlockVisible: true,
      planoSidebarVisible: true,
      leftFormVisible: false,
      headerChips: [
        { label: "Fornecedor", value: oc.fornecedor ?? "—" },
        { label: "Galpão", value: oc.galpao_nome ?? "—" },
        { label: "Origem", value: "Compra (OC)" },
        ...(oc.observacao
          ? [{ label: "Observação", value: oc.observacao }]
          : []),
      ],
      guardaTogglesVisible: true,
      permissaoReceber: ["operacoes.receber", "compras.executar"],
      confirmLabel: "Confirmar recebimento",
    };
  }, [oc]);

  // ── submit: OC (linhas do documento) + extras (entrada avulsa) ──────────
  async function submit(itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) {
    if (!oc) throw new Error("OC não carregada");
    const { ocItens, extras } = splitOcExtras(itens);

    // Guard ANTES de qualquer POST: se há extras mas a OC não tem fornecedor
    // cadastrado, aborta tudo (evita receber a OC e deixar o extra órfão).
    if (extras.length > 0 && !oc.fornecedor_id) {
      throw new Error(
        "Fornecedor da OC não cadastrado — receba o item extra pelo avulso",
      );
    }

    const extraSemCusto = extras.some((it) => !(Number(it.custo) > 0));
    if (extras.length > 0 && extraSemCusto) {
      throw new Error(
        "Informe o custo do(s) item(ns) extra(s) — obrigatório pra entrada avulsa",
      );
    }

    const r1 = await sisoFetch(`/api/wms/receber/oc/${id}`, {
      method: "POST",
      headers: JSONH,
      body: JSON.stringify(
        buildOcPayload(ocItens, {
          entradaDireta: ctx.entradaDireta,
          nfReferencia: nf || null,
        }),
      ),
    });
    if (!r1.ok) {
      const b = await r1.json().catch(() => ({}));
      throw new Error(b.error || `HTTP ${r1.status}`);
    }
    const ocResp = (await r1.json()) as OcResp;

    let extrasResp: ExtrasResp | null = null;
    if (extras.length > 0) {
      const r2 = await sisoFetch("/api/wms/receber", {
        method: "POST",
        headers: JSONH,
        body: JSON.stringify({
          galpao_id: oc.galpao_id,
          fornecedor_id: oc.fornecedor_id,
          origem_tipo: "ajuste_manual",
          motivo: `Item extra no recebimento da OC ${String(id).slice(0, 8)}`,
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

    // Devolve os itens já resolvidos (loc efetiva no locIdOverride) pro print.
    return { ocResp, extrasResp, itensResolvidos: itens };
  }

  function onSuccess(out: unknown, _itens: ReceberLoteItem[], ctx: ReceberLoteSubmitCtx) {
    const { ocResp, extrasResp, itensResolvidos } = out as {
      ocResp: OcResp;
      extrasResp: ExtrasResp | null;
      itensResolvidos: ReceberLoteItem[];
    };
    // ── Impressão fire-and-forget dos itens marcados ───────────────────────
    // Split em 2 POSTs (OC + extras) torna o alinhamento por índice contra
    // pendencia_ids inviável (cross-dock pode gerar 2 pendências/item; entrada
    // direta gera 0). Aproximação segura: monto `linhas` localmente pros itens
    // marcados — sku/qty/loc/produto_id são todos conhecidos no cliente. O
    // modo `linhas` do endpoint aceita loc ausente (mostra "—"), então cobre
    // tanto entrada direta quanto dock sem loc decidida.
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

    // ── Toast rico + navegação ─────────────────────────────────────────────
    const recebidos = ocResp.itens_recebidos ?? 0;
    const extrasCount = extrasResp?.pendencia_ids?.length ?? 0;
    const partes = [`${recebidos} recebido(s)`];
    if (ocResp.oc_fechada) partes.push("OC fechada");
    if (extrasCount > 0)
      partes.push(`${extrasCount} item(ns) extra(s) avulso(s)`);
    toast.success(partes.join(" · "));

    qc.invalidateQueries({ queryKey: ["wms-compras"] });
    router.push(backHref);
  }

  if (isLoading) {
    return (
      <>
        <PageHeader
          title="Receber OC"
          backHref={backHref}
          backLabel={backLabel}
        />
        <div className="px-4 pt-4 max-w-3xl mx-auto">
          <LoadingSpinner message="Carregando OC…" />
        </div>
      </>
    );
  }

  if (error || !oc || !config) {
    const msg =
      (error as Error | null)?.message === "not_found"
        ? "OC não encontrada."
        : "Erro ao carregar OC.";
    return (
      <>
        <PageHeader
          title="Receber OC"
          backHref={backHref}
          backLabel={backLabel}
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
        title={`Receber OC — ${oc.fornecedor ?? "—"} · ${oc.galpao_nome ?? "—"}`}
        subtitle={
          <>
            <span className="wms-mono" style={{ fontSize: 11 }}>
              {oc.id.slice(0, 8)}
            </span>
            {oc.status ? <> · {oc.status}</> : null}
          </>
        }
        backHref={backHref}
        backLabel={backLabel}
      />
      <div className="px-4 pb-12 max-w-5xl mx-auto pt-4">
        <h3 className="wms-sec-h" style={{ marginTop: 0 }}>
          Dados do recebimento
        </h3>
        <div style={{ maxWidth: 320, marginBottom: 12 }}>
          <Field label="NF de referência" hint="opcional">
            <input
              className="wms-input"
              value={nf}
              onChange={(e) => setNf(e.target.value)}
              placeholder="Número da NF (opcional)"
            />
          </Field>
        </div>
        <ReceberLote
          config={config}
          galpaoId={oc.galpao_id}
          itensIniciais={itensIniciais}
          submit={submit}
          onSuccess={onSuccess}
          onError={(e) => toast.error(e.message)}
        />
      </div>
    </>
  );
}
