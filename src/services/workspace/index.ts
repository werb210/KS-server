// KS_SERVER_v12_GOOGLE_WORKSPACE - provider abstraction: Microsoft 365 or Google Workspace, per staff member.
//
// Features ask for the user's workspace and call sendMail / createEvent / busyTimes / createTask /
// ensureClientFolder without caring which provider is behind it. Choice:
//   1. an explicit `prefer` when that provider is connected;
//   2. otherwise Microsoft 365 when connected (so every existing O365 path behaves exactly as before);
//   3. otherwise Google Workspace when connected;
//   4. otherwise null (the caller answers "not connected" as it always has).
// The company setting (licensee_settings.workspace_provider: m365 | google | both) decides which Connect buttons
// staff see; it does not disconnect anyone.
import type { Pool } from "pg";
import { getGraphForUser } from "../../modules/o365/graphClient.js";
import { getLicenseeSettings } from "../../licensee/settings.js";
import { getGoogleForUser, type Db, type GoogleClient } from "./googleAuth.js";
import * as G from "./google.js";
import * as M from "./o365.js";
import type { MimeMessageInput } from "./gmailMime.js";

export type WorkspaceProviderName = "o365" | "google";
export type CompanyWorkspaceMode = "m365" | "google" | "both";
export const WORKSPACE_MODES: readonly CompanyWorkspaceMode[] = ["m365", "google", "both"];

export function normalizeWorkspaceMode(v: unknown): CompanyWorkspaceMode {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "google" || s === "both" ? s : "m365";
}

export async function companyWorkspaceMode(db: Pool | Db): Promise<CompanyWorkspaceMode> {
  const s = await getLicenseeSettings(db as any);
  return normalizeWorkspaceMode((s as Record<string, string>).workspace_provider);
}

export type SendMailInput = MimeMessageInput & { threadId?: string | null };
export type EventInput = G.EventInput;
export type TaskInput = G.GoogleTaskInput;

export interface Workspace {
  provider: WorkspaceProviderName;
  email: string;
  sendMail(input: SendMailInput): Promise<{ id: string | null }>;
  listEvents(start: string, end: string): Promise<Array<Record<string, unknown>>>;
  createEvent(input: EventInput): Promise<{ id: string | null; joinUrl: string | null }>;
  updateEvent(id: string, patch: Partial<EventInput>): Promise<void>;
  cancelEvent(id: string): Promise<void>;
  busyTimes(from: Date, to: Date): Promise<Array<{ start: Date; end: Date }>>;
  createTask(t: TaskInput): Promise<string | null>;
  updateTask(id: string, t: TaskInput): Promise<void>;
  deleteTask(id: string): Promise<void>;
  ensureClientFolder(rootName: string, folderName: string): Promise<{ id: string; url: string | null }>;
}

export function googleWorkspace(g: GoogleClient): Workspace {
  return {
    provider: "google",
    email: g.email,
    sendMail: async (input) => G.sendGmail(g, input, { threadId: input.threadId ?? null }),
    listEvents: (start, end) => G.listGoogleEvents(g, start, end) as Promise<Array<Record<string, unknown>>>,
    createEvent: async (input) => { const r = await G.createGoogleEvent(g, input); return { id: r.id, joinUrl: r.joinUrl }; },
    updateEvent: async (id, patch) => { await G.updateGoogleEvent(g, id, patch); },
    cancelEvent: (id) => G.cancelGoogleEvent(g, id),
    busyTimes: (from, to) => G.googleBusyTimes(g, from, to),
    createTask: (t) => G.createGoogleTask(g, t),
    updateTask: (id, t) => G.updateGoogleTask(g, id, t),
    deleteTask: (id) => G.deleteGoogleTask(g, id),
    ensureClientFolder: (root, name) => G.ensureGoogleClientFolder(g, root, name),
  };
}

export async function getWorkspaceForUser(
  db: Pool,
  userId: string | null | undefined,
  opts: { prefer?: WorkspaceProviderName | null } = {},
): Promise<Workspace | null> {
  if (!userId) return null;
  const uid = String(userId);
  const tryGoogle = async () => { const g = await getGoogleForUser(db, uid); return g ? googleWorkspace(g) : null; };
  const tryO365 = async () => { const graph = await getGraphForUser(db, uid); return graph ? M.o365Workspace(graph) : null; };
  const order = opts.prefer === "google" ? [tryGoogle, tryO365] : [tryO365, tryGoogle];
  for (const attempt of order) {
    const ws = await attempt();
    if (ws) return ws;
  }
  return null;
}
