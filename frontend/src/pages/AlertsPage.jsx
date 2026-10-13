import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function AlertsPage({ user }) {
  const [alerts, setAlerts] = useState([])
  const [escalationMinutes, setEscalationMinutes] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const canAcknowledge = user.role !== 'Auditor'

  async function load() {
    try {
      setAlerts(await api('/alerts'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    load()
    // refresh every 10 seconds so new alerts and escalations show up
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (user.role === 'LabSupervisor' || user.role === 'QualityEngineer') {
      api('/settings').then((s) => setEscalationMinutes(s.escalation_minutes))
    }
  }, [user.role])

  async function acknowledge(id) {
    setError('')
    try {
      await api('/alerts/' + id + '/acknowledge', 'POST')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveEscalation() {
    try {
      await api('/settings', 'PUT', { escalation_minutes: escalationMinutes })
      setMessage('Escalation time saved')
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <h2>Alerts</h2>
      {escalationMinutes !== '' && (
        <div className="box">
          Escalate to the supervisor if not acknowledged within{' '}
          {user.role === 'LabSupervisor' ? (
            <>
              <input style={{ width: 60 }} value={escalationMinutes} onChange={(e) => setEscalationMinutes(e.target.value)} /> minutes{' '}
              <button className="small" onClick={saveEscalation}>Save</button>
            </>
          ) : (
            <b>{escalationMinutes} minutes</b>
          )}
          {message && <span className="success"> {message}</span>}
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <table>
        <thead>
          <tr>
            <th>ID</th><th>State</th><th>Type</th><th>Instrument / analyte / lot</th><th>Message</th>
            <th>Times seen</th><th>First seen</th><th>Acknowledged by</th><th></th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id}>
              <td>{a.id}</td>
              <td><span className={'badge ' + a.state}>{a.state}</span></td>
              <td>{a.type}</td>
              <td>{a.instrument} {a.analyte} <span className="muted">{a.reagent_lot}</span></td>
              <td>{a.message}</td>
              <td>{a.occurrences}</td>
              <td>{formatTime(a.first_seen)}</td>
              <td>{a.acknowledged_by} {a.acknowledged_at && <div className="muted">{formatTime(a.acknowledged_at)}</div>}</td>
              <td>
                {canAcknowledge && (a.state === 'OPEN' || a.state === 'ESCALATED') && (
                  <button className="small" onClick={() => acknowledge(a.id)}>Acknowledge</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {alerts.length === 0 && <p>No alerts.</p>}
    </div>
  )
}

export default AlertsPage
