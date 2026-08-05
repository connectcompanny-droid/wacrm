/**
 * Client for a self-hosted Evolution API instance
 * (https://doc.evolution-api.com/), which wraps Baileys — the
 * unofficial WhatsApp Web protocol — behind a REST API + webhooks.
 * Connecting a number happens by scanning a QR code (see
 * `POST /instance/connect/{instance}`), not through Meta's
 * app/WABA/template-approval flow.
 *
 * IMPORTANT — verify against your deployed version before going live:
 * Evolution API's endpoint/payload shape has changed across major
 * versions (this targets the v2 REST surface documented at the URL
 * above as of 2025). If your instance is on an older/newer version,
 * diff the request bodies below against your instance's Swagger docs
 * (`{baseUrl}/docs`) and adjust.
 *
 * Unlike the Meta Cloud API:
 *   - there is no 24-hour customer-service-window restriction — any
 *     message can be sent to any contact at any time;
 *   - there is no template-approval concept — `sendTemplate` below
 *     renders the template body as plain text and sends it as a
 *     regular message;
 *   - native interactive buttons/lists are best-effort — WhatsApp has
 *     been deprecating button rendering for non-Business-API senders,
 *     so these may silently degrade to plain text on the recipient's
 *     device depending on their WhatsApp client version.
 */

import type {
  IWhatsAppProvider,
  ProviderSendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
} from './types'

export interface EvolutionProviderConfig {
  /** e.g. https://evolution.yourdomain.com — no trailing slash. */
  baseUrl: string
  /** Name of the instance created via POST /instance/create. */
  instanceName: string
  /** Instance-level API key (Evolution's `apikey` header). Null for an
   *  instance running without auth (not recommended outside local dev). */
  apiKey: string | null
}

interface EvolutionErrorResponse {
  message?: string | string[]
  error?: string
}

/** Substitutes `{{1}}`, `{{2}}`, … in a template body with positional params. */
export function renderTemplateBody(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{(\d+)\}\}/g, (match, indexStr) => {
    const index = Number(indexStr) - 1
    return params[index] ?? match
  })
}

export class EvolutionProvider implements IWhatsAppProvider {
  constructor(private readonly config: EvolutionProviderConfig) {}

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.config.baseUrl}/${path}/${this.config.instanceName}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.apikey = this.config.apiKey

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!response.ok) {
      let message = `Evolution API error: ${response.status}`
      try {
        const data = (await response.json()) as EvolutionErrorResponse
        const raw = data.message ?? data.error
        if (raw) message = Array.isArray(raw) ? raw.join('; ') : raw
      } catch {
        // response body wasn't JSON — keep the fallback
      }
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }

  /** Evolution wants a bare number (digits only, no `+`), unlike Meta's E.164-with-`+`. */
  private static toEvolutionNumber(to: string): string {
    return to.replace(/^\+/, '')
  }

  async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
    const data = await this.request<{ key?: { id?: string } }>('message/sendText', {
      number: EvolutionProvider.toEvolutionNumber(args.to),
      text: args.text,
      ...(args.contextMessageId
        ? { quoted: { key: { id: args.contextMessageId } } }
        : {}),
    })
    return { messageId: data.key?.id ?? '' }
  }

  async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
    // Evolution's mediatype enum only distinguishes image/video/document —
    // audio is sent through the same sendMedia endpoint with
    // mediatype: 'audio' on the versions this targets. If your instance
    // instead exposes a dedicated `sendWhatsAppAudio` endpoint for voice
    // notes, route 'audio' there instead.
    const data = await this.request<{ key?: { id?: string } }>('message/sendMedia', {
      number: EvolutionProvider.toEvolutionNumber(args.to),
      mediatype: args.kind,
      media: args.link,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.filename ? { fileName: args.filename } : {}),
      ...(args.contextMessageId
        ? { quoted: { key: { id: args.contextMessageId } } }
        : {}),
    })
    return { messageId: data.key?.id ?? '' }
  }

  /**
   * No template-approval concept in Evolution/Baileys — render the
   * saved template body with its params substituted and send as plain
   * text. `params` (legacy positional) wins when present; otherwise
   * falls back to `messageParams.body` (the structured form other
   * callers pass).
   */
  async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
    const bodyText = args.template?.body_text
    if (!bodyText) {
      throw new Error(
        `Cannot send template "${args.templateName}" via Evolution API: no local template row with body_text found. Evolution has no server-side template store — the row must exist locally.`,
      )
    }
    const params =
      args.params && args.params.length > 0
        ? args.params
        : ((args.messageParams as { body?: string[] } | undefined)?.body ?? [])
    const text = renderTemplateBody(bodyText, params)
    return this.sendText({ to: args.to, text, contextMessageId: args.contextMessageId })
  }

  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<ProviderSendResult> {
    const data = await this.request<{ key?: { id?: string } }>('message/sendButtons', {
      number: EvolutionProvider.toEvolutionNumber(args.to),
      title: args.headerText ?? '',
      description: args.bodyText,
      footer: args.footerText ?? '',
      buttons: args.buttons.map((b) => ({
        type: 'reply',
        displayText: b.title,
        id: b.id,
      })),
    })
    return { messageId: data.key?.id ?? '' }
  }

  async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
    const data = await this.request<{ key?: { id?: string } }>('message/sendList', {
      number: EvolutionProvider.toEvolutionNumber(args.to),
      title: args.headerText ?? '',
      description: args.bodyText,
      footerText: args.footerText ?? '',
      buttonText: args.buttonLabel,
      sections: args.sections.map((s) => ({
        title: s.title ?? '',
        rows: s.rows.map((r) => ({
          title: r.title,
          description: r.description ?? '',
          rowId: r.id,
        })),
      })),
    })
    return { messageId: data.key?.id ?? '' }
  }
}
