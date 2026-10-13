import { useState } from 'react'
import { setToken } from './api'
import LoginPage from './pages/LoginPage'
import ResultsPage from './pages/ResultsPage'
import ReviewPage from './pages/ReviewPage'
import AlertsPage from './pages/AlertsPage'
import QcChartPage from './pages/QcChartPage'
import RulesPage from './pages/RulesPage'
import ImpactPage from './pages/ImpactPage'
import DeadLettersPage from './pages/DeadLettersPage'
import AuditPage from './pages/AuditPage'

// which pages each role can see (the backend checks this again on every call)
const PAGES = [
  { key: 'results', title: 'Results', roles: ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'] },
  { key: 'review', title: 'Review Queue', roles: ['LabSupervisor'] },
  { key: 'alerts', title: 'Alerts', roles: ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'] },
  { key: 'qc', title: 'QC Chart', roles: ['LabTechnician', 'QualityEngineer', 'LabSupervisor'] },
  { key: 'rules', title: 'Rules', roles: ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'] },
  { key: 'impact', title: 'Impact Reports', roles: ['QualityEngineer', 'LabSupervisor', 'Auditor'] },
  { key: 'deadletters', title: 'Dead Letters', roles: ['LabTechnician', 'QualityEngineer', 'LabSupervisor', 'Auditor'] },
  { key: 'audit', title: 'Audit Log', roles: ['Auditor'] }
]

function App() {
  const [user, setUser] = useState(null) // null = not logged in -> login page
  const [page, setPage] = useState('results')

  if (!user) {
    return <LoginPage onLogin={(u) => { setUser(u); setPage('results') }} />
  }

  const myPages = PAGES.filter((p) => p.roles.includes(user.role))

  function handleLogout() {
    setToken(null)
    setUser(null)
  }

  return (
    <div>
      <div className="topbar">
        <b>NovaDx Result Surveillance</b>
        <span className="user-info">
          {user.username} ({user.role}, {user.lab_id})
          <button className="small" onClick={handleLogout}>Log out</button>
        </span>
      </div>
      <div className="nav">
        {myPages.map((p) => (
          <button key={p.key} className={page === p.key ? 'active' : ''} onClick={() => setPage(p.key)}>
            {p.title}
          </button>
        ))}
      </div>
      <div className="content">
        {page === 'results' && <ResultsPage user={user} />}
        {page === 'review' && <ReviewPage user={user} />}
        {page === 'alerts' && <AlertsPage user={user} />}
        {page === 'qc' && <QcChartPage user={user} />}
        {page === 'rules' && <RulesPage user={user} />}
        {page === 'impact' && <ImpactPage user={user} />}
        {page === 'deadletters' && <DeadLettersPage user={user} />}
        {page === 'audit' && <AuditPage user={user} />}
      </div>
    </div>
  )
}

export default App
