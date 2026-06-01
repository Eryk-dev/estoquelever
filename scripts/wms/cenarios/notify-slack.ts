import "dotenv/config";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

const REPORTS_DIR = "scripts/wms/cenarios/reports";

export interface DetailReport {
  iniciado_em: string;
  duracao_ms: number;
  totais: { pass: number; fail: number; skip: number; product_fail?: number; infra_fail?: number };
  cenarios: Array<{
    nome: string;
    status: string;
    classe?: string;
    motivo?: string;
    invariantes?: Array<{ nome: string; ok: boolean }>;
  }>;
}

async function ultimoRelatorio(): Promise<DetailReport | null> {
  let arquivos: string[];
  try {
    arquivos = (await readdir(REPORTS_DIR)).filter((f) => f.endsWith("-detail.json")).sort();
  } catch {
    return null;
  }
  if (arquivos.length === 0) return null;
  const ultimo = arquivos[arquivos.length - 1];
  return JSON.parse(await readFile(join(REPORTS_DIR, ultimo), "utf-8")) as DetailReport;
}

export function montarMensagem(rep: DetailReport): { texto: string; problema: boolean } {
  const productFail = rep.cenarios.filter((c) => c.classe === "product-fail");
  const infraFail = rep.cenarios.filter((c) => c.classe === "infra-fail");
  const pass = rep.cenarios.filter((c) => c.status === "pass").length;
  const problema = productFail.length > 0 || infraFail.length > 0;

  const icone = productFail.length > 0 ? "🔴" : infraFail.length > 0 ? "🟡" : "🟢";
  const linhas: string[] = [];
  linhas.push(`${icone} *Bateria de estoque* — ${rep.iniciado_em}`);
  linhas.push(`✅ ${pass} pass · 🔴 ${productFail.length} bug · 🟡 ${infraFail.length} infra`);

  if (productFail.length > 0) {
    linhas.push("");
    linhas.push("*Fluxos quebrados (bug de estoque):*");
    for (const c of productFail.slice(0, 20)) {
      const invs = (c.invariantes ?? []).filter((i) => !i.ok).map((i) => i.nome);
      const motivo = invs.length > 0 ? `invariante ${invs.join(", ")}` : (c.motivo ?? "assert/erro");
      linhas.push(`• ${c.nome} — ${motivo}`);
    }
  }
  if (infraFail.length > 0) {
    linhas.push("");
    linhas.push(`*Inconclusivos (infra instável):* ${infraFail.slice(0, 10).map((c) => c.nome).join(", ")}`);
  }
  return { texto: linhas.join("\n"), problema };
}

async function main() {
  const always = process.argv.includes("--always");
  const webhook = process.env.STOCK_SUITE_WEBHOOK_URL;
  if (!webhook) {
    console.error("STOCK_SUITE_WEBHOOK_URL ausente — pulando alerta");
    process.exit(0);
  }
  const rep = await ultimoRelatorio();
  if (!rep) {
    console.error("Nenhum relatório encontrado");
    process.exit(0);
  }
  const { texto, problema } = montarMensagem(rep);
  if (!problema && !always) {
    console.log("Suite verde — sem alerta (use --always pra heartbeat).");
    process.exit(0);
  }
  // Slack usa `text`; Discord usa `content`. Mandar os dois cobre ambos.
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: texto, content: texto }),
  });
  if (!res.ok) {
    console.error(`Webhook falhou: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log("Alerta enviado.");
}

// Só roda main() quando invocado direto (não em import de teste).
const _isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1]}`).href; } catch { return false; }
})();
if (_isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
