import { z } from "zod";

/** One line on the invoice. Prices are integer paise. */
export const lineItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().positive().max(100_000),
  unitPricePaise: z.number().int().nonnegative().max(10_000_000_00),
});
export type LineItem = z.infer<typeof lineItemSchema>;

/** Discount is either a percentage of the subtotal or a fixed amount. */
export const discountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), value: z.number().min(0).max(100) }),
  z.object({ kind: z.literal("amount"), paise: z.number().int().nonnegative() }),
]);
export type Discount = z.infer<typeof discountSchema>;

/**
 * What a parser produces from a WhatsApp message: everything the sender
 * said, nothing computed. Totals are always derived in code, never taken
 * from the message or from an LLM.
 */
export const invoiceDraftSchema = z.object({
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.email().optional(),
  customerPhone: z.string().trim().max(20).optional(),
  items: z.array(lineItemSchema).min(1).max(100),
  gstPercent: z.number().min(0).max(100).optional(),
  discount: discountSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});
export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;

export interface InvoiceTotals {
  /** quantity x unit price per item, in paise */
  lineTotals: number[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstPercent: number;
  gstPaise: number;
  totalPaise: number;
}

/** A finalized invoice: a draft plus its number, date and computed totals. */
export interface Invoice extends InvoiceDraft {
  number: string;
  /** ISO date, e.g. 2026-09-30 */
  date: string;
  totals: InvoiceTotals;
}

export interface Business {
  name: string;
  address?: string;
  gstin?: string;
  email?: string;
  phone?: string;
}
