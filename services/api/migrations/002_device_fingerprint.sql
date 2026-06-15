ALTER TABLE license_codes
  ADD COLUMN IF NOT EXISTS bound_device_fingerprint CHAR(64);
