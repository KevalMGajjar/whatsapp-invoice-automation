import { z } from "zod";
import type { SmtpConfig } from "./email/mailer.js";
import type { Business } from "./invoice/types.js";
import type { GeminiConfig } from "./parser/geminiParser.js";

/** Treat empty strings (`KEY=` in .env) as "not set". */
const optional = z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.string().default("development"),

  BUSINESS_NAME: z.string().trim().min(1).default("My Business"),
  BUSINESS_ADDRESS: optional,
  BUSINESS_GSTIN: optional,
  BUSINESS_EMAIL: optional,
  BUSINESS_PHONE: optional,
  DEFAULT_GST_PERCENT: z.coerce.number().min(0).max(100).default(0),

  ALLOWED_SENDERS: optional,

  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_VERIFY_TOKEN: optional,
  WHATSAPP_APP_SECRET: optional,
  WHATSAPP_GRAPH_VERSION: z.string().default("v21.0"),

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),

  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,

  DATA_DIR: z.string().default("data"),
});

export interface Config {
  port: number;
  production: boolean;
  business: Business;
  defaultGstPercent: number;
  allowedSenders: Set<string>;
  whatsapp?: { accessToken: string; phoneNumberId: string; graphVersion: string };
  verifyToken?: string;
  appSecret?: string;
  gemini?: GeminiConfig;
  smtp?: SmtpConfig;
  dataDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  const production = e.NODE_ENV === "production";

  const business: Business = { name: e.BUSINESS_NAME };
  if (e.BUSINESS_ADDRESS) business.address = e.BUSINESS_ADDRESS;
  if (e.BUSINESS_GSTIN) business.gstin = e.BUSINESS_GSTIN;
  if (e.BUSINESS_EMAIL) business.email = e.BUSINESS_EMAIL;
  if (e.BUSINESS_PHONE) business.phone = e.BUSINESS_PHONE;

  const config: Config = {
    port: e.PORT,
    production,
    business,
    defaultGstPercent: e.DEFAULT_GST_PERCENT,
    // Keep digits only so "+91 98765-43210" and "919876543210" compare equal.
    allowedSenders: new Set(
      (e.ALLOWED_SENDERS ?? "")
        .split(",")
        .map((n) => n.replace(/\D/g, ""))
        .filter(Boolean),
    ),
    dataDir: e.DATA_DIR,
  };

  if (e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID) {
    config.whatsapp = {
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
      graphVersion: e.WHATSAPP_GRAPH_VERSION,
    };
  }
  if (e.WHATSAPP_VERIFY_TOKEN) config.verifyToken = e.WHATSAPP_VERIFY_TOKEN;
  if (e.WHATSAPP_APP_SECRET) config.appSecret = e.WHATSAPP_APP_SECRET;
  if (e.GEMINI_API_KEY) config.gemini = { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL };
  if (e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS) {
    config.smtp = {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      from: e.SMTP_FROM ?? e.SMTP_USER,
    };
  }

  // A production webhook that accepts unsigned requests, or requests from
  // anyone, would let strangers issue invoices. Refuse to start like that.
  if (production && config.whatsapp) {
    if (!config.appSecret) throw new Error("WHATSAPP_APP_SECRET is required in production");
    if (!config.verifyToken) throw new Error("WHATSAPP_VERIFY_TOKEN is required in production");
    if (config.allowedSenders.size === 0) throw new Error("ALLOWED_SENDERS is required in production");
  }
  return config;
}
