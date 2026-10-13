# NovaDx – Result Surveillance and Auto-Verification Engine

A system that receives lab results from analyzers, decides which results can be **released**, which must be **held** for review, and which are **rejected**, and warns when an **instrument or reagent lot** starts to go wrong.

* Backend: **Node.js + Express**
* Database: **PostgreSQL**
* Frontend: **React** (Vite)
* All data is simulated. NovaDx is fictional.

---

## 1. How to install and run

**You need:** Node.js 20+ and PostgreSQL running on your computer.

### Settings (`backend/.env`)
Copy `backend/.env.example` to `backend/.env`:
```
DATABASE_URL=postgres://postgres@localhost:5432/novadx            # the app database
TEST_DATABASE_URL=postgres://postgres@localhost:5432/novadx_test  # wiped by every test run
PORT=5050                                                         # port of the API
INGEST_API_KEY=analyzer-key-123                                   # key the analyzers send in the x-api-key header
NOTIFY_CHANNEL=log                                                # how notifications are sent (log file)
```
If your Postgres user has a password, write `postgres://postgres:PASSWORD@localhost:5432/novadx`.
The databases are created automatically.

### Backend
```bash
cd backend
npm install
npm run db:setup      # creates the database and tables (deletes old data)
npm run simulate      # creates 50,000 simulated results in backend/data/
npm start             # starts the API on http://localhost:5050
```
In a second terminal, send the simulated results to the API:
```bash
cd backend
npm run load
```

### Frontend (user interface)
```bash
cd frontend
npm install
npm run dev           # open http://localhost:5180
```

Sign in with one of these users. The password is **`password123`** for all of them:

| User | Role |
|---|---|
| tech1 | LabTechnician |
| super1 | LabSupervisor |
| qe1 | QualityEngineer |
| auditor1 | Auditor |

### Tests
```bash
cd backend
npm test              # 121 tests, uses the separate novadx_test database
```

---

## 2. Overall design

```
Analyzer ──► POST /api/ingest
               │
               ├── invalid message ──────────► dead letter store (kept with the reason)
               ├── already received ─────────► duplicate (not stored again)
               ▼
           save result + check rules ────────► RELEASED / HELD / REJECTED
               │
               ▼
           quality monitoring (moving averages per instrument)
               │
               └── problem found ────────────► alert ──► notification (retried if it fails)
                                                  └── not acknowledged in time ──► ESCALATED
```

| Part | Where |
|---|---|
| API endpoints | `backend/src/routes/` |
| Main logic | `backend/src/services/` |
| Database tables | `backend/db/schema.sql` |
| Rules (configuration) | `backend/config/rules/ruleset_v1.json` |
| Simulator | `backend/src/simulator.js` |
| User interface | `frontend/src/pages/` |

**What each part does:**

* **Receiving results:** each message is checked. Invalid messages go to the dead letter store with the reason.
* **Auto-verification:** every result is checked against the rules: reportable range, critical range, delta check, hemolysis/icterus/lipemia limits, and instrument fault flag. Each rule says HOLD or REJECT. If no rule fires, the result is RELEASED.
* **Rules are configuration:** they are stored in JSON. A QualityEngineer changes them on the Rules page (or with `npm run rules:load -- file.json`).
  * Every change is a **new version**, and old versions are kept.
  * Every decision stores the rule version it used.
  * **Dry run** tests new rules on stored results without changing anything (it runs in a read-only database transaction).
* **Quality monitoring:** a moving average of patient results per instrument and test, compared with the normal level for that time of day. It detects:
  * **shift**: the average jumps
  * **drift**: slow movement, using CUSUM
  * **instrument disagreement**: the two instruments differ
  * **reagent lot change**: a new lot gives different results
* **Alerts:**
  * The same problem within 24 hours is grouped into one alert, and notifications are limited per hour.
  * States: OPEN → ACKNOWLEDGED, or OPEN → ESCALATED if nobody acknowledges in time. The time is configurable on the Alerts page, default 15 minutes.
  * The alert is saved in the database **before** sending. Failed sends are retried.
  * The notification channel is replaceable (`backend/src/channels/`). A log channel is used.
* **Records and audit:**
  * Results, decisions and the audit log can't be changed or deleted (database triggers block it). Corrections are new versions.
  * Every user action is in the audit log, which is linked with hashes. The Auditor can check that it was not altered.
* **Roles and labs:** each endpoint checks the user's role, and every query only returns the user's own lab.

| Role | Can do |
|---|---|
| LabTechnician | view results, QC chart, acknowledge alerts, dead letters |
| LabSupervisor | review held results, issue corrections, set escalation time, impact reports |
| QualityEngineer | edit rules, dry run, QC chart, acknowledge alerts, impact reports |
| Auditor | read only, audit log and its check, impact reports |

---

## 3. How each result is stored exactly once

The `results` table has a **unique rule on sample_id + analyte** (+ version, which is 1 for analyzer results and 2, 3… only for corrections). A result is saved with:

```sql
INSERT INTO results (...) VALUES (...) ON CONFLICT DO NOTHING
```

* **Sent twice:** the second insert does nothing, and we answer "duplicate".
* **Two copies at the same moment:** PostgreSQL makes the second one wait until the first is saved, then it does nothing. So even then only one is stored.
* **Same sample but a different value:** not overwritten. It goes to the dead letter store for a person to check.
* **Late or out-of-order messages:** stored normally. The delta check uses the sample's own timestamp, not the arrival order.
* The result and its decision are saved in **one transaction**, so there is never a result without a decision.

Tested with 20 identical messages sent at the same time: 1 stored, 19 duplicates. Sending all 51,659 simulated messages a second time stored 0 new results.

---

## 4. Simulated data

`npm run simulate` creates **50,000 results** over 14 days for 1 lab, 2 instruments (INS-01, INS-02) and 2 tests (K = potassium, GLU = glucose). It includes:

| Problem | Details |
|---|---|
| Slow drift | INS-02, K: +0.0125 mmol/L per hour for 48 hours |
| Sudden shift | INS-01, K: +0.6 mmol/L for 24 hours |
| Faulty reagent lot | LOT-GLU-203 on INS-01 reads 15 % too low |
| Duplicate messages | 1,509 (some at the same moment, some sent again later) |
| Also | late messages, 150 invalid messages, a quiet period (6 hours no results on INS-02), day/night pattern |

---

## 5. Detection results (honest measurement)

Measured with `npm run evaluate` (also checked by the tests):

| Injected fault | Detected? | How quickly |
|---|---|---|
| Slow drift (INS-02, K) | yes | 12.8 hours after it started |
| Sudden shift (INS-01, K) | yes | 0.3 hours |
| Faulty reagent lot (LOT-GLU-203) | yes | 0.6 hours |

* **3 of 3 faults detected.**
* **False alarms:** 2 in the data with faults. On 10 extra data sets **without any fault**, every alarm is false: between 0 and 2 per 14 days, about **0.5 per 14 days on average**.
* **Limit:** very small changes (less than about 0.3 SD) are not detected.
* In the live run, 115 raw alarms were grouped into **7 alerts**.

---

## 6. Impact of a confirmed problem

**How affected results are flagged**
1. A QualityEngineer or LabSupervisor opens the **Impact Reports** page and enters the reagent lot (or instrument) and the time it started being wrong.
2. The system finds every result from that lot or instrument after that time that was already **RELEASED**.
3. Each one gets a **"potentially affected" flag** (a new row in `result_flags`; the result itself is not changed). It shows ⚠ on the Results page.
4. A **report per laboratory** lists the affected results. Each lab sees only its own.

**How corrected results are issued**
1. The LabSupervisor opens the result and clicks **Issue correction** (new value + reason).
2. A **new version** of the result is saved and linked to the original. The original stays visible.
3. The new version is checked by the rules again and becomes the current result.
4. The report shows how many are corrected and how many are still to review.

---

## 7. Performance

Run on a MacBook with local PostgreSQL, using the 50,000 simulated results:

| What | Result |
|---|---|
| Processing all 51,659 messages | **15.9 seconds** (about 3,250 messages per second) |
| Time per message | 2 ms typical, 6 ms slowest 1 % |

Typical queries (`npm run benchmark`):

| Query | Time |
|---|---|
| Latest results | 3 ms |
| Search by patient | 6 ms |
| One result with details | 3 ms |
| Alerts list | 2 ms |
| Review queue | 77 ms |
| QC chart | 50 ms |
| Dry run on all results | 190 ms |

**Slowest parts:** the review queue, the QC chart and the dry run, because they read the whole history.

**When the design must change:** at around **1–2 million results**:
* the review queue and dry run should only look at recent data (e.g. the last 90 days)
* the QC monitoring, which keeps its averages in the server's memory, would need to move to a separate service if more than one server is used

---

## 8. Key decisions and assumptions

* A message is identified by **sample_id + analyte**.
* The lab of a result comes from the instrument (the message has no lab field).
* Fault flags come in an optional field `instrument_flags`.
* The timestamp must have a timezone, otherwise the message is a dead letter.
* Critical values are **held** (a person must check them). Values outside the reportable range are **rejected**.
* Only **one lab** and **two tests** (K, GLU) are set up. More can be added in `config/labs.json` and the rules file without code changes.
* Lab separation is still built in. The tests create a temporary second lab to prove that one lab can't see another lab's data.
* After a server restart, the quality monitoring rebuilds its averages from the stored results.
* The rule limits are realistic examples, not clinical advice.

## 9. What I did not build, and why

* **Real login security** (strong password hashing, token expiry): the assessment asks for simple token login.
* **Email / SMS notifications:** a log channel is enough. A new channel only needs one new file.
* **Sending corrected reports to hospital systems:** outside the scope of the assessment.

---

## 10. Screenshots

**Sign in:** pick a user; the right side shows what each role can do.

![Sign in page with roles and permissions](docs/screenshots/01-login.jpeg)

![Choosing a user on the sign in page](docs/screenshots/02-login-users.jpeg)

**Results:** totals at the top (released, held, rejected, duplicates, dead letters), filters, and every result with its decision and rule set version.

![Results page](docs/screenshots/03-results.jpeg)

**Review queue:** held results with the reason they were held. The supervisor releases or rejects each one with a comment.

![Review queue](docs/screenshots/04-review-queue.jpeg)

**Alerts:** the problems found by quality monitoring (shift, disagreement, reagent lot change), grouped, with the escalation time setting.

![Alerts page](docs/screenshots/05-alerts.jpeg)

**QC chart:** moving average of potassium per instrument. The slow drift on INS-02 and the sudden shift on INS-01 are clearly visible.

![QC chart showing the drift and the shift](docs/screenshots/06-qc-chart.jpeg)

**Rules:** all rule set versions, and the rules as JSON configuration.

![Rules page](docs/screenshots/07-rules.jpeg)

**Dead letter store:** invalid messages, kept with the reason and the raw message.

![Dead letter store](docs/screenshots/08-dead-letters.jpeg)

**Simulated data:** one analyzer message per line in `backend/data/simulated_results.jsonl`.

![Simulated analyzer messages](docs/screenshots/09-simulated-data.jpeg)

---

See **WHAT_COULD_GO_WRONG.md** for the risks to patient safety and how the design reduces them.
