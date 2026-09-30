import { invoiceDraftSchema, type InvoiceDraft } from "../invoice/types.js";
import { parseWithGemini, type GeminiConfig } from "./geminiParser.js";
import { parseWithRules } from "./ruleParser.js";

export type ParseOutcome =
  | { ok: true; draft: InvoiceDraft; source: "rules" | "gemini" }
  | { ok: false; reason: string };

/** Validate a candidate draft; returns a human-readable reason on failure. */
function validate(candidate: unknown): { draft: InvoiceDraft } | { reason: string } {
  const parsed = invoiceDraftSchema.safeParse(candidate);
  if (parsed.success) return { draft: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") ?? "message";
  if (field === "customerName") return { reason: "I couldn't find the customer's name." };
  if (field === "items") return { reason: "I couldn't find any items with a price." };
  if (field === "customerEmail") return { reason: "The email address doesn't look valid." };
  return { reason: `Problem with ${field}: ${issue?.message ?? "invalid value"}.` };
}

/**
 * Turn a WhatsApp message into a validated invoice draft.
 *
 * 1. The rule parser runs first. If it understood every line and the result
 *    is a valid draft, that is the answer (no network call, no cost).
 * 2. Otherwise, if a Gemini key is configured, the LLM gets the message.
 * 3. Whatever produced the draft, it must pass the same zod schema.
 */
export async function parseMessage(message: string, gemini?: GeminiConfig): Promise<ParseOutcome> {
  const rules = parseWithRules(message);
  const ruleCheck = validate(rules.draft);
  if (rules.unreadable.length === 0 && "draft" in ruleCheck) {
    return { ok: true, draft: ruleCheck.draft, source: "rules" };
  }

  if (gemini) {
    try {
      const llm = await parseWithGemini(message, gemini);
      const llmCheck = validate(llm.draft);
      if ("draft" in llmCheck) return { ok: true, draft: llmCheck.draft, source: "gemini" };
      return { ok: false, reason: llm.problem ?? llmCheck.reason };
    } catch (err) {
      console.error("[parser] Gemini fallback failed:", err instanceof Error ? err.message : err);
      // fall through to the rule parser's explanation
    }
  }

  if (rules.unreadable.length > 0) {
    const shown = rules.unreadable.slice(0, 3).map((l) => `"${l}"`).join(", ");
    return { ok: false, reason: `I couldn't read: ${shown}.` };
  }
  return { ok: false, reason: "reason" in ruleCheck ? ruleCheck.reason : "I couldn't read that message." };
}
