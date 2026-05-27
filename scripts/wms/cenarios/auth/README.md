# P4 auth-matrix tests

Each per-endpoint test file calls `runAuthMatrix` with 3+ cases:
 - no session (sessão `null`) → expected 401
 - session with wrong perm → expected 403
 - session with right perm → expected 200 (or 400/404 if body lacks data; the assertion is "NOT 401/403")

Run a single file: `npx tsx scripts/wms/cenarios/auth/NN-<endpoint>.ts`
Run all: `npx tsx scripts/wms/cenarios/auth/run-all-auth.ts`

Requires: dev server on :3001 + seeded users (seedInicial calls seedTestUsers).
