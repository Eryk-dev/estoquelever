"use client";

import { useEffect, useId, useState } from "react";
import { Plus, X, Loader2 } from "lucide-react";
import { sisoFetch } from "@/lib/auth-context";
import { toast } from "sonner";
import type { VeiculoEntry } from "@/lib/cross/types";

interface VeiculoListEditorProps {
  sku: string;
  veiculos: VeiculoEntry[];
  onChange: () => void;
}

export function VeiculoListEditor({ sku, veiculos, onChange }: VeiculoListEditorProps) {
  const [adicionando, setAdicionando] = useState(false);
  const [marca, setMarca] = useState("");
  const [modelo, setModelo] = useState("");
  const [anoInicio, setAnoInicio] = useState("");
  const [anoFim, setAnoFim] = useState("");
  const [variante, setVariante] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [marcasSugeridas, setMarcasSugeridas] = useState<string[]>([]);
  const [modelosSugeridos, setModelosSugeridos] = useState<string[]>([]);
  const marcaListId = useId();
  const modeloListId = useId();

  // Sugestões de marca conforme digita
  useEffect(() => {
    if (!adicionando) return;
    const handle = setTimeout(async () => {
      const res = await sisoFetch(
        `/api/cross/sugestoes/marcas?q=${encodeURIComponent(marca)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setMarcasSugeridas(data.marcas ?? []);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [marca, adicionando]);

  // Sugestões de modelo
  useEffect(() => {
    if (!adicionando || !marca) {
      setModelosSugeridos([]);
      return;
    }
    const handle = setTimeout(async () => {
      const res = await sisoFetch(
        `/api/cross/sugestoes/modelos?marca=${encodeURIComponent(marca)}&q=${encodeURIComponent(modelo)}`,
      );
      if (res.ok) {
        const data = await res.json();
        setModelosSugeridos(data.modelos ?? []);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [marca, modelo, adicionando]);

  function reset() {
    setMarca("");
    setModelo("");
    setAnoInicio("");
    setAnoFim("");
    setVariante("");
    setAdicionando(false);
  }

  async function adicionar() {
    if (!marca.trim() || !modelo.trim()) {
      toast.error("Marca e modelo são obrigatórios");
      return;
    }
    setSalvando(true);
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/veiculos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marca: marca.trim(),
            modelo: modelo.trim(),
            ano_inicio: anoInicio ? Number(anoInicio) : null,
            ano_fim: anoFim ? Number(anoFim) : null,
            variante: variante.trim() || null,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Erro ao adicionar veículo");
        return;
      }
      toast.success("Veículo adicionado");
      reset();
      onChange();
    } catch {
      toast.error("Erro ao adicionar");
    } finally {
      setSalvando(false);
    }
  }

  async function remover(id: number) {
    if (!confirm("Remover este veículo?")) return;
    try {
      const res = await sisoFetch(
        `/api/cross/produtos/${encodeURIComponent(sku)}/veiculos/${id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Erro ao remover");
        return;
      }
      toast.success("Veículo removido");
      onChange();
    } catch {
      toast.error("Erro ao remover");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Compatibilidade veicular</h3>
        {!adicionando && (
          <button
            onClick={() => setAdicionando(true)}
            className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700"
          >
            <Plus className="h-3.5 w-3.5" /> Adicionar
          </button>
        )}
      </div>

      {adicionando && (
        <div className="space-y-2 mb-3 p-3 rounded bg-zinc-50 dark:bg-zinc-800">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <input
                type="text"
                list={marcaListId}
                value={marca}
                onChange={(e) => setMarca(e.target.value.toUpperCase())}
                placeholder="Marca"
                className="w-full rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
              />
              <datalist id={marcaListId}>
                {marcasSugeridas.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div>
              <input
                type="text"
                list={modeloListId}
                value={modelo}
                onChange={(e) => setModelo(e.target.value.toUpperCase())}
                placeholder="Modelo"
                className="w-full rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
              />
              <datalist id={modeloListId}>
                {modelosSugeridos.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <input
              type="number"
              value={anoInicio}
              onChange={(e) => setAnoInicio(e.target.value)}
              placeholder="Ano início"
              className="rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
            />
            <input
              type="number"
              value={anoFim}
              onChange={(e) => setAnoFim(e.target.value)}
              placeholder="Ano fim"
              className="rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
            />
            <input
              type="text"
              value={variante}
              onChange={(e) => setVariante(e.target.value)}
              placeholder="Variante (opcional)"
              className="col-span-2 rounded border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-sm"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={reset}
              className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700"
            >
              Cancelar
            </button>
            <button
              onClick={adicionar}
              disabled={salvando}
              className="px-3 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1"
            >
              {salvando && <Loader2 className="h-3 w-3 animate-spin" />}
              Salvar
            </button>
          </div>
        </div>
      )}

      {veiculos.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum veículo cadastrado.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {veiculos.map((v) => (
            <span
              key={v.id}
              className="group inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-800 text-xs"
              title={
                v.adicionado_por_nome ? `Por ${v.adicionado_por_nome}` : "Importado"
              }
            >
              <span className="font-medium">
                {v.marca} {v.modelo}
              </span>
              {(v.ano_inicio || v.ano_fim) && (
                <span className="text-zinc-500">
                  {v.ano_inicio ?? "?"}-{v.ano_fim ?? "?"}
                </span>
              )}
              {v.variante && <span className="text-zinc-500">{v.variante}</span>}
              {v.pode_remover && (
                <button
                  onClick={() => remover(v.id)}
                  className="opacity-0 group-hover:opacity-100 hover:text-red-600"
                  title="Remover"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
