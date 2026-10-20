"use client";

import { useState } from "react";
import { sisoFetch } from "@/lib/auth-context";

/** Operação administrativa para drenar notas órfãs sem esperar o próximo cron. */
export function RecuperarVendas({ empresas }: { empresas: Array<{ id: string; nome: string }> }) {
  const [empresaId, setEmpresaId] = useState("");
  const [notas, setNotas] = useState<number[] | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState("");
  async function consultar() {
    setOcupado(true);
    setMensagem("");
    setNotas(null);
    try {
      const res = await sisoFetch(`/api/wms/tiny/recuperar-vendas?empresaId=${empresaId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setNotas(data.notas);
      setMensagem(`${data.notas.length} notas aguardando pedido.${data.truncado ? " Consulta limitada às 1.000 notas mais recentes." : ""}`);
    } catch (err) {
      setMensagem(err instanceof Error ? err.message : "Falha na consulta");
    } finally { setOcupado(false); }
  }
  async function recuperar() {
    if (!notas?.length) return;
    setOcupado(true);
    let concluidas = 0;
    let aguardando = 0;
    let falhas = 0;
    try {
      for (let i = 0; i < notas.length; i += 5) {
        const res = await sisoFetch("/api/wms/tiny/recuperar-vendas", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ empresaId, notas: notas.slice(i, i + 5) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        for (const r of data.resultados) {
          if (r.status === "processado" || r.status === "concluido") concluidas++;
          else if (r.status === "erro") falhas++;
          else aguardando++;
        }
        setMensagem(`Verificadas ${Math.min(i + 5, notas.length)} de ${notas.length}. Notas concluídas: ${concluidas}. Sem liberação: ${aguardando}. Falhas: ${falhas}.`);
      }
      setNotas(null);
    } catch (err) {
      setMensagem(`Processamento interrompido: ${err instanceof Error ? err.message : "falha"}. Consulte novamente para continuar.`);
    } finally { setOcupado(false); }
  }
  return (
    <section className="rounded-lg border bg-white p-5 space-y-3">
      <h3 className="text-sm font-semibold">Recuperar vendas faturadas</h3>
      <p className="text-sm text-muted-foreground">
        Confere as notas que chegaram sem pedido e recupera as vendas do Mercado Livre
        que ainda aguardam despacho, reutilizando a nota existente. Envios coletados,
        cancelados, Full e etiquetas futuras não são liberados por esta recuperação.
      </p>
      <div className="flex flex-wrap gap-2">
        <select aria-label="Empresa para recuperar vendas" className="rounded border px-3 py-2 text-sm"
          value={empresaId} disabled={ocupado}
          onChange={(e) => { setEmpresaId(e.target.value); setNotas(null); setMensagem(""); }}>
          <option value="">Selecione a empresa</option>
          {empresas.filter((e) => !/bellator/i.test(e.nome)).map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
        </select>
        <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50"
          disabled={!empresaId || ocupado} onClick={consultar}>Consultar pendências</button>
        {!!notas?.length && <button type="button"
          className="rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
          disabled={ocupado} onClick={recuperar}>Recuperar vendas</button>}
      </div>
      <p role="status" className="text-sm">{ocupado && !mensagem ? "Consultando…" : mensagem}</p>
    </section>
  );
}
