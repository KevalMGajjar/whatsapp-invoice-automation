import { InvoiceBot, type BotDeps } from "./bot.js";
import type { Config } from "./config.js";
import { createMailer } from "./email/mailer.js";
import { InvoiceStore } from "./invoice/store.js";
import { CloudApiClient, ConsoleClient, type WhatsAppClient } from "./whatsapp/client.js";

/** Build the bot and its dependencies from configuration. */
export function createBot(config: Config, whatsappOverride?: WhatsAppClient): InvoiceBot {
  const whatsapp = whatsappOverride ?? (config.whatsapp ? new CloudApiClient(config.whatsapp) : new ConsoleClient());
  const deps: BotDeps = {
    whatsapp,
    store: new InvoiceStore(config.dataDir),
    business: config.business,
    defaultGstPercent: config.defaultGstPercent,
    allowedSenders: config.allowedSenders,
  };
  if (config.smtp) deps.mailer = createMailer(config.smtp);
  if (config.gemini) deps.gemini = config.gemini;
  return new InvoiceBot(deps);
}
