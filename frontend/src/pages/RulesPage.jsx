import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function RulesPage({ user }) {
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [jsonText, setJsonText] = useState('')
  const [description, setDescription] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [dryRunReport, setDryRunReport] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const isEngineer = user.role === 'QualityEngineer'

  async function loadList() {
    try {
      const data = await api('/rules')
      setList(data)
      if (!selected) openVersion(data.active_version)
    } catch (err) {
      setError(err.message)
    }
  }

  async function openVersion(version) {
    const rs = await api('/rules/' + version)
    setSelected(rs)
    setJsonText(JSON.stringify(rs.config, null, 2))
    setDryRunReport(null)
  }

  useEffect(() => {
    loadList()
  }, [])

  // reads the text area; returns null if it is not valid JSON
  function readConfig() {
    try {
      return JSON.parse(jsonText)
    } catch (err) {
      setError('The rule set is not valid JSON: ' + err.message)
      return null
    }
  }

  async function runDryRun() {
    setError('')
    setMessage('')
    const config = readConfig()
    if (!config) return
    try {
      setDryRunReport(await api('/rules/dry-run', 'POST', { config }))
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveNewVersion() {
    setError('')
    setMessage('')
    const config = readConfig()
    if (!config) return
    if (!window.confirm('Save this as a NEW rule set version? (old versions are kept)')) return
    try {
      const body = { config, description }
      if (effectiveFrom) body.effective_from = new Date(effectiveFrom).toISOString()
      const saved = await api('/rules', 'POST', body)
      setMessage('Saved as version ' + saved.version)
      setSelected(null)
      loadList()
      openVersion(saved.version)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="two-columns">
      <div style={{ maxWidth: 420 }}>
        <h2>Rule set versions</h2>
        {list && (
          <table>
            <thead><tr><th>Version</th><th>Effective from</th><th>Description</th><th>By</th></tr></thead>
            <tbody>
              {list.versions.map((v) => (
                <tr key={v.version} className="clickable" onClick={() => openVersion(v.version)}>
                  <td>
                    v{v.version}
                    {v.version === list.active_version && <span className="badge RELEASED"> active</span>}
                  </td>
                  <td>{formatTime(v.effective_from)}</td>
                  <td>{v.description} <span className="muted">({v.rule_count} rules)</span></td>
                  <td>{v.created_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Rules are configuration. Each rule has an analyte, a type (range, index_limit, delta, instrument_flag, unit)
          and an action (HOLD or REJECT). A value exactly on a limit is allowed.
        </p>

        {dryRunReport && (
          <div className="box">
            <h3>Dry run result (nothing was saved)</h3>
            <p>Checked <b>{dryRunReport.total_results}</b> stored results.<br />
              Decisions that would change: <b>{dryRunReport.would_change}</b></p>
            <table>
              <thead><tr><th>Change</th><th>Count</th></tr></thead>
              <tbody>
                {Object.keys(dryRunReport.changes).map((k) => (
                  <tr key={k}><td>{k}</td><td>{dryRunReport.changes[k]}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Now: {JSON.stringify(dryRunReport.outcome_counts_now)}<br />
              Proposed: {JSON.stringify(dryRunReport.outcome_counts_proposed)}
            </p>
            {dryRunReport.examples.length > 0 && (
              <>
                <h3>Examples</h3>
                <ul>
                  {dryRunReport.examples.slice(0, 10).map((e) => (
                    <li key={e.result_id}>#{e.result_id} {e.analyte} {e.value}: {e.stored} → {e.proposed} <span className="muted">({e.reason})</span></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      <div>
        {selected && (
          <div className="box">
            <h3>Version {selected.version} {isEngineer && '(edit below to make a new version)'}</h3>
            <textarea className="json" value={jsonText} readOnly={!isEngineer} onChange={(e) => setJsonText(e.target.value)} />
            {isEngineer && (
              <div>
                <input placeholder="Description of the change" style={{ width: 260 }} value={description} onChange={(e) => setDescription(e.target.value)} />{' '}
                <label>Effective from <input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
                <div style={{ marginTop: 8 }}>
                  <button onClick={runDryRun}>Dry run on history</button>{' '}
                  <button className="green" onClick={saveNewVersion}>Save as new version</button>
                </div>
              </div>
            )}
            {message && <div className="success">{message}</div>}
            {error && <div className="error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

export default RulesPage
