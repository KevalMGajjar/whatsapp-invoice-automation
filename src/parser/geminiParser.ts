import { z } from "zod";
import { rupeesToPaise } from "../invoice/money.js";
import type { InvoiceDraft } from "../invoice/types.js";

/**
 * LLM fallback for free-form messages such as
 * "bill rahul for two notebooks at 45 each and a pen for ten rupees, 18% gst".
 *
 * The model only EXTRACTS what the sender wrote. It is never asked for
 * totals: arithmetic is done in code (see invoice/totals.ts), and the sender
 * confirms a preview before anything is sent.
 */
export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
}

const SYSTEM_PROMPT = `You extract invoice details from a WhatsApp message written by a shop owner in India.
Rules:
- Extract only what the message states. Never invent a customer, an email address, an item or a price.
- unitPrice is the price of ONE unit in rupees, as a number. If the message gives a total for several units, divide it.
- quantity defaults to 1 when not stated.
- Convert number words to digits ("two" -> 2, "ten rupees" -> 10).
- gstPercent, discountPercent and discountAmount only when the message mentions them.
- If the message is not an invoice request, or has no items, return an empty items array and explain why in "problem".`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    customerName: { type: "STRING" },
    customerEmail: { type: "STRING" },
    customerPhone: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          quantity: { type: "NUMBER" },
          unitPrice: { type: "NUMBER" },
        },
        required: ["name", "quantity", "unitPrice"],
      },
    },
    gstPercent: { type: "NUMBER" },
    discountPercent: { type: "NUMBER" },
    discountAmount: { type: "NUMBER" },
    notes: { type: "STRING" },
    problem: { type: "STRING" },
  },
  required: ["items"],
} as const;

const extractionSchema = z.object({
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  customerPhone: z.string().optional(),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), unitPrice: z.number() })),
  gstPercent: z.number().optional(),
  discountPercent: z.number().optional(),
  discountAmount: z.number().optional(),
  notes: z.string().optional(),
  problem: z.string().optional(),
});

export interface GeminiParseResult {
  draft: Partial<InvoiceDraft>;
  /** Why the model could not extract an invoice, if it said so. */
  problem?: string;
}

export async function parseWithGemini(message: string, config: GeminiConfig): Promise<GeminiParseResult> {
  const fetchFn = config.fetchFn ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned no content");

  const data = extractionSchema.parse(JSON.parse(text));
  const draft: Partial<InvoiceDraft> = {
    items: data.items
      .filter((i) => i.name.trim() && i.quantity > 0 && i.unitPrice >= 0)
      .map((i) => ({
        name: i.name.trim(),
        quantity: i.quantity,
        unitPricePaise: rupeesToPaise(i.unitPrice),
      })),
  };
  if (data.customerName?.trim()) draft.customerName = data.customerName.trim();
  // Guard against a hallucinated address: the email must literally appear in the message.
  const email = data.customerEmail?.trim().toLowerCase();
  if (email && message.toLowerCase().includes(email)) draft.customerEmail = email;
  if (data.customerPhone?.trim()) draft.customerPhone = data.customerPhone.replace(/[\s\-]/g, "");
  if (data.gstPercent !== undefined) draft.gstPercent = data.gstPercent;
  if (data.discountPercent !== undefined) {
    draft.discount = { kind: "percent", value: data.discountPercent };
  } else if (data.discountAmount !== undefined) {
    draft.discount = { kind: "amount", paise: rupeesToPaise(data.discountAmount) };
  }
  if (data.notes?.trim()) draft.notes = data.notes.trim();

  const result: GeminiParseResult = { draft };
  if (data.problem?.trim()) result.problem = data.problem.trim();
  return result;
}
