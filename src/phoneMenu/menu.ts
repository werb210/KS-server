// KS_SETTINGS_PACK_v1_PHONE_MENU - the brokerage's phone menu (IVR), edited by an Admin in Settings > Phone menu.
//
// Replaces the menu that was written into the code for one brokerage (its departments and two staff names). What a
// caller hears and where each key goes is now data:
//   greeting            text read aloud, or an uploaded recording
//   hours + holidays    in the brokerage's time zone; outside them (or on a holiday) the after-hours greeting plays and
//                       the after-hours choice runs (voicemail by default)
//   options 1-9         each routes to a person, a group (rings everyone at once, or one at a time), a voicemail box,
//                       the AI receptionist (the caller says what they need and is routed), or the meeting dial-in
//   no-answer fallback  where a call goes when nobody picks up (the person's own voicemail by default)
// Pure: no database or Twilio here (see ./store.ts and routes/reception.ts).
import { zonedDay, zonedParts } from "../lib/brokerageTime.js";

export const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type Digit = (typeof DIGITS)[number];
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export type MenuTarget =
  | { type: "user"; userId: string }
  | { type: "group"; userIds: string[]; strategy: "simultaneous" | "sequential" }
  /** userId null: the person who was being rung, else the shared mailbox. */
  | { type: "voicemail"; userId: string | null }
  | { type: "ai" }
  | { type: "meeting" };

export type Prompt = { mode: "tts" | "audio"; text: string; audioId: string | null };

export type MenuOption = { digit: Digit; label: string; keywords: string[]; target: MenuTarget };

export type PhoneMenu = {
  greeting: Prompt;
  /** Read "For sales, press 1..." after the greeting, built from the option labels. */
  announceOptions: boolean;
  hours: { enabled: boolean; weekly: Record<DayKey, Array<[string, string]>> };
  afterHoursGreeting: Prompt;
  afterHours: MenuTarget;
  options: MenuOption[];
  noAnswer: { ringSeconds: number; target: MenuTarget };
  holidays: Array<{ date: string; name: string }>;
};

export type MenuUser = { id: string; first_name: string | null; last_name: string | null; role?: string | null };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEXT = 600;
export const MAX_HOLIDAYS = 60;

function defaultWeekly(): PhoneMenu["hours"]["weekly"] {
  const work: Array<[string, string]> = [["09:00", "17:00"]];
  return { sun: [], mon: [...work], tue: [...work], wed: [...work], thu: [...work], fri: [...work], sat: [] };
}

export function displayName(u: Pick<MenuUser, "first_name" | "last_name">): string {
  return [u.first_name, u.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || "a team member";
}

/** The menu a brokerage starts with, built from its own active staff: 1 rings everyone; 2-9 each person by name. */
export function defaultMenu(companyName: string, users: MenuUser[]): PhoneMenu {
  const staff = users.filter((u) => UUID.test(u.id)).slice(0, 8);
  const options: MenuOption[] = [];
  if (staff.length === 1) {
    options.push({ digit: "1", label: displayName(staff[0]!), keywords: [], target: { type: "user", userId: staff[0]!.id } });
  } else if (staff.length > 1) {
    options.push({ digit: "1", label: "the next available person", keywords: ["sales", "apply", "new", "loan", "financing"], target: { type: "group", userIds: staff.map((u) => u.id), strategy: "simultaneous" } });
    staff.forEach((u, i) => {
      const first = String(u.first_name ?? "").trim();
      options.push({ digit: DIGITS[i + 1]!, label: `${displayName(u)}`, keywords: first ? [first.toLowerCase()] : [], target: { type: "user", userId: u.id } });
    });
  }
  return {
    greeting: { mode: "tts", text: `Thank you for calling ${companyName}.`, audioId: null },
    announceOptions: true,
    hours: { enabled: false, weekly: defaultWeekly() },
    afterHoursGreeting: { mode: "tts", text: `Thank you for calling ${companyName}. Our office is closed right now.`, audioId: null },
    afterHours: { type: "voicemail", userId: null },
    options,
    noAnswer: { ringSeconds: 25, target: { type: "voicemail", userId: null } },
    holidays: [],
  };
}

type Errors = Record<string, string>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function checkPrompt(raw: unknown, key: string, errors: Errors, audioIds: Set<string>): Prompt {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = r.mode === "audio" ? "audio" : "tts";
  const text = str(r.text);
  const audioId = r.audioId == null || r.audioId === "" ? null : str(r.audioId);
  if (text.length > MAX_TEXT) errors[`${key}.text`] = `Keep it under ${MAX_TEXT} characters.`;
  if (mode === "tts" && !text) errors[`${key}.text`] = "Enter the words to read to callers.";
  if (mode === "audio" && (!audioId || !audioIds.has(audioId))) errors[`${key}.audioId`] = "Upload a recording, or switch to text-to-speech.";
  return { mode, text, audioId: mode === "audio" ? audioId : null };
}

function checkTarget(raw: unknown, key: string, errors: Errors, userIds: Set<string>, allow: MenuTarget["type"][]): MenuTarget {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const type = str(r.type) as MenuTarget["type"];
  if (!allow.includes(type)) {
    errors[key] = "Choose where this goes.";
    return { type: "voicemail", userId: null };
  }
  if (type === "user") {
    const id = str(r.userId);
    if (!userIds.has(id)) errors[key] = "Choose an active team member.";
    return { type, userId: id };
  }
  if (type === "group") {
    const ids = Array.isArray(r.userIds) ? Array.from(new Set(r.userIds.map(str))) : [];
    if (!ids.length) errors[key] = "Choose at least one person for the group.";
    else if (ids.some((id) => !userIds.has(id))) errors[key] = "Every person in the group must be an active team member.";
    else if (ids.length > 10) errors[key] = "A group can ring at most 10 people.";
    return { type, userIds: ids, strategy: r.strategy === "sequential" ? "sequential" : "simultaneous" };
  }
  if (type === "voicemail") {
    const id = r.userId == null || r.userId === "" ? null : str(r.userId);
    if (id && !userIds.has(id)) errors[key] = "Choose an active team member's voicemail, or the shared voicemail.";
    return { type, userId: id };
  }
  return { type } as MenuTarget;
}

function checkWeekly(raw: unknown, errors: Errors): PhoneMenu["hours"]["weekly"] {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {} as PhoneMenu["hours"]["weekly"];
  for (const d of DAY_KEYS) {
    const ranges = Array.isArray(src[d]) ? (src[d] as unknown[]) : [];
    out[d] = [];
    for (const r of ranges.slice(0, 3)) {
      const [a, b] = Array.isArray(r) ? r.map(str) : ["", ""];
      if (!HHMM.test(a ?? "") || !HHMM.test(b ?? "") || a! >= b!) { errors[`hours.${d}`] = "Use times like 09:00 to 17:00 (start before end)."; continue; }
      out[d].push([a!, b!]);
    }
  }
  return out;
}

/** Checks an edited menu against the brokerage's active users and uploaded recordings. */
export function validateMenu(raw: unknown, ctx: { userIds: Iterable<string>; audioIds: Iterable<string> }):
  { ok: true; value: PhoneMenu } | { ok: false; errors: Errors } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const errors: Errors = {};
  const users = new Set(ctx.userIds);
  const audio = new Set(ctx.audioIds);
  const all: MenuTarget["type"][] = ["user", "group", "voicemail", "ai", "meeting"];
  const greeting = checkPrompt(r.greeting, "greeting", errors, audio);
  const afterHoursGreeting = checkPrompt(r.afterHoursGreeting, "afterHoursGreeting", errors, audio);
  const hours = { enabled: r.hours?.enabled === true, weekly: checkWeekly(r.hours?.weekly, errors) };
  const afterHours = checkTarget(r.afterHours ?? { type: "voicemail", userId: null }, "afterHours", errors, users, ["user", "group", "voicemail", "ai"]);
  const seen = new Set<string>();
  const options: MenuOption[] = [];
  const rawOptions = Array.isArray(r.options) ? r.options : [];
  if (rawOptions.length > 9) errors.options = "A menu can have at most 9 options.";
  rawOptions.slice(0, 9).forEach((o: any, i: number) => {
    const digit = str(o?.digit) as Digit;
    const key = `options.${i}`;
    if (!(DIGITS as readonly string[]).includes(digit)) errors[`${key}.digit`] = "Choose a key from 1 to 9.";
    else if (seen.has(digit)) errors[`${key}.digit`] = `Key ${digit} is used twice.`;
    seen.add(digit);
    const label = str(o?.label);
    if (!label) errors[`${key}.label`] = "Say what this option is for (for example: sales).";
    if (label.length > 80) errors[`${key}.label`] = "Keep the label under 80 characters.";
    const keywords = (Array.isArray(o?.keywords) ? o.keywords : String(o?.keywords ?? "").split(","))
      .map((k: unknown) => str(k).toLowerCase()).filter(Boolean).slice(0, 12);
    options.push({ digit, label, keywords, target: checkTarget(o?.target, `${key}.target`, errors, users, all) });
  });
  options.sort((a, b) => a.digit.localeCompare(b.digit));
  const ringSeconds = Math.round(Number(r.noAnswer?.ringSeconds ?? 25));
  if (!Number.isFinite(ringSeconds) || ringSeconds < 10 || ringSeconds > 60) errors["noAnswer.ringSeconds"] = "Ring for 10 to 60 seconds.";
  const noAnswer = {
    ringSeconds: Number.isFinite(ringSeconds) ? Math.min(60, Math.max(10, ringSeconds)) : 25,
    target: checkTarget(r.noAnswer?.target ?? { type: "voicemail", userId: null }, "noAnswer.target", errors, users, ["user", "group", "voicemail", "ai"]),
  };
  const holidays: PhoneMenu["holidays"] = [];
  const rawHolidays = Array.isArray(r.holidays) ? r.holidays : [];
  if (rawHolidays.length > MAX_HOLIDAYS) errors.holidays = `At most ${MAX_HOLIDAYS} holidays.`;
  rawHolidays.slice(0, MAX_HOLIDAYS).forEach((h: any, i: number) => {
    const date = str(h?.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) { errors[`holidays.${i}`] = "Use a date like 2026-12-25."; return; }
    holidays.push({ date, name: str(h?.name).slice(0, 80) || "Holiday" });
  });
  holidays.sort((a, b) => a.date.localeCompare(b.date));
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { greeting, announceOptions: r.announceOptions !== false, hours, afterHoursGreeting, afterHours, options, noAnswer, holidays } };
}

/** Is the office open at `now` (brokerage time zone)? Hours off = always open, except on a holiday. */
export function officeOpen(menu: PhoneMenu, now: Date, tz?: string): { open: boolean; holiday: string | null } {
  const day = zonedDay(now, tz);
  const holiday = menu.holidays.find((h) => h.date === day);
  if (holiday) return { open: false, holiday: holiday.name };
  if (!menu.hours.enabled) return { open: true, holiday: null };
  const p = zonedParts(now, tz);
  const m = p.hour * 60 + p.minute;
  const ranges = menu.hours.weekly[DAY_KEYS[p.dow]!] ?? [];
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return { open: ranges.some(([a, b]) => m >= toMin(a) && m < toMin(b)), holiday: null };
}

/** "For sales, press 1. For Jane Smith, press 2." */
export function optionsPrompt(menu: PhoneMenu): string {
  return menu.options.map((o) => `For ${o.label}, press ${o.digit}.`).join(" ");
}

/** The text read to a caller on arrival (the greeting, then the options when announced). */
export function greetingText(menu: PhoneMenu): string {
  return [menu.greeting.mode === "tts" ? menu.greeting.text : "", menu.announceOptions ? optionsPrompt(menu) : ""].filter(Boolean).join(" ");
}

/** The option a caller's words point to: a keyword or the label's words. Null when nothing (or more than one) fits. */
export function matchSpeech(menu: PhoneMenu, speech: string, opts: { exclude?: MenuTarget["type"][] } = {}): MenuOption | null {
  const said = ` ${String(speech ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  if (said.trim() === "") return null;
  const spoken = /\b(one|two|three|four|five|six|seven|eight|nine)\b/.exec(said);
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const candidates = menu.options.filter((o) => !(opts.exclude ?? []).includes(o.target.type));
  if (spoken) {
    const byNumber = candidates.find((o) => o.digit === String(words.indexOf(spoken[1]!) + 1));
    if (byNumber) return byNumber;
  }
  const stop = new Set(["the", "a", "an", "and", "or", "to", "for", "with", "our", "of", "speak", "talk", "next", "available", "person", "team"]);
  const hits = candidates.filter((o) => {
    const terms = [...o.keywords, ...o.label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !stop.has(w))];
    return terms.some((t) => t && said.includes(` ${t} `));
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** People a target can ring, in order. */
export function targetUserIds(t: MenuTarget): string[] {
  if (t.type === "user") return [t.userId];
  if (t.type === "group") return t.userIds;
  return [];
}

/** True when the menu still routes to someone who is no longer an active user (the editor flags it). */
export function staleUserIds(menu: PhoneMenu, activeIds: Set<string>): string[] {
  const ids = new Set<string>();
  const add = (t: MenuTarget) => {
    for (const id of targetUserIds(t)) if (!activeIds.has(id)) ids.add(id);
    if (t.type === "voicemail" && t.userId && !activeIds.has(t.userId)) ids.add(t.userId);
  };
  menu.options.forEach((o) => add(o.target));
  add(menu.afterHours);
  add(menu.noAnswer.target);
  return [...ids];
}
