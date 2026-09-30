import type { Mailer } from "./email/mailer.js";
import { formatAmount } from "./invoice/money.js";
import { formatQuantity, renderInvoicePdf } from "./invoice/pdf.js";
import type { InvoiceStore } from "./invoice/store.js";
import { computeTotals } from "./invoice/totals.js";
import type { Business, InvoiceDraft } from "./invoice/types.js";
import type { GeminiConfig } from "./parser/geminiParser.js";
import { parseMessage } from "./parser/index.js";
import type { WhatsAppClient } from "./whatsapp/client.js";
import type { IncomingMessage } from "./whatsapp/webhook.js";

export interface BotDeps {
  whatsapp: WhatsAppClient;
  store: InvoiceStore;
  business: Business;
  defaultGstPercent: number;
  /** Numbers allowed to create invoices; empty set = anyone. */
  allowedSenders: Set<string>;
  mailer?: Mailer;
  gemini?: GeminiConfig;
  /** Injected in tests. */
  now?: () => number;
}

const DRAFT_TTL_MS = 15 * 60 * 1000;
const MAX_SEEN_IDS = 5000;

const YES = /^(y|yes|ok|okay|confirm|send|haan|ha)[.! ]*$/i;
const NO = /^(n|no|cancel|stop|nahi)[.! ]*$/i;
const HELP = /^(hi|hello|hey|help|menu|start|\?)[.! ]*$/i;

export const HELP_TEXT = `*Invoice bot*
Send the invoice details, one item per line:

invoice for Rahul Sharma, rahul@example.com
2 x Notebook @ 45
Pen x 3 @ 10
Stapler - 120
gst 18
discount 5%
note: Thank you!

I'll show a preview. Reply *YES* to create the PDF and send it, or *NO* to cancel.`;

const rs = (paise: number) => `Rs. ${formatAmount(paise)}`;

/** The WhatsApp preview shown before anything is created. */
export function formatPreview(draft: InvoiceDraft, defaultGstPercent: number, emailEnabled: boolean): string {
  const t = computeTotals(draft, defaultGstPercent);
  const lines = ["*Invoice preview*", `Customer: ${draft.customerName}`];
  if (draft.customerEmail) lines.push(`Email: ${draft.customerEmail}`);
  if (draft.customerPhone) lines.push(`Phone: ${draft.customerPhone}`);
  lines.push("");
  draft.items.forEach((item, i) => {
    lines.push(
      `${i + 1}. ${item.name}: ${formatQuantity(item.quantity)} x ${rs(item.unitPricePaise)} = ${rs(t.lineTotals[i] ?? 0)}`,
    );
  });
  lines.push("", `Subtotal: ${rs(t.subtotalPaise)}`);
  if (t.discountPaise > 0) lines.push(`Discount: - ${rs(t.discountPaise)}`);
  if (t.gstPercent > 0) lines.push(`GST ${t.gstPercent}%: ${rs(t.gstPaise)}`);
  lines.push(`*Total: ${rs(t.totalPaise)}*`);
  if (draft.notes) lines.push("", `Note: ${draft.notes}`);
  lines.push("");
  if (!draft.customerEmail) {
    lines.push("No customer email given, so I'll only send the PDF here.");
  } else if (!emailEnabled) {
    lines.push("Email is not set up on the server, so I'll only send the PDF here.");
  }
  lines.push("Reply *YES* to create and send it, or *NO* to cancel.");
  return lines.join("\n");
}

/**
 * The conversation logic, independent of HTTP and of the WhatsApp provider.
 *
 *   message -> (duplicate? sender allowed?) -> help | YES | NO | new invoice text
 *   invoice text -> parse -> preview, remembered for 15 minutes
 *   YES -> number + PDF + store -> email (if possible) -> PDF back on WhatsApp
 *
 * Nothing is created or emailed until the sender confirms the preview. That
 * confirmation is what makes it safe to accept free-form text and an LLM.
 */
export class InvoiceBot {
  private readonly pending = new Map<string, { draft: InvoiceDraft; expiresAt: number }>();
  private readonly seen = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: BotDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Handle one incoming message. Replies go to `client` (defaults to the configured one). */
  async handle(message: IncomingMessage, client: WhatsAppClient = this.deps.whatsapp): Promise<void> {
    // WhatsApp re-delivers a webhook if it isn't acknowledged quickly; the
    // same message must never produce two invoices.
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > MAX_SEEN_IDS) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    const { allowedSenders } = this.deps;
    if (allowedSenders.size > 0 && !allowedSenders.has(message.from)) {
      // Stay silent: replying would confirm the number is a bot and cost a message.
      console.warn(`[bot] ignored message from non-allowed sender ${message.from}`);
      return;
    }

    const text = message.text.trim();
    try {
      if (HELP.test(text)) {
        await client.sendText(message.from, HELP_TEXT);
      } else if (YES.test(text)) {
        await this.confirm(message.from, client);
      } else if (NO.test(text)) {
        const had = this.pending.delete(message.from);
        await client.sendText(message.from, had ? "Cancelled. Nothing was created." : "There is nothing to cancel.");
      } else {
        await this.draft(message.from, text, client);
      }
    } catch (err) {
      console.error("[bot] failed to handle message:", err);
      await client
        .sendText(message.from, "Something went wrong on my side. Please try again in a minute.")
        .catch(() => undefined);
    }
  }

  private async draft(from: string, text: string, client: WhatsAppClient): Promise<void> {
    const outcome = await parseMessage(text, this.deps.gemini);
    if (!outcome.ok) {
      await client.sendText(from, `${outcome.reason}\n\nSend *help* to see the format.`);
      return;
    }
    this.pending.set(from, { draft: outcome.draft, expiresAt: this.now() + DRAFT_TTL_MS });
    await client.sendText(
      from,
      formatPreview(outcome.draft, this.deps.defaultGstPercent, this.deps.mailer !== undefined),
    );
  }

  private async confirm(from: string, client: WhatsAppClient): Promise<void> {
    const entry = this.pending.get(from);
    if (!entry || entry.expiresAt < this.now()) {
      this.pending.delete(from);
      await client.sendText(from, "There is no invoice waiting for confirmation. Send the details first.");
      return;
    }
    // Remove the draft before doing any work so a second YES cannot issue it twice.
    this.pending.delete(from);

    const { invoice, pdf } = await this.deps.store.create(
      entry.draft,
      { createdBy: from, defaultGstPercent: this.deps.defaultGstPercent },
      (inv) => renderInvoicePdf(inv, this.deps.business),
    );

    let emailStatus = "";
    if (invoice.customerEmail && this.deps.mailer) {
      try {
        await this.deps.mailer.sendInvoice(invoice, pdf, this.deps.business);
        emailStatus = `Emailed to ${invoice.customerEmail}.`;
      } catch (err) {
        // The invoice exists; a mail failure must not lose it.
        console.error("[bot] email failed:", err);
        emailStatus = `Could not email ${invoice.customerEmail}. Please forward the PDF yourself.`;
      }
    }

    const caption = `Invoice ${invoice.number} for ${invoice.customerName}: ${rs(invoice.totals.totalPaise)}`;
    await client.sendDocument(from, pdf, `${invoice.number}.pdf`, caption);
    if (emailStatus) await client.sendText(from, emailStatus);
  }
}
