// BF_AZURE_OCR_TERMSHEET_v44 — storage factory
// KS_SERVER_BROKERAGE_CONTAINERS_v1 - on the shared server each brokerage gets its own documents container
// ("<code>-documents"), created on first use; a single-brokerage server keeps one backend as before.
import path from "node:path";
import { AzureBlobBackend } from "./azureBlob.js";
import { LocalBackend } from "./local.js";
import { brokerageContainer } from "./containers.js";
import type { StorageBackend } from "./types.js";

const _byContainer = new Map<string, StorageBackend>();

export function documentsContainer(): string {
  const configured = process.env.AZURE_STORAGE_CONTAINER_BF;
  return brokerageContainer(configured || "bf-documents", configured ? undefined : "documents");
}

export function getStorage(): StorageBackend {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const container = documentsContainer();
  const key = conn ? `azure\n${container}\n${conn}` : `local\n${container}`;
  const hit = _byContainer.get(key);
  if (hit) return hit;
  let backend: StorageBackend;
  if (conn) {
    backend = new AzureBlobBackend(container, conn);
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[STORAGE] AZURE_STORAGE_CONNECTION_STRING is required in production");
    }
    backend = new LocalBackend(path.join(process.cwd(), "uploads", "bf"));
  }
  _byContainer.set(key, backend);
  return backend;
}

export function __resetStorageForTests() { _byContainer.clear(); }
export type { StorageBackend, PutResult } from "./types.js";
