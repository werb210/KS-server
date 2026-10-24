// KS_SERVER_v14_DATA_IMPORT - the import jobs' file store (the copy's blob storage) and audit log.
import { getStorage } from "../lib/storage/index.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import type { FileStore, JobDeps } from "./engine.js";

export function importFileStore(): FileStore {
  return {
    get: async (key) => (await getStorage().get(key))?.buffer ?? null,
    put: (p) => getStorage().put(p),
    delete: (key) => getStorage().delete(key),
  };
}

export function importJobDeps(): JobDeps {
  return {
    files: importFileStore(),
    audit: async ({ actorUserId, action, batchId, metadata }) => {
      await recordAuditEvent({
        actorUserId, targetUserId: null, targetType: "import_batch", targetId: batchId, action,
        eventType: "data_import", eventAction: action, success: true, metadata,
      });
    },
  };
}
