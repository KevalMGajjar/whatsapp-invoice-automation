import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeTotals } from "./totals.js";
import type { Invoice, InvoiceDraft } from "./types.js";

export interface InvoiceRecord {
  number: string;
  date: string;
  customerName: string;
  customerEmail?: string;
  totalPaise: number;
  /** PDF path relative to the data directory. */
  file: string;
  /** WhatsApp number that created it. */
  createdBy: string;
  createdAt: string;
}

interface Index {
  /** Last sequence number used, per year. */
  counters: Record<string, number>;
  invoices: InvoiceRecord[];
}

/**
 * File-based invoice storage:
 *
 *   <dataDir>/index.json                 counters + one record per invoice
 *   <dataDir>/invoices/INV-2026-0001.pdf
 *
 * Invoice numbers must be sequential with no gaps or duplicates. Two things
 * guarantee that here:
 *  - all writes go through one promise chain (`queue`), so two confirmations
 *    arriving together are processed one after the other;
 *  - the counter is only advanced after the PDF was written, and the index is
 *    replaced atomically (write to a temp file, then rename), so a crash
 *    never leaves a half-written index or a number without an invoice.
 *
 * A single JSON file is enough for one shop's volume. With several server
 * instances this would move to a database sequence.
 */
export class InvoiceStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get indexPath(): string {
    return path.join(this.dataDir, "index.json");
  }

  private async readIndex(): Promise<Index> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as Index;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { counters: {}, invoices: [] };
      throw err;
    }
  }

  private async writeIndex(index: Index): Promise<void> {
    const tmp = `${this.indexPath}.tmp`;
    await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
    await rename(tmp, this.indexPath);
  }

  /**
   * Assign the next number, render and save the PDF, and record the invoice.
   * `render` receives the finalized invoice and returns the PDF bytes.
   */
  create(
    draft: InvoiceDraft,
    options: { createdBy: string; defaultGstPercent: number },
    render: (invoice: Invoice) => Promise<Buffer>,
  ): Promise<{ invoice: Invoice; pdf: Buffer; filePath: string }> {
    const task = this.queue.then(async () => {
      await mkdir(path.join(this.dataDir, "invoices"), { recursive: true });
      const index = await this.readIndex();
      const today = this.now();
      const year = String(today.getFullYear());
      const sequence = (index.counters[year] ?? 0) + 1;
      const number = `INV-${year}-${String(sequence).padStart(4, "0")}`;
      const date = [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, "0"),
        String(today.getDate()).padStart(2, "0"),
      ].join("-");

      const invoice: Invoice = {
        ...draft,
        number,
        date,
        totals: computeTotals(draft, options.defaultGstPercent),
      };
      const pdf = await render(invoice);
      const file = path.join("invoices", `${number}.pdf`);
      const filePath = path.join(this.dataDir, file);
      await writeFile(filePath, pdf);

      index.counters[year] = sequence;
      const record: InvoiceRecord = {
        number,
        date,
        customerName: invoice.customerName,
        totalPaise: invoice.totals.totalPaise,
        file: file.replaceAll("\\", "/"),
        createdBy: options.createdBy,
        createdAt: today.toISOString(),
      };
      if (invoice.customerEmail) record.customerEmail = invoice.customerEmail;
      index.invoices.push(record);
      await this.writeIndex(index);
      return { invoice, pdf, filePath };
    });
    // Keep the chain alive even if this task fails.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** All invoices, oldest first. */
  async list(): Promise<InvoiceRecord[]> {
    return (await this.readIndex()).invoices;
  }
}
