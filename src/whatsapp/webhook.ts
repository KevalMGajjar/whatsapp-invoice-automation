import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header.
 *
 * Meta signs the exact request body with the app secret (HMAC-SHA256). Anyone
 * can find a public webhook URL, so without this check anyone could post fake
 * "messages" and make the bot issue invoices. The comparison is constant-time
 * to avoid leaking how many leading characters matched.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface IncomingMessage {
  /** WhatsApp message id (wamid...), used for de-duplication. */
  id: string;
  /** Sender's number in international format, digits only. */
  from: string;
  text: string;
}

/**
 * Pull text messages out of a Cloud API webhook payload. Status updates
 * (sent/delivered/read) and non-text messages are ignored.
 */
export function extractTextMessages(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (payload as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown[] } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const raw of messages) {
        const m = raw as { id?: unknown; from?: unknown; type?: unknown; text?: { body?: unknown } };
        if (
          m.type === "text" &&
          typeof m.id === "string" &&
          typeof m.from === "string" &&
          typeof m.text?.body === "string"
        ) {
          out.push({ id: m.id, from: m.from, text: m.text.body });
        }
      }
    }
  }
  return out;
}
