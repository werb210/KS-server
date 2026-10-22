#!/usr/bin/env node
// KS_SERVER_v4_BRANDING - no Boreal branding in text this server sends.
//
// KS-server is a licensed copy of Boreal Financial's server. Every text, email, PDF, push notification and AI
// prompt now names the licensee (src/licensee/brand.ts). This check fails when a string literal under src/
// (outside tests) mentions Boreal again: "Boreal", a boreal.financial / boreal.insure address, Boreal's numbered
// company or its street. Comments, identifiers and column names are not string literals, so they are not checked.
// The few literals that must stay (identifiers sent between Boreal-built apps, domain filters) are in ALLOW.
//
//   node scripts/check-brand-strings.mjs          check (exit 1 on a hit)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const BRAND_RE = /Boreal|BOREAL|boreal\.(?:financial|insure)|2630108|Sparling/;

// file (relative to the repo, forward slashes) -> substrings of literals that are allowed to stay.
export const ALLOW = {
  // custom mail header used to recognise mail this server already logged; never shown
  "src/modules/o365/sentItemsLog.ts": ["X-Boreal-Logged"],
  // env var name (BOREAL_SUPPORT_PHONE), not text
  "src/services/accountantInvite.ts": ["BOREAL_SUPPORT_PHONE"],
  // staff-domain filters (behaviour, not text) - see the PR notes
  "src/services/clientBooking.ts": ["%@boreal.financial", "andrew@boreal.financial,andrew.p@boreal.financial"],
  "src/routes/marketing.ts": ["%boreal.financial", "%boreal.insure"],
  // placeholder addresses of the two seeded admin accounts (internal, never mailed)
  "src/db/seed.ts": ["seeded-admin@boreal.financial", "seeded-admin-2@boreal.financial"],
  // header name the Boreal-built mobile apps send
  "src/routes/voiceCalls.ts": ["X-Boreal-App"],
  // notification category identifier the Boreal-built mobile apps register
  "src/services/push/pushCategories.ts": ["BOREAL_NOTIFICATION_CLICK"],
  // KS_SERVER_v6_PLANS - default inbox for upgrade requests to the software vendor (KS_SALES_EMAIL overrides it)
  "src/plans/email.ts": ["keystone@boreal.financial"],
};

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

/** The string-literal contents in TypeScript source: quoted strings and template-literal text (via the compiler). */
export function stringLiterals(src) {
  const out = [];
  const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        // An import/export path or a property name in quotes is not text.
        if (node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent))) break;
        out.push(node.text);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The literals in one file's source that mention Boreal and are not allowed. */
export function brandHits(src, allowed = []) {
  return stringLiterals(src).filter((s) => BRAND_RE.test(s) && !allowed.some((a) => s.includes(a)));
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}

/** Every disallowed literal under <root>/src, as { file, literal }. */
export function scanRepo(root) {
  const hits = [];
  for (const f of walk(path.join(root, "src"), [])) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (TEST_FILE.test(rel)) continue;
    for (const literal of brandHits(fs.readFileSync(f, "utf8"), ALLOW[rel] ?? [])) hits.push({ file: rel, literal });
  }
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = scanRepo(process.cwd());
  if (hits.length) {
    console.error(`::error::${hits.length} string literal(s) in src/ still mention Boreal. Use src/licensee/brand.ts (brandName(), legalName(), assistantName(), supportEmail()) instead:`);
    for (const h of hits) console.error(`  ${h.file}: ${JSON.stringify(h.literal.slice(0, 160))}`);
    process.exit(1);
  }
  console.log("No Boreal branding in src/ string literals. OK.");
}
