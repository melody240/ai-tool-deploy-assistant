ALTER TABLE license_codes
  ADD COLUMN IF NOT EXISTS label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS batch VARCHAR(80),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_app_version VARCHAR(64);

CREATE INDEX IF NOT EXISTS license_codes_batch_idx
  ON license_codes (batch);

CREATE INDEX IF NOT EXISTS license_codes_status_idx
  ON license_codes (status);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor VARCHAR(32) NOT NULL,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(40),
  target_id VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at DESC);
