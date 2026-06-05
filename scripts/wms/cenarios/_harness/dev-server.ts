import { spawn, type ChildProcess } from "child_process";

export interface DevServerHandle {
  process: ChildProcess;
  port: number;
  kill: () => Promise<void>;
}

export async function buildProd(opts: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("npx", ["next", "build"], {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build saiu com código ${code}`))));
  });
}

export async function startDevServer(opts: { port: number; cwd?: string; prod?: boolean }): Promise<DevServerHandle> {
  const env = { ...process.env, PORT: String(opts.port), NODE_ENV: opts.prod ? "production" : "development" };
  const cmd = opts.prod
    ? ["next", "start", "-p", String(opts.port)]
    : ["next", "dev", "-p", String(opts.port)];
  const proc = spawn("npx", cmd, {
    cwd: opts.cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (chunk) => process.stderr.write(`[srv] ${chunk}`));
  proc.stderr?.on("data", (chunk) => process.stderr.write(`[srv:err] ${chunk}`));

  return {
    process: proc,
    port: opts.port,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 5_000);
      });
    },
  };
}

export async function isHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status > 0;
  } catch {
    return false;
  }
}

export async function waitForHealth(url: string, opts: { timeout_ms?: number } = {}): Promise<void> {
  const timeout = opts.timeout_ms ?? 30_000;
  const deadline = Date.now() + timeout;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      // Qualquer resposta HTTP (mesmo 401/404) significa servidor vivo
      if (res.status > 0) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForHealth: ${url} não respondeu em ${timeout}ms (último erro: ${lastErr})`);
}

export async function loginTestRunner(opts: { baseUrl: string; nome: string; pin: string }): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: opts.nome, pin: opts.pin }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`loginTestRunner: HTTP ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { sessionId?: string; sessao_id?: string; session_id?: string };
  const sessionId = data.sessionId ?? data.sessao_id ?? data.session_id;
  if (!sessionId) throw new Error(`loginTestRunner: response sem session id: ${JSON.stringify(data)}`);
  return sessionId;
}
