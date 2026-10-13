import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

const PAGE_SIZE = 50

function ResultsPage({ user }) {
  const [results, setResults] = useState([])
  const [summary, setSummary] = useState(null)
  const [outcome, setOutcome] = useState('')
  const [analyte, setAnalyte] = useState('')
  const [instrument, setInstrument] = useState('')
  const [search, setSearch] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [error, setError] = useState('')

  async function loadResults() {
    setError('')
    let url = '/results?limit=' + PAGE_SIZE + '&offset=' + offset
    if (outcome) url += '&outcome=' + outcome
    if (analyte) url += '&analyte=' + analyte
    if (instrument) url += '&instrument=' + instrument
    if (search) url += '&search=' + encodeURIComponent(search)
    if (flaggedOnly) url += '&flagged=true'
    try {
      setResults(await api(url))
      setSummary(await api('/results/summary'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    loadResults()
  }, [outcome, analyte, instrument, flaggedOnly, offset])

  return (
    <div>
      {summary && (
        <div className="box summary">
          <span>Released: <b>{summary.RELEASED}</b></span>
          <span>Held: <b>{summary.HELD}</b></span>
          <span>Rejected: <b>{summary.REJECTED}</b></span>
          <span>Duplicate messages ignored: <b>{summary.duplicates_received}</b></span>
          <span>Dead letters: <b>{summary.dead_letters}</b></span>
        </div>
      )}

      <div className="box filters">
        <select value={outcome} onChange={(e) => { setOffset(0); setOutcome(e.target.value) }}>
          <option value="">All decisions</option>
          <option value="RELEASED">Released</option>
          <option value="HELD">Held</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <select value={analyte} onChange={(e) => { setOffset(0); setAnalyte(e.target.value) }}>
          <option value="">All analytes</option>
          <option value="K">K</option>
          <option value="GLU">GLU</option>
        </select>
        <input placeholder="Instrument e.g. INS-01" value={instrument} onChange={(e) => setInstrument(e.target.value)} onBlur={() => setOffset(0)} />
        <input placeholder="Sample or patient id" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button onClick={() => { setOffset(0); loadResults() }}>Search</button>
        <label>
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => { setOffset(0); setFlaggedOnly(e.target.checked) }} />
          only potentially affected
        </label>
      </div>

      {error && <div className="error">{error}</div>}

      {selectedId && <ResultDetail id={selectedId} user={user} onClose={() => setSelectedId(null)} onChanged={loadResults} />}

      <table>
        <thead>
          <tr>
            <th>ID</th><th>Sample</th><th>Patient</th><th>Analyte</th><th>Value</th><th>Instrument</th><th>Lot</th>
            <th>Collected</th><th>Decision</th><th>Rule(s) / reason</th><th>Rule set</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => setSelectedId(r.id)}>
              <td>{r.id}</td>
              <td>{r.sample_id}{r.version > 1 && <span className="muted"> (v{r.version} corrected)</span>}</td>
              <td>{r.patient}</td>
              <td>{r.analyte}</td>
              <td>{r.value} {r.unit}</td>
              <td>{r.instrument}</td>
              <td>{r.reagent_lot}</td>
              <td>{formatTime(r.collected_at)}</td>
              <td>
                <span className={'badge ' + r.outcome}>{r.outcome}</span>
                {r.decided_by !== 'AUTO' && <div className="muted">by {r.decided_by}</div>}
                {r.flag_count > 0 && <div className="flag">⚠ potentially affected</div>}
              </td>
              <td>{r.triggered_rules.length > 0 ? r.triggered_rules.map((t) => t.id).join(', ') : 'all rules passed'}</td>
              <td>v{r.rule_set_version}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>{' '}
        <button disabled={results.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
        <span className="muted"> showing {offset + 1} - {offset + results.length}. Click a row for details.</span>
      </div>
    </div>
  )
}

// details of one result: all decisions, all versions, flags, reproduce, correction
function ResultDetail({ id, user, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [reproduce, setReproduce] = useState(null)
  const [newValue, setNewValue] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function load() {
    try {
      setData(await api('/results/' + id))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    setReproduce(null)
    setMessage('')
    load()
  }, [id])

  async function runReproduce() {
    try {
      setReproduce(await api('/results/' + id + '/reproduce'))
    } catch (err) {
      setError(err.message)
    }
  }

  async function issueCorrection() {
    setError('')
    try {
      const res = await api('/results/' + id + '/correct', 'POST', { value: newValue, reason: reason })
      setMessage('Corrected result issued (new id ' + res.corrected.id + ', decision ' + res.decision.outcome + ')')
      setNewValue('')
      setReason('')
      load()
      onChanged()
    } catch (err) {
      setError(err.message)
    }
  }

  if (!data) return <div className="box">Loading... {error}</div>
  const r = data.result

  return (
    <div className="box">
      <button className="small" style={{ float: 'right' }} onClick={onClose}>Close</button>
      <h3>Result #{r.id} - {r.analyte} {r.value} {r.unit} ({r.sample_id}, {r.patient})</h3>
      {!data.is_current && <div className="flag">This is an old version. A corrected version exists.</div>}
      <div className="muted">
        Instrument {r.instrument}, lot {r.reagent_lot}, H/I/L = {r.h_index}/{r.i_index}/{r.l_index},
        flags: {r.instrument_flags.length ? r.instrument_flags.join(', ') : 'none'}, timestamp {r.original_timestamp}, received {formatTime(r.received_at)}
      </div>

      <h3>Decisions (newest last, nothing is ever overwritten)</h3>
      <table>
        <thead><tr><th>#</th><th>Outcome</th><th>By</th><th>Rule set</th><th>Reason</th><th>When</th></tr></thead>
        <tbody>
          {data.decisions.map((d) => (
            <tr key={d.id}>
              <td>{d.seq}</td>
              <td><span className={'badge ' + d.outcome}>{d.outcome}</span></td>
              <td>{d.decided_by}</td>
              <td>v{d.rule_set_version}</td>
              <td>{d.reason}</td>
              <td>{formatTime(d.decided_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button onClick={runReproduce}>Reproduce automatic decision</button>{' '}
        {reproduce && (
          <span className={reproduce.same ? 'success' : 'error'}>
            {reproduce.same ? 'Same result' : 'DIFFERENT result'} with rule set v{reproduce.rule_set_version}: {reproduce.reproduced_outcome}
          </span>
        )}
      </p>

      <h3>Versions</h3>
      <table>
        <thead><tr><th>Version</th><th>ID</th><th>Value</th><th>Created by</th><th>Correction reason</th></tr></thead>
        <tbody>
          {data.versions.map((v) => (
            <tr key={v.id}>
              <td>{v.version}</td><td>{v.id}</td><td>{v.value} {v.unit}</td><td>{v.created_by}</td><td>{v.correction_reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.flags.length > 0 && (
        <>
          <h3 className="flag">Impact flags</h3>
          <ul>
            {data.flags.map((f) => (
              <li key={f.id}>{f.flag} - case #{f.impact_case_id}: {f.kind} {f.target} since {formatTime(f.start_time)} ({f.description})</li>
            ))}
          </ul>
        </>
      )}

      {user.role === 'LabSupervisor' && data.is_current && (
        <div>
          <h3>Issue a corrected result</h3>
          <input placeholder="Corrected value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />{' '}
          <input placeholder="Reason" style={{ width: 300 }} value={reason} onChange={(e) => setReason(e.target.value)} />{' '}
          <button onClick={issueCorrection}>Issue correction</button>
        </div>
      )}
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

export default ResultsPage
