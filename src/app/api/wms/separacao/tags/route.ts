import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { logger } from "@/lib/logger";
import { getSessionUser } from "@/lib/session";

/**
 * GET /api/separacao/tags
 *
 * Returns all unique separacao_tags used across pedidos (for autocomplete).
 * Optionally scoped by galpao.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const isAdmin = session.cargos.includes("admin");
  const activeGalpaoId = session.galpaoId;

  try {
    // Fetch all non-null separacao_tags arrays from pedidos in separation
    let query = supabase
      .from("siso_pedidos")
      .select("separacao_tags")
      .not("status_separacao", "is", null)
      .not("separacao_tags", "eq", "{}");

    if (!isAdmin && activeGalpaoId) {
      query = query.eq("separacao_galpao_id", activeGalpaoId);
    }

    const { data, error } = await query;

    if (error) {
      logger.error("separacao-tags", "Failed to fetch tags", { error: error.message });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Flatten and deduplicate
    const tagSet = new Set<string>();
    for (const row of data ?? []) {
      for (const tag of row.separacao_tags ?? []) {
        if (tag) tagSet.add(tag);
      }
    }

    const tags = Array.from(tagSet).sort((a, b) => a.localeCompare(b, "pt-BR"));
    return NextResponse.json({ tags });
  } catch (err) {
    logger.error("separacao-tags", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}

/**
 * POST /api/separacao/tags
 *
 * Add or remove tags from pedidos.
 *
 * Body:
 *   pedido_ids: string[]   — target pedidos
 *   tags: string[]         — tags to add or remove
 *   action: "add" | "remove" | "set"
 *     - add: append tags (deduplicates)
 *     - remove: remove specified tags
 *     - set: replace all tags with the given list
 */
export async function POST(request: NextRequest) {
  const session = await getSessionUser(request);
  if (!session) {
    return NextResponse.json({ error: "sessao_invalida" }, { status: 401 });
  }

  let body: { pedido_ids?: string[]; tags?: string[]; action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const { pedido_ids, tags, action } = body;

  if (!Array.isArray(pedido_ids) || pedido_ids.length === 0) {
    return NextResponse.json({ error: "pedido_ids obrigatório" }, { status: 400 });
  }
  if (!Array.isArray(tags)) {
    return NextResponse.json({ error: "tags obrigatório (array)" }, { status: 400 });
  }
  if (!action || !["add", "remove", "set"].includes(action)) {
    return NextResponse.json({ error: "action deve ser add, remove ou set" }, { status: 400 });
  }

  // Sanitize tags: trim, lowercase, remove empty
  const cleanTags = tags
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 50);

  const supabase = createServiceClient();

  try {
    if (action === "set") {
      // Replace all tags
      const { error } = await supabase
        .from("siso_pedidos")
        .update({ separacao_tags: cleanTags })
        .in("id", pedido_ids);

      if (error) {
        logger.error("separacao-tags", "Failed to set tags", { error: error.message });
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, action: "set", tags: cleanTags, total: pedido_ids.length });
    }

    // For add/remove, we need to read current tags first, then update
    const { data: pedidos, error: fetchError } = await supabase
      .from("siso_pedidos")
      .select("id, separacao_tags")
      .in("id", pedido_ids);

    if (fetchError) {
      logger.error("separacao-tags", "Failed to fetch pedidos", { error: fetchError.message });
      return NextResponse.json({ error: fetchError.message }, { status: 500 });
    }

    let updated = 0;

    for (const pedido of pedidos ?? []) {
      const current: string[] = pedido.separacao_tags ?? [];
      let next: string[];

      if (action === "add") {
        const currentSet = new Set(current);
        for (const tag of cleanTags) currentSet.add(tag);
        next = Array.from(currentSet);
      } else {
        // remove
        const removeSet = new Set(cleanTags);
        next = current.filter((t) => !removeSet.has(t));
      }

      // Skip if no change
      if (next.length === current.length && next.every((t, i) => t === current[i])) {
        continue;
      }

      const { error: updateError } = await supabase
        .from("siso_pedidos")
        .update({ separacao_tags: next })
        .eq("id", pedido.id);

      if (updateError) {
        logger.error("separacao-tags", `Failed to update tags for pedido ${pedido.id}`, {
          error: updateError.message,
        });
      } else {
        updated++;
      }
    }

    return NextResponse.json({ ok: true, action, tags: cleanTags, total: updated });
  } catch (err) {
    logger.error("separacao-tags", "Unexpected error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Erro interno" }, { status: 500 });
  }
}
