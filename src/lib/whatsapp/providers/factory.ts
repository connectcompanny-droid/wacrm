/**
 * Resolves the right `IWhatsAppProvider` for an account's saved
 * `whatsapp_config` row, so send call sites don't need to know whether
 * the account is on the official Meta Cloud API or a self-hosted
 * Evolution API instance.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '../encryption'
import { MetaProvider } from './meta-provider'
import { EvolutionProvider } from './evolution-provider'
import type { IWhatsAppProvider } from './types'

export class ProviderConfigError extends Error {}

/**
 * Row shape this factory needs — a subset of `whatsapp_config`. Callers
 * that already fetched the full row (most send call sites do, to read
 * `phone_number_id` / `account_id` / etc. for their own purposes) can
 * pass it straight through instead of re-querying.
 */
export interface WhatsAppConfigRow {
  provider: string | null
  phone_number_id: string | null
  access_token: string | null
  evolution_instance_name: string | null
  evolution_base_url: string | null
  evolution_api_key: string | null
}

/**
 * Build a provider instance from an already-fetched config row.
 * Throws `ProviderConfigError` if the row is missing the fields its
 * provider needs — callers should treat that the same as "WhatsApp not
 * configured".
 */
export function providerFromConfig(config: WhatsAppConfigRow): IWhatsAppProvider {
  const provider = config.provider ?? 'meta'

  if (provider === 'evolution') {
    if (!config.evolution_instance_name || !config.evolution_base_url) {
      throw new ProviderConfigError(
        'Evolution API connection is missing instance_name or base_url.',
      )
    }
    // API key is optional at the HTTP layer (a self-hosted instance can
    // run without auth), but decrypt it when present.
    const apiKey = config.evolution_api_key ? decrypt(config.evolution_api_key) : null
    return new EvolutionProvider({
      baseUrl: config.evolution_base_url,
      instanceName: config.evolution_instance_name,
      apiKey,
    })
  }

  if (!config.phone_number_id || !config.access_token) {
    throw new ProviderConfigError(
      'Meta connection is missing phone_number_id or access_token.',
    )
  }
  return new MetaProvider(config.phone_number_id, decrypt(config.access_token))
}

/**
 * Fetch the account's `whatsapp_config` row and build its provider in
 * one call. Throws `ProviderConfigError` when no row exists, mirroring
 * the "WhatsApp not configured" failure every existing call site
 * already special-cases.
 */
export async function getProviderForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<{ provider: IWhatsAppProvider; config: WhatsAppConfigRow & Record<string, unknown> }> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()

  if (error || !config) {
    throw new ProviderConfigError('WhatsApp not configured for this account.')
  }

  return { provider: providerFromConfig(config), config }
}
