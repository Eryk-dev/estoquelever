/**
 * ML stub layer (staging-only).
 *
 * Quando ML_DISABLED=true, ml-api.ts roteia chamadas pra cá. Returns
 * determinísticos por endpoint pra não exigir conta ML em testes.
 */

export function isMlDisabled(): boolean {
  return process.env.ML_DISABLED === "true";
}

export async function getMlUserMeStub(connectionId: string) {
  return {
    id: 999_999,
    nickname: `stub-user-${connectionId.slice(0, 6)}`,
    email: "stub@ml.local",
    country_id: "BR",
  };
}

export async function searchSellerItemsBySkuStub(_sku: string) {
  return { results: [], total: 0 };
}

export async function searchAndMatchItemsBySkuStub(_sku: string) {
  return [];
}

export async function getMlItemsDetailsStub(_ids: string[]) {
  return [];
}

export async function testarMlConnectionStub() {
  return { ok: true as const, user_id: 999_999, nickname: "stub-user" };
}
