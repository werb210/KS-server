// KS_SERVER_BROKERAGE_CONTAINERS_v1 - each brokerage on the shared server keeps its files in its own blob containers.
//
// Before this, every brokerage on the shared server wrote to the same container names ("bf-documents",
// "voicemails", ...) and those containers were never created, so every upload failed with "The specified container
// does not exist" - and a cancelled brokerage's purge would have emptied everyone's files. Now, inside a brokerage's
// request or job on the shared server, a container name is prefixed with the brokerage's code ("kt1-documents"), and
// it is created the first time it is used. A single-brokerage server (the demo, CI, tests) keeps its exact names.
import { currentTenantCode } from "../../tenancy/context.js";
import { isMultiBrokerage } from "../../tenancy/mode.js";

/** Azure container names: 3-63 characters, lowercase letters, digits and single hyphens, starting and ending alnum. */
export function safeContainerName(name: string): string {
  const s = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return s.length >= 3 ? s : `ks-${s}`.slice(0, 63);
}

/**
 * The container to use for `base` right now. `sharedBase` is the name used on the shared server when no setting
 * overrides it (e.g. "documents" instead of the single-server "bf-documents").
 */
export function brokerageContainer(base: string, sharedBase?: string): string {
  const code = isMultiBrokerage() ? currentTenantCode() : null;
  if (!code) return base;
  return safeContainerName(`${code}-${sharedBase ?? base}`);
}

/** For callers that build their own Azure client: create the container once per process, then remember it. */
const ensured = new Set<string>();
export async function ensureContainer(client: { createIfNotExists: (o?: any) => Promise<unknown> }, name: string, opts?: { access?: "blob" }): Promise<void> {
  if (ensured.has(name)) return;
  await client.createIfNotExists(opts?.access ? { access: opts.access } : undefined);
  ensured.add(name);
}
export function __resetEnsuredForTests() { ensured.clear(); }
