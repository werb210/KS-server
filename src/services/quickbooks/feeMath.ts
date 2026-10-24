// KS_SERVER_v13_QUICKBOOKS - the media funding fee on an invoice. Pure: no database, no network.
//
// The client-side media fee agreement charges a percent of funding (2% unless staff recorded another percent when
// marking it signed by hand). Before funding the invoice is on the requested amount; at funding it is moved to the
// funded amount. A fixed fee recorded by staff (fee_amount) wins over the percent and never changes at funding.
export const DEFAULT_MEDIA_FEE_PERCENT = 2;

export type FeeInput = {
  feePercent: number | string | null | undefined;
  feeAmount: number | string | null | undefined;
  requestedAmount: number | string | null | undefined;
  fundedAmount: number | string | null | undefined;
  funded: boolean;
};

export type Fee = { amount: number; percent: number | null; base: number | null; description: string };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export const roundCents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function percentText(p: number): string {
  return String(Number(p.toFixed(3)));
}

/** The fee, or null when there is nothing to invoice (no amount to charge on). */
export function mediaFee(input: FeeInput): Fee | null {
  const fixed = num(input.feeAmount);
  if (fixed !== null && fixed > 0) {
    return { amount: roundCents(fixed), percent: null, base: null, description: "Media funding fee (fixed fee)" };
  }
  const percent = num(input.feePercent) ?? DEFAULT_MEDIA_FEE_PERCENT;
  const funded = num(input.fundedAmount);
  const base = input.funded && funded !== null && funded > 0 ? funded : num(input.requestedAmount);
  if (base === null || !(base > 0) || !(percent > 0)) return null;
  return {
    amount: roundCents((base * percent) / 100),
    percent,
    base: roundCents(base),
    description: `Media funding fee (${percentText(percent)}% of funding)`,
  };
}
