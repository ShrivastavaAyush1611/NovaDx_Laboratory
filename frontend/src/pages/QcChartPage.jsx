import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { api, formatTime } from '../api'

const COLORS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728']

function formatDay(t) {
  const d = new Date(t)
  return d.getDate() + '/' + (d.getMonth() + 1)
}

function QcChartPage() {
  const [analyte, setAnalyte] = useState('K')
  const [windowSize, setWindowSize] = useState(50)
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    setError('')
    try {
      setData(await api('/qc/moving-average?analyte=' + analyte + '&window=' + windowSize))
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    load()
  }, [analyte])

  const instruments = data ? Object.keys(data.series) : []

  return (
    <div>
      <h2>Moving average per instrument</h2>
      <div className="box filters">
        <label>Analyte{' '}
          <select value={analyte} onChange={(e) => setAnalyte(e.target.value)}>
            <option value="K">K (potassium)</option>
            <option value="GLU">GLU (glucose)</option>
          </select>
        </label>
        <label>Window (results){' '}
          <input style={{ width: 60 }} value={windowSize} onChange={(e) => setWindowSize(e.target.value)} />
        </label>
        <button onClick={load}>Update</button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="box">
        {instruments.length === 0 && <p>No data yet. Load the simulated results first (see README).</p>}
        {instruments.length > 0 && (
          <ResponsiveContainer width="100%" height={380}>
            <LineChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={formatDay} />
              <YAxis domain={['auto', 'auto']} />
              <Tooltip labelFormatter={(t) => formatTime(t)} />
              <Legend />
              {instruments.map((ins, i) => (
                <Line key={ins} data={data.series[ins]} dataKey="avg" name={ins} stroke={COLORS[i % COLORS.length]}
                  dot={false} strokeWidth={2} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
        <p className="muted">
          Each point is the average of the last {windowSize} patient results of that instrument.
          The normal daily up/down movement comes from different patients at night vs. day.
          A line that slowly moves away from the other instrument is a drift.
        </p>
      </div>

    </div>
  )
}

export default QcChartPage
