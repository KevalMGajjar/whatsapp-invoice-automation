import PDFDocument from "pdfkit";
import { formatAmount } from "./money.js";
import type { Business, Invoice } from "./types.js";

const MARGIN = 50;
const GREY = "#666666";
const LINE = "#dddddd";
const ACCENT = "#1f4e79";

/** Column layout of the items table (A4 content width is 495pt). */
const COL = {
  index: { x: MARGIN, width: 30 },
  name: { x: MARGIN + 30, width: 215 },
  qty: { x: MARGIN + 245, width: 60 },
  rate: { x: MARGIN + 305, width: 90 },
  amount: { x: MARGIN + 395, width: 100 },
} as const;

// The built-in PDF fonts have no rupee glyph, so amounts are written as "Rs.".
const rs = (paise: number) => `Rs. ${formatAmount(paise)}`;

/** 2 -> "2", 1.5 -> "1.5", 0.250 -> "0.25" */
export function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3)));
}

/** Render the invoice as an A4 PDF and return its bytes. */
export function renderInvoicePdf(invoice: Invoice, business: Business): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      info: { Title: `Invoice ${invoice.number}`, Author: business.name },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const right = doc.page.width - MARGIN;
    const contentWidth = right - MARGIN;

    // ---- Header: business on the left, invoice meta on the right ----
    doc.font("Helvetica-Bold").fontSize(18).fillColor(ACCENT).text(business.name, MARGIN, MARGIN, {
      width: 300,
    });
    doc.font("Helvetica").fontSize(9).fillColor(GREY);
    for (const line of [
      business.address,
      business.gstin ? `GSTIN: ${business.gstin}` : undefined,
      [business.phone, business.email].filter(Boolean).join("  |  ") || undefined,
    ]) {
      if (line) doc.text(line, { width: 300 });
    }
    const headerBottom = doc.y;

    doc.font("Helvetica-Bold").fontSize(22).fillColor("#000000").text("INVOICE", MARGIN, MARGIN, {
      width: contentWidth,
      align: "right",
    });
    doc.font("Helvetica").fontSize(10).fillColor(GREY);
    doc.text(`No: ${invoice.number}`, { width: contentWidth, align: "right" });
    doc.text(`Date: ${invoice.date}`, { width: contentWidth, align: "right" });

    let y = Math.max(headerBottom, doc.y) + 20;
    doc.moveTo(MARGIN, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 15;

    // ---- Bill to ----
    doc.font("Helvetica-Bold").fontSize(9).fillColor(GREY).text("BILL TO", MARGIN, y);
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#000000").text(invoice.customerName, MARGIN, y + 13);
    doc.font("Helvetica").fontSize(10).fillColor(GREY);
    if (invoice.customerEmail) doc.text(invoice.customerEmail);
    if (invoice.customerPhone) doc.text(invoice.customerPhone);
    y = doc.y + 20;

    // ---- Items table ----
    const drawTableHeader = (top: number): number => {
      doc.rect(MARGIN, top, contentWidth, 22).fill(ACCENT);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#ffffff");
      doc.text("#", COL.index.x + 6, top + 7, { width: COL.index.width - 6 });
      doc.text("ITEM", COL.name.x, top + 7, { width: COL.name.width });
      doc.text("QTY", COL.qty.x, top + 7, { width: COL.qty.width, align: "right" });
      doc.text("RATE", COL.rate.x, top + 7, { width: COL.rate.width, align: "right" });
      doc.text("AMOUNT", COL.amount.x, top + 7, { width: COL.amount.width - 6, align: "right" });
      return top + 22;
    };
    y = drawTableHeader(y);

    const bottomLimit = doc.page.height - MARGIN - 40;
    invoice.items.forEach((item, i) => {
      doc.font("Helvetica").fontSize(10);
      const rowHeight = Math.max(doc.heightOfString(item.name, { width: COL.name.width }), 12) + 10;
      if (y + rowHeight > bottomLimit) {
        doc.addPage();
        y = drawTableHeader(MARGIN);
      }
      doc.fillColor("#000000");
      doc.text(String(i + 1), COL.index.x + 6, y + 5, { width: COL.index.width - 6 });
      doc.text(item.name, COL.name.x, y + 5, { width: COL.name.width });
      doc.text(formatQuantity(item.quantity), COL.qty.x, y + 5, { width: COL.qty.width, align: "right" });
      doc.text(formatAmount(item.unitPricePaise), COL.rate.x, y + 5, { width: COL.rate.width, align: "right" });
      doc.text(formatAmount(invoice.totals.lineTotals[i] ?? 0), COL.amount.x, y + 5, {
        width: COL.amount.width - 6,
        align: "right",
      });
      y += rowHeight;
      doc.moveTo(MARGIN, y).lineTo(right, y).strokeColor(LINE).stroke();
    });

    // ---- Totals ----
    const totalsHeight = 110;
    if (y + totalsHeight > bottomLimit) {
      doc.addPage();
      y = MARGIN;
    }
    y += 12;
    const labelX = COL.rate.x - 60;
    const labelWidth = COL.rate.width + 60;
    const totalRow = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10).fillColor(bold ? "#000000" : GREY);
      doc.text(label, labelX, y, { width: labelWidth, align: "right" });
      doc.fillColor("#000000").text(value, COL.amount.x, y, { width: COL.amount.width - 6, align: "right" });
      y += bold ? 20 : 16;
    };
    const t = invoice.totals;
    totalRow("Subtotal", rs(t.subtotalPaise));
    if (t.discountPaise > 0) {
      const label = invoice.discount?.kind === "percent" ? `Discount (${invoice.discount.value}%)` : "Discount";
      totalRow(label, `- ${rs(t.discountPaise)}`);
    }
    if (t.gstPercent > 0) totalRow(`GST (${t.gstPercent}%)`, rs(t.gstPaise));
    y += 2;
    doc.moveTo(labelX + 40, y).lineTo(right, y).strokeColor("#000000").stroke();
    y += 8;
    totalRow("TOTAL", rs(t.totalPaise), true);

    // ---- Notes ----
    if (invoice.notes) {
      y += 10;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GREY).text("NOTES", MARGIN, y);
      doc.font("Helvetica").fontSize(10).fillColor("#000000").text(invoice.notes, MARGIN, y + 13, {
        width: contentWidth,
      });
    }

    // ---- Footer ----
    doc.font("Helvetica").fontSize(8).fillColor(GREY).text(
      "This is a computer-generated invoice.",
      MARGIN,
      doc.page.height - MARGIN - 10,
      { width: contentWidth, align: "center", lineBreak: false },
    );

    doc.end();
  });
}
