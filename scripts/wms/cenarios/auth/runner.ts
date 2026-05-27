import { loginTestUser, TEST_USERS } from "../_harness/seed-test-users";

export type AuthCase = {
  label: string;
  user: "admin-runner" | "op-runner" | "vendor-runner" | "buyer-runner" | null; // null = no session
  expectedStatus: number;
};

export interface AuthMatrixTest {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  bodyFor?: (user: string | null) => unknown; // if body depends on caller
  extraHeaders?: Record<string, string>;
  cases: AuthCase[];
}

export interface AuthMatrixResult {
  name: string;
  pass: boolean;
  details: Array<{ label: string; expected: number; got: number; bodySnippet: string }>;
}

export async function runAuthMatrix(opts: {
  baseUrl: string;
  tests: AuthMatrixTest[];
}): Promise<AuthMatrixResult[]> {
  // Resolve sessionIds once per user
  const sessionByUser: Record<string, string> = {};
  for (const u of TEST_USERS) {
    sessionByUser[u.nome] = await loginTestUser({ baseUrl: opts.baseUrl, nome: u.nome });
  }

  const results: AuthMatrixResult[] = [];
  for (const t of opts.tests) {
    const details: AuthMatrixResult["details"] = [];
    for (const c of t.cases) {
      const headers: Record<string, string> = { ...(t.extraHeaders ?? {}) };
      if (c.user) headers["X-Session-Id"] = sessionByUser[c.user];
      const body = t.bodyFor ? t.bodyFor(c.user) : t.body;
      if (body !== undefined) headers["Content-Type"] = "application/json";

      const res = await fetch(`${opts.baseUrl}${t.path}`, {
        method: t.method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      details.push({
        label: c.label,
        expected: c.expectedStatus,
        got: res.status,
        bodySnippet: text.slice(0, 160),
      });
    }
    const pass = details.every((d) => d.expected === d.got);
    results.push({ name: t.name, pass, details });
  }
  return results;
}

export function printAuthMatrixReport(results: AuthMatrixResult[]): boolean {
  let allPass = true;
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(`[${tag}] ${r.name}`);
    for (const d of r.details) {
      const ok = d.expected === d.got ? "  ok " : "  X  ";
      console.log(`${ok} ${d.label}: expected ${d.expected}, got ${d.got}${d.expected !== d.got ? ` body=${d.bodySnippet}` : ""}`);
    }
    if (!r.pass) allPass = false;
  }
  return allPass;
}
