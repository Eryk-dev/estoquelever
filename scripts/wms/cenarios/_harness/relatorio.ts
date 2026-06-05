import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { ScenarioResult } from "./types";

const REPORTS_DIR = "scripts/wms/cenarios/reports";

export async function writeReport(results: ScenarioResult[], iniciadoEm: Date, duracaoMs: number) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const ts = iniciadoEm.toISOString().replace(/[:.]/g, "-");
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  const productFail = results.filter((r) => r.classe === "product-fail").length;
  const infraFail = results.filter((r) => r.classe === "infra-fail").length;

  const md = buildMarkdown(results, iniciadoEm, duracaoMs, pass, fail, skip, productFail, infraFail);
  const json = JSON.stringify({
    iniciado_em: iniciadoEm.toISOString(),
    duracao_ms: duracaoMs,
    totais: { pass, fail, skip, product_fail: productFail, infra_fail: infraFail },
    cenarios: results,
  }, null, 2);

  await writeFile(join(REPORTS_DIR, `${ts}-summary.md`), md, "utf-8");
  await writeFile(join(REPORTS_DIR, `${ts}-detail.json`), json, "utf-8");

  return { mdPath: `${REPORTS_DIR}/${ts}-summary.md`, jsonPath: `${REPORTS_DIR}/${ts}-detail.json` };
}

function buildMarkdown(results: ScenarioResult[], iniciado: Date, duracaoMs: number, pass: number, fail: number, skip: number, productFail: number, infraFail: number): string {
  const dur = formatarDuracao(duracaoMs);
  const lines: string[] = [];
  lines.push(`# Suite Scenarios — ${iniciado.toISOString()}`);
  lines.push("");
  lines.push(`**Total:** ${results.length} · **Pass:** ${pass} · **Fail:** ${fail} (🔴 ${productFail} bug · 🟡 ${infraFail} infra) · **Skip:** ${skip} · **Tempo:** ${dur}`);
  lines.push("");

  if (fail > 0) {
    lines.push("## Falhas");
    lines.push("");
    for (const r of results.filter((x) => x.status === "fail")) {
      lines.push(`### ❌ ${r.nome} (${formatarDuracao(r.duracao_ms ?? 0)})`);
      lines.push(`**Motivo:** ${r.motivo ?? "desconhecido"}`);
      if (r.erro) {
        lines.push("");
        lines.push("```");
        lines.push(r.erro.mensagem);
        lines.push("```");
      }
      if (r.detalhes) {
        lines.push("");
        lines.push("Detalhes:");
        lines.push("```json");
        lines.push(JSON.stringify(r.detalhes, null, 2).slice(0, 4000));
        lines.push("```");
      }
      if (r.invariantes?.some((i) => !i.ok)) {
        lines.push("");
        lines.push("Invariantes falhando:");
        for (const inv of r.invariantes.filter((i) => !i.ok)) {
          lines.push(`- ${inv.nome}: ${JSON.stringify(inv.detalhes).slice(0, 500)}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("## Cenários OK");
  for (const r of results.filter((x) => x.status === "pass")) {
    lines.push(`- ✅ ${r.nome} (${formatarDuracao(r.duracao_ms ?? 0)})`);
  }

  if (skip > 0) {
    lines.push("");
    lines.push("## Cenários Skipped");
    for (const r of results.filter((x) => x.status === "skip")) {
      lines.push(`- ⏭️ ${r.nome}`);
    }
  }

  return lines.join("\n");
}

function formatarDuracao(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}.${String(ms % 1000).padStart(3, "0").slice(0, 1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
