import { useEffect, useState } from 'react'
import { api, formatTime } from '../api'

function ReviewPage() {
  const [queue, setQueue] = useState({ total_held: 0, items: [] })
  const [comments, setComments] = useState({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function load() {
    try {
      setQueue(await api('/review/queue'))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function decide(id, action) {
    setError('')
    setMessage('')
    try {
      await api('/review/' + id, 'POST', { action: action, comment: comments[id] || '' })
      setMessage('Result #' + id + (action === 'RELEASE' ? ' released' : ' rejected'))
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <h2>Review queue ({queue.total_held} held results)</h2>
      <p className="muted">Oldest first. Showing up to 100.</p>
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Sample / patient</th><th>Analyte</th><th>Value</th><th>Instrument</th><th>H/I/L</th>
            <th>Collected</th><th>Why held</th><th>Comment</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          {queue.items.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.sample_id}<br />{r.patient}</td>
              <td>{r.analyte}</td>
              <td><b>{r.value}</b> {r.unit}</td>
              <td>{r.instrument}<br /><span className="muted">{r.reagent_lot}</span></td>
              <td>{r.h_index}/{r.i_index}/{r.l_index}</td>
              <td>{formatTime(r.collected_at)}</td>
              <td>{r.triggered_rules.map((t) => <div key={t.id}><b>{t.id}</b>: {t.message}</div>)}</td>
              <td>
                <input placeholder="comment" value={comments[r.id] || ''}
                  onChange={(e) => setComments({ ...comments, [r.id]: e.target.value })} />
              </td>
              <td>
                <button className="green small" onClick={() => decide(r.id, 'RELEASE')}>Release</button>{' '}
                <button className="red small" onClick={() => decide(r.id, 'REJECT')}>Reject</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {queue.items.length === 0 && <p>Nothing to review.</p>}
    </div>
  )
}

export default ReviewPage
