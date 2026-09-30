import { randomUUID } from "node:crypto";
import express, { type Express, type Request } from "express";
import type { InvoiceBot } from "./bot.js";
import type { Config } from "./config.js";
import { RecordingClient } from "./whatsapp/client.js";
import { extractTextMessages, verifySignature } from "./whatsapp/webhook.js";

type RawBodyRequest = Request & { rawBody?: Buffer };

export function createApp(config: Config, bot: InvoiceBot): Express {
  const app = express();
  app.disable("x-powered-by");

  // Keep the raw bytes: the webhook signature is computed over them, and
  // re-serializing the parsed JSON would not reproduce them exactly.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Meta calls this once, when the webhook URL is registered.
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && config.verifyToken && token === config.verifyToken && typeof challenge === "string") {
      res.status(200).type("text/plain").send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // Incoming messages.
  app.post("/webhook", (req: RawBodyRequest, res) => {
    if (config.appSecret) {
      const signature = req.get("x-hub-signature-256");
      if (!req.rawBody || !verifySignature(req.rawBody, signature, config.appSecret)) {
        res.sendStatus(401);
        return;
      }
    }
    // Acknowledge first: Meta retries if it doesn't get a 200 within a few
    // seconds, and parsing + PDF + email can take longer than that.
    res.sendStatus(200);

    const messages = extractTextMessages(req.body);
    void (async () => {
      for (const message of messages) {
        await bot.handle(message);
      }
    })();
  });

  // Local testing without WhatsApp: POST {"text": "...", "from": "..."}.
  if (!config.production) {
    app.post("/dev/message", async (req, res) => {
      const body = req.body as { text?: unknown; from?: unknown } | undefined;
      if (typeof body?.text !== "string") {
        res.status(400).json({ error: 'expected JSON body {"text": "..."}' });
        return;
      }
      const from = typeof body.from === "string" ? body.from.replace(/\D/g, "") : "";
      const sender = from || [...config.allowedSenders][0] || "910000000000";
      const client = new RecordingClient();
      await bot.handle({ id: `dev-${randomUUID()}`, from: sender, text: body.text }, client);
      res.json({ replies: client.texts, documents: client.documents });
    });
  }

  return app;
}
