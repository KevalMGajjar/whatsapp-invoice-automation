import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createBot } from "./setup.js";

const config = loadConfig();
const app = createApp(config, createBot(config));

app.listen(config.port, () => {
  console.log(`Invoice bot listening on http://localhost:${config.port}`);
  console.log(`  WhatsApp: ${config.whatsapp ? "Cloud API" : "console mode (replies are printed here)"}`);
  console.log(`  Parser:   rules${config.gemini ? ` + Gemini (${config.gemini.model})` : ""}`);
  console.log(`  Email:    ${config.smtp ? `SMTP via ${config.smtp.host}` : "disabled"}`);
  console.log(`  Senders:  ${config.allowedSenders.size > 0 ? [...config.allowedSenders].join(", ") : "anyone (set ALLOWED_SENDERS)"}`);
  if (config.whatsapp && !config.appSecret) {
    console.warn("  WARNING: WHATSAPP_APP_SECRET is not set; webhook signatures are not checked.");
  }
});
