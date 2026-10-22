// KS_SERVER_v8_CONNECTIONS - the licensee's own accounts, synchronously: the saved licensee setting (loaded at startup
// and every minute by startBrandRefresh, and on save), else the App Service setting.
import { lastLoadedConnections } from "./settings.js";

/** The main business line: licensee setting twilio_main_number, else TWILIO_MAIN_LINE_NUMBER. Raw text. */
export function mainLineNumberSetting(env: NodeJS.ProcessEnv = process.env): string {
  return lastLoadedConnections()?.twilio_main_number || String(env.TWILIO_MAIN_LINE_NUMBER ?? "").trim();
}

/** The Google Ads customer id: licensee setting google_ads_customer_id, else GOOGLE_ADS_CUSTOMER_ID. Raw text. */
export function googleAdsCustomerIdSetting(env: NodeJS.ProcessEnv = process.env): string {
  return lastLoadedConnections()?.google_ads_customer_id || String(env.GOOGLE_ADS_CUSTOMER_ID ?? "").trim();
}

/** The Office 365 tenant: licensee setting office365_tenant_id, else MS_GRAPH_TENANT_ID. */
export function office365TenantSetting(env: NodeJS.ProcessEnv = process.env): string {
  return lastLoadedConnections()?.office365_tenant_id || String(env.MS_GRAPH_TENANT_ID ?? "").trim();
}
