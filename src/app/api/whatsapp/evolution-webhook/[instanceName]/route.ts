import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { uploadAccountMediaServer } from '@/lib/storage/upload-media-server'
import {
  processNormalizedInboundMessage,
  ALLOWED_CONTENT_TYPES,
  type NormalizedInboundMessage,
} from '@/lib/whatsapp/inbound-pipeline'

// Same bucket the inbox composer uploads outbound attachments to
// (CHAT_MEDIA_BUCKET in src/components/inbox/message-composer.tsx).
// Kept as a literal here rather than importing that constant — it
// lives in a 'use client' component file, and importing from there
// into a server route is best avoided even though the value itself is
// just a string.
const CHAT_MEDIA_BUCKET = 'chat-media'

/**
 * Webhook receiver for a self-hosted Evolution API instance.
 *
 * Unlike Meta's single fixed webhook URL + HMAC signature, Evolution is
 * configured with one webhook URL per instance (set at instance-create
 * time or via `POST /webhook/set/{instance}`) — this route's dynamic
 * `[instanceName]` segment is that per-instance URL:
 *
 *   https://<your-wacrm-domain>/api/whatsapp/evolution-webhook/<instanceName>
 *
 * Authentication: Evolution's webhook payload carries an `apikey` field
 * (the instance's own API key) at the top level. We compare it against
 * the `evolution_api_key` saved for this instance's `whatsapp_config`
 * row — equivalent in spirit to Meta's HMAC check, though weaker (a
 * shared secret in the payload, not a signature over the raw body).
 * If the row has no `evolution_api_key` (an instance intentionally run
 * without auth), the check is skipped — documented as a risk, not
 * silently upgraded.
 *
 * IMPORTANT — verify against your deployed version: the exact
 * `data.message.*` shapes below reflect Baileys' typical message
 * envelope as surfaced by Evolution API's v2 webhook payloads. Diff
 * against a real payload from your instance (log `JSON.stringify(body)`
 * once) if messages aren't landing correctly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface EvolutionMessageKey {
  remoteJid: string
  fromMe: boolean
  id: string
}

interface EvolutionContextInfo {
  stanzaId?: string
}

interface EvolutionMessageContent {
  conversation?: string
  extendedTextMessage?: { text: string; contextInfo?: EvolutionContextInfo }
  imageMessage?: { caption?: string; mimetype?: string; contextInfo?: EvolutionContextInfo }
  videoMessage?: { caption?: string; mimetype?: string; contextInfo?: EvolutionContextInfo }
  documentMessage?: {
    caption?: string
    fileName?: string
    mimetype?: string
    contextInfo?: EvolutionContextInfo
  }
  audioMessage?: { mimetype?: string; contextInfo?: EvolutionContextInfo }
  locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string }
  buttonsResponseMessage?: { selectedButtonId: string; selectedDisplayText?: string }
  listResponseMessage?: {
    singleSelectReply?: { selectedRowId: string }
    title?: string
  }
  /**
   * Present only when the instance's webhook is configured with
   * `webhookBase64: true` (set in POST /api/whatsapp/evolution/instance
   * when registering the webhook) — the media file's bytes, already
   * decrypted by Evolution, as base64. Without it, media messages
   * persist with `mediaUrl: null` — see `resolveMediaUrl` below.
   */
  base64?: string
}

interface EvolutionUpsertData {
  key: EvolutionMessageKey
  pushName?: string
  message?: EvolutionMessageContent
  messageType?: string
  messageTimestamp?: number
  /** Some Evolution versions put the base64 payload here instead of on `message`. */
  base64?: string
}

interface EvolutionConnectionUpdateData {
  state?: 'open' | 'connecting' | 'close'
}

interface EvolutionWebhookBody {
  event?: string
  instance?: string
  apikey?: string
  data?: EvolutionUpsertData | EvolutionUpsertData[] | EvolutionConnectionUpdateData
}

/** Evolution's `remoteJid` is `<digits>@s.whatsapp.net` for a DM, `<id>@g.us` for a group. */
function jidToPhone(remoteJid: string): string | null {
  const [id, domain] = remoteJid.split('@')
  if (domain !== 's.whatsapp.net') return null // skip groups / broadcast lists
  return id
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

function extensionFromMime(mime: string | undefined, fallback: string): string {
  if (!mime) return fallback
  return EXTENSION_BY_MIME[mime] ?? mime.split('/')[1]?.split(';')[0] ?? fallback
}

/**
 * Decode+upload a media message's base64 payload (present only when
 * the instance's webhook was registered with `webhookBase64: true` —
 * see POST /api/whatsapp/evolution/instance) to the same Storage
 * bucket outbound composer attachments use, and return its public URL.
 *
 * Returns null (not a throw) on any failure or when no base64 payload
 * is present at all — inbound processing degrades to a text-only
 * bubble rather than dropping the whole message over a media hiccup.
 */
async function resolveMediaUrl(
  accountId: string,
  externalId: string,
  base64: string | undefined,
  mimetype: string | undefined,
  fileNameHint: string | undefined,
  fallbackExt: string,
): Promise<string | null> {
  if (!base64) return null
  try {
    const bytes = Buffer.from(base64, 'base64')
    const ext = extensionFromMime(mimetype, fallbackExt)
    const fileName = fileNameHint || `${externalId}.${ext}`
    return await uploadAccountMediaServer(
      CHAT_MEDIA_BUCKET,
      accountId,
      fileName,
      bytes,
      mimetype || 'application/octet-stream',
    )
  } catch (err) {
    console.error('[evolution-webhook] media upload failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Map one Baileys/Evolution message envelope to our normalized shape.
 * Returns null for message types we don't (yet) support persisting.
 */
async function normalizeUpsertMessage(
  data: EvolutionUpsertData,
  accountId: string,
): Promise<NormalizedInboundMessage | null> {
  if (data.key.fromMe) return null // echo of our own send — see route doc comment
  const fromPhone = jidToPhone(data.key.remoteJid)
  if (!fromPhone) return null // group/broadcast — not supported yet

  const msg = data.message ?? {}
  // Some Evolution versions put the decoded base64 on `data.base64`,
  // others nest it under `data.message.base64` (or under the specific
  // `*Message` object) — check the plausible spots defensively.
  const rawBase64 = data.base64 ?? msg.base64
  const timestampMs = (data.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000
  const base = {
    externalId: data.key.id,
    fromPhone,
    fromName: data.pushName || fromPhone,
    timestampMs,
  }

  if (typeof msg.conversation === 'string') {
    return {
      ...base,
      contentType: 'text',
      contentText: msg.conversation,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToExternalId: null,
    }
  }
  if (msg.extendedTextMessage) {
    return {
      ...base,
      contentType: 'text',
      contentText: msg.extendedTextMessage.text,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToExternalId: msg.extendedTextMessage.contextInfo?.stanzaId ?? null,
    }
  }
  if (msg.imageMessage) {
    return {
      ...base,
      contentType: 'image',
      contentText: msg.imageMessage.caption || null,
      mediaUrl: await resolveMediaUrl(
        accountId,
        base.externalId,
        rawBase64,
        msg.imageMessage.mimetype,
        undefined,
        'jpg',
      ),
      interactiveReplyId: null,
      replyToExternalId: msg.imageMessage.contextInfo?.stanzaId ?? null,
    }
  }
  if (msg.videoMessage) {
    return {
      ...base,
      contentType: 'video',
      contentText: msg.videoMessage.caption || null,
      mediaUrl: await resolveMediaUrl(
        accountId,
        base.externalId,
        rawBase64,
        msg.videoMessage.mimetype,
        undefined,
        'mp4',
      ),
      interactiveReplyId: null,
      replyToExternalId: msg.videoMessage.contextInfo?.stanzaId ?? null,
    }
  }
  if (msg.documentMessage) {
    return {
      ...base,
      contentType: 'document',
      contentText: msg.documentMessage.caption || msg.documentMessage.fileName || null,
      mediaUrl: await resolveMediaUrl(
        accountId,
        base.externalId,
        rawBase64,
        msg.documentMessage.mimetype,
        msg.documentMessage.fileName,
        'bin',
      ),
      interactiveReplyId: null,
      replyToExternalId: msg.documentMessage.contextInfo?.stanzaId ?? null,
    }
  }
  if (msg.audioMessage) {
    return {
      ...base,
      contentType: 'audio',
      contentText: null,
      mediaUrl: await resolveMediaUrl(
        accountId,
        base.externalId,
        rawBase64,
        msg.audioMessage.mimetype,
        undefined,
        'ogg',
      ),
      interactiveReplyId: null,
      replyToExternalId: msg.audioMessage.contextInfo?.stanzaId ?? null,
    }
  }
  if (msg.locationMessage) {
    const loc = msg.locationMessage
    const locationText = [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`]
      .filter(Boolean)
      .join(' - ')
    return {
      ...base,
      contentType: 'location',
      contentText: locationText,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToExternalId: null,
    }
  }
  if (msg.buttonsResponseMessage) {
    return {
      ...base,
      contentType: 'interactive',
      contentText:
        msg.buttonsResponseMessage.selectedDisplayText ||
        msg.buttonsResponseMessage.selectedButtonId,
      mediaUrl: null,
      interactiveReplyId: msg.buttonsResponseMessage.selectedButtonId,
      replyToExternalId: null,
    }
  }
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return {
      ...base,
      contentType: 'interactive',
      contentText:
        msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply.selectedRowId,
      mediaUrl: null,
      interactiveReplyId: msg.listResponseMessage.singleSelectReply.selectedRowId,
      replyToExternalId: null,
    }
  }

  return null // unsupported message type (e.g. sticker, poll, reaction) — skip for now
}

async function processEvolutionWebhook(instanceName: string, body: EvolutionWebhookBody) {
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, evolution_api_key')
    .eq('evolution_instance_name', instanceName)
    .eq('provider', 'evolution')
    .maybeSingle()

  if (error || !config) {
    console.error('[evolution-webhook] no config found for instance:', instanceName, error)
    return
  }

  if (config.evolution_api_key) {
    const expected = decrypt(config.evolution_api_key)
    if (body.apikey !== expected) {
      console.warn('[evolution-webhook] apikey mismatch for instance:', instanceName)
      return
    }
  }

  if (body.event === 'connection.update') {
    const state = (body.data as EvolutionConnectionUpdateData | undefined)?.state
    if (state === 'open' || state === 'close') {
      await supabaseAdmin()
        .from('whatsapp_config')
        .update({
          status: state === 'open' ? 'connected' : 'disconnected',
          connected_at: state === 'open' ? new Date().toISOString() : null,
        })
        .eq('evolution_instance_name', instanceName)
    }
    return
  }

  if (body.event !== 'messages.upsert') return

  const rawMessages = Array.isArray(body.data) ? body.data : body.data ? [body.data] : []
  for (const raw of rawMessages as EvolutionUpsertData[]) {
    const normalized = await normalizeUpsertMessage(raw, config.account_id)
    if (!normalized) continue
    // Defensive: even though the interface promises a narrowed union,
    // messages.upsert type mapping only ever produces values from
    // ALLOWED_CONTENT_TYPES above — assert that invariant rather than
    // trusting it silently.
    if (!ALLOWED_CONTENT_TYPES.has(normalized.contentType)) continue
    await processNormalizedInboundMessage(normalized, config.account_id, config.user_id)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ instanceName: string }> }
) {
  const { instanceName } = await params
  let body: EvolutionWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Same ack-fast-then-process pattern as the Meta webhook — see
  // src/app/api/whatsapp/webhook/route.ts for why `after()` is required
  // on serverless rather than a detached promise.
  after(async () => {
    try {
      await processEvolutionWebhook(instanceName, body)
    } catch (error) {
      console.error('[evolution-webhook] processing failed:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
