// BF_SERVER_v887_LENDER_MATCH_FIX (KS port) - reads an amount from a dropdown band ("$100,000 - $250,000", "Over $1M",
// "250k") as its midpoint; a single figure or an "over" band reads as that figure. Copied from BF's biHandoff reader.
export function amountFromBand(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.toLowerCase().replace(/zero/g, "0");
  const values = Array.from(text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(million|m\b|k\b)?/g)).map((m) => {
    const n = Number(m[1]!.replace(/,/g, ""));
    const unit = m[2];
    return unit === "million" || unit === "m" ? n * 1_000_000 : unit === "k" ? n * 1_000 : n;
  }).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  if (/\bover\b|\+$/.test(text) || values.length === 1) return values[0]! > 0 ? values[0]! : null;
  const mid = Math.round((values[0]! + values[1]!) / 2);
  return mid > 0 ? mid : null;
}
