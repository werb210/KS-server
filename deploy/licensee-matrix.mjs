#!/usr/bin/env node
// KS_LICENSEE_DEPLOY_v1 - which Keystone licensees a deploy workflow deploys to.
//
// Reads deploy/licensees.json (the committed, non-secret registry; the same file is kept in KS-server, KS-Agent,
// KS-Portal and KS-Client) and prints the licensees that get <app>:
//
//   node deploy/licensee-matrix.mjs <server|agent|portal|client> [code]   the deploy plan (GitHub matrix)
//   node deploy/licensee-matrix.mjs --check                              validate the registry only
//
// With [code] only that licensee is returned; it must be in the registry, enabled, and list <app>.
// Inside GitHub Actions it writes `matrix` ({"include":[{code, environment}, ...]}) and `count` to $GITHUB_OUTPUT.
// Each licensee's settings live in its GitHub environment (normally `ks-<code>`), never in this file.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPS = ["server", "agent", "portal", "client"];
// Same rule as KS-Ops scripts/provision-licensee.sh: 3-32 lowercase letters, numbers or single hyphens.
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const ENV_RE = /^[A-Za-z0-9_.-]{1,255}$/;

/** The registry's licensees, normalised, or throws with every problem found. */
export function parseRegistry(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`deploy/licensees.json is not valid JSON: ${err.message}`);
  }
  const list = data && Array.isArray(data.licensees) ? data.licensees : null;
  if (!list) throw new Error('deploy/licensees.json must be an object with a "licensees" array');
  const errors = [];
  const seen = new Set();
  const out = [];
  list.forEach((entry, i) => {
    const at = `licensees[${i}]`;
    if (!entry || typeof entry !== "object") return errors.push(`${at} must be an object`);
    const code = String(entry.code ?? "");
    if (!CODE_RE.test(code) || code.includes("--")) errors.push(`${at}.code "${code}" must be 3-32 lowercase letters, numbers or single hyphens`);
    if (seen.has(code)) errors.push(`${at}.code "${code}" is listed twice`);
    seen.add(code);
    const environment = entry.environment === undefined ? `ks-${code}` : String(entry.environment);
    if (!ENV_RE.test(environment)) errors.push(`${at}.environment "${environment}" is not a valid GitHub environment name`);
    if (typeof entry.enabled !== "boolean") errors.push(`${at}.enabled must be true or false`);
    const apps = entry.apps === undefined ? APPS : entry.apps;
    if (!Array.isArray(apps) || apps.some((a) => !APPS.includes(a))) errors.push(`${at}.apps must list only ${APPS.join(", ")}`);
    out.push({ code, environment, enabled: entry.enabled === true, apps: Array.isArray(apps) ? apps : [] });
  });
  if (errors.length) throw new Error(`deploy/licensees.json:\n  - ${errors.join("\n  - ")}`);
  return out;
}

/** The licensees to deploy <app> to; `wanted` (a code) narrows it to one, and must then be deployable. */
export function plan(licensees, app, wanted = "") {
  if (!APPS.includes(app)) throw new Error(`Unknown app "${app}" (expected ${APPS.join(", ")})`);
  const code = String(wanted ?? "").trim();
  if (code) {
    const hit = licensees.find((l) => l.code === code);
    if (!hit) throw new Error(`Licensee "${code}" is not in deploy/licensees.json (known: ${licensees.map((l) => l.code).join(", ") || "none"})`);
    if (!hit.enabled) throw new Error(`Licensee "${code}" is disabled in deploy/licensees.json`);
    if (!hit.apps.includes(app)) throw new Error(`Licensee "${code}" does not list "${app}" in its apps`);
    return [{ code: hit.code, environment: hit.environment }];
  }
  return licensees.filter((l) => l.enabled && l.apps.includes(app)).map((l) => ({ code: l.code, environment: l.environment }));
}

function main(argv) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "licensees.json");
  const licensees = parseRegistry(readFileSync(file, "utf8"));
  if (argv[0] === "--check") {
    console.log(`deploy/licensees.json: ${licensees.length} licensee(s), ${licensees.filter((l) => l.enabled).length} enabled`);
    return;
  }
  const include = plan(licensees, argv[0], argv[1]);
  const matrix = JSON.stringify({ include });
  console.log(include.length ? `Deploying ${argv[0]} to: ${include.map((l) => `${l.code} (environment ${l.environment})`).join(", ")}` : `No licensees get ${argv[0]}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\ncount=${include.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${String(err.message).replace(/\n/g, "%0A")}`);
    process.exit(1);
  }
}
