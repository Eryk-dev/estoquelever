import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Server-side Supabase client using service role key (bypasses RLS).
 * Used in API routes only.
 *
 * Memoized at module scope: the service-role client is stateless (PostgREST
 * over HTTP, no persistent connection to lose), so a single instance is safely
 * reused across all requests served by a warm serverless instance — avoiding
 * the repeated client construction this function was doing on every call.
 */
export function createServiceClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  _client = createClient(url, key);
  return _client;
}
