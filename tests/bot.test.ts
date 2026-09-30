import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InvoiceBot, type BotDeps } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import type { Mailer } from "../src/email/mailer.js";
import { InvoiceStore } from "../src/invoice/store.js";
import type { Invoice } from "../src/invoice/types.js";
import { RecordingClient } from "../src/whatsapp/client.js";
import { extractTextMessages, verifySignature } from "../src/whatsapp/webhook.js";

const OWNER = "919876543210";
const MESSAGE = "invoice for Rahul Sharma, rahul@example.com\n2 x Notebook @ 45\nPen x 3 @ 10\ngst 18";

let dir: string;
let client: RecordingClient;
let emailed: Invoice[];
let clock: number;

function makeBot(overrides: Partial<BotDeps> = {}): InvoiceBot {
  const mailer: Mailer = {
    async sendInvoice(invoice) {
      emailed.push(invoice);
    },
  };
  return new InvoiceBot({
    whatsapp: client,
    store: new InvoiceStore(dir, () => new Date(2026, 8, 30)),
    business: { name: "Sharma General Store", address: "12 MG Road, Ahmedabad" },
    defaultGstPercent: 0,
    allowedSenders: new Set([OWNER]),
    mailer,
    now: () => clock,
    ...overrides,
  });
}

let nextId = 0;
const msg = (text: string, from = OWNER) => ({ id: `wamid.${nextId++}`, from, text });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "invoice-bot-"));
  client = new RecordingClient();
  emailed = [];
  clock = 1_000_000;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("InvoiceBot", () => {
  it("previews, then creates, emails and sends the PDF after YES", async () => {
    const bot = makeBot();
    await bot.handle(msg(MESSAGE));

    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toContain("Invoice preview");
    expect(client.texts[0]).toContain("1. Notebook: 2 x Rs. 45.00 = Rs. 90.00");
    expect(client.texts[0]).toContain("GST 18%: Rs. 21.60");
    expect(client.texts[0]).toContain("*Total: Rs. 141.60*");
    expect(client.documents).toHaveLength(0);
    expect(emailed).toHaveLength(0);

    await bot.handle(msg("yes"));

    expect(client.documents).toEqual([
      {
        filename: "INV-2026-0001.pdf",
        bytes: expect.any(Number),
        caption: "Invoice INV-2026-0001 for Rahul Sharma: Rs. 141.60",
      },
    ]);
    expect(emailed.map((i) => [i.number, i.customerEmail, i.totals.totalPaise])).toEqual([
      ["INV-2026-0001", "rahul@example.com", 14160],
    ]);
    expect(client.texts.at(-1)).toBe("Emailed to rahul@example.com.");

    const pdf = await readFile(path.join(dir, "invoices", "INV-2026-0001.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const index = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8"));
    expect(index.counters).toEqual({ "2026": 1 });
    expect(index.invoices[0]).toMatchObject({ number: "INV-2026-0001", totalPaise: 14160, createdBy: OWNER });
  });

  it("numbers invoices sequentially, even when confirmed at the same time", async () => {
    const bot = makeBot({ allowedSenders: new Set() });
    const senders = ["911", "912", "913", "914", "915"];
    for (const s of senders) await bot.handle(msg("invoice for A\nPen - 10", s));
    await Promise.all(senders.map((s) => bot.handle(msg("YES", s))));
    expect(client.documents.map((d) => d.filename).sort()).toEqual([
      "INV-2026-0001.pdf",
      "INV-2026-0002.pdf",
      "INV-2026-0003.pdf",
      "INV-2026-0004.pdf",
      "INV-2026-0005.pdf",
    ]);
  });

  it("does nothing on NO, and a second YES cannot issue the invoice twice", async () => {
    const bot = makeBot();
    await bot.handle(msg(MESSAGE));
    await bot.handle(msg("no"));
    expect(client.texts.at(-1)).toBe("Cancelled. Nothing was created.");
    await bot.handle(msg("yes"));
    expect(client.texts.at(-1)).toContain("no invoice waiting");
    expect(client.documents).toHaveLength(0);

    await bot.handle(msg(MESSAGE));
    await bot.handle(msg("yes"));
    await bot.handle(msg("yes"));
    expect(client.documents).toHaveLength(1);
  });

  it("ignores a re-delivered webhook message", async () => {
    const bot = makeBot();
    const first = msg(MESSAGE);
    await bot.handle(first);
    await bot.handle(first);
    expect(client.texts).toHaveLength(1);
  });

  it("stays silent for senders that are not allowed", async () => {
    const bot = makeBot();
    await bot.handle(msg(MESSAGE, "911111111111"));
    expect(client.texts).toHaveLength(0);
  });

  it("expires a preview after 15 minutes", async () => {
    const bot = makeBot();
    await bot.handle(msg(MESSAGE));
    clock += 16 * 60 * 1000;
    await bot.handle(msg("yes"));
    expect(client.texts.at(-1)).toContain("no invoice waiting");
    expect(client.documents).toHaveLength(0);
  });

  it("still delivers the PDF when the email fails", async () => {
    const bot = makeBot({
      mailer: {
        async sendInvoice() {
          throw new Error("smtp down");
        },
      },
    });
    await bot.handle(msg(MESSAGE));
    await bot.handle(msg("yes"));
    expect(client.documents).toHaveLength(1);
    expect(client.texts.at(-1)).toContain("Could not email rahul@example.com");
  });

  it("explains the format when the message cannot be parsed", async () => {
    const bot = makeBot();
    await bot.handle(msg("what is this"));
    expect(client.texts[0]).toContain("Send *help* to see the format.");
    await bot.handle(msg("help"));
    expect(client.texts[1]).toContain("invoice for Rahul Sharma");
  });
});

describe("webhook", () => {
  const secret = "app-secret";
  const sign = (body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const payload = (text: string, id = "wamid.A") => ({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ id, from: OWNER, type: "text", text: { body: text } }],
              statuses: [{ id: "x", status: "delivered" }],
            },
          },
        ],
      },
    ],
  });

  it("verifies signatures", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySignature(body, sign('{"a":1}'), secret)).toBe(true);
    expect(verifySignature(body, sign('{"a":2}'), secret)).toBe(false);
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, "sha256=zz", secret)).toBe(false);
  });

  it("extracts text messages and ignores everything else", () => {
    expect(extractTextMessages(payload("hello"))).toEqual([{ id: "wamid.A", from: OWNER, text: "hello" }]);
    expect(extractTextMessages({ entry: [{ changes: [{ value: { messages: [{ type: "image", id: "1" }] } }] }] })).toEqual(
      [],
    );
    expect(extractTextMessages(null)).toEqual([]);
    expect(extractTextMessages({ entry: "nope" })).toEqual([]);
  });

  it("serves the verification handshake and rejects unsigned posts", async () => {
    const config = loadConfig({
      WHATSAPP_VERIFY_TOKEN: "verify-me",
      WHATSAPP_APP_SECRET: secret,
      ALLOWED_SENDERS: OWNER,
      DATA_DIR: dir,
    });
    const bot = makeBot();
    const server = createApp(config, bot).listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("12345");
      const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`);
      expect(bad.status).toBe(403);

      const body = JSON.stringify(payload(MESSAGE));
      const headers = { "Content-Type": "application/json" };
      const unsigned = await fetch(`${base}/webhook`, { method: "POST", headers, body });
      expect(unsigned.status).toBe(401);
      expect(client.texts).toHaveLength(0);

      const signed = await fetch(`${base}/webhook`, {
        method: "POST",
        headers: { ...headers, "X-Hub-Signature-256": sign(body) },
        body,
      });
      expect(signed.status).toBe(200);
      // The webhook acknowledges first and processes afterwards.
      for (let i = 0; i < 50 && client.texts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(client.texts[0]).toContain("Invoice preview");
    } finally {
      server.close();
    }
  });
});

describe("config", () => {
  it("refuses an unsafe production setup", () => {
    const base = { NODE_ENV: "production", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" };
    expect(() => loadConfig(base)).toThrow("WHATSAPP_APP_SECRET");
    expect(() => loadConfig({ ...base, WHATSAPP_APP_SECRET: "s", WHATSAPP_VERIFY_TOKEN: "v" })).toThrow(
      "ALLOWED_SENDERS",
    );
    const ok = loadConfig({
      ...base,
      WHATSAPP_APP_SECRET: "s",
      WHATSAPP_VERIFY_TOKEN: "v",
      ALLOWED_SENDERS: "+91 98765-43210, 919999999999",
    });
    expect([...ok.allowedSenders]).toEqual(["919876543210", "919999999999"]);
  });
});
