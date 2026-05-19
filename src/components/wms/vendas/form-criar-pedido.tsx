"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { sisoFetch, useAuth } from "@/lib/auth-context";
import { Modal, Field, Icon } from "@/components/wms/ui/wms-ui";
import {
  ProdutoCombo,
  LocalizacaoCombo,
  useGalpoes,
  type EmpresaLite,
  type GalpaoLite,
} from "@/components/wms/ui/modals";
import type { Produto } from "@/lib/wms/types";
import type { ModoVendaDireta } from "@/types";

interface ItemForm {
  produto: Produto | null;
  quantidade: number;
  galpao_id: string;
  localizacao_id: string;
  empresa_dona_id: string;
}

const CANAIS = ["Balcão", "WhatsApp", "Telefone", "Outro"];

function emptyItem(): ItemForm {
  return {
    produto: null,
    quantidade: 1,
    galpao_id: "",
    localizacao_id: "",
    empresa_dona_id: "",
  };
}

export function FormCriarPedidoModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (pedidoId: string) => void;
}) {
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
  const [modo, setModo] = useState<ModoVendaDireta>("separacao");
  const [items, setItems] = useState<ItemForm[]>([emptyItem()]);
  const [enviando, setEnviando] = useState(false);

  if (!open) return null;

  const addItem = () => setItems((arr) => [...arr, emptyItem()]);
  const updateItem = (idx: number, patch: Partial<ItemForm>) =>
    setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) =>
    setItems((arr) => (arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr));

  const valido =
    !!clienteNome.trim() &&
    !!empresaOrigemId &&
    items.every((it) => {
      if (!it.produto || it.quantidade <= 0) return false;
      if (modo === "baixa_direta") {
        return !!it.galpao_id && !!it.localizacao_id && !!it.empresa_dona_id;
      }
      return true;
    });

  const submit = async () => {
    if (!valido || enviando) return;
    setEnviando(true);
    try {
      const payload = {
        cliente_nome: clienteNome.trim(),
        cliente_cpf_cnpj: clienteCpf.trim() || null,
        canal_venda: canal,
        empresa_origem_id: empresaOrigemId,
        modo,
        items: items.map((it) => ({
          produto_id: it.produto!.id,
          quantidade: it.quantidade,
          ...(modo === "baixa_direta"
            ? {
                galpao_id: it.galpao_id,
                localizacao_id: it.localizacao_id,
                empresa_dona_id: it.empresa_dona_id,
              }
            : {}),
        })),
        idempotency_key: crypto.randomUUID(),
      };

      const res = await sisoFetch("/api/wms/vendas/criar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { erro?: string; sku?: string };
        toast.error(err.erro ?? "Erro ao criar pedido");
        return;
      }

      const data = (await res.json()) as { pedido_id: string; numero: string };
      toast.success(`Pedido ${data.numero} criado`);
      onCreated(data.pedido_id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar pedido");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal
      title="Nova venda"
      subtitle={
        user
          ? `Vendedor: ${user.nome}`
          : "Preencha os dados do pedido — você será registrado como vendedor."
      }
      onClose={onClose}
      width={680}
      footer={
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="wms-btn" onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button
            className="wms-btn wms-btn-primary"
            onClick={submit}
            disabled={!valido || enviando}
          >
            {enviando
              ? "Criando…"
              : modo === "separacao"
                ? "Criar e mandar pra separação"
                : "Criar e baixar estoque agora"}
          </button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
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

        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
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
        </div>

        {/* Toggle modo */}
        <Field label="Como baixar do estoque">
          <div className="wms-segmented" style={{ display: "flex", gap: 4 }}>
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
          <p className="wms-td-mute" style={{ fontSize: 11, marginTop: 4 }}>
            {modo === "separacao"
              ? "Pedido vai pra fila de wave picking dos operadores."
              : "Baixa direta — escolha a localização exata. Não passa pelo operador."}
          </p>
        </Field>

        {/* Items */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <strong style={{ fontSize: 12 }}>Itens</strong>
            <button className="wms-btn-link" onClick={addItem}>
              <Icon name="plus" size={11} /> Adicionar item
            </button>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {items.map((item, idx) => (
              <div
                key={idx}
                style={{
                  border: "1px solid var(--wms-c-border)",
                  borderRadius: 8,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 28px", gap: 8 }}>
                  <ProdutoCombo
                    value={item.produto}
                    onChange={(p) => updateItem(idx, { produto: p })}
                  />
                  <input
                    type="number"
                    min={1}
                    value={item.quantidade}
                    onChange={(e) =>
                      updateItem(idx, { quantidade: parseInt(e.target.value, 10) || 0 })
                    }
                    className="wms-input"
                    placeholder="Qty"
                  />
                  <button
                    className="wms-btn-icon"
                    onClick={() => removeItem(idx)}
                    disabled={items.length === 1}
                    aria-label="Remover item"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>

                {modo === "baixa_direta" && item.produto && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      gap: 8,
                      paddingTop: 6,
                      borderTop: "1px dashed var(--wms-c-border)",
                    }}
                  >
                    <Field label="Galpão">
                      <select
                        value={item.galpao_id}
                        onChange={(e) =>
                          updateItem(idx, {
                            galpao_id: e.target.value,
                            localizacao_id: "",
                          })
                        }
                        className="wms-input"
                      >
                        <option value="">Selecione</option>
                        {(galpoes ?? []).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.nome}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Localização">
                      <LocalizacaoCombo
                        galpaoId={item.galpao_id || null}
                        value={item.localizacao_id}
                        onChange={(id) => updateItem(idx, { localizacao_id: id })}
                        allowCreate={false}
                      />
                    </Field>
                    <Field label="Empresa dona">
                      <select
                        value={item.empresa_dona_id}
                        onChange={(e) => updateItem(idx, { empresa_dona_id: e.target.value })}
                        className="wms-input"
                      >
                        <option value="">Selecione</option>
                        {empresas.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.nome}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
