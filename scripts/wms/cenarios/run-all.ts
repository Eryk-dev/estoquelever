import "dotenv/config";
import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { readdir } from "fs/promises";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { createServiceClient } from "../../../src/lib/supabase-server";
import type { Cenario, ScenarioResult } from "./_harness/types";
import { createContext } from "./_harness/context";
import { createHttp } from "./_harness/http";
import { seedInicial, truncateOperacional } from "./_harness/seed";
import { loginTestRunner, startDevServer, waitForHealth, buildProd, isHealthy, type DevServerHandle } from "./_harness/dev-server";
import { rodarInvariantes } from "./_harness/invariantes";
import { writeReport } from "./_harness/relatorio";

interface Args { only?: string; filter?: string; keepServer: boolean; port: number; prod: boolean; }

function parseArgs(): Args {
  const a: Args = { keepServer: false, port: 3001, prod: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") a.only = argv[++i];
    else if (argv[i] === "--filter") a.filter = argv[++i];
    else if (argv[i] === "--keep-server") a.keepServer = true;
    else if (argv[i] === "--prod") a.prod = true;
    else if (argv[i].startsWith("--port=")) a.port = Number(argv[i].slice(7));
  }
  return a;
}

function filterMatches(c: Cenario, args: Args): boolean {
  if (args.only) return c.nome.includes(args.only);
  if (args.filter) return c.tags.includes(args.filter);
  return true;
}

async function rodarCenario(args: { sb: any; cenario: Cenario; baseUrl: string; sessionId: string; staging: any }): Promise<ScenarioResult> {
  const t0 = Date.now();
  const correlationId = randomUUID();
  const http = createHttp({ baseUrl: args.baseUrl, sessionId: args.sessionId, correlationId });
  const ctx = createContext({ sb: args.sb, http, staging: args.staging, correlationId });

  try {
    const setupData = await args.cenario.setup(ctx);
    await args.cenario.run(ctx, setupData);
    await args.cenario.assertEsperado(ctx, setupData);
    const invs = await rodarInvariantes(args.sb);
    const falhas = invs.filter((i) => !i.ok);
    if (falhas.length > 0) {
      return {
        nome: args.cenario.nome,
        status: "fail",
        classe: "product-fail",
        duracao_ms: Date.now() - t0,
        motivo: "invariante",
        detalhes: { invariantes_falhando: falhas },
        invariantes: invs,
        correlation_id: correlationId,
      };
    }
    return { nome: args.cenario.nome, status: "pass", classe: "pass", duracao_ms: Date.now() - t0, invariantes: invs, correlation_id: correlationId };
  } catch (err) {
    const e = err as Error;
    const ehInfra = e.name === "NetworkError";
    const { data: logs } = await args.sb.from("siso_logs").select("level, source, message, created_at").eq("correlation_id", correlationId).order("created_at", { ascending: false }).limit(50);
    const { data: erros } = await args.sb.from("siso_erros").select("category, message, stack_trace, created_at").eq("correlation_id", correlationId).limit(50);
    return {
      nome: args.cenario.nome,
      status: "fail",
      classe: ehInfra ? "infra-fail" : "product-fail",
      duracao_ms: Date.now() - t0,
      motivo: e.name === "HttpError" ? "run" : ehInfra ? "infra" : "assert",
      erro: { mensagem: e.message, stack: e.stack },
      detalhes: { logs, erros },
      correlation_id: correlationId,
    };
  }
}

async function main() {
  const args = parseArgs();
  loadEnv({ path: ".env.test", override: false });
  loadEnv({ path: ".env.test.local", override: true });

  const baseUrl = `http://localhost:${args.port}`;

  if (args.prod) {
    console.log(`[0/6] next build (modo prod)`);
    await buildProd();
  }

  console.log(`[1/6] subindo Next ${args.prod ? "start" : "dev"} server em :${args.port}`);
  let server: DevServerHandle = await startDevServer({ port: args.port, prod: args.prod });
  process.on("SIGINT", () => server.kill().then(() => process.exit(130)));

  try {
    await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 60_000 });
  } catch (e) {
    await server.kill();
    throw e;
  }

  console.log(`[2/6] truncate + reseed`);
  const sb = createServiceClient();
  await truncateOperacional(sb);
  const staging = await seedInicial(sb);

  console.log(`[3/6] login test-runner`);
  let sessionId = await loginTestRunner({
    baseUrl,
    nome: process.env.TEST_RUNNER_NOME ?? "test-runner",
    pin: process.env.TEST_RUNNER_PIN ?? "9999",
  });

  // Recuperação de saúde: se o servidor caiu, reinicia uma vez e re-loga, em
  // vez de deixar todo cenário subsequente falhar com "fetch failed".
  async function garantirServidor(): Promise<boolean> {
    if (await isHealthy(`${baseUrl}/api/auth/me`)) return true;
    console.warn(`  ⚠️ servidor não responde — reiniciando`);
    try {
      await server.kill();
      server = await startDevServer({ port: args.port, prod: args.prod });
      await waitForHealth(`${baseUrl}/api/auth/me`, { timeout_ms: 60_000 });
      sessionId = await loginTestRunner({
        baseUrl,
        nome: process.env.TEST_RUNNER_NOME ?? "test-runner",
        pin: process.env.TEST_RUNNER_PIN ?? "9999",
      });
      console.warn(`  ✅ servidor reiniciado`);
      return true;
    } catch (e) {
      console.error(`  ❌ falha ao reiniciar servidor: ${(e as Error).message}`);
      return false;
    }
  }

  console.log(`[4/6] descobrindo cenários`);
  const catalogoDir = resolve("scripts/wms/cenarios/catalogo");
  let files: string[] = [];
  try {
    files = (await readdir(catalogoDir)).filter((f) => f.endsWith(".ts")).sort();
  } catch (e) {
    console.warn(`  ⚠️ catalogo/ não encontrado (${(e as Error).message}); nenhum cenário pra rodar`);
    if (!args.keepServer) await server.kill();
    process.exit(0);
  }

  console.log(`[5/6] executando ${files.length} cenários`);
  const iniciadoEm = new Date();
  const t0 = Date.now();
  const results: ScenarioResult[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(catalogoDir, f)).href);
    const cenario: Cenario = mod.default;
    if (!cenario) { console.warn(`  ⚠️ ${f}: sem default export, pulando`); continue; }
    if (cenario.skip || !filterMatches(cenario, args)) {
      results.push({ nome: cenario.nome, status: "skip" });
      console.log(`  ⏭️  ${cenario.nome}`);
      continue;
    }
    if (!(await garantirServidor())) {
      results.push({ nome: cenario.nome, status: "fail", classe: "infra-fail", motivo: "infra", duracao_ms: 0, erro: { mensagem: "servidor não recuperável" } });
      console.log(`  ❌ ${cenario.nome} — infra (servidor caiu)`);
      continue;
    }
    console.log(`  ▶️  ${cenario.nome}`);
    const r = await rodarCenario({ sb, cenario, baseUrl, sessionId, staging });
    results.push(r);
    console.log(`     ${r.status === "pass" ? "✅" : "❌"} ${r.duracao_ms}ms${r.status === "fail" ? ` — ${r.motivo}` : ""}`);
  }

  console.log(`[6/6] relatório`);
  const { mdPath, jsonPath } = await writeReport(results, iniciadoEm, Date.now() - t0);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);

  if (!args.keepServer) await server.kill();

  const productFail = results.filter((r) => r.classe === "product-fail").length;
  const infraFail = results.filter((r) => r.classe === "infra-fail").length;
  console.log(`  product-fail: ${productFail} · infra-fail: ${infraFail}`);
  // Só product-fail derruba o build (alerta de bug de estoque). infra-fail é
  // inconclusivo — sinalizado no relatório/alerta, mas não vira "bug".
  process.exit(productFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Runner fatal:", e);
  process.exit(2);
});
