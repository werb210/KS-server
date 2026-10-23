// KS_SERVER_v12_GOOGLE_WORKSPACE - the Microsoft 365 side of the workspace abstraction (services/workspace/index.ts).
// The established O365 routes keep their own Graph code unchanged; this adapter gives new features one interface
// over both providers, using the same Graph calls those routes make.
import type { GraphClient } from "../../modules/o365/graphClient.js";
import type { EventInput, Workspace } from "./index.js";
import type { GoogleTaskInput } from "./google.js";

async function graphCall(graph: GraphClient, path: string, init: RequestInit = {}): Promise<any> {
  const r = await graph.fetch(path, init);
  if (!r.ok) throw new Error(`graph_${r.status} ${path.split("?")[0]} ${(await r.text().catch(() => "")).slice(0, 200)}`); // swallow-ok: not a query
  if (r.status === 204) return null;
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/** Graph event body; meet=true -> a Teams meeting, as /api/crm meetings create today. */
export function graphEventBody(input: EventInput): Record<string, unknown> {
  const attendees = (input.attendees ?? []).map((a) => (typeof a === "string" ? { address: a } : { address: a.email, name: a.name ?? a.email, optional: a.optional }))
    .filter((a) => String(a.address ?? "").includes("@"))
    .map((a: any) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) }, type: a.optional ? "optional" : "required" }));
  return {
    subject: input.title,
    start: { dateTime: new Date(input.start).toISOString(), timeZone: "UTC" },
    end: { dateTime: new Date(input.end).toISOString(), timeZone: "UTC" },
    ...(input.notes ? { body: { contentType: "text", content: input.notes } } : {}),
    ...(input.location ? { location: { displayName: input.location } } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(typeof input.reminderMinutes === "number" ? { reminderMinutesBeforeStart: input.reminderMinutes } : {}),
    ...(input.meet ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
  };
}

function todoBody(t: GoogleTaskInput): Record<string, unknown> {
  return {
    title: t.title,
    body: { content: String(t.notes ?? ""), contentType: "text" },
    status: t.completed ? "completed" : "notStarted",
    dueDateTime: t.due ? { dateTime: new Date(t.due).toISOString(), timeZone: "UTC" } : null,
  };
}

async function defaultTodoList(graph: GraphClient): Promise<string> {
  const lists = await graphCall(graph, "/me/todo/lists?$top=50");
  const all: Array<{ id?: string; wellknownListName?: string }> = lists?.value ?? [];
  const id = (all.find((l) => l.wellknownListName === "defaultList") ?? all[0])?.id;
  if (!id) throw new Error("graph_no_todo_list");
  return id;
}

export function o365Workspace(graph: GraphClient): Workspace {
  let me: string | null = null;
  return {
    provider: "o365",
    get email() { return me ?? ""; },
    sendMail: async (input) => {
      const recips = (xs?: string[]) => (xs ?? []).map((address) => ({ emailAddress: { address } }));
      const message = {
        subject: input.subject,
        body: { contentType: "HTML", content: input.html },
        toRecipients: recips(input.to),
        ccRecipients: recips(input.cc),
        bccRecipients: recips(input.bcc),
        attachments: (input.attachments ?? []).map((a) => ({
          "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType || "application/octet-stream",
          contentBytes: a.contentBytes, ...(a.isInline && a.contentId ? { isInline: true, contentId: a.contentId } : {}),
        })),
      };
      await graphCall(graph, "/me/sendMail", { method: "POST", body: JSON.stringify({ message, saveToSentItems: true }) });
      return { id: null };
    },
    listEvents: async (start, end) => {
      const d = await graphCall(graph, `/me/calendarView?startDateTime=${new Date(start).toISOString()}&endDateTime=${new Date(end).toISOString()}&$top=200&$orderby=start/dateTime`);
      return (d?.value ?? []) as Array<Record<string, unknown>>;
    },
    createEvent: async (input) => {
      const ev = await graphCall(graph, "/me/events", { method: "POST", body: JSON.stringify(graphEventBody(input)) });
      return { id: ev?.id ?? null, joinUrl: ev?.onlineMeeting?.joinUrl ?? null };
    },
    updateEvent: async (id, patch) => {
      const body: Record<string, unknown> = {};
      if (patch.title) body.subject = patch.title;
      if (patch.start) body.start = { dateTime: new Date(patch.start).toISOString(), timeZone: "UTC" };
      if (patch.end) body.end = { dateTime: new Date(patch.end).toISOString(), timeZone: "UTC" };
      if (patch.notes) body.body = { contentType: "text", content: patch.notes };
      await graphCall(graph, `/me/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
    },
    cancelEvent: async (id) => { await graphCall(graph, `/me/events/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    busyTimes: async (from, to) => {
      const d = await graphCall(graph, `/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}&$top=200&$select=start,end,showAs,isCancelled`);
      return ((d?.value ?? []) as any[])
        .filter((e) => !e?.isCancelled && e?.showAs !== "free")
        .map((e) => ({ start: new Date(`${e.start.dateTime}Z`), end: new Date(`${e.end.dateTime}Z`) }));
    },
    createTask: async (t) => {
      const list = await defaultTodoList(graph);
      const r = await graphCall(graph, `/me/todo/lists/${list}/tasks`, { method: "POST", body: JSON.stringify(todoBody(t)) });
      return r?.id ?? null;
    },
    updateTask: async (id, t) => {
      const list = await defaultTodoList(graph);
      await graphCall(graph, `/me/todo/lists/${list}/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(todoBody(t)) });
    },
    deleteTask: async (id) => {
      const list = await defaultTodoList(graph);
      await graphCall(graph, `/me/todo/lists/${list}/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    ensureClientFolder: async (rootName, folderName) => {
      await graph.fetch("/me/drive/root/children", { method: "POST", body: JSON.stringify({ name: rootName, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
      const item = await graphCall(graph, "/me/drive/root:/" + encodeURIComponent(rootName) + ":/children", {
        method: "POST", body: JSON.stringify({ name: folderName, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
      });
      if (!me) {
        const who = await graphCall(graph, "/me?$select=mail,userPrincipalName").catch((err: unknown) => { console.warn("graph_me_failed", { message: (err as Error)?.message }); return null; });
        me = who?.mail ?? who?.userPrincipalName ?? null;
      }
      return { id: String(item?.id ?? ""), url: item?.webUrl ?? null };
    },
  };
}
