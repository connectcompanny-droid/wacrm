-- ============================================================
-- Idempotent migration — safe to run multiple times.
--
-- Widens `whatsapp_config` into a multi-provider connection row.
-- Existing rows are all Meta connections (DEFAULT 'meta' backfills
-- them for free). `phone_number_id` / `access_token` stay required
-- for Meta rows but become optional for Evolution rows — enforced by
-- a cross-column CHECK rather than relaxing them unconditionally, so
-- a NULL Meta credential still fails loudly.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'evolution'));

-- Evolution-specific columns. All nullable — irrelevant for provider='meta'.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT,
  ADD COLUMN IF NOT EXISTS evolution_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS evolution_base_url TEXT,
  ADD COLUMN IF NOT EXISTS evolution_api_key TEXT;

-- Cross-column guards — belt-and-suspenders alongside app-level
-- validation, so a row can never claim a provider it doesn't have
-- credentials for.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_meta_fields_required;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_meta_fields_required
  CHECK (
    provider <> 'meta'
    OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)
  );

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_evolution_fields_required;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_evolution_fields_required
  CHECK (
    provider <> 'evolution'
    OR (evolution_instance_name IS NOT NULL AND evolution_base_url IS NOT NULL)
  );

-- Webhook routing for Evolution events looks up the config row by
-- instance name (the Evolution-world equivalent of `phone_number_id`),
-- so it must be unique the same way `phone_number_id` already is
-- (migration 013). Partial index — only meaningful (and only non-null)
-- for evolution rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_evolution_instance_name
  ON whatsapp_config(evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

COMMENT ON COLUMN whatsapp_config.provider IS
  'Which WhatsApp connection backend this row talks to: the official Meta Cloud API, or a self-hosted Evolution API instance (QR-code login, unofficial).';
