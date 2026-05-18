import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { buildAuthorizeUrl } from "@/lib/tiny-oauth";

/**
 * GET /api/tiny/oauth?connectionId=xxx
 *
 * Starts the OAuth2 Authorization Code flow.
 * Redirects the user to Tiny's authorization page.
 */
export async function GET(request: NextRequest) {
  const connectionId = request.nextUrl.searchParams.get("connectionId");
  if (!connectionId) {
    return NextResponse.json(
      { error: "Missing connectionId" },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();
  const { data: conn } = await supabase
    .from("siso_tiny_connections")
    .select("id, client_id, client_secret")
    .eq("id", connectionId)
    .single();

  if (!conn) {
    return NextResponse.json(
      { error: "Connection not found" },
      { status: 404 },
    );
  }

  if (!conn.client_id || !conn.client_secret) {
    return NextResponse.json(
      { error: "Configure Client ID e Client Secret primeiro" },
      { status: 400 },
    );
  }

  // Generate CSRF state
  const state = `${connectionId}:${crypto.randomUUID()}`;

  // Save state to DB for validation on callback
  await supabase
    .from("siso_tiny_connections")
    .update({ oauth_state: state })
    .eq("id", connectionId);

  // Build redirect URL — use X-Forwarded headers from reverse proxy
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const origin = `${forwardedProto}://${forwardedHost}`;
  const redirectUri = `${origin}/api/tiny/oauth/callback`;

  const authorizeUrl = buildAuthorizeUrl({
    clientId: conn.client_id,
    redirectUri,
    state,
  });

  return NextResponse.redirect(authorizeUrl);
}
