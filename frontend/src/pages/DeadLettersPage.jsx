import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function DeadLettersPage() {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    api('/dead-letters').then(setItems).catch((err) => setError(err.message))
  }, [])

  return (
    <div>
      <h2>Dead letter store</h2>
      <p className="muted">Messages that were invalid. They are kept here with the reason and are never deleted.</p>
      {error && <div className="error">{error}</div>}
      <table>
        <thead><tr><th>ID</th><th>Received</th><th>Lab</th><th>Reason</th><th>Raw message</th></tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>{d.id}</td>
              <td>{formatTime(d.received_at)}</td>
              <td>{d.lab_id || <span className="muted">unassigned</span>}</td>
              <td>{d.reason}</td>
              <td><code style={{ fontSize: 11 }}>{d.raw_message}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <p>No dead letters.</p>}
    </div>
  )
}

export default DeadLettersPage
