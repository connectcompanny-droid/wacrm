/**
 * Server-only counterpart to `upload-media.ts`'s `uploadAccountMedia`.
 *
 * That helper uses the browser Supabase client and an authenticated
 * user session — fine for the composer / template manager (client
 * components), but unusable from a webhook handler, which has no user
 * session and runs entirely server-side. This uses the service-role
 * client instead, going straight through (bypasses the bucket's RLS
 * write policy, which is fine — the service role is trusted).
 *
 * Deliberately its own file, not added to `upload-media.ts`: that file
 * is imported by several 'use client' components, and pulling in
 * `@/lib/flows/admin-client` (which reads `SUPABASE_SERVICE_ROLE_KEY`)
 * there would risk that server-only secret being reachable from a
 * client bundle.
 */

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildMediaPath } from './upload-media'

/**
 * Upload raw bytes to an account-scoped Storage bucket path and return
 * the public URL. Same path convention as `uploadAccountMedia`
 * (`<bucket>/account-<account_id>/<timestamp>-<basename>.<ext>`), so
 * existing bucket RLS read policies and any tooling that assumes that
 * shape keep working regardless of which path uploaded the object.
 */
export async function uploadAccountMediaServer(
  bucket: string,
  accountId: string,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const path = buildMediaPath(accountId, fileName)
  const { error } = await supabaseAdmin()
    .storage.from(bucket)
    .upload(path, bytes, {
      cacheControl: '3600',
      upsert: false,
      contentType,
    })
  if (error) throw new Error(error.message)

  const {
    data: { publicUrl },
  } = supabaseAdmin().storage.from(bucket).getPublicUrl(path)
  return publicUrl
}
