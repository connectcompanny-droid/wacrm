/**
 * Thin 1:1 wrapper around the existing Meta Cloud API helpers.
 *
 * Deliberately does nothing beyond forwarding — behaviour for existing
 * Meta-connected accounts must stay byte-for-byte identical after call
 * sites switch from importing `meta-api.ts` directly to going through
 * this provider via the factory.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from '../meta-api'
import type {
  IWhatsAppProvider,
  ProviderSendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
} from './types'

export class MetaProvider implements IWhatsAppProvider {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
    const result = await sendTextMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: result.messageId }
  }

  async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
    const result = await sendMediaMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: result.messageId }
  }

  async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
    const result = await sendTemplateMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      templateName: args.templateName,
      language: args.language,
      params: args.params,
      template: args.template,
      messageParams: args.messageParams,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: result.messageId }
  }

  async sendInteractiveButtons(
    args: SendInteractiveButtonsArgs,
  ): Promise<ProviderSendResult> {
    const result = await sendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      headerText: args.headerText,
      footerText: args.footerText,
      buttons: args.buttons,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: result.messageId }
  }

  async sendInteractiveList(args: SendInteractiveListArgs): Promise<ProviderSendResult> {
    const result = await sendInteractiveList({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      headerText: args.headerText,
      footerText: args.footerText,
      sections: args.sections,
      contextMessageId: args.contextMessageId,
    })
    return { messageId: result.messageId }
  }
}
