"use client";

import { Suspense, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { sisoFetch, useAuth, usePermissoes } from "@/lib/auth-context";
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

interface VendedorLite {
  id: string;
  nome: string;
}

const CANAIS = ["Balcão", "WhatsApp", "Telefone", "Outro"];

interface ItemForm {
  uid: string;
  produto: Produto | null;
  quantidade: number;
}

// Plano ledger simplificado 3D (2026-05-20): estoque fungível dentro do galpão.
// API /disponibilidade não devolve mais empresa_dona — só loc + qty.
interface DisponibilidadeResp {
  total_disponivel: number;
  sugestao: {
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
  const { can, permissoes } = usePermissoes();
  const podeCriar = can("vendas.criar");
  // Permission gate scaffold pra "criar em nome de X" (finding 5.28).
  // A permissão `vendas.criar_em_nome_de` será adicionada pelo P4. Checa
  // direto no Set (em vez de can(...)) pra contornar o tipo restrito
  // PermissaoCodigo. Hoje retorna false sempre — UI fica oculta.
  const podeCriarEmNomeDe = permissoes.has("vendas.criar_em_nome_de");
  const { data: galpoes } = useGalpoes();

  // Vendedores disponíveis pra atribuir o pedido. Só carrega quando o
  // operador tem `vendas.criar_em_nome_de` (P4). Endpoint atual exige
  // sistema.usuarios; P4 deve expor um endpoint mais leve.
  const vendedoresQuery = useQuery({
    queryKey: ["wms-vendedores-lite"],
    queryFn: async () => {
      const r = await sisoFetch("/api/wms/admin/usuarios");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list = (await r.json()) as Array<{
        id: string;
        nome: string;
        ativo: boolean;
        cargos?: string[];
      }>;
      return list
        .filter((u) => u.ativo && (u.cargos ?? []).includes("vendedor"))
        .map((u) => ({ id: u.id, nome: u.nome }) satisfies VendedorLite);
    },
    enabled: podeCriarEmNomeDe,
    staleTime: 60_000,
  });

  const empresas = useMemo<EmpresaLite[]>(
    () =>
      (galpoes ?? []).flatMap((g: GalpaoLite) =>
        g.empresas.map((e) => ({ ...e, galpao_id: g.id })),
      ),
    [galpoes],
  );

  // Full: envio de estoque ao CDF do ML, sem pedido-fantasma no Tiny. Esconde
  // cliente/CPF/canal (não se aplica); força modo="separacao" (Full nunca faz
  // baixa_direta — reconciliação de estoque é sempre via editor da lane Full).
  const [isFull, setIsFull] = useState(false);
  const [clienteNome, setClienteNome] = useState("");
  const [clienteCpf, setClienteCpf] = useState("");
  const [canal, setCanal] = useState("Balcão");
  const [empresaOrigemId, setEmpresaOrigemId] = useState("");
  const [galpaoId, setGalpaoId] = useState("");
  const [modo, setModo] = useState<ModoVendaDireta>("separacao");
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [enviando, setEnviando] = useState(false);
  // Override do vendedor (P4 gate — finding 5.28). null = usa o operador
  // logado (comportamento padrão). Quando setado, o pedido fica em nome
  // do vendedor escolhido. Backend consome `vendedor_id_alvo` (commit
  // 89577b5) — frontend re-aligned no re-audit fix #7.NEW2.
  const [vendedorIdAlvo, setVendedorIdAlvo] = useState<string | null>(
    null,
  );

  const addItem = () => setItems((arr) => [...arr, emptyItem()]);
  const updateItem = (idx: number, patch: Partial<ItemForm>) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) =>
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));

  // Resolve disponibilidade por item (paralelo, cacheado por React Query).
  // Em 3D, estoque é fungível dentro do galpão — empresa_origem_id não
  // influencia a sugestão, então fica fora do query key.
  const dispQueries = useQueries({
    queries: items.map((it) => ({
      queryKey: [
        "wms-vendas-disponibilidade",
        it.produto?.id,
        galpaoId,
      ],
      queryFn: () => {
        const sp = new URLSearchParams({
          produto_id: it.produto!.id,
          galpao_id: galpaoId,
        });
        return wmsApi<DisponibilidadeResp>(
          `/api/wms/vendas/disponibilidade?${sp.toString()}`,
        );
      },
      enabled: !!(it.produto?.id && galpaoId),
      staleTime: 15 * 1000,
    })),
  });

  const valido =
    (isFull || !!clienteNome.trim()) &&
    !!empresaOrigemId &&
    !!galpaoId &&
    items.every((it) => !!it.produto && it.quantidade > 0);

  const submitFull = async () => {
    const payload = {
      empresa_origem_id: empresaOrigemId,
      galpao_id: galpaoId,
      items: items.map((it) => ({
        produto_id: it.produto!.id,
        quantidade: it.quantidade,
      })),
      idempotency_key: crypto.randomUUID(),
    };

    const res = await sisoFetch("/api/wms/full/criar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { erro?: string };
      toast.error(err.erro ?? "Erro ao criar Full");
      return;
    }

    const data = (await res.json()) as {
      pedido_id: string;
      numero: string;
      parcial?: boolean;
      itens_parciais?: Array<{
        sku: string;
        quantidade_pedida: number;
        quantidade_reservada: number;
      }>;
    };
    if (data.parcial) {
      const detalhe = (data.itens_parciais ?? [])
        .map((i) => `${i.sku} (${i.quantidade_reservada}/${i.quantidade_pedida})`)
        .join(", ");
      toast.warning(`Full ${data.numero} criado com reserva parcial: ${detalhe}`, {
        duration: 10000,
      });
    } else {
      toast.success(`Full ${data.numero} criado e mandado pra separação`);
    }
    router.push("/wms/separacao-full");
  };

  const submit = async () => {
    if (!valido || enviando) return;
    setEnviando(true);
    try {
      if (isFull) {
        await submitFull();
        return;
      }

      const payload: CriarVendaDiretaRequest & {
        vendedor_id_alvo?: string;
      } = {
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
      // P4 scaffold: envia override quando o operador tem a permissão.
      // Backend ainda ignora hoje (gravando user.id) — P4 vai consumir.
      if (podeCriarEmNomeDe && vendedorIdAlvo) {
        payload.vendedor_id_alvo = vendedorIdAlvo;
      }

      const res = await sisoFetch("/api/wms/vendas/criar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          erro?: string;
          codigo?: string;
          sku?: string;
          empresas_disponiveis?: Array<{ id: string; nome: string }>;
        };
        // [Fix-D #7.8] Surface payload estruturado pra PRODUTO_NAO_MAPEADO
        if (res.status === 400 && err.codigo === "PRODUTO_NAO_MAPEADO") {
          const empresasMsg =
            err.empresas_disponiveis && err.empresas_disponiveis.length > 0
              ? ` Disponível em: ${err.empresas_disponiveis.map((e) => e.nome).join(", ")}.`
              : "";
          toast.error(
            `Produto ${err.sku ?? ""} não cadastrado nessa empresa.${empresasMsg}`,
            { duration: 8000 },
          );
          return;
        }
        toast.error(err.erro ?? "Erro ao criar pedido");
        return;
      }

      const data = (await res.json()) as CriarVendaDiretaResponse;
      if (data.degradado && data.motivo_degradacao === "falta_saldo") {
        const skus = (data.skus_sem_saldo ?? []).join(", ") || "—";
        toast.warning(
          `Pedido ${data.numero} criado, mas vai pra separação: sem saldo de ${skus}.`,
          { duration: 10000 },
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

      {/* Tipo de pedido — Full esconde cliente/CPF/canal e envia ao CDF do ML
          sem pedido-fantasma no Tiny (ver /wms/separacao-full). */}
      <section className="wms-card" style={{ padding: 14 }}>
        <Field label="Tipo de pedido">
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => setIsFull(false)}
              className={`wms-btn ${!isFull ? "wms-btn-primary" : ""}`}
              style={{ flex: 1 }}
            >
              Venda
            </button>
            <button
              type="button"
              onClick={() => setIsFull(true)}
              className={`wms-btn ${isFull ? "wms-btn-primary" : ""}`}
              style={{ flex: 1 }}
            >
              Full
            </button>
          </div>
          <p className="wms-td-mute" style={{ fontSize: 11, marginTop: 6 }}>
            {isFull
              ? "Envio de estoque ao CDF do Mercado Livre. Sem cliente, sem NF, sem Tiny."
              : "Pedido de venda pra um cliente."}
          </p>
        </Field>
      </section>

      {/* Cliente + canal */}
      <section className="wms-card" style={{ padding: 14, display: "grid", gap: 12 }}>
        {!isFull && (
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
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: isFull ? "1fr 1fr" : "1fr 1.5fr 1fr",
            gap: 10,
          }}
        >
          {!isFull && (
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
          )}
          <Field label={isFull ? "Conta ML" : "Empresa que vende"} required>
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

        {/* "Criar em nome de X" — gate por permissão vendas.criar_em_nome_de
            (P4). Hoje renderiza zero porque a perm não existe; quando P4
            adicionar, esta seção fica visível pra admins/operadores. */}
        {podeCriarEmNomeDe && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
            <Field label="Criar em nome de">
              <select
                value={vendedorIdAlvo ?? ""}
                onChange={(e) =>
                  setVendedorIdAlvo(e.target.value || null)
                }
                className="wms-input"
                disabled={vendedoresQuery.isLoading || vendedoresQuery.isError}
              >
                <option value="">
                  Eu mesmo ({user?.nome ?? "—"})
                </option>
                {(vendedoresQuery.data ?? [])
                  .filter((v) => v.id !== user?.id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.nome}
                    </option>
                  ))}
              </select>
              <p className="wms-td-mute" style={{ fontSize: 11, marginTop: 4 }}>
                {vendedorIdAlvo
                  ? "Pedido será criado em nome do vendedor selecionado."
                  : "Pedido será atribuído a você."}
              </p>
            </Field>
          </div>
        )}
      </section>

      {/* Modo — Full não se aplica (sempre separação; editor da lane Full é
          quem reconcilia estoque, nunca baixa_direta). */}
      {!isFull && (
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
      )}

      {/* Itens — overflow visible pra não clipar dropdown do ProdutoCombo */}
      <section className="wms-card" style={{ padding: 14, overflow: "visible" }}>
        <strong style={{ fontSize: 13, display: "block", marginBottom: 10 }}>
          Itens
        </strong>

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

        {/* Botão fica embaixo da lista pra seguir o crescimento — o operador
            não precisa mais subir até o topo a cada SKU adicionado. */}
        <button
          className="wms-btn"
          onClick={addItem}
          type="button"
          style={{ width: "100%", marginTop: 10 }}
        >
          <Icon name="plus" size={11} /> Adicionar item
        </button>
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
          disabled={!valido || enviando || !podeCriar}
          title={!podeCriar ? "Sem permissão pra criar venda" : ""}
          type="button"
        >
          {enviando
            ? "Criando…"
            : isFull
              ? "Criar Full e mandar pra separação"
              : modo === "separacao"
                ? "Criar e mandar pra separação"
                : "Criar e baixar estoque agora"}
        </button>
      </div>
    </div>
  );
}
