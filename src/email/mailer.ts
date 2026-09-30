import nodemailer from "nodemailer";
import { formatAmount } from "../invoice/money.js";
import type { Business, Invoice } from "../invoice/types.js";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export interface Mailer {
  /** Email the invoice PDF to the customer. */
  sendInvoice(invoice: Invoice, pdf: Buffer, business: Business): Promise<void>;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function createMailer(config: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });

  return {
    async sendInvoice(invoice, pdf, business) {
      if (!invoice.customerEmail) return;
      const total = `Rs. ${formatAmount(invoice.totals.totalPaise)}`;
      const text = [
        `Hello ${invoice.customerName},`,
        "",
        `Please find attached invoice ${invoice.number} dated ${invoice.date} for ${total}.`,
        "",
        "Thank you for your business.",
        business.name,
      ].join("\n");
      await transport.sendMail({
        from: `"${business.name.replace(/"/g, "'")}" <${config.from}>`,
        to: invoice.customerEmail,
        subject: `Invoice ${invoice.number} from ${business.name}`,
        text,
        html: `<p>Hello ${escapeHtml(invoice.customerName)},</p>
<p>Please find attached invoice <b>${escapeHtml(invoice.number)}</b> dated ${escapeHtml(invoice.date)} for <b>${escapeHtml(total)}</b>.</p>
<p>Thank you for your business.<br>${escapeHtml(business.name)}</p>`,
        attachments: [{ filename: `${invoice.number}.pdf`, content: pdf, contentType: "application/pdf" }],
      });
    },
  };
}
