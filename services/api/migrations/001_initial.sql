CREATE TABLE IF NOT EXISTS license_codes (
  id UUID PRIMARY KEY,
  code_hash CHAR(64) NOT NULL UNIQUE,
  prefix VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'disabled')),
  bound_device_id UUID,
  bound_device_fingerprint CHAR(64),
  label VARCHAR(120),
  batch VARCHAR(80),
  expires_at TIMESTAMPTZ,
  last_renewed_at TIMESTAMPTZ,
  last_app_version VARCHAR(64),
  reset_count INTEGER NOT NULL DEFAULT 0 CHECK (reset_count >= 0),
  max_resets INTEGER NOT NULL DEFAULT 1 CHECK (max_resets >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS license_codes_created_at_idx
  ON license_codes (created_at DESC);

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
