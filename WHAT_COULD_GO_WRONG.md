# What could go wrong

Risks to patient safety and regulatory compliance, how this design reduces each one, and what is still open.
Each risk links to the code or test that handles it.

---

### 1. A slow drift or a small shift is not detected
**Risk:** an instrument slowly reads high. Each result still looks normal, results are auto-released, and patients are treated on wrong values.

**How the design reduces it**
* Moving-average **and** CUSUM per instrument + analyte (CUSUM is made for slow drifts), plus a DISAGREEMENT check between instruments running the same test, plus a check on every new reagent lot (`qcDetector.js`).
* Detection is **measured, not assumed**: `npm run evaluate` and `tests/qc.test.js`. The drift was found after 13 h, the shift after 0.3 h, and the bad lot after 0.6 h.
* The QC chart makes a drift visible to the eye.

**Still open**
* Very small shifts (below ~0.3 SD, e.g. a few % on glucose) are too small for a 40-result average. They need longer windows or internal QC material.
* This monitoring adds to the lab's normal internal QC; it does not replace it.

### 2. An alert is lost
**Risk:** a real problem is detected, but nobody is told (send failure, server crash).

**How the design reduces it**
* The alert and its notification are saved in **one transaction before** any send attempt (outbox).
* Failed sends are retried with backoff. After the last try the notification is marked FAILED, but the alert stays visible.
* An unacknowledged alert **escalates** to the supervisor after a configurable time. Escalations bypass the rate limit.
* Tests: `tests/alerts.test.js`.

**Still open**
* If the process crashes in the few milliseconds *after* a result is committed but *before* the QC detector runs, a signal at exactly that moment is not raised. The next results usually raise it again, because the windows are rebuilt by replay.
* Fix for production: store a "QC processed" marker per result and re-process unmarked results on start-up.

### 3. Alert fatigue: too many false alarms, staff stop looking
**Risk:** hundreds of notifications for one problem, or many false alarms. People ignore the system and miss the real problem.

**How the design reduces it**
* Grouping by `group_key` with a unique index (one active alert per problem), occurrence counter, per-signal cooldown, and a per-lab hourly notification limit (delayed, never dropped).
* The false-alarm rate is measured on clean data, including seeds not used for tuning: **about 1 false alarm per 14 days** for 1 lab / 2 instruments / 2 analytes (K, GLU).
* In the live run, 115 raw QC signals became 7 alerts.

**Still open**
* Limits were tuned on simulated data and must be re-tuned on each lab's real data before going live.

### 4. A wrong result is auto-released because a rule is wrong or was changed by mistake
**Risk:** someone loosens a limit (or makes a typo, e.g. 62 instead of 6.2), and critical values are released without review.

**How the design reduces it**
* Rule sets are validated before saving (types, low ≤ high, required fields, unique ids).
* **Dry-run** on the lab's own history shows how many decisions would change before saving. It runs in a read-only transaction.
* Every change is a **new version** with an effective date. Old versions are kept, and the change is in the audit log with the user's name.
* Every decision records the rule version and inputs used, so any decision can be **reproduced** later.
* Only QualityEngineers can change rules.
* An unknown analyte is **held**, never auto-released.

**Still open**
* There is no second-person approval (four-eyes) for a new rule set yet. That would be the next step for compliance.

### 5. Duplicate or out-of-order messages produce wrong data or wrong delta checks
**Risk:**
* A result is stored twice and counted twice.
* A resent message with a different value silently overwrites the original.
* A late result breaks the delta check.

**How the design reduces it**
* A unique constraint in the database gives exactly-once storage, also under parallel requests (tested with 20 simultaneous copies).
* A conflicting duplicate is **never** overwritten: it goes to the dead-letter store for a person to check.
* Delta checks use the sample time, not the arrival order. The previous result used is stored with the decision.

### 6. Invalid or incomplete messages disappear silently
**Risk:** a result is never reported because its message was malformed, and nobody notices.

**How the design reduces it**
* Every rejected message (even broken JSON) is stored in the append-only **dead-letter store** with the reason.
* Its count is shown on the Results page and listed on the Dead Letters page.
* Messages with an unknown lab are shown to QualityEngineers and Auditors.

**Still open**
* No alert is raised when dead letters suddenly increase (e.g. after an analyzer software update). This is easy to add as a new signal type.

### 7. Released results from a faulty lot or instrument are never corrected
**Risk:** a problem is confirmed, but patients who already got wrong results are not found or not informed.

**How the design reduces it**
* An impact case finds **every released result** of that lot/instrument since the start time (for a reagent lot: in every lab that used it).
* It flags each result (append-only flag), and gives a per-lab report with "corrected / still to review" counts.
* Corrections are new versions linked to the original. Both remain visible.

**Still open**
* Sending corrected reports to clinicians (LIS/HL7) is out of scope.
* The start time is a human decision. If it is set too late, early affected results are missed. A tip: use the first QC alert time minus the detection delay.

### 8. Records are changed after the fact (data integrity, e.g. 21 CFR Part 11 / ISO 15189)
**Risk:** someone edits a result, a decision or the audit trail to hide an error.

**How the design reduces it**
* Results, decisions, rule sets, dead letters, flags, alert events and the audit log are **append-only, enforced by database triggers**, not only by the API.
* The audit log is a **SHA-256 hash chain**. The verify endpoint finds a changed, deleted or re-hashed entry (`tests/audit.test.js`).

**Still open**
* Someone with full DB admin rights could rewrite the whole chain from the changed entry onwards.
* Fix for production: regularly copy the latest hash to a separate write-once store (or sign it) so the chain can be checked against it.

### 9. A user sees another laboratory's patients, or does something their role should not allow
**Risk:** a privacy breach between labs, or a technician releasing held results.

**How the design reduces it**
* Every query filters on the user's lab. Another lab's data gives **404**.
* Every endpoint checks the role, and the UI hides what a role can't use.
* Tests in `tests/access.test.js` cover results, alerts, reviews, corrections, QC and impact reports.
* Patient names are refused at ingestion (only pseudonyms `P-…`).

**Still open**
* Demo authentication: fixed tokens, SHA-256 passwords, no expiry. This must be replaced by real identity management (SSO, MFA, expiring tokens) before real use.

### 10. Wrong day/night baseline or wrong timezone
**Risk:** night results (sicker patients) look like a shift, or timestamps without a timezone shift results by hours.

**How the design reduces it**
* Messages **without timezone are rejected** to the dead-letter store.
* The QC baseline is per 6-hour block of lab-local time.
* The normal day/night pattern is in the simulator and is tested not to cause alarms.

**Still open**
* Weekend vs. weekday patient mixes are not modelled yet.
