import { useEffect, useState } from 'react'
import { api, setToken } from '../api'

// what each role is allowed to do (short words, shown on the login page)
// the backend checks the same rules on every API call
const ROLE_INFO = [
  { role: 'LabTechnician', user: 'tech1', can: ['View results', 'QC chart', 'Ack alerts', 'Dead letters'] },
  { role: 'LabSupervisor', user: 'super1', can: ['Review results', 'Corrections', 'Ack alerts', 'Escalation time', 'Impact reports'] },
  { role: 'QualityEngineer', user: 'qe1', can: ['Edit rules', 'Dry run', 'QC chart', 'Ack alerts', 'Impact reports'] },
  { role: 'Auditor', user: 'auditor1', can: ['Read only', 'Audit log', 'Verify log', 'Impact reports'] }
]

function LoginPage({ onLogin }) {
  const [users, setUsers] = useState([])
  const [username, setUsername] = useState('tech1')
  const [password, setPassword] = useState('password123')
  const [error, setError] = useState('')

  useEffect(() => {
    api('/auth/demo-users')
      .then(setUsers)
      .catch(() => setError('Can not reach the backend. Is it running on port 5050?'))
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    try {
      const data = await api('/auth/login', 'POST', { username, password })
      setToken(data.token)
      onLogin(data.user)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <h2>NovaDx Sign in</h2>
        <form onSubmit={handleLogin}>
          <div>User (role)</div>
          <select value={username} onChange={(e) => setUsername(e.target.value)}>
            {users.map((u) => (
              <option key={u.username} value={u.username}>
                {u.username} - {u.role}
              </option>
            ))}
          </select>
          <div>Password</div>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit">Sign in</button>
        </form>
        {error && <div className="error">{error}</div>}
        <p className="muted">Demo password for all users: password123</p>
      </div>

      <div className="roles-box">
        <h3>Roles and permissions</h3>
        <table>
          <tbody>
            {ROLE_INFO.map((r) => (
              <tr key={r.role} className="clickable" onClick={() => setUsername(r.user)} title={'Select ' + r.user}>
                <td>
                  <b>{r.role}</b>
                  <div className="muted">{r.user}</div>
                </td>
                <td>
                  {r.can.map((c) => <span key={c} className="tag">{c}</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Click a role to select that user.</p>
      </div>
    </div>
  )
}

export default LoginPage
