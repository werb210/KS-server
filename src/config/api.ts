import { serverUrl } from "../licensee/urls.js"; // KS_SERVER_v1_LICENSEE
export const API_BASE =
  process.env.PUBLIC_BASE_URL ||
  process.env.SERVER_URL ||
  serverUrl();
