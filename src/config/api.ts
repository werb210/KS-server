import { serverUrl } from "../licensee/urls.js"; // KS_SERVER_v1_LICENSEE
export const API_BASE =
  process.env.PUBLIC_BASE_URL ||
  process.env.SERVER_URL ||
  serverUrl();

/** KS_SHARED_HOSTING_v1 - the same address, read now (on the shared server it is the current brokerage's). */
export function apiBase(): string {
  return process.env.PUBLIC_BASE_URL || process.env.SERVER_URL || serverUrl();
}
