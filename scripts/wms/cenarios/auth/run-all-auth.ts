import "dotenv/config";
import { readdir } from "fs/promises";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Match files like NN-...ts but exclude runner.ts and this file.
function isAuthCenario(name: string): boolean {
  if (!name.endsWith(".ts")) return false;
  if (name === "runner.ts" || name === "run-all-auth.ts") return false;
  return /^\d+[a-z]?-/.test(name);
}

async function runOne(file: string): Promise<{ file: string; code: number; output: string }> {
  return new Promise((resolveP) => {
    let buf = "";
    const child = spawn("npx", ["tsx", file], { cwd: process.cwd(), env: process.env });
    child.stdout?.on("data", (c) => { buf += c.toString(); });
    child.stderr?.on("data", (c) => { buf += c.toString(); });
    child.on("exit", (code) => {
      resolveP({ file, code: code ?? 1, output: buf });
    });
  });
}

async function main() {
  const dir = __dirname;
  const entries = (await readdir(dir)).filter(isAuthCenario).sort();
  if (entries.length === 0) {
    console.error("Nenhum cenário de auth encontrado.");
    process.exit(2);
  }
  console.log(`Executando ${entries.length} cenários de auth...\n`);
  const results: Array<{ file: string; code: number; output: string }> = [];
  for (const e of entries) {
    const full = resolve(dir, e);
    const r = await runOne(full);
    results.push(r);
    const tag = r.code === 0 ? "PASS" : "FAIL";
    console.log(`[${tag}] ${e}`);
    if (r.code !== 0) {
      console.log(r.output.split("\n").map((l) => `    ${l}`).join("\n"));
    }
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(`\nResumo: ${results.length - failed.length}/${results.length} cenários passaram.`);
  process.exit(failed.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
