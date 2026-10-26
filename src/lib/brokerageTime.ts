// KS_SETTINGS_PACK_v1_TIME_ZONE - the brokerage's own time zone, used everywhere the server works with local time:
// quiet hours, call hours, business hours, booking slots, reports, the Monday emails, queue hours and usage periods.
//
// The Admin sets it in Settings > Company (licensee_settings.time_zone, default America/Edmonton). It is read
// synchronously from the licensee settings last loaded (src/licensee/brand.ts refreshes them every minute and on save),
// so plain functions and string builders can use it without awaiting.
//
// Daylight saving comes from the IANA rules (Intl), so Toronto, Vancouver or New York change their clocks on the right
// dates. One exception: Alberta stopped changing its clocks in 2026 and is on UTC-6 all year, but servers, browsers and
// phones with older time-zone data still move America/Edmonton back an hour on 2026-11-01. "America/Edmonton" is
// therefore computed as America/Regina (UTC-6 all year in every version of the data); see ./albertaTime.ts.
import { brandSettings } from "../licensee/brand.js";
import { ALBERTA_TZ } from "./albertaTime.js";

export const DEFAULT_BROKERAGE_TIME_ZONE = "America/Edmonton";

/** True for a zone name Intl accepts (an IANA name such as America/Toronto, or UTC). */
export function isValidTimeZone(raw: unknown): boolean {
  const tz = String(raw ?? "").trim();
  if (!tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to compute with for a stored zone name: Edmonton as Alberta's all-year UTC-6; anything invalid falls back
 *  to the brokerage's zone (or Alberta when that is invalid too). */
export function computeZone(raw: unknown, fallback?: string): string {
  const tz = String(raw ?? "").trim();
  if (tz === DEFAULT_BROKERAGE_TIME_ZONE) return ALBERTA_TZ;
  if (isValidTimeZone(tz)) return tz;
  if (fallback !== undefined) return computeZone(fallback);
  return ALBERTA_TZ;
}

/** Alberta's last clock change: from 2026-03-08 02:00 MST it stays on UTC-6. */
export const ALBERTA_ALL_YEAR_FROM = Date.UTC(2026, 2, 8, 9, 0, 0);

/** computeZone for a particular moment: Edmonton before 2026-03-08 keeps its old DST rules (so history reads right). */
export function computeZoneAt(raw: unknown, at: Date, fallback?: string): string {
  const tz = String(raw ?? "").trim();
  if (tz === DEFAULT_BROKERAGE_TIME_ZONE && at.getTime() < ALBERTA_ALL_YEAR_FROM) return DEFAULT_BROKERAGE_TIME_ZONE;
  return computeZone(raw, fallback);
}

/** The brokerage's time zone as stored (what staff picked), e.g. "America/Toronto". */
export function brokerageZoneName(raw: unknown = brandSettings().time_zone): string {
  const tz = String(raw ?? "").trim();
  return isValidTimeZone(tz) ? tz : DEFAULT_BROKERAGE_TIME_ZONE;
}

/** The brokerage's time zone to compute with (Intl / SQL AT TIME ZONE). */
export function brokerageTimeZone(raw: unknown = brandSettings().time_zone): string {
  return computeZone(brokerageZoneName(raw));
}

/** A zone name safe to inline in SQL as a literal ('...'): validated, so it can only be letters, digits, _ + - /. */
export function sqlZoneLiteral(tz: string = brokerageTimeZone()): string {
  const z = isValidTimeZone(tz) ? tz : ALBERTA_TZ;
  return `'${z}'`;
}

export type ZonedParts = { y: number; m: number; d: number; hour: number; minute: number; dow: number };

/** The wall-clock date and time of a moment in a zone. dow: 0 = Sunday. */
export function zonedParts(at: Date, tz: string = brokerageTimeZone()): ZonedParts {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)),
  };
}

function offsetMin(at: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** The moment a wall-clock time happens in a zone (DST-correct; a time skipped by spring-forward moves an hour on). */
export function zonedTime(y: number, m: number, d: number, h: number, min = 0, tz: string = brokerageTimeZone()): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const t1 = guess - offsetMin(new Date(guess), tz) * 60_000;
  // Second pass: the offset at the answer can differ from the offset at the guess near a clock change.
  const t2 = guess - offsetMin(new Date(t1), tz) * 60_000;
  const p = zonedParts(new Date(t2), tz);
  if (p.hour === h && p.minute === min) return new Date(t2);
  // The wall-clock time does not exist (spring forward): the later reading, an hour on.
  return new Date(Math.max(t1, t2));
}

/** "YYYY-MM-DD" of a moment in a zone. */
export function zonedDay(at: Date, tz: string = brokerageTimeZone()): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
export function zonedMinuteOfDay(at: Date, tz: string = brokerageTimeZone()): number {
  const p = zonedParts(at, tz);
  return p.hour * 60 + p.minute;
}

/** How a time's zone is named to clients: "Alberta time" for Edmonton, else the city ("Toronto time"). */
export function zoneLabel(name: string = brokerageZoneName()): string {
  if (name === DEFAULT_BROKERAGE_TIME_ZONE) return "Alberta time";
  if (name === "UTC" || name === "Etc/UTC") return "UTC";
  const city = name.split("/").pop() ?? name;
  return `${city.replace(/_/g, " ")} time`;
}
