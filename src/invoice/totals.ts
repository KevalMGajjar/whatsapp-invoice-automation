import { percentOf } from "./money.js";
import type { InvoiceDraft, InvoiceTotals } from "./types.js";

/**
 * Compute every amount on the invoice from the draft.
 *
 * Order of operations (the usual GST invoice layout):
 *   subtotal  = sum(quantity x unit price)
 *   discount  = percentage of subtotal, or a fixed amount (capped at subtotal)
 *   taxable   = subtotal - discount
 *   GST       = gstPercent of taxable
 *   total     = taxable + GST
 */
export function computeTotals(draft: InvoiceDraft, defaultGstPercent = 0): InvoiceTotals {
  const lineTotals = draft.items.map((item) => Math.round(item.quantity * item.unitPricePaise));
  const subtotalPaise = lineTotals.reduce((sum, line) => sum + line, 0);

  let discountPaise = 0;
  if (draft.discount?.kind === "percent") {
    discountPaise = percentOf(subtotalPaise, draft.discount.value);
  } else if (draft.discount?.kind === "amount") {
    discountPaise = Math.min(draft.discount.paise, subtotalPaise);
  }

  const taxablePaise = subtotalPaise - discountPaise;
  const gstPercent = draft.gstPercent ?? defaultGstPercent;
  const gstPaise = percentOf(taxablePaise, gstPercent);

  return {
    lineTotals,
    subtotalPaise,
    discountPaise,
    taxablePaise,
    gstPercent,
    gstPaise,
    totalPaise: taxablePaise + gstPaise,
  };
}
