import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function ImpactPage({ user }) {
  const [cases, setCases] = useState([])
  const [report, setReport] = useState(null)
  const [kind, setKind] = useState('reagent_lot')
  const [target, setTarget] = useState('')
  const [startTime, setStartTime] = useState('')
  const [description, setDescription] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const canCreate = user.role === 'QualityEngineer' || user.role === 'LabSupervisor'

  async function loadCases() {
    try {
      setCases(await api('/impact'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    loadCases()
  }, [])

  async function createCase(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    if (!startTime) {
      setError('Start time is required')
      return
    }
    try {
      const body = {
        kind, target, description,
        start_time: new Date(startTime).toISOString()
      }
      const res = await api('/impact', 'POST', body)
      setMessage('Case #' + res.impact_case.id + ' created. ' + res.flagged_total + ' released result(s) flagged as potentially affected.')
      loadCases()
      openReport(res.impact_case.id)
    } catch (err) {
      setError(err.message)
    }
  }

  async function openReport(id) {
    try {
      setReport(await api('/impact/' + id + '/report'))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <h2>Impact of a confirmed problem</h2>
      {canCreate && (
        <form className="box filters" onSubmit={createCase}>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="reagent_lot">Reagent lot</option>
            <option value="instrument">Instrument</option>
          </select>
          <input placeholder={kind === 'reagent_lot' ? 'e.g. LOT-GLU-203' : 'e.g. INS-01'} value={target} onChange={(e) => setTarget(e.target.value)} />
          <label>Wrong since <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button type="submit">Find affected results</button>
        </form>
      )}
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}

      <h3>Cases</h3>
      <table>
        <thead><tr><th>ID</th><th>Problem</th><th>Wrong since</th><th>Description</th><th>Affected in my lab</th><th>By</th><th></th></tr></thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>{c.id}</td>
              <td>{c.kind} <b>{c.target}</b></td>
              <td>{formatTime(c.start_time)}</td>
              <td>{c.description}</td>
              <td>{c.affected_in_my_lab}</td>
              <td>{c.created_by}</td>
              <td><button className="small" onClick={() => openReport(c.id)}>Report</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {report && (
        <div className="box" style={{ marginTop: 16 }}>
          <button className="small" style={{ float: 'right' }} onClick={() => setReport(null)}>Close</button>
          <h3>Report for {report.lab.name} ({report.lab.id}) - case #{report.impact_case.id}</h3>
          <p>
            {report.impact_case.kind} <b>{report.impact_case.target}</b> since {formatTime(report.impact_case.start_time)}.{' '}
            Affected results: <b>{report.summary.affected_results}</b>, patients: <b>{report.summary.affected_patients}</b>,
            corrected: <b>{report.summary.corrected}</b>, still to review: <b>{report.summary.still_to_review}</b>
          </p>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Result</th><th>Sample</th><th>Patient</th><th>Analyte</th><th>Value</th><th>Instrument / lot</th><th>Collected</th><th>Released</th><th>Corrected value</th></tr></thead>
            <tbody>
              {report.results.map((r) => (
                <tr key={r.result_id}>
                  <td>{r.result_id}</td><td>{r.sample_id}</td><td>{r.patient}</td><td>{r.analyte}</td>
                  <td>{r.value} {r.unit}</td><td>{r.instrument} / {r.reagent_lot}</td>
                  <td>{formatTime(r.collected_at)}</td><td>{formatTime(r.released_at)} <span className="muted">{r.released_by}</span></td>
                  <td>{r.corrected_result_id ? r.corrected_value + ' (#' + r.corrected_result_id + ')' : <span className="flag">not yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">To issue a corrected result: open the result on the Results page (as LabSupervisor) and use "Issue correction".</p>
        </div>
      )}
    </div>
  )
}

export default ImpactPage
