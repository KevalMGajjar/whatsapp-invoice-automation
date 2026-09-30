import { parseAmount } from "../invoice/money.js";
import type { Discount, InvoiceDraft, LineItem } from "../invoice/types.js";

/**
 * Deterministic parser for the documented message format:
 *
 *   invoice for Rahul Sharma, rahul@example.com
 *   2 x Notebook @ 45
 *   Pen x 3 @ 10
 *   Stapler - 120
 *   gst 18
 *   discount 5%
 *   note: Thank you!
 *
 * It is free, instant and predictable, so it always runs first. Anything it
 * cannot read is reported in `unreadable`, and the caller decides whether to
 * ask an LLM or ask the sender to rephrase.
 */
export interface RuleParseResult {
  draft: Partial<InvoiceDraft> & { items: LineItem[] };
  /** Lines that matched no known pattern. */
  unreadable: string[];
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const QTY = String.raw`(\d+(?:\.\d{1,3})?)`;
const PRICE = String.raw`((?:₹|rs\.?|inr)?\s*[\d,]+(?:\.\d{1,2})?)(?:\s*\/-)?(?:\s*(?:each|ea))?`;
/** Separator between an item name and its price: "@", "-", ":", "=", " at " or plain spaces. */
const SEP = String.raw`(?:\s*[@\-:=]\s*|\s+at\s+|\s+)`;
const UNIT = String.raw`(kg|kgs|g|gm|gms|l|ltr|ml|pcs?|nos?|units?|pkts?|box|boxes|dozen|dz)`;

/** "2 x Notebook @ 45", "2 Notebook 45", "2 kg Rice @ 60" */
/** The multiplier must be followed by a space, so "2 xylophone 500" keeps its x. */
const QTY_FIRST = new RegExp(`^${QTY}(?:\\s*[x*×]\\s+|\\s+)(?:${UNIT}\\s+)?(.+?)${SEP}${PRICE}$`, "i");
/** "Notebook x 2 @ 45", "Notebook x2 45" (the x must be its own token) */
const NAME_FIRST = new RegExp(`^(.+?)\\s+[x*×]\\s*${QTY}${SEP}${PRICE}$`, "i");
/** "Stapler - 120", "Stapler 120" (quantity 1) */
const NAME_PRICE = new RegExp(`^(.+?)${SEP}${PRICE}$`, "i");

const HEADER = /^(?:(?:invoice|bill|receipt)\s+)?(?:for|to)\s*[:\-]?\s+(.+)$/i;
const NAME_LINE = /^(?:name|customer|client)\s*[:=\-]\s*(.+)$/i;
const EMAIL_LINE = /^(?:e-?mail|mail)\s*[:=\-]\s*(\S+)$/i;
const PHONE_LINE = /^(?:phone|mobile|mob|ph)\s*[:=\-]?\s*(\+?[\d\s\-]{7,16})$/i;
const GST_LINE = /^(?:gst|tax|vat)\s*[:=@\-]?\s*(\d+(?:\.\d+)?)\s*%?$/i;
const DISCOUNT_LINE = /^(?:discount|less)\b\s*[:=\-]?\s*(.+)$/i;
const NOTE_LINE = /^(?:notes?|remarks?)\s*[:=\-]\s*(.+)$/i;
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^[\s,.:\-]+|[\s,.:\-]+$/g, "");
}

function parseItem(line: string): LineItem | null {
  const text = line.replace(BULLET, "");

  const nameFirst = NAME_FIRST.exec(text);
  if (nameFirst) {
    const price = parseAmount(nameFirst[3] ?? "");
    const name = cleanName(nameFirst[1] ?? "");
    if (price !== null && name) {
      return { name, quantity: Number(nameFirst[2]), unitPricePaise: price };
    }
  }

  const qtyFirst = QTY_FIRST.exec(text);
  if (qtyFirst) {
    const price = parseAmount(qtyFirst[4] ?? "");
    const unit = qtyFirst[2];
    const base = cleanName(qtyFirst[3] ?? "");
    // A name must contain a letter; otherwise "2 45" would become an item.
    if (price !== null && /[a-z]/i.test(base)) {
      const name = unit ? `${base} (${unit.toLowerCase()})` : base;
      return { name, quantity: Number(qtyFirst[1]), unitPricePaise: price };
    }
  }

  const namePrice = NAME_PRICE.exec(text);
  if (namePrice) {
    const price = parseAmount(namePrice[2] ?? "");
    const name = cleanName(namePrice[1] ?? "");
    if (price !== null && /[a-z]/i.test(name)) {
      return { name, quantity: 1, unitPricePaise: price };
    }
  }
  return null;
}

function parseDiscount(raw: string): Discount | null {
  const text = raw.trim();
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) {
    const value = Number(percent[1]);
    return value <= 100 ? { kind: "percent", value } : null;
  }
  const paise = parseAmount(text);
  return paise === null ? null : { kind: "amount", paise };
}

/** Pull "Rahul Sharma" (and phone, if present) out of "Rahul Sharma, rahul@x.com, 98765 43210". */
function parseHeader(rest: string, draft: RuleParseResult["draft"]): void {
  const email = EMAIL.exec(rest);
  if (email && !draft.customerEmail) draft.customerEmail = email[0].toLowerCase();
  const withoutEmail = rest.replace(EMAIL, " ");
  const phone = /\+?\d[\d\s\-]{8,14}\d/.exec(withoutEmail);
  if (phone && !draft.customerPhone) draft.customerPhone = phone[0].replace(/[\s\-]/g, "");
  const name = cleanName((phone ? withoutEmail.replace(phone[0], " ") : withoutEmail).split(",")[0] ?? "");
  if (name && !draft.customerName) draft.customerName = name;
}

export function parseWithRules(message: string): RuleParseResult {
  const draft: RuleParseResult["draft"] = { items: [] };
  const unreadable: string[] = [];
  const lines = message
    .split(/\r?\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = GST_LINE.exec(line))) {
      draft.gstPercent = Number(m[1]);
    } else if ((m = DISCOUNT_LINE.exec(line))) {
      const discount = parseDiscount(m[1] ?? "");
      if (discount) draft.discount = discount;
      else unreadable.push(line);
    } else if ((m = NOTE_LINE.exec(line))) {
      draft.notes = (m[1] ?? "").trim();
    } else if ((m = EMAIL_LINE.exec(line))) {
      const email = EMAIL.exec(m[1] ?? "");
      if (email) draft.customerEmail = email[0].toLowerCase();
      else unreadable.push(line);
    } else if ((m = PHONE_LINE.exec(line))) {
      draft.customerPhone = (m[1] ?? "").replace(/[\s\-]/g, "");
    } else if ((m = NAME_LINE.exec(line)) || (m = HEADER.exec(line))) {
      parseHeader(m[1] ?? "", draft);
    } else {
      const item = parseItem(line);
      if (item) draft.items.push(item);
      else unreadable.push(line);
    }
  }
  return { draft, unreadable };
}
