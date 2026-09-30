/**
 * Money is handled as an integer number of paise (1 rupee = 100 paise).
 *
 * Floating point cannot represent most decimal amounts exactly
 * (0.1 + 0.2 !== 0.3), and an invoice that is off by one paisa is a wrong
 * invoice. Every amount is therefore parsed into paise once, all arithmetic
 * is done on integers, and amounts are formatted back only for display.
 */

/** Parse "45", "45.5", "1,250.75", "₹45", "Rs. 45" into paise. Returns null if invalid. */
export function parseAmount(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/^(?:₹|rs\.?|inr)\s*/i, "")
    .replace(/,/g, "")
    .replace(/\/-$/, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "").padEnd(2, "0") || "0");
  const total = rupees * 100 + paise;
  return Number.isSafeInteger(total) ? total : null;
}

/** Convert a rupee number (e.g. from an LLM's JSON) into paise, rounding to the nearest paisa. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Format paise with Indian digit grouping: 12345678 -> "1,23,456.78". */
export function formatAmount(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100).toString();
  const fraction = (abs % 100).toString().padStart(2, "0");
  // Indian grouping: last three digits, then groups of two.
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${sign}${grouped}.${fraction}`;
}

/** `percent` of `paise`, rounded half up to a whole paisa. */
export function percentOf(paise: number, percent: number): number {
  return Math.round((paise * percent) / 100);
}
