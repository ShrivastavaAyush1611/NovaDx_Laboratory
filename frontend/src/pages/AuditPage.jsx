import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function AuditPage() {
  const [entries, setEntries] = useState([])
  const [check, setCheck] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      setEntries(await api('/audit?limit=200'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function verify() {
    setError('')
    try {
      setCheck(await api('/audit/verify'))
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <h2>Audit log</h2>
      <div className="box">
        <button onClick={verify}>Check audit log for changes</button>
        {check && check.valid && (
          <span className="success"> ✔ The audit log is intact. {check.checked} entries checked, hash chain is correct.</span>
        )}
        {check && !check.valid && (
          <span className="error"> ✘ The audit log was ALTERED! First broken entry: #{check.broken_at_id}. {check.problem}</span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>#</th><th>When</th><th>Who</th><th>Role</th><th>Action</th><th>Details</th><th>Hash</th></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.id}</td>
              <td>{formatTime(e.created_at)}</td>
              <td>{e.username}</td>
              <td>{e.role}</td>
              <td>{e.action}</td>
              <td><code style={{ fontSize: 11 }}>{e.details}</code></td>
              <td className="muted">{e.hash.substring(0, 12)}…</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default AuditPage
