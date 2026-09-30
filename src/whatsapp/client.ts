/** Outbound WhatsApp operations the bot needs. */
export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<void>;
  sendDocument(to: string, file: Buffer, filename: string, caption?: string): Promise<void>;
}

export interface CloudApiConfig {
  accessToken: string;
  phoneNumberId: string;
  /** e.g. "v21.0" */
  graphVersion: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
}

/**
 * Client for Meta's WhatsApp Cloud API.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export class CloudApiClient implements WhatsAppClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: CloudApiConfig) {
    this.base = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}`;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private async post(path: string, body: BodyInit, json: boolean): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.config.accessToken}` };
    if (json) headers["Content-Type"] = "application/json";
    const response = await this.fetchFn(`${this.base}/${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`WhatsApp API ${path} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  }

  async sendText(to: string, body: string): Promise<void> {
    await this.post(
      "messages",
      JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: false } }),
      true,
    );
  }

  /** Upload the file as media, then send it as a document message. */
  async sendDocument(to: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(file)], { type: "application/pdf" }), filename);
    const uploaded = (await this.post("media", form, false)) as { id?: string };
    if (!uploaded.id) throw new Error("WhatsApp media upload returned no id");

    const document: Record<string, string> = { id: uploaded.id, filename };
    if (caption) document.caption = caption;
    await this.post(
      "messages",
      JSON.stringify({ messaging_product: "whatsapp", to, type: "document", document }),
      true,
    );
  }
}

/** Prints replies instead of sending them. Used when no access token is configured. */
export class ConsoleClient implements WhatsAppClient {
  async sendText(to: string, body: string): Promise<void> {
    console.log(`\n[whatsapp -> ${to}]\n${body}\n`);
  }

  async sendDocument(to: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    console.log(`\n[whatsapp -> ${to}] document ${filename} (${file.length} bytes)${caption ? `: ${caption}` : ""}\n`);
  }
}

/** Records replies; used by the local simulate endpoint and by tests. */
export class RecordingClient implements WhatsAppClient {
  readonly texts: string[] = [];
  readonly documents: { filename: string; bytes: number; caption?: string }[] = [];

  async sendText(_to: string, body: string): Promise<void> {
    this.texts.push(body);
  }

  async sendDocument(_to: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    const doc: { filename: string; bytes: number; caption?: string } = { filename, bytes: file.length };
    if (caption) doc.caption = caption;
    this.documents.push(doc);
  }
}
