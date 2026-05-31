import { describe, it, expect, beforeEach } from "vitest";
import {
  sessionCacheKey,
  getCachedSession,
  setCachedSession,
  clearSessionCache,
  type SessionUser,
} from "./session";

function makeUser(galpaoId: string | null = null): SessionUser {
  return {
    id: "u1",
    nome: "Eryk",
    cargo: "admin",
    cargos: ["admin"],
    roles: [{ id: "r1", codigo: "admin", nome: "Admin" }],
    permissoes: new Set(["sistema.usuarios"]),
    galpaoId,
  };
}

describe("session cache", () => {
  beforeEach(() => clearSessionCache());

  it("a chave inclui sessionId + header de galpão", () => {
    expect(sessionCacheKey("s1", "g1")).toBe("s1|g1");
    expect(sessionCacheKey("s1", null)).toBe("s1|");
    // galpões diferentes → chaves diferentes (galpão resolvido depende do header)
    expect(sessionCacheKey("s1", "g1")).not.toBe(sessionCacheKey("s1", "g2"));
  });

  it("set seguido de get dentro do TTL retorna o mesmo usuário", () => {
    const key = sessionCacheKey("s1", "g1");
    const user = makeUser("g1");
    const now = 1_000_000;
    setCachedSession(key, user, now);
    expect(getCachedSession(key, now + 10_000)).toBe(user); // <30s → hit
  });

  it("get após o TTL retorna null e remove a entrada (miss)", () => {
    const key = sessionCacheKey("s1", "g1");
    const now = 1_000_000;
    setCachedSession(key, makeUser("g1"), now);
    expect(getCachedSession(key, now + 30_001)).toBeNull(); // >30s → expirou
    // segunda leitura confirma que foi removida (não só expirada)
    expect(getCachedSession(key, now)).toBeNull();
  });

  it("galpão diferente é cache miss (chave distinta)", () => {
    const now = 1_000_000;
    setCachedSession(sessionCacheKey("s1", "g1"), makeUser("g1"), now);
    expect(getCachedSession(sessionCacheKey("s1", "g2"), now)).toBeNull();
  });

  it("clearSessionCache(sessionId) remove todas as entradas daquela sessão", () => {
    const now = 1_000_000;
    setCachedSession(sessionCacheKey("s1", "g1"), makeUser("g1"), now);
    setCachedSession(sessionCacheKey("s1", "g2"), makeUser("g2"), now);
    setCachedSession(sessionCacheKey("s2", "g1"), makeUser("g1"), now);

    clearSessionCache("s1");

    expect(getCachedSession(sessionCacheKey("s1", "g1"), now)).toBeNull();
    expect(getCachedSession(sessionCacheKey("s1", "g2"), now)).toBeNull();
    // outra sessão permanece
    expect(getCachedSession(sessionCacheKey("s2", "g1"), now)).not.toBeNull();
  });

  it("clearSessionCache() sem argumento limpa tudo", () => {
    const now = 1_000_000;
    setCachedSession(sessionCacheKey("s1", "g1"), makeUser("g1"), now);
    setCachedSession(sessionCacheKey("s2", "g1"), makeUser("g1"), now);
    clearSessionCache();
    expect(getCachedSession(sessionCacheKey("s1", "g1"), now)).toBeNull();
    expect(getCachedSession(sessionCacheKey("s2", "g1"), now)).toBeNull();
  });
});
