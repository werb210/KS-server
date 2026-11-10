// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
import { AzureBlobBackend } from "../lib/storage/azureBlob.js";
import { brokerageContainer } from "../lib/storage/containers.js"; // KS_SERVER_BROKERAGE_CONTAINERS_v1
// KS_SHARED_HOSTING_v1 - SIGNNOW_BLOB_CONTAINER is read when used (a brokerage's own value on the shared server), and
// one backend is kept per container and connection string.
const cached = new Map<string, AzureBlobBackend>();
function getBackend(): AzureBlobBackend | null {
  const container = brokerageContainer(process.env.SIGNNOW_BLOB_CONTAINER || "signed-applications");
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  const key = `${container}\n${conn}`;
  let b = cached.get(key);
  if (!b) { b = new AzureBlobBackend(container, conn); cached.set(key, b); }
  return b;
}
export async function downloadBlobAsset(blobName: string): Promise<Buffer | null> {
  const b = getBackend();
  if (!b) throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
  const got = await b.get(blobName);
  return got ? got.buffer : null;
}
export async function uploadSignedApplicationPdf(applicationId: string, buffer: Buffer): Promise<{ blobName: string; url: string; sizeBytes: number; hash: string }> {
  const b = getBackend();
  if (!b) throw new Error("AZURE_STORAGE_CONNECTION_STRING not configured");
  await b.ping().catch(() => {});
  const result = await b.put({ buffer, filename: `signed-application-${applicationId}.pdf`, contentType: "application/pdf", pathPrefix: applicationId });
  return { blobName: result.blobName, url: result.url, sizeBytes: result.sizeBytes, hash: result.hash };
}
