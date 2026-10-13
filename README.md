# NovaDx – Result Surveillance and Auto-Verification Engine

A backend (Node.js + Express + PostgreSQL) and a simple web UI (React) that:

* receives analyzer results and stores each valid result **exactly once**
* puts invalid messages in a **dead-letter store** (nothing disappears)
* **auto-verifies** each result with **versioned, configurable rules** (release / hold / reject)
* watches patient results per instrument to find **drifts, shifts, faulty reagent lots and instruments that disagree**
* scope of this version: **one laboratory (LAB-1, instruments INS-01 and INS-02)** and **two analytes: K (potassium) and GLU (glucose)**
* raises **alerts** that are grouped, rate limited, retried and escalated, and are never lost
* finds every **already released result affected** by a confirmed problem and makes a per-lab report
* keeps everything **append-only**, with **roles**, **lab separation** and a **tamper-evident audit log**

All data is simulated. NovaDx is fictional.

---

## 1. Project layout

```
NovaDx/
├── backend/                 Node.js API
│   ├── config/
│   │   ├── labs.json        labs, instruments, demo users, default settings
│   │   └── rules/ruleset_v1.json   the first rule set (configuration, not code)
│   ├── db/schema.sql        all PostgreSQL tables, views and triggers
│   ├── scripts/             setup DB, simulator, data loader, evaluation, benchmark
│   ├── src/
│   │   ├── app.js / server.js
│   │   ├── routes/          one file per API area
│   │   ├── services/        the real logic (ingest, rules, QC, alerts, impact, audit…)
│   │   ├── channels/        notification channels (log)
│   │   ├── simulator.js     generates the 50,000+ simulated results
│   │   └── qcEvaluation.js  measures detection rate / delay / false alarms
│   └── tests/               Jest + Supertest tests
├── frontend/                React (Vite) UI
├── README.md
└── WHAT_COULD_GO_WRONG.md   risks for patient safety / compliance
```

---

## 2. Install and run

### Requirements
* Node.js 20 or newer (built with Node 26)
* PostgreSQL 14 or newer running locally (built with PostgreSQL 18)

### Where PostgreSQL is configured
The only place is **`backend/.env`** (copy it from `backend/.env.example`):

```
DATABASE_URL=postgres://postgres@localhost:5432/novadx            # the app database
TEST_DATABASE_URL=postgres://postgres@localhost:5432/novadx_test  # wiped by every test run
PORT=5050
INGEST_API_KEY=analyzer-key-123
NOTIFY_CHANNEL=log
```

If your Postgres user has a password, use `postgres://postgres:YOURPASSWORD@localhost:5432/novadx`.
You do **not** need to create the databases yourself: `npm run db:setup` and the tests create them if they are missing.

### Backend

```bash
cd backend
npm install
cp .env.example .env          # then edit DATABASE_URL if needed
npm run db:setup              # creates DB "novadx", all tables, demo users, rule set v1  (DELETES old data!)
npm run simulate              # writes data/simulated_results.jsonl (51,659 messages, 50,013 valid results)
npm start                     # API on http://localhost:5050
```

In a second terminal, send the simulated data to the running API (as the analyzers would):

```bash
cd backend
npm run load                  # ~15 seconds
npm run benchmark             # optional: timing of typical queries
npm run evaluate              # detection rate, delay and false alarms (does not need the DB)
```

### Frontend

```bash
cd frontend
npm install
npm run dev                   # http://localhost:5180  (API calls are proxied to port 5050)
```

Sign in with any demo user. **The password for all of them is `password123`.**

| User | Role | Short permissions |
|---|---|---|
| tech1 | LabTechnician | View results, QC chart, Ack alerts, Dead letters |
| super1 | LabSupervisor | Review results, Corrections, Ack alerts, Escalation time, Impact reports |
| qe1 | QualityEngineer | Edit rules, Dry run, QC chart, Ack alerts, Impact reports |
| auditor1 | Auditor | Read only, Audit log, Verify log, Impact reports |

The login page shows the same list in a "Roles and permissions" box. Clicking a role selects that user.
There is one lab, LAB-1, with instruments INS-01 and INS-02.

### Tests

```bash
cd backend
npm test                      # 122 tests, about 8 seconds, uses the novadx_test database
```

### A short demo path
1. `super1` → **QC Chart**, analyte K: the INS-02 line slowly climbs on 6–8 March (injected drift) and drops back after recalibration.
2. `super1` → **Alerts**: grouped alerts (SHIFT, DRIFT, DISAGREEMENT, LOT_SHIFT). Acknowledge one; wait 15 minutes, or set the escalation time to 1 minute, and the others become ESCALATED.
3. `super1` → **Review Queue**: release or reject held results.
4. `qe1` → **Rules**: change `K-CRITICAL` "high" from 6.2 to 5.0, press **Dry run on history**, and see how many decisions would change. Nothing is saved. **Save as new version** creates v2, and v1 stays.
5. `qe1` → **Impact Reports**: reagent lot `LOT-GLU-203`, from 10 March 12:00 → lists every released GLU result of LAB-1 made with that lot.
6. `super1` → **Results** → click a flagged result → **Issue correction**.
7. `auditor1` → **Audit Log** → **Check audit log for changes**.

---

## 3. Overall design

```
 analyzers ──POST /api/ingest──►  validate ──invalid──► dead_letters
                                     │
                                     ▼
                     ┌──── one DB transaction ─────┐
                     │ INSERT result ON CONFLICT   │──duplicate──► duplicate_messages (counted, not stored again)
                     │ run rules (active version)  │
                     │ INSERT decision             │
                     └─────────────────────────────┘
                                     │ (after commit)
                                     ▼
                          QC detector (in memory)  ──signal──► alerts + notifications (one transaction)
                                                                    │
                                    background worker every 2 s ◄───┘ sends, retries, rate-limits
                                    escalation job every 15 s   ──► ESCALATED + notify supervisor

 React UI ──/api (token)──► routes check role + lab ──► PostgreSQL
```

One Node process, one PostgreSQL database. I kept it to a single process on purpose: for this size it is fast enough (see §9), and it is much easier to reason about during a crash.

---

## 4. Receiving results (4.1)

### How exactly-once storage works
The `results` table has a **UNIQUE constraint on `(sample_id, analyte, version)`**. Analyzer messages are always version 1.

```sql
INSERT INTO results (...) VALUES (...)
ON CONFLICT (sample_id, analyte, version) DO NOTHING
RETURNING *;
```

* **Sent twice, minutes or hours apart:** the second insert hits the constraint and does nothing. We answer `"duplicate"` with the original result id and note the copy in `duplicate_messages` (shown as "Duplicate messages ignored" on the Results page).
* **Two copies at the same moment:** PostgreSQL makes the second transaction **wait** on the unique index until the first one commits, and then it does nothing. This is guaranteed by the database, not by application code, so it also works with several API servers. Tested with 20 parallel copies (in process) and 10 parallel HTTP requests (`tests/ingest.test.js`).
* **Result + decision are one transaction.** A result is never stored without its decision, and a decision never exists without its result.
* **Same sample + analyte but different content** (e.g. a different value): this is not a duplicate, it is a conflict. The stored result is **not** overwritten. The new message goes to the dead-letter store with the reason, so a person can issue a proper correction (§7).
* **Late / out-of-order messages** are stored normally. The delta check uses the **sample timestamp** (`collected_at`), not the arrival time:
  * The delta check compares with the latest *earlier collected* result.
  * The QC window counts results, so a message arriving a few positions late only changes the order inside the window, not the average.
* At scale: re-sending all 51,659 simulated messages a second time stored **0** new results (51,522 duplicates + 137 dead letters).

### Dead-letter store
Invalid messages are saved in `dead_letters` with the raw text and the reason. The table is append-only. Examples:
broken JSON, missing field, value not a number, timestamp **without timezone**, unknown instrument, negative HIL index, and a patient field that is not a pseudonym (`P-…`).
The ingest endpoint reads the body as **plain text**, so even broken JSON is kept.
Screen: **Dead Letters**.

### Simulator (`npm run simulate`, `backend/src/simulator.js`)
It creates 50,000 results (50,013 stored incl. 13 deliberately silly but valid values) over 14 days, 1 lab, 2 instruments, and analytes K and GLU. The data includes:

* realistic patients: personal set points, ~6 % sick patients, more inpatients at night, a daily volume curve, a 6-hour instrument downtime (quiet period), hemolysis raising K
* reagent lot changes on every instrument (normal ones, to test false alarms)
* **F1 slow drift**: INS-02 K +0.0125 mmol/L per hour for 48 h
* **F2 sudden shift**: INS-01 K +0.6 mmol/L for 24 h
* **F3 faulty reagent lot**: LOT-GLU-203 reads 15 % low (used on INS-01 only)
* **duplicates**: 1,509 (2 % immediately, 1 % re-sent 50–550 messages later), 781 late/out-of-order messages, 150 bad messages

The random generator is seeded, so every run gives the same data. The injected faults are written to `data/simulated_results_faults.json`. `--clean` gives the same data without faults.

---

## 5. Auto-verification (4.2)

### Rules are configuration
`backend/config/rules/ruleset_v1.json`. Each rule is one JSON object:

```json
{ "id": "K-CRITICAL", "name": "Potassium critical value", "analyte": "K",
  "type": "range", "low": 2.8, "high": 6.2, "action": "HOLD" }
```

| type | fires when | used for |
|---|---|---|
| `range` | value < low or value > high | reportable range (REJECT), critical range (HOLD) |
| `delta` | change from the previous result > `max_abs_change` or `max_percent_change`, within `within_hours` | delta check |
| `index_limit` | `h_index` / `i_index` / `l_index` > max | hemolysis, icterus, lipemia |
| `instrument_flag` | the message has `instrument_flags` | analyzer fault flags (`"analyte": "*"` = all) |

* **Limits are inclusive**: a value exactly on a limit is OK (tested at, just below and just above every limit type).
* Outcome = the worst action of all rules that fired: REJECT > HOLD > RELEASE.
* An analyte with **no rules** is HELD (`unknown_analyte_action`), because it can't be auto-verified.
* A quality engineer adds a rule or a new analyte by editing JSON:
  * **in the UI** (Rules page, as QualityEngineer), or
  * **from a file**: `npm run rules:load -- config/rules/my_rules.json`

  No code change is needed. Rule sets are validated before saving (unknown types, low > high, duplicate ids, …).

### Versioned and dated
* Every save creates a **new row in `rule_sets`** with `version` and `effective_from`. Old versions can't be changed (a DB trigger blocks UPDATE/DELETE).
* The **active** rule set is the newest version whose `effective_from` has been reached. This lets you schedule a rule change for the future.
* Every decision stores `rule_set_version` **and `previous_result_id`**, i.e. the exact previous result the delta check used.
  `GET /api/results/:id/reproduce` re-runs the stored rule version on the same inputs and shows that the outcome is the same. There is a "Reproduce" button in the result details.

  Why store the previous result: with parallel ingestion, a result with a smaller id can commit after a later one. Re-searching for "the previous result" afterwards could then find a different one. I found this with the dry-run (§5, next point) and fixed it by recording the input.

### Dry-run mode
`POST /api/rules/dry-run` (QualityEngineer, Rules page):
* evaluates the proposed rules on **all stored results**, with the same inputs as the original decision (same previous result)
* reports how many decisions would change, from → to counts, which rules fire, and examples
* runs in a PostgreSQL **`READ ONLY` transaction**, so the database itself refuses any write. The test fingerprints all results, decisions and rule sets (md5 of every row) before and after.
* sanity check: a dry run with the **unchanged** rules reports 0 changes on all stored results

### Review
A LabSupervisor releases or rejects HELD results (Review Queue). This adds a **new decision row** (`seq` 2) with the reviewer's name. The automatic decision stays. Two supervisors can't decide the same result twice: the row lock plus the unique `(result_id, seq)` give the second one a 409.

---

## 6. Patient-based quality monitoring (4.3)

Code: `backend/src/services/qcDetector.js` (pure logic, no DB, so the same code runs in the server, the tests and the evaluation).

1. **Baseline per analyte and time-of-day block** (4 blocks of 6 h, lab local time, all instruments together). It is the plain **mean and SD** of the first 300 results of each block.
   * Different blocks handle the **daily pattern**: night has more (sicker) inpatients.
2. Each result → z-score. Results with |z| > 3 (very sick patients) are **left out** ("average of normals"); they say nothing about the instrument.
3. Per instrument + analyte, a **moving window of the last 40 results**. It is counted in results, not hours, so **quiet periods** (night, downtime) just take longer and there are no averages over 3 results. No alarms before the baseline is ready.
4. Checks:
   * **SHIFT**: |moving average| > 4 / √40 (4 standard errors)
   * **DRIFT**: two-sided **CUSUM** (k = 0.5, h = 12). It adds up small deviations, which is good for slow drifts.
   * **DISAGREEMENT**: two instruments of the same lab running the same test: |mean A − mean B| > 4 standard errors. It is only compared when both had results in the last 2 h.
   * **LOT_SHIFT**: the first 80 results of a **new reagent lot** must differ from the previous lot **and** from the baseline. The second condition means replacing a bad lot with a good one does not alarm.
   * After a signal, the same check is quiet for 100 results (cooldown).
5. On start-up the server **replays** all stored results through the detector. After a crash or restart the windows and baselines are exactly as before (50,013 results take < 1 s). `tests/recovery.test.js` checks this.

The **QC Chart** page shows the raw moving average per instrument (window adjustable), so the drift is visible to the eye.

### Honest measurement (`npm run evaluate`, also checked in `tests/qc.test.js`)

Data with faults (seed 42, 50,013 results, 14 days):

| Fault | Detected? | Delay after start | By |
|---|---|---|---|
| F1 slow drift INS-02 K (+0.0125 mmol/L/h) | yes | **12.8 h** (drift was about +0.16 mmol/L ≈ 0.4 SD) | SHIFT, then DRIFT, DISAGREEMENT |
| F2 sudden shift INS-01 K (+0.6 mmol/L) | yes | **0.3 h** | DRIFT, DISAGREEMENT, SHIFT |
| F3 faulty lot LOT-GLU-203 (−15 %) on INS-01 | yes | **0.6 h** | SHIFT, LOT_SHIFT, DRIFT, DISAGREEMENT |

**3 of 3 faults detected.** 2 false alarms on this data set. In the live run (`npm run load`), the 115 raw QC signals were grouped into **7 alerts**.

Limit: the method can't see very small shifts (below about 0.3 SD, e.g. a few % on glucose), because a 40-result average is too noisy for that.

False alarms on **clean data** (no faults, 50,000 results / 14 days each):

| seeds | false alarms per run | average |
|---|---|---|
| used while tuning (4242, 1001, 2002, 7, 8) | 0, 1, 0, 0, 0 | 0.2 per 14 days |
| **held out**, not looked at while tuning (11–15) | 0, 1, 0, 2, 1 | **0.8 per 14 days** (≈0.16 per 10,000 results) |

With 2 instruments and 2 analytes, each instrument now gets about 4 times more results than in the first version (which had 4 instruments and 4 analytes). So faults are found faster, but there are also more checks per day, and therefore a few more false alarms per stream.

What I learned while tuning (all visible in the git history):
* A single valid but absurd value (999999) can ruin an average, so very abnormal results (|z| > 3) are left out before anything else.
* The time-of-day blocks must match the lab's real shift pattern. When the simulated "night patients" started at 22:00 but the QC night block started at 00:00, the hours 22:00–24:00 gave false SHIFT alarms every evening. A real lab would set the blocks to its own shifts.
* The false-alarm rate varies between seeds (0 to 2 per 14 days), so a single run is not a reliable number.
* The limits were tuned on the same simulator that generated the faults. On real data they would need re-tuning.

---

## 7. Alerts (4.4)

* **Saved before sending.** `raiseAlert()` writes the alert and a **notification row (`PENDING`) in one transaction**. Nothing is sent inside that transaction (the "outbox" pattern).
* **Sending + retry.** A background worker (every 2 s) takes `PENDING` rows with `FOR UPDATE SKIP LOCKED`, so several workers would not take the same row.
  * On failure: `attempts + 1`, `last_error` is stored, and it waits 2, 4, 8 … max 300 s before the next try.
  * After `max_send_attempts` (8) the row is `FAILED`. It stays visible in the alert details, and the alert still escalates.
* **Crash:** pending notifications are in the database, so they are sent after a restart. Delivery is therefore *at least once*: if the process dies after sending but before marking SENT, the message goes out twice. That is better than zero times.
* **Grouping / de-duplication:** each alert has a `group_key` (e.g. `QC|LAB-1|INS-02|K`, where SHIFT and DRIFT of one stream are one problem, or `LOT|LAB-1|LOT-GLU-203`).
  * The same `group_key` seen again **within 24 hours** is added to the existing alert. A PostgreSQL advisory lock per group key makes sure two parallel requests can't both create a new alert.
  * A repeat only increases `occurrences` and sends **no** new notification. 100 signals → 1 alert, 1 notification (tested).
* **Rate limit:** max `max_notifications_per_hour` (20) per lab. Extra notifications wait. They are **delayed, never dropped**. Escalations ignore the limit.
* **States:** OPEN → ACKNOWLEDGED (by a technician / QE / supervisor), OPEN → ESCALATED after `escalation_minutes` (default 15, editable by a LabSupervisor on the Alerts page). An escalation creates a second notification to **LabSupervisor**. Only the three states from the assessment are used: OPEN, ACKNOWLEDGED, ESCALATED.
* **Replaceable channels:** a channel is `{ name, send(notification, alert) }` in `src/channels/`. `NOTIFY_CHANNEL=log` writes to `backend/logs/notifications.log`. The retry is tested with a fake channel that fails (`tests/alerts.test.js`). Email/SMS/queue = one new file + one line in `channels/index.js`. The core logic doesn't change.

---

## 8. Impact of a confirmed problem (4.5)

`POST /api/impact` (QualityEngineer / LabSupervisor, Impact Reports page) with `kind` (`instrument` or `reagent_lot`), `target` and `start_time` ("producing wrong results since").

**How affected results are found and flagged**
* Affected = results of that instrument/lot, collected between start and end, that are the current version, and whose **current decision is RELEASED**. Held and rejected results never reached a patient.
* For each one, a row is added to **`result_flags`** (`POTENTIALLY_AFFECTED`, linked to the impact case). The result itself is not changed (append-only).
* Flagged results show "⚠ potentially affected" in the results list (filter: *only potentially affected*) and in the result details.
* A **reagent lot can be shared between labs**, so a lot case flags matching results in every lab in the database. A faulty lot is everyone's problem. An **instrument case** is only allowed for your own lab's instrument. (This version runs one lab, but the code and tests are ready for more.)
* **Per-lab report:** `GET /api/impact/:id/report` only ever returns the requesting user's lab: affected results, number of patients, how many are corrected and how many are still to review. Each lab's supervisor gets their own report and never sees another lab's patients.

**How corrected results are issued**
* A LabSupervisor opens the result → *Issue correction* (new value + reason) → `POST /api/results/:id/correct`.
* This creates a **new row in `results`** with `version = n+1`, `corrects_result_id` = the previous version, `correction_reason` and `created_by`.
* The corrected value goes through the rules again and gets its own decision.
* The original row and its decisions stay unchanged and visible (the *Versions* table in the details). Lists and reports use the **latest version** as current, and the old one is marked "old version".
* The impact report shows the corrected value next to each affected result, so the lab can work through the list until "still to review" is 0.
* All of it is written to the audit log.
* In a real lab the corrected report would also be sent to the requesting doctor (HL7/LIS). That's outside this assessment.

---

## 9. Records, roles, audit (4.6)

**Nothing is edited or deleted.** A PostgreSQL trigger (`block_changes`) raises an error on UPDATE/DELETE of `results`, `decisions`, `rule_sets`, `dead_letters`, `result_flags` and `audit_log`. So even a bug in the code can't change them. Changes are new rows: decisions get `seq` + 1, results get `version` + 1.
Mutable on purpose: `alerts` and `notifications` (their *state* changes; who acknowledged an alert is also written to the audit log), `settings`, and `users`.

**Roles** (checked on every endpoint with `requireRole(...)`; the UI only shows allowed pages):

| | Technician | QualityEngineer | Supervisor | Auditor |
|---|---|---|---|---|
| View results / decisions / dead letters | ✔ | ✔ | ✔ | ✔ |
| Release / reject held results, issue corrections | | | ✔ | |
| View alerts | ✔ | ✔ | ✔ | ✔ (read only) |
| Acknowledge alerts | ✔ | ✔ | ✔ | |
| Change escalation time / limits | | | ✔ | |
| QC chart and status | ✔ | ✔ | ✔ | |
| View rule sets | ✔ | ✔ | ✔ | ✔ |
| Create rule set, dry run | | ✔ | | |
| Create impact case | | ✔ | ✔ | |
| Read impact report | | ✔ | ✔ | ✔ |
| Read audit log, verify the chain | | | | ✔ |

**Authentication:** `POST /api/auth/login` (username + password) returns a token, which is sent as `Authorization: Bearer <token>`. Demo tokens are fixed (`token-<username>`) to keep the demo simple. Analyzers use a separate API key (`x-api-key`).

**Lab separation:** this version is set up with **one lab (LAB-1)**, but the separation is still built in, because the requirement says a user from one lab must never see another lab's data:
* Every user belongs to one lab and every instrument belongs to one lab. Every query filters on `lab_id = user's lab`.
* Another lab's result/alert/case returns **404**, not 403, so it doesn't even reveal that the id exists.
* To prove it, `tests/access.test.js` and `tests/impact.test.js` add a **test-only second lab** (LAB-2, INS-03, users tech2/super2/…) to the test database (`addSecondLab()` in `tests/helpers.js`). It is tested for results, reproduce, review, correction, alerts, QC chart, impact report and dead letters.
* Adding a real second lab later = add it to `config/labs.json` and run `npm run db:setup`. No code change.

**Tamper-evident audit log:** each entry stores `prev_hash` and `hash = sha256(prev_hash | time | user | role | lab | action | details)`.
* Entries are written under a PostgreSQL advisory lock, so the chain never forks.
* `GET /api/audit/verify` (button on the Audit Log page) recomputes the whole chain and reports the first broken entry.
* Tests: a changed detail, a changed username, a deleted row, and a changed row whose own hash was recomputed are all detected.
* Logged actions: logins, reviews, corrections, rule sets and dry runs, alert acknowledge, settings, impact cases, and audit checks.
* Automatic decisions are not in the audit log: they are in the append-only `decisions` table, and writing 50,000 chained hashes would serialize ingestion.

---

## 10. Performance (4.8)

Measured on a MacBook (Apple Silicon), PostgreSQL 18 local, data from `npm run simulate`:

| What | Result |
|---|---|
| Load 51,659 messages over HTTP, 8 parallel senders (`npm run load`) | **15.9 s → ~3,250 messages/s**; p50 2 ms, p95 4 ms, p99 6 ms per message |
| Same, 1 sender (strictly one after another, measured with the first 2-lab version) | 164 s → ~315 messages/s; p50 3 ms (mostly HTTP round-trip time, so the server isn't busy) |
| Re-sending all 51,659 messages again | 0 stored, 51,522 duplicates, 137 dead letters |
| Server start-up QC replay of 50,013 results | < 1 s |
| Database size after loading | 46 MB |

Typical queries (`npm run benchmark`, median of 10 calls, through HTTP):

| Query | Time |
|---|---|
| Latest 50 results | 3.4 ms |
| Results filtered by HELD | 7.6 ms |
| Search by patient / sample | 5.8 ms |
| Counts bar (whole lab) | 28 ms |
| One result with decisions, versions, flags | 2.8 ms |
| Alerts list | 1.8 ms |
| Review queue | 77 ms |
| QC moving average chart (≈27,000 K results) | 50 ms |
| Audit log check | 2.1 ms |
| Dry run over all stored results (50,013) | 190 ms |

**Slowest parts**
1. **Review queue and counts bar**: they compute the current decision per result over the whole lab (`LATERAL` / `DISTINCT ON`), so they grow linearly with history.
2. **Dry run and QC chart**: they read the whole history into memory.
3. **Ingestion** is ~3 round trips per result in one transaction. The QC detector and alert writes run after it in the same process.
4. **QC replay at start-up** reads every result.

**When the design would need to change**
* ~1–2 million results: add a `current_outcome` table (or materialized view) per result instead of computing it, limit dry-run, chart and replay to a time window (e.g. last 90 days), and partition `results` by month.
* ~1,000+ results/second sustained or several API servers: the QC detector is in memory in one process. It must become a single consumer per instrument (e.g. a queue partitioned by instrument) with its state saved in a table. Ingestion itself already works with many servers, because the unique constraint does the de-duplication.
* The audit log uses one global lock: fine for user actions (a few per second), not for millions of entries.

---

## 11. Assumptions

* **Identity of a message** = `sample_id + analyte`. A re-run of the same test on the same sample comes as a *correction*, not a new message with the same ids.
* The lab of a result is derived from the instrument (the message has no lab field).
* Optional message field `instrument_flags: ["CLOT_DETECTED", …]` carries analyzer fault flags (the spec mentions fault flags but the example message has none).
* The timestamp must contain a timezone. The QC day/night blocks use the **lab-local hour written in the timestamp**.
* Critical values are **HELD** (a person must phone the doctor before release). Values outside the reportable range are **REJECTED**.
* A result that was REJECTED by the rules is not used as "previous result" for delta checks and not used in the QC chart.
* Corrections (version > 1) are not fed into QC monitoring, because they are not new patient samples.
* Dead letters whose lab can't be determined (unknown instrument, broken JSON) are "unassigned" and visible to QualityEngineers and Auditors of every lab, so somebody responsible sees them.
* Rule limits in `ruleset_v1.json` are plausible demo values, **not clinical advice**.
* The simulated lab timezone is +05:30.
* Only one lab and two analytes (K and GLU) are configured, as requested. Another analyte can be added with rules only (see §5), and another lab with `config/labs.json`.

## 12. What I did not build (and why)

* **Real authentication** (password hashing with bcrypt, token expiry, SSO): the spec asks for simple token auth. Passwords are SHA-256 with a fixed salt, which is OK for a demo and **not** for production.
* **Email/SMS channels**: the channel interface is there, and a log channel is enough for the assessment.
* **Sending corrected reports to the hospital system (HL7/FHIR)**: outside the scope.
* **A separate message broker** (Kafka/RabbitMQ): PostgreSQL + the outbox table is enough at this size and is one less thing to fail.
* **UI tests**: the UI is thin and the logic is in the backend, which has the automated tests. I checked the UI by hand and with a headless-browser screenshot run.
* **Per-instrument baselines** for QC: pooling all instruments gives a usable baseline much faster. It assumes the instruments agree when healthy, which is exactly what DISAGREEMENT watches.

## 13. Behaviour in unusual situations

| Situation | What happens |
|---|---|
| Server crashes during an ingest request | The transaction is rolled back, so neither result nor decision is stored. The analyzer gets no 2xx and resends, and the resend is stored once. |
| Crash after commit but before QC ran | The result and decision are safe. On restart the replay includes that result in the windows, but a signal that would have fired exactly then is not raised (known gap, see WHAT_COULD_GO_WRONG #2). |
| Crash after an alert was saved but before it was sent | The notification row is still PENDING and is sent after restart. |
| Notification channel down for hours | Retries with growing waits, then FAILED. The alert is still visible and still escalates. |
| Two supervisors review the same result | One wins, the other gets 409 (row lock + unique `seq`). |
| Database down | The API returns 500 and analyzers must buffer and resend, which is safe because duplicates are ignored. |
| Someone edits the audit table directly | The UPDATE is refused by the trigger. If a DB admin disables the trigger, `/api/audit/verify` shows the first broken entry. |
