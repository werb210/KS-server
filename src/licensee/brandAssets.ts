// KS_SERVER_BRAND_ASSETS_v1 - an Admin uploads the brokerage's logo or favicon instead of pasting a web address.
// The file goes to the public "brand-assets" container (one folder per brokerage) and its https address is saved as
// logo_url / favicon_url, so every app, email and PDF that already reads those picks it up.
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { currentTenantCode } from "../tenancy/context.js";

export type BrandAssetKind = "logo" | "favicon";
export const BRAND_ASSET_MAX_BYTES = 2 * 1024 * 1024;

const TYPES: Record<string, { ext: string; kinds: BrandAssetKind[] }> = {
  "image/png": { ext: ".png", kinds: ["logo", "favicon"] },
  "image/jpeg": { ext: ".jpg", kinds: ["logo"] },
  "image/webp": { ext: ".webp", kinds: ["logo"] },
  "image/svg+xml": { ext: ".svg", kinds: ["logo", "favicon"] },
  "image/x-icon": { ext: ".ico", kinds: ["favicon"] },
  "image/vnd.microsoft.icon": { ext: ".ico", kinds: ["favicon"] },
};

export function checkBrandAsset(kind: string, mime: string, size: number): { ok: true; ext: string } | { ok: false; error: string } {
  if (kind !== "logo" && kind !== "favicon") return { ok: false, error: "kind must be logo or favicon" };
  const t = TYPES[String(mime).toLowerCase()];
  if (!t || !t.kinds.includes(kind)) {
    return { ok: false, error: kind === "logo" ? "Use a PNG, JPG, WebP or SVG image." : "Use a PNG, SVG or ICO image (a square PNG of 512 x 512 works best)." };
  }
  if (size <= 0) return { ok: false, error: "The file is empty." };
  if (size > BRAND_ASSET_MAX_BYTES) return { ok: false, error: "The file is larger than 2 MB." };
  return { ok: true, ext: t.ext };
}

export type BlobUploader = (path: string, buf: Buffer, contentType: string) => Promise<string>;

export const azureUploader: BlobUploader = async (path, buf, contentType) => {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) throw Object.assign(new Error("storage_not_configured"), { code: "storage_not_configured" });
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(process.env.KS_BRAND_ASSET_CONTAINER || "brand-assets");
  await container.createIfNotExists({ access: "blob" });
  const blob = container.getBlockBlobClient(path);
  await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "public, max-age=31536000, immutable" } });
  return blob.url;
};

/** Stores the file; returns its public https address. */
export async function storeBrandAsset(kind: BrandAssetKind, buf: Buffer, mime: string, upload: BlobUploader = azureUploader): Promise<string> {
  const checked = checkBrandAsset(kind, mime, buf.length);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { code: "invalid_file" });
  const folder = (currentTenantCode() ?? "brokerage").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "brokerage";
  return upload(`${folder}/${kind}-${randomUUID()}${checked.ext}`, buf, String(mime).toLowerCase());
}
