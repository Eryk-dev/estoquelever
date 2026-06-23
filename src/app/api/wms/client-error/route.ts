import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { forwardErrorToDiscord } from "@/lib/discord-erros";

/**
 * Receives operator-facing errors from the browser (render crashes, uncaught
 * JS, API 5xx — see client-error-report.ts) and forwards them to Discord.
 *
 * Intentionally NOT auth-gated: the error may have happened precisely because
 * the session broke. We tag the operator when a valid session is present, but
 * never reject. Abuse is bounded by the client throttle + the Discord dedup.
 */

const schema = z.object({
  message: z.string().min(1).max(1000),
  stack: z.string().max(4000).nullish(),
  source: z.string().max(100).default("frontend"),
  url: z.string().max(500).nullish(),
  requestPath: z.string().max(500).nullish(),
  requestMethod: z.string().max(10).nullish(),
  status: z.number().int().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const data = parsed.data;

  let userName: string | null = null;
  try {
    const session = await getSessionUser(request);
    userName = session?.nome ?? null;
  } catch {
    userName = null;
  }

  forwardErrorToDiscord({
    source: data.source,
    message: data.message,
    severity: "error",
    origin: "frontend",
    stack: data.stack ?? null,
    url: data.url ?? null,
    userName,
    requestPath: data.requestPath ?? null,
    requestMethod: data.requestMethod ?? null,
    errorCode: data.status ? `HTTP_${data.status}` : null,
    metadata: data.metadata ?? undefined,
  });

  return NextResponse.json({ ok: true });
}
