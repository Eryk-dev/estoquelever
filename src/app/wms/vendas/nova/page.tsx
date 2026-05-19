"use client";

import { Suspense, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { wmsApi } from "@/lib/wms/api-client";
import { PageHeader, Field, Icon } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  useGalpoes,
  type EmpresaLite,
  type GalpaoLite,
} from "@/components/wms/ui/modals";
import type { Produto } from "@/lib/wms/types";
import type {
  CriarVendaDiretaRequest,
  CriarVendaDiretaResponse,
  ModoVendaDireta,
} from "@/types";

const CANAIS = ["Balcão", "WhatsApp", "Telefone", "Outro"];

interface ItemForm {
  uid: string;
  produto: Produto | null;
  quantidade: number;
}

interface DisponibilidadeResp {
  total_disponivel: number;
  sugestao: {
    empresa_dona_id: string;
    empresa_dona_nome: string;
    localizacao_id: string;
    localizacao_codigo: string;
    localizacao_tipo: string;
    disponivel: number;
  } | null;
}

function emptyItem(): ItemForm {
  return {
    uid: crypto.randomUUID(),
    produto: null,
    quantidade: 1,
  };
}

export default function NovaVendaPage() {
  return (
    <>
      <PageHeader
        title="Nova venda"
        subtitle="Pedido manual. Escolha o galpão onde você está, adicione produtos e o sistema resolve loc + saldo."
        backHref="/wms/vendas"
        backLabel="Vendas"
      />
      <Suspense fallback={null}>
        <NovaVendaBody />
      </Suspense>
    </>
  );
}

function NovaVendaBody() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: galpoes } = useGalpoes();

  const empresas = useMemo<EmpresaLite[]>(
    () =>
      (galpoes ?? []).flatMap((g: GalpaoLite) =>
        g.empresas.map((e) => ({ ...e, galpao_id: g.id })),
      ),
    [galpoes],
  );

  const [clienteNome, setClienteNome] = useState("");
  const [clienteCpf, setClienteCpf] = useState("");
  const [canal, setCanal] = useState("Balcão");
  const [empresaOrigemId, setEmpresaOrigemId] = useState("");
  const [galpaoId, setGalpaoId] = useState("");
  const [modo, setModo] = useState<ModoVendaDireta>("separacao");
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [enviando, setEnviando] = useState(false);

  const addItem = () => setItems((arr) => [...arr, emptyItem()]);
  const updateItem = (idx: number, patch: Partial<ItemForm>) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) =>
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));

  // Resolve disponibilidade por item (paralelo, cacheado por React Query).
  const dispQueries = useQueries({
    queries: items.map((it) => ({
      queryKey: [
        "wms-vendas-disponibilidade",
        it.produto?.id,
        galpaoId,
        empresaOrigemId,
      ],
      queryFn: () => {
        const sp = new URLSearchParams({
          produto_id: it.produto!.id,
          galpao_id: galpaoId,
        });
        if (empresaOrigemId) sp.set("empresa_origem_id", empresaOrigemId);
        return wmsApi<DisponibilidadeResp>(
          `/api/wms/vendas/disponibilidade?${sp.toString()}`,
        );
      },
      enabled: !!(it.produto?.id && galpaoId),
      staleTime: 15 * 1000,
    })),
  });

  const valido =
    !!clienteNome.trim() &&
    !!empresaOrigemId &&
    !!galpaoId &&
    items.every((it) => !!it.produto && it.quantidade > 0);

  const submit = async () => {
    if (!valido || enviando) return;
    setEnviando(true);
    try {
      const payload: CriarVendaDiretaRequest = {
        cliente_nome: clienteNome.trim(),
        cliente_cpf_cnpj: clienteCpf.trim() || null,
        canal_venda: canal,
        empresa_origem_id: empresaOrigemId,
        galpao_id: galpaoId,
        modo,
        items: items.map((it) => ({
          produto_id: it.produto!.id,
          quantidade: it.quantidade,
        })),
        idempotency_key: crypto.randomUUID(),
      };

      const res = await sisoFetch("/api/wms/vendas/criar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          erro?: string;
          sku?: string;
        };
        toast.error(err.erro ?? "Erro ao criar pedido");
        return;
      }

      const data = (await res.json()) as CriarVendaDiretaResponse;
      if (data.degradado && data.motivo_degradacao === "falta_saldo") {
        toast.warning(
          `Sem saldo de ${(data.skus_sem_saldo ?? []).join(", ")} — pedido foi pra fila de separação.`,
        );
      } else if (modo === "baixa_direta") {
        toast.success(`Pedido ${data.numero} criado e baixado do estoque`);
      } else {
        toast.success(`Pedido ${data.numero} criado e mandado pra separação`);
      }
      router.push(`/wms/vendas/${encodeURIComponent(data.pedido_id)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar pedido");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div style={{ padding: "12px 16px", display: "grid", gap: 16, maxWidth: 880 }}>
      {user ? (
        <p className="wms-td-mute" style={{ fontSize: 11 }}>
          Vendedor: <strong>{user.nome}</strong>
        </p>
      ) : null}

      {/* Cliente + canal */}
      <section className="wms-card" style={{ padding: 14, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
          <Field label="Cliente" required>
            <input
              value={clienteNome}
              onChange={(e) => setClienteNome(e.target.value)}
              className="wms-input"
              placeholder="Nome do cliente"
            />
          </Field>
          <Field label="CPF/CNPJ">
            <input
              value={clienteCpf}
              onChange={(e) => setClienteCpf(e.target.value)}
              className="wms-input"
              placeholder="Opcional"
            />
          </Field>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1.5fr 1fr",
            gap: 10,
          }}
        >
          <Field label="Canal">
            <select
              value={canal}
              onChange={(e) => setCanal(e.target.value)}
              className="wms-input"
            >
              {CANAIS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Empresa que vende" required>
            <select
              value={empresaOrigemId}
              onChange={(e) => setEmpresaOrigemId(e.target.value)}
              className="wms-input"
            >
              <option value="">Selecione…</option>
              {empresas.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Galpão" required>
            <select
              value={galpaoId}
              onChange={(e) => setGalpaoId(e.target.value)}
              className="wms-input"
            >
              <option value="">Selecione…</option>
              {(galpoes ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      {/* Modo */}
      <section className="wms-card" style={{ padding: 14 }}>
        <Field label="Como baixar do estoque">
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => setModo("separacao")}
              className={`wms-btn ${modo === "separacao" ? "wms-btn-primary" : ""}`}
              style={{ flex: 1 }}
            >
              Mandar pra separação
            </button>
            <button
              type="button"
              onClick={() => setModo("baixa_direta")}
              className={`wms-btn ${modo === "baixa_direta" ? "wms-btn-primary" : ""}`}
              style={{ flex: 1 }}
            >
              Baixar estoque direto
            </button>
          </div>
          <p className="wms-td-mute" style={{ fontSize: 11, marginTop: 6 }}>
            {modo === "separacao"
              ? "Pedido vai pra fila de wave picking. Operador separa e embala."
              : "Sistema baixa direto na loc sugerida. Se faltar saldo, cai pra separação automaticamente."}
          </p>
        </Field>
      </section>

      {/* Itens */}
      <section className="wms-card" style={{ padding: 14 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <strong style={{ fontSize: 13 }}>Itens</strong>
          <button className="wms-btn-link" onClick={addItem} type="button">
            <Icon name="plus" size={11} /> Adicionar item
          </button>
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          {items.map((item, idx) => {
            const disp = dispQueries[idx];
            const sug = disp?.data?.sugestao ?? null;
            const total = disp?.data?.total_disponivel ?? 0;
            const carregando = !!disp?.isFetching && !disp?.data;
            const podeBaixar = !!item.produto && total >= item.quantidade;
            const semSaldo =
              !!item.produto && !!galpaoId && !carregando && total === 0;
            const saldoInsuficiente =
              !!item.produto &&
              !!galpaoId &&
              !carregando &&
              total > 0 &&
              total < item.quantidade;
            return (
              <div
                key={item.uid}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: 8,
                  padding: 12,
                  display: "grid",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 90px 28px",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <ProdutoCombo
                    value={item.produto}
                    onChange={(p) => updateItem(idx, { produto: p })}
                  />
                  <input
                    type="number"
                    min={1}
                    value={item.quantidade}
                    onChange={(e) =>
                      updateItem(idx, {
                        quantidade: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    className="wms-input"
                    placeholder="Qty"
                  />
                  <button
                    type="button"
                    className="wms-btn-icon"
                    onClick={() => removeItem(idx)}
                    disabled={items.length === 1}
                    aria-label="Remover item"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>

                {/* Linha de disponibilidade — read-only, automática */}
                {item.produto && galpaoId && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: 12,
                      paddingTop: 6,
                      borderTop: "1px dashed var(--wms-c-border)",
                    }}
                  >
                    <Icon name="sparkle" size={11} />
                    {carregando ? (
                      <span className="wms-td-mute">
                        Buscando localização…
                      </span>
                    ) : sug ? (
                      <>
                        <span>
                          Loc sugerida:{" "}
                          <strong>{sug.localizacao_codigo}</strong>
                          {sug.localizacao_tipo === "picking" ? " (picking)" : ""}
                        </span>
                        <span className="wms-td-mute">·</span>
                        <span
                          style={{
                            color: podeBaixar
                              ? "var(--wms-c-success, #16a34a)"
                              : saldoInsuficiente
                                ? "var(--wms-c-warning, #d97706)"
                                : "var(--wms-c-danger, #dc2626)",
                            fontWeight: 500,
                          }}
                        >
                          {total} disponíve{total === 1 ? "l" : "is"} no galpão
                        </span>
                        {saldoInsuficiente && (
                          <span
                            className="wms-td-mute"
                            style={{ fontSize: 11 }}
                          >
                            — pedindo {item.quantidade}, vira separação/OC
                          </span>
                        )}
                      </>
                    ) : semSaldo ? (
                      <span
                        style={{
                          color: "var(--wms-c-danger, #dc2626)",
                        }}
                      >
                        Sem saldo no galpão — vira separação/OC ao criar
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          paddingTop: 4,
        }}
      >
        <button
          className="wms-btn"
          onClick={() => router.push("/wms/vendas")}
          disabled={enviando}
          type="button"
        >
          Cancelar
        </button>
        <button
          className="wms-btn wms-btn-primary"
          onClick={submit}
          disabled={!valido || enviando}
          type="button"
        >
          {enviando
            ? "Criando…"
            : modo === "separacao"
              ? "Criar e mandar pra separação"
              : "Criar e baixar estoque agora"}
        </button>
      </div>
    </div>
  );
}
