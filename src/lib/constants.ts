/** Refresh interval for list/overview pages (SISO dashboard, Separacao, Compras).
 *  30s balances freshness with API load at ~500 orders/day. */
export const REFRESH_INTERVAL_LIST = 30_000;

/** Refresh interval for active workflow pages (Checklist, Embalagem).
 *  10s keeps the UI responsive during hands-on scan/pick operations. */
export const REFRESH_INTERVAL_ACTIVE = 10_000;

/** Refresh interval for monitoring dashboard.
 *  30s — same as list pages; monitoring data changes slowly. */
export const REFRESH_INTERVAL_MONITORING = 30_000;
