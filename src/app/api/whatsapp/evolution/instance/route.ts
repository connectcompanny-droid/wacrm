import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * QR-code onboarding for a self-hosted Evolution API instance.
 *
 *   POST — create (or re-create) this account's Evolution instance and
 *          return a QR code to scan with WhatsApp.
 *   GET  — fetch a fresh QR for an already-created-but-not-yet-connected
 *          instance (the first QR expires after ~60s).
 *
 * Requires the operator to have deployed their own Evolution API
 * instance (see README / docker-compose.evolution.yml) and set
 * `EVOLUTION_API_GLOBAL_URL` + `EVOLUTION_API_GLOBAL_KEY` — the admin
 * credentials for that deployment, distinct from the per-instance
 * `evolution_api_key` Evolution generates for each connected number
 * (which is what actually authenticates message sends and webhooks).
 */

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

function globalEvolutionConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.EVOLUTION_API_GLOBAL_URL
  const apiKey = process.env.EVOLUTION_API_GLOBAL_KEY
  if (!baseUrl || !apiKey) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey }
}

/** Deterministic per-account instance name — stable across reconnects. */
function instanceNameForAccount(accountId: string): string {
  return `wacrm-${accountId}`
}

/**
 * Evolution API's `qrcode.base64` / `/instance/connect` `base64` field
 * comes back as a full data URI (`data:image/png;base64,<data>`), not
 * bare base64 — despite the field name. Strip it here so this route's
 * `qrcode_base64` response is always the raw base64 payload; the
 * frontend prepends its own `data:image/png;base64,` prefix when
 * building the `<img src>`, and stacking both produced a corrupted,
 * unrenderable data URI.
 */
function stripDataUriPrefix(value: string): string {
  const match = value.match(/^data:[^;]+;base64,([\s\S]+)$/)
  return match ? match[1] : value
}

interface EvolutionErrorResponse {
  message?: string | string[]
  error?: string
}

async function evolutionFetch<T>(
  baseUrl: string,
  path: string,
  init: RequestInit & { apiKey: string },
): Promise<T> {
  const { apiKey, ...rest } = init
  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', apikey: apiKey, ...rest.headers },
  })
  if (!response.ok) {
    let message = `Evolution API error: ${response.status}`
    try {
      const data = (await response.json()) as EvolutionErrorResponse
      const raw = data.message ?? data.error
      if (raw) message = Array.isArray(raw) ? raw.join('; ') : raw
    } catch {
      // not JSON — keep fallback
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

interface CreateInstanceResponse {
  instance?: { instanceId?: string; instanceName?: string }
  hash?: { apikey?: string } | string
  qrcode?: { base64?: string; code?: string }
}

interface ConnectResponse {
  base64?: string
  code?: string
}

export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const globalConfig = globalEvolutionConfig()
    if (!globalConfig) {
      return NextResponse.json(
        {
          error:
            'Evolution API is not configured on this wacrm deployment. Set EVOLUTION_API_GLOBAL_URL and EVOLUTION_API_GLOBAL_KEY (see README) before connecting via QR code.',
        },
        { status: 400 },
      )
    }
    if (!process.env.NEXT_PUBLIC_SITE_URL) {
      return NextResponse.json(
        {
          error:
            'NEXT_PUBLIC_SITE_URL is not set — required to register the Evolution webhook URL for this instance.',
        },
        { status: 400 },
      )
    }

    const instanceName = instanceNameForAccount(accountId)

    // Look up any connection already saved for this account BEFORE
    // touching Evolution. `instanceNameForAccount` is deterministic, so
    // a second "Generate QR Code" click (QR expired, user re-opened
    // Settings, etc.) would otherwise call /instance/create again for a
    // name that already exists. Different Evolution versions signal
    // that differently — some return a friendly "already exists"
    // message, others a bare 403 Forbidden — which made string-matching
    // the error fragile. Simplest robust fix: if we already have a
    // saved instance for this account, skip /instance/create entirely
    // and go straight to /instance/connect (same as the GET handler),
    // reusing the previously-stored per-instance API key.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, provider, evolution_instance_name, evolution_instance_id, evolution_api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    const reusingInstance =
      existing?.provider === 'evolution' && existing.evolution_instance_name === instanceName

    let created: CreateInstanceResponse = {}
    let instanceApiKey: string | undefined = reusingInstance && existing?.evolution_api_key
      ? decrypt(existing.evolution_api_key)
      : undefined

    if (!reusingInstance) {
      try {
        created = await evolutionFetch<CreateInstanceResponse>(
          globalConfig.baseUrl,
          '/instance/create',
          {
            method: 'POST',
            apiKey: globalConfig.apiKey,
            body: JSON.stringify({
              instanceName,
              qrcode: true,
              integration: 'WHATSAPP-BAILEYS',
            }),
          },
        )
        instanceApiKey =
          typeof created.hash === 'string' ? created.hash : created.hash?.apikey
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[evolution/instance] create failed:', message)
        return NextResponse.json(
          { error: `Evolution API error creating instance: ${message}` },
          { status: 502 },
        )
      }
    }

    // Register (or re-register) this instance's webhook to point at our
    // Evolution webhook route — idempotent on Evolution's side.
    try {
      await evolutionFetch(globalConfig.baseUrl, `/webhook/set/${instanceName}`, {
        method: 'POST',
        apiKey: instanceApiKey ?? globalConfig.apiKey,
        body: JSON.stringify({
          webhook: {
            enabled: true,
            url: `${process.env.NEXT_PUBLIC_SITE_URL}/api/whatsapp/evolution-webhook/${instanceName}`,
            events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
            // Without this, inbound media (image/video/document/audio)
            // messages carry no retrievable file — Evolution reports
            // the message but not its decrypted bytes, and the
            // webhook route has nothing to upload/display. With it,
            // the media's decoded bytes ride along in the webhook
            // payload (see resolveMediaUrl in the webhook route).
            webhookBase64: true,
          },
        }),
      })
    } catch (err) {
      console.warn(
        '[evolution/instance] webhook registration failed (non-fatal, retry from Settings):',
        err instanceof Error ? err.message : err,
      )
    }

    // If the instance is already logged in (the common case when this
    // POST is a "resync the webhook config" call from an already-
    // connected Settings page, not a first-time connect), Evolution
    // won't return a QR at all — asking for one is meaningless once
    // authenticated. Check first so that case is a clean success
    // response instead of the "no QR returned" error below.
    let alreadyConnected = false
    try {
      const state = await evolutionFetch<{ instance?: { state?: string } }>(
        globalConfig.baseUrl,
        `/instance/connectionState/${instanceName}`,
        { method: 'GET', apiKey: instanceApiKey ?? globalConfig.apiKey },
      )
      alreadyConnected = state.instance?.state === 'open'
    } catch (err) {
      // Instance genuinely brand new (never connected) — connectionState
      // may 404 here on some Evolution versions. Fall through to the QR
      // flow below, which is the correct path for that case anyway.
      console.warn(
        '[evolution/instance] connectionState check failed (treating as not-yet-connected):',
        err instanceof Error ? err.message : err,
      )
    }

    let qrBase64: string | null = null
    if (!alreadyConnected) {
      // QR may already be in the create response; otherwise fetch it.
      qrBase64 = created.qrcode?.base64 ?? null
      if (!qrBase64) {
        const connect = await evolutionFetch<ConnectResponse>(
          globalConfig.baseUrl,
          `/instance/connect/${instanceName}`,
          { method: 'GET', apiKey: instanceApiKey ?? globalConfig.apiKey },
        )
        qrBase64 = connect.base64 ?? null
      }
    }

    // Persist the connection row. Same account_id-keyed upsert pattern
    // as the Meta config route. `existing` was already fetched above
    // (before deciding whether to call /instance/create). Only clobber
    // status/connected_at when we have fresh evidence either way —
    // `alreadyConnected` (a live check we just made) or a first-time
    // create (definitely not connected yet); don't blindly stamp
    // 'disconnected' over a row that's actually still live.
    const row = {
      provider: 'evolution' as const,
      evolution_instance_name: instanceName,
      evolution_instance_id:
        created.instance?.instanceId ?? (reusingInstance ? existing?.evolution_instance_id ?? null : null),
      evolution_base_url: globalConfig.baseUrl,
      evolution_api_key: instanceApiKey ? encrypt(instanceApiKey) : null,
      status: alreadyConnected ? ('connected' as const) : ('disconnected' as const),
      connected_at: alreadyConnected ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', accountId)
      if (updateError) {
        console.error('[evolution/instance] update failed:', updateError)
        return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase.from('whatsapp_config').insert({
        account_id: accountId,
        user_id: user.id,
        ...row,
      })
      if (insertError) {
        console.error('[evolution/instance] insert failed:', insertError)
        return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
      }
    }

    if (alreadyConnected) {
      return NextResponse.json({
        instance_name: instanceName,
        already_connected: true,
      })
    }

    if (!qrBase64) {
      return NextResponse.json(
        {
          error:
            'Instance created but Evolution API did not return a QR code. Try GET /api/whatsapp/evolution/instance to fetch one.',
        },
        { status: 502 },
      )
    }

    return NextResponse.json({
      qrcode_base64: stripDataUriPrefix(qrBase64),
      instance_name: instanceName,
    })
  } catch (error) {
    console.error('[evolution/instance] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Refresh the QR code for an already-created instance (the first one expires quickly). */
export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('provider, evolution_instance_name, evolution_base_url, evolution_api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError || !config || config.provider !== 'evolution' || !config.evolution_instance_name || !config.evolution_base_url) {
      return NextResponse.json(
        { error: 'No Evolution API connection found for this account. Start one with POST first.' },
        { status: 400 },
      )
    }

    const apiKey = config.evolution_api_key
      ? decrypt(config.evolution_api_key)
      : (globalEvolutionConfig()?.apiKey ?? '')

    const connect = await evolutionFetch<ConnectResponse>(
      config.evolution_base_url,
      `/instance/connect/${config.evolution_instance_name}`,
      { method: 'GET', apiKey },
    )

    if (!connect.base64) {
      return NextResponse.json(
        { error: 'Evolution API did not return a QR code — the instance may already be connected.' },
        { status: 400 },
      )
    }

    return NextResponse.json({
      qrcode_base64: stripDataUriPrefix(connect.base64),
      instance_name: config.evolution_instance_name,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[evolution/instance] GET failed:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
