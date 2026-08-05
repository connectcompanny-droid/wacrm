/**
 * Provider-agnostic WhatsApp send interface.
 *
 * Mirrors the shape of the existing Meta helpers in `../meta-api.ts` on
 * purpose — every call site that previously called `sendTextMessage`,
 * `sendMediaMessage`, `sendTemplateMessage`, `sendInteractiveButtons` /
 * `sendInteractiveList` directly can switch to calling the same-named
 * method on an `IWhatsAppProvider` instance with the `phoneNumberId` /
 * `accessToken` pair dropped (the provider instance already closes over
 * whichever credentials it needs), keeping the diff at each call site
 * small.
 *
 * `MetaProvider` (./meta-provider.ts) wraps the existing Meta API 1:1.
 * `EvolutionProvider` (./evolution-provider.ts) talks to a self-hosted
 * Evolution API instance instead — no 24h-window / template-approval
 * concept there, so `sendTemplate` degrades to rendering the template
 * body as plain text.
 */

import type { MediaKind, InteractiveButton, InteractiveListSection } from '../meta-api'
import type { SendTimeParams } from '../template-send-builder'
import type { MessageTemplate } from '@/types'

export interface ProviderSendResult {
  messageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

export interface IWhatsAppProvider {
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult>
}
