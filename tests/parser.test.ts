import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount, percentOf } from "../src/invoice/money.js";
import { computeTotals } from "../src/invoice/totals.js";
import { parseMessage } from "../src/parser/index.js";
import { parseWithRules } from "../src/parser/ruleParser.js";

describe("money", () => {
  it("parses amounts into paise", () => {
    expect(parseAmount("45")).toBe(4500);
    expect(parseAmount("45.5")).toBe(4550);
    expect(parseAmount("1,250.75")).toBe(125075);
    expect(parseAmount("₹45")).toBe(4500);
    expect(parseAmount("Rs. 99.99")).toBe(9999);
    expect(parseAmount("120/-")).toBe(12000);
  });

  it("rejects things that are not amounts", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("45.123")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("formats with Indian digit grouping", () => {
    expect(formatAmount(4500)).toBe("45.00");
    expect(formatAmount(12345678)).toBe("1,23,456.78");
    expect(formatAmount(100000000)).toBe("10,00,000.00");
    expect(formatAmount(5)).toBe("0.05");
  });

  it("rounds percentages to a whole paisa", () => {
    expect(percentOf(9999, 18)).toBe(1800); // 1799.82 -> 1800
    expect(percentOf(100, 0)).toBe(0);
  });
});

describe("rule parser", () => {
  it("reads the documented format", () => {
    const { draft, unreadable } = parseWithRules(
      [
        "invoice for Rahul Sharma, rahul@example.com",
        "2 x Notebook @ 45",
        "Pen x 3 @ 10",
        "Stapler - 120",
        "gst 18",
        "discount 5%",
        "note: Thank you!",
      ].join("\n"),
    );
    expect(unreadable).toEqual([]);
    expect(draft.customerName).toBe("Rahul Sharma");
    expect(draft.customerEmail).toBe("rahul@example.com");
    expect(draft.items).toEqual([
      { name: "Notebook", quantity: 2, unitPricePaise: 4500 },
      { name: "Pen", quantity: 3, unitPricePaise: 1000 },
      { name: "Stapler", quantity: 1, unitPricePaise: 12000 },
    ]);
    expect(draft.gstPercent).toBe(18);
    expect(draft.discount).toEqual({ kind: "percent", value: 5 });
    expect(draft.notes).toBe("Thank you!");
  });

  it("accepts loose variants of item lines", () => {
    const { draft, unreadable } = parseWithRules(
      ["bill to Asha", "2 Notebook 45", "1. Eraser 5", "- Marker: Rs. 30.50", "2 kg Rice @ 60", "T-shirt x2 299"].join(
        "\n",
      ),
    );
    expect(unreadable).toEqual([]);
    expect(draft.items).toEqual([
      { name: "Notebook", quantity: 2, unitPricePaise: 4500 },
      { name: "Eraser", quantity: 1, unitPricePaise: 500 },
      { name: "Marker", quantity: 1, unitPricePaise: 3050 },
      { name: "Rice (kg)", quantity: 2, unitPricePaise: 6000 },
      { name: "T-shirt", quantity: 2, unitPricePaise: 29900 },
    ]);
  });

  it("does not mistake letters inside names for operators", () => {
    const { draft } = parseWithRules("for Dev\n2 xylophone 500\n2 Hat 50\n7up 40\nLessons book 200");
    expect(draft.items.map((i) => [i.name, i.quantity, i.unitPricePaise])).toEqual([
      ["xylophone", 2, 50000],
      ["Hat", 2, 5000],
      ["7up", 1, 4000],
      ["Lessons book", 1, 20000],
    ]);
  });

  it("splits on semicolons and reads phone numbers and fixed discounts", () => {
    const { draft, unreadable } = parseWithRules("invoice for Meera, 98765 43210; Pen - 10; discount 2; tax 5%");
    expect(unreadable).toEqual([]);
    expect(draft.customerName).toBe("Meera");
    expect(draft.customerPhone).toBe("9876543210");
    expect(draft.discount).toEqual({ kind: "amount", paise: 200 });
    expect(draft.gstPercent).toBe(5);
  });

  it("reports lines it cannot read", () => {
    const { unreadable } = parseWithRules("invoice for Rahul\nplease add two notebooks");
    expect(unreadable).toEqual(["please add two notebooks"]);
  });
});

describe("totals", () => {
  it("applies discount before GST", () => {
    const totals = computeTotals({
      customerName: "A",
      items: [
        { name: "Notebook", quantity: 2, unitPricePaise: 4500 },
        { name: "Pen", quantity: 3, unitPricePaise: 1000 },
      ],
      discount: { kind: "percent", value: 10 },
      gstPercent: 18,
    });
    expect(totals.lineTotals).toEqual([9000, 3000]);
    expect(totals.subtotalPaise).toBe(12000);
    expect(totals.discountPaise).toBe(1200);
    expect(totals.taxablePaise).toBe(10800);
    expect(totals.gstPaise).toBe(1944);
    expect(totals.totalPaise).toBe(12744);
  });

  it("caps a fixed discount at the subtotal and uses the default GST", () => {
    const totals = computeTotals(
      {
        customerName: "A",
        items: [{ name: "Pen", quantity: 1, unitPricePaise: 1000 }],
        discount: { kind: "amount", paise: 5000 },
      },
      12,
    );
    expect(totals.discountPaise).toBe(1000);
    expect(totals.totalPaise).toBe(0);
    expect(totals.gstPercent).toBe(12);
  });

  it("handles fractional quantities without float drift", () => {
    const totals = computeTotals({
      customerName: "A",
      items: [{ name: "Rice (kg)", quantity: 1.5, unitPricePaise: 6033 }],
    });
    expect(totals.lineTotals).toEqual([9050]); // 9049.5 rounds to 9050
  });
});

/** A fake Gemini endpoint that returns `payload` as the model's JSON answer. */
function fakeGemini(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }), {
      status: 200,
    })) as typeof fetch;
}

describe("parseMessage", () => {
  it("uses the rule parser when it understands everything (no LLM call)", async () => {
    let called = false;
    const outcome = await parseMessage("invoice for Rahul\nPen - 10", {
      apiKey: "k",
      model: "m",
      fetchFn: (async () => {
        called = true;
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(outcome).toMatchObject({ ok: true, source: "rules" });
    expect(called).toBe(false);
  });

  it("falls back to Gemini for free-form text and converts rupees to paise", async () => {
    const message = "bill rahul (rahul@example.com) for two notebooks at 45 each and a pen for ten rupees";
    const outcome = await parseMessage(message, {
      apiKey: "k",
      model: "m",
      fetchFn: fakeGemini({
        customerName: "Rahul",
        customerEmail: "rahul@example.com",
        items: [
          { name: "Notebook", quantity: 2, unitPrice: 45 },
          { name: "Pen", quantity: 1, unitPrice: 10 },
        ],
      }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.source).toBe("gemini");
      expect(outcome.draft.items[0]).toEqual({ name: "Notebook", quantity: 2, unitPricePaise: 4500 });
      expect(outcome.draft.customerEmail).toBe("rahul@example.com");
    }
  });

  it("drops an email the model invented", async () => {
    const outcome = await parseMessage("bill rahul for a pen costing ten rupees", {
      apiKey: "k",
      model: "m",
      fetchFn: fakeGemini({
        customerName: "Rahul",
        customerEmail: "rahul@gmail.com",
        items: [{ name: "Pen", quantity: 1, unitPrice: 10 }],
      }),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.draft.customerEmail).toBeUndefined();
  });

  it("explains what is missing when nothing can parse the message", async () => {
    expect(await parseMessage("Pen - 10")).toEqual({ ok: false, reason: "I couldn't find the customer's name." });
    expect(await parseMessage("invoice for Rahul")).toEqual({
      ok: false,
      reason: "I couldn't find any items with a price.",
    });
    const unreadable = await parseMessage("invoice for Rahul\nsome words");
    expect(unreadable).toEqual({ ok: false, reason: 'I couldn\'t read: "some words".' });
  });

  it("survives a Gemini outage", async () => {
    const outcome = await parseMessage("invoice for Rahul\nsome words", {
      apiKey: "k",
      model: "m",
      fetchFn: (async () => new Response("overloaded", { status: 503 })) as typeof fetch,
    });
    expect(outcome.ok).toBe(false);
  });
});
