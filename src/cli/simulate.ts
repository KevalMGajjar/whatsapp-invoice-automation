/**
 * Run the bot locally without WhatsApp.
 *
 *   npm run simulate -- "invoice for Rahul, rahul@example.com; 2 x Notebook @ 45; gst 18"
 *   npm run simulate -- --yes "invoice for Rahul; Pen - 10"     (also confirms, writes the PDF)
 *
 * Use ";" or real newlines between lines. Replies are printed to the terminal;
 * with --yes the PDF is written to <DATA_DIR>/invoices/.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createBot } from "../setup.js";
import { ConsoleClient } from "../whatsapp/client.js";

const args = process.argv.slice(2);
const confirm = args.includes("--yes");
const text = args.filter((a) => a !== "--yes").join(" ").trim();

if (!text) {
  console.error('Usage: npm run simulate -- [--yes] "invoice for <name>, <email>; 2 x Item @ 45; gst 18"');
  process.exit(1);
}

const config = loadConfig();
const bot = createBot(config, new ConsoleClient());
const from = [...config.allowedSenders][0] ?? "910000000000";

await bot.handle({ id: randomUUID(), from, text });
if (confirm) {
  await bot.handle({ id: randomUUID(), from, text: "yes" });
  console.log(`PDF saved under ${config.dataDir}/invoices/`);
}
