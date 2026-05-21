import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase-server";
import { getSessionUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
];

/**
 * POST /api/wms/admin/usuarios/foto
 *
 * Body: multipart/form-data
 *   - id: uuid do usuário alvo
 *   - file: arquivo de imagem (PNG/JPEG/WebP/GIF, ≤ 2MB)
 *
 * Auth: usuário logado pode trocar a foto dele mesmo; admin pode trocar
 * de qualquer um.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ erro: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ erro: "form-data inválido" }, { status: 400 });
  }

  const id = form.get("id");
  const file = form.get("file");

  if (typeof id !== "string" || !id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ erro: "file é obrigatório" }, { status: 400 });
  }

  const podeGerenciarOutros = userCan(user, "sistema.usuarios");
  if (!podeGerenciarOutros && user.id !== id) {
    return NextResponse.json(
      { erro: "só admin pode trocar foto de outro usuário" },
      { status: 403 },
    );
  }

  if (!ALLOWED_MIME.includes(file.type)) {
    return NextResponse.json(
      { erro: `formato inválido: ${file.type}. Use PNG, JPEG, WebP ou GIF.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { erro: "arquivo maior que 2MB" },
      { status: 400 },
    );
  }

  const sb = createServiceClient();

  // Path com hash do timestamp pra forçar cache-bust no <img> sem
  // precisar de query string. Sobrescreve o anterior (upsert).
  const ext = file.type.split("/")[1].replace("jpeg", "jpg");
  const path = `${id}/avatar-${Date.now()}.${ext}`;

  const arrayBuffer = await file.arrayBuffer();
  const { error: uploadError } = await sb.storage
    .from("avatars")
    .upload(path, arrayBuffer, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json(
      { erro: `falha no upload: ${uploadError.message}` },
      { status: 500 },
    );
  }

  // URL pública (bucket é public)
  const { data: pub } = sb.storage.from("avatars").getPublicUrl(path);
  const foto_url = pub.publicUrl;

  // Limpa fotos antigas do mesmo usuário (mantém só a atual).
  const { data: antigas } = await sb.storage.from("avatars").list(id, {
    limit: 100,
  });
  if (antigas && antigas.length > 0) {
    const aRemover = antigas
      .map((f) => `${id}/${f.name}`)
      .filter((p) => p !== path);
    if (aRemover.length > 0) {
      await sb.storage.from("avatars").remove(aRemover);
    }
  }

  const { error: updateError } = await sb
    .from("siso_usuarios")
    .update({ foto_url, atualizado_em: new Date().toISOString() })
    .eq("id", id);

  if (updateError) {
    return NextResponse.json(
      { erro: `falha ao salvar URL: ${updateError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, foto_url });
}

/**
 * DELETE /api/wms/admin/usuarios/foto?id=<uuid>
 * Remove a foto (volta pra iniciais).
 */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ erro: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ erro: "id é obrigatório" }, { status: 400 });
  }
  const podeGerenciarOutros = userCan(user, "sistema.usuarios");
  if (!podeGerenciarOutros && user.id !== id) {
    return NextResponse.json(
      { erro: "só admin pode remover foto de outro usuário" },
      { status: 403 },
    );
  }

  const sb = createServiceClient();

  const { data: antigas } = await sb.storage.from("avatars").list(id, { limit: 100 });
  if (antigas && antigas.length > 0) {
    await sb.storage.from("avatars").remove(antigas.map((f) => `${id}/${f.name}`));
  }

  const { error } = await sb
    .from("siso_usuarios")
    .update({ foto_url: null, atualizado_em: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ erro: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
