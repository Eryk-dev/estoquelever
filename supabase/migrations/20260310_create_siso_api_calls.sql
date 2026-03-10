-- Rate limiter tracking table for Tiny API calls per branch
CREATE TABLE IF NOT EXISTS siso_api_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filial text NOT NULL,
  endpoint text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_siso_api_calls_filial_called_at
  ON siso_api_calls (filial, called_at);
