

DROP TABLE IF EXISTS result_flags, impact_cases, notifications, alert_events, alerts,
  duplicate_messages, dead_letters, decisions, results, rule_sets, settings,
  audit_log, users, instruments, labs CASCADE;
DROP VIEW IF EXISTS current_decisions;
DROP FUNCTION IF EXISTS block_changes() CASCADE;


CREATE TABLE labs (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE instruments (
  id     TEXT PRIMARY KEY,
  lab_id TEXT NOT NULL REFERENCES labs(id)
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor')),
  lab_id        TEXT NOT NULL REFERENCES labs(id),
  token         TEXT UNIQUE NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);


CREATE TABLE rule_sets (
  version        INT PRIMARY KEY,
  effective_from TIMESTAMPTZ NOT NULL,
  description    TEXT,
  config         JSONB NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE results (
  id                 BIGSERIAL PRIMARY KEY,
  sample_id          TEXT NOT NULL,
  patient            TEXT NOT NULL,
  analyte            TEXT NOT NULL,
  value              DOUBLE PRECISION NOT NULL,
  unit               TEXT NOT NULL,
  instrument         TEXT NOT NULL REFERENCES instruments(id),
  lab_id             TEXT NOT NULL REFERENCES labs(id),
  reagent_lot        TEXT NOT NULL,
  h_index            DOUBLE PRECISION NOT NULL,
  i_index            DOUBLE PRECISION NOT NULL,
  l_index            DOUBLE PRECISION NOT NULL,
  instrument_flags   JSONB NOT NULL DEFAULT '[]',
  collected_at       TIMESTAMPTZ NOT NULL,   
  original_timestamp TEXT NOT NULL,            
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  message_hash       TEXT NOT NULL,
  version            INT NOT NULL DEFAULT 1,
  corrects_result_id BIGINT REFERENCES results(id),
  correction_reason  TEXT,
  created_by         TEXT NOT NULL DEFAULT 'analyzer',
  CONSTRAINT results_unique_message UNIQUE (sample_id, analyte, version)
);

CREATE INDEX idx_results_patient ON results (patient, analyte, collected_at);
CREATE INDEX idx_results_lab ON results (lab_id, id DESC);
CREATE INDEX idx_results_instrument ON results (instrument, analyte, collected_at);
CREATE INDEX idx_results_lot ON results (reagent_lot, collected_at);

CREATE TABLE decisions (
  id               BIGSERIAL PRIMARY KEY,
  result_id        BIGINT NOT NULL REFERENCES results(id),
  seq              INT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('RELEASED', 'HELD', 'REJECTED')),
  rule_set_version INT REFERENCES rule_sets(version),
  triggered_rules  JSONB NOT NULL DEFAULT '[]',
  reason           TEXT,

  previous_result_id BIGINT REFERENCES results(id),
  decided_by       TEXT NOT NULL,   
  decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (result_id, seq)
);


CREATE VIEW current_decisions AS
  SELECT DISTINCT ON (result_id) *
  FROM decisions
  ORDER BY result_id, seq DESC;

CREATE TABLE dead_letters (
  id          BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_message TEXT NOT NULL,
  reason      TEXT NOT NULL,
  lab_id      TEXT REFERENCES labs(id)  
);

CREATE TABLE duplicate_messages (
  id          BIGSERIAL PRIMARY KEY,
  result_id   BIGINT NOT NULL REFERENCES results(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE alerts (
  id              BIGSERIAL PRIMARY KEY,
  lab_id          TEXT NOT NULL REFERENCES labs(id),
  type            TEXT NOT NULL,
  group_key       TEXT NOT NULL,    
  instrument      TEXT,
  analyte         TEXT,
  reagent_lot     TEXT,
  message         TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED')),
  occurrences     INT NOT NULL DEFAULT 1,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  escalated_at    TIMESTAMPTZ
);

CREATE INDEX idx_alerts_group ON alerts (group_key, last_seen);

CREATE TABLE notifications (
  id              BIGSERIAL PRIMARY KEY,
  alert_id        BIGINT NOT NULL REFERENCES alerts(id),
  lab_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,        
  recipient       TEXT NOT NULL,          
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  channel         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

CREATE INDEX idx_notifications_pending ON notifications (status, next_attempt_at);


CREATE TABLE impact_cases (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('instrument', 'reagent_lot')),
  target      TEXT NOT NULL,
  start_time  TIMESTAMPTZ NOT NULL,  
  description TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE result_flags (
  id             BIGSERIAL PRIMARY KEY,
  result_id      BIGINT NOT NULL REFERENCES results(id),
  impact_case_id BIGINT NOT NULL REFERENCES impact_cases(id),
  flag           TEXT NOT NULL DEFAULT 'POTENTIALLY_AFFECTED',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (result_id, impact_case_id)
);


CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  username   TEXT NOT NULL,
  role       TEXT,
  lab_id     TEXT,
  action     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '{}', 
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);


CREATE FUNCTION block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. % is not allowed.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER results_no_change BEFORE UPDATE OR DELETE ON results
  FOR EACH ROW EXECUTE FUNCTION block_changes();
CREATE TRIGGER decisions_no_change BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION block_changes();
CREATE TRIGGER rule_sets_no_change BEFORE UPDATE OR DELETE ON rule_sets
  FOR EACH ROW EXECUTE FUNCTION block_changes();
CREATE TRIGGER dead_letters_no_change BEFORE UPDATE OR DELETE ON dead_letters
  FOR EACH ROW EXECUTE FUNCTION block_changes();
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION block_changes();
CREATE TRIGGER result_flags_no_change BEFORE UPDATE OR DELETE ON result_flags
  FOR EACH ROW EXECUTE FUNCTION block_changes();
