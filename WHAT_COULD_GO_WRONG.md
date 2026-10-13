# What could go wrong

This document lists things that could hurt a patient or break the rules for medical labs, and what this system does to stop them.

For each risk:
* **Problem:** what can go wrong
* **How we protect:** what the system does about it
* **Not perfect yet:** what is still missing

---

### 1. A machine slowly goes wrong and nobody notices
**Problem:** a machine starts giving results that are a little too high. Each single result still looks normal, so it is released. Patients may get the wrong treatment.

**How we protect:**
* The system watches the **average of the last 40 patients** on each machine. If the average moves away from normal, it raises an alert.
* A special check (CUSUM) adds up small changes over time, so even a **slow** drift is caught.
* It also compares the two machines with each other, and checks every **new reagent lot**.
* We measured it on simulated data: the slow drift was found after 13 hours, the sudden jump after 0.3 hours, and the bad reagent lot after 0.6 hours.
* The QC chart lets people **see** a drift with their own eyes.

**Not perfect yet:** very small changes (a few percent) are not caught. The lab's normal daily quality checks are still needed.

### 2. An alert is lost
**Problem:** the system finds a problem, but the message never reaches anyone (for example the server crashes, or sending fails).

**How we protect:**
* The alert is **saved in the database first**, and only then sent. If the server crashes, the alert is still there and is sent after the restart.
* If sending fails, the system **tries again** (after 2, 4, 8… seconds).
* If nobody clicks "Acknowledge" in time (15 minutes by default), the alert is **escalated** to the supervisor.

**Not perfect yet:** if the server crashes in the exact millisecond between saving a result and checking it, that one check is skipped. The next results usually catch the problem again.

### 3. Too many alerts, so staff start ignoring them
**Problem:** one problem creates hundreds of messages, or there are many false alarms. People stop reading them and miss the real one.

**How we protect:**
* The same problem within 24 hours is **one alert** with a counter ("seen 30 times"), not 30 alerts.
* At most **20 notifications per hour** per lab. Extra ones wait; they are not deleted.
* We measured the false alarms: about **1 false alarm every 14 days**.
* In our test run, 115 alarms were grouped into just **7 alerts**.

**Not perfect yet:** the limits were set using simulated data. A real lab must adjust them to its own data.

### 4. A rule is changed by mistake
**Problem:** someone types a wrong limit (e.g. 62 instead of 6.2), and dangerous results are released without anyone checking.

**How we protect:**
* New rules are **checked for mistakes** before saving (e.g. low limit bigger than high limit).
* **Dry run:** before saving, you can see how many decisions would change. Nothing is saved during a dry run.
* Every change is a **new version**. The old rules are kept, and we know who changed what and when.
* Only the **QualityEngineer** can change rules.
* A test with no rules is **held**, never released automatically.

**Not perfect yet:** a second person does not have to approve a rule change.

### 5. The same result is stored twice, or arrives late
**Problem:** analyzers often send a message twice or in the wrong order. A result could be saved twice, overwritten, or compared with the wrong earlier result.

**How we protect:**
* The database **refuses a second copy** of the same sample and test, even when both copies arrive at the same moment.
* If a copy has a **different value**, the original is not overwritten. The copy goes to the dead letter list for a person to check.
* The delta check uses the **time the sample was taken**, not the time it arrived.

### 6. A broken message disappears
**Problem:** a message is broken (missing value, wrong format), the result is never reported, and nobody notices.

**How we protect:**
* Every broken message is **kept** in the dead letter list together with the reason. It is never deleted.
* The number of dead letters is shown on the Results page, and the list is on the Dead Letters page.

**Not perfect yet:** there is no alert when suddenly many broken messages arrive.

### 7. Patients who already got a wrong result are not found
**Problem:** a reagent lot turns out to be faulty, but some wrong results were already sent to doctors.

**How we protect:**
* The **Impact Reports** page finds **every released result** made with that lot (or machine) since the problem started, and marks it "potentially affected".
* The supervisor can issue a **corrected result**. The old one stays visible, and the new one becomes the current result.
* The report shows how many are corrected and how many are still left.

**Not perfect yet:** the corrected result is not sent to the hospital system automatically. Also, if the start time is entered too late, some affected results are missed.

### 8. Someone secretly changes old records
**Problem:** someone edits a result, a decision or the audit log to hide a mistake.

**How we protect:**
* The **database itself blocks** changing or deleting results, decisions, rules, dead letters and the audit log.
* Each audit log entry is **linked to the one before it** with a fingerprint (hash). If someone changes an old entry, the chain breaks. The Auditor's "Check audit log" button shows exactly where.

**Not perfect yet:** a database administrator with full rights could rebuild the whole chain. Keeping a copy of the latest fingerprint somewhere else would stop that.

### 9. A user sees data they should not see, or does something they are not allowed to do
**Problem:** a user sees another lab's patients, or a technician releases a held result.

**How we protect:**
* Every request checks the user's **role**. A wrong role gets "not allowed".
* Every request only returns the user's **own lab**.
* Real patient names are refused. Only codes like `P-7731` are accepted.
* Automatic tests check all of this.

**Not perfect yet:** the login is simple (fixed demo passwords, tokens don't expire). A real lab needs stronger login security.

### 10. Night results or wrong times cause false alarms
**Problem:** at night the patients are sicker, so values are naturally higher. This could look like a machine problem. A time without a timezone could also put a result hours off.

**How we protect:**
* The system learns what is **normal for each part of the day** (night, morning, afternoon, evening) separately.
* Messages **without a timezone are rejected** and kept in the dead letter list.

**Not perfect yet:** weekend vs. weekday differences are not handled.
