// Floating dev toolbar, only mounted by `npm run dev:mock`. Not translated on purpose (developer tool).
import { FlaskConical, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import './mock-toolbar.css'
import { MOCK_PASSWORD, mockControls, type MockFlags, type Scenario } from './mock'
import { mockBuildFailure, type MockBuildFailure } from './mockF1'
import { addStressFile, finishPrintSoon, printerIdleSoon, restartDemoPrint } from './mockF2'

const SCENARIOS: { key: Scenario; label: string; to: string }[] = [
  { key: 'fresh', label: 'Fresh install (setup)', to: '/setup' },
  { key: 'blocked', label: 'Setup from non-LAN (blocked)', to: '/setup' },
  { key: 'lowMemory', label: 'Low memory warning', to: '/setup' },
  { key: 'loggedOut', label: 'Logged out', to: '/login' },
  { key: 'admin', label: 'Logged in as admin', to: '/' },
  { key: 'user', label: 'Logged in as user', to: '/' },
]

export default function MockToolbar() {
  const [open, setOpen] = useState(false)
  const [flags, setFlags] = useState<MockFlags>(mockControls.flags)
  const [buildFail, setBuildFail] = useState<MockBuildFailure>(mockBuildFailure.get())
  const summary = mockControls.summary

  const flag = <K extends keyof MockFlags>(key: K, value: MockFlags[K]) => {
    mockControls.setFlag(key, value)
    setFlags({ ...mockControls.flags })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mock API toolbar"
        className="sdm-fab"
      >
        <FlaskConical size={14} />
        Mock
      </button>
    )
  }

  const check = (key: 'probeFails' | 'writeFails' | 'lowMemory' | 'printerOffline' | 'proxyHeaders' | 'readOnly', label: string) => (
    <label className="sdm-row">
      <input type="checkbox" checked={flags[key]} onChange={(e) => flag(key, e.target.checked)} />
      {label}
    </label>
  )

  return (
    <div className="sdm-panel">
      <div className="sdm-head">
        <FlaskConical size={14} color="#c026d3" />
        <strong>Mock API</strong>
        <span className="sdm-muted">{summary.setupComplete ? (summary.user ?? 'signed out') : 'setup pending'}</span>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="sdm-close">
          <X size={14} />
        </button>
      </div>
      <p className="sdm-label">Scenario</p>
      <div className="sdm-list">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => {
              mockControls.scenario(s.key)
              window.location.assign(s.to)
            }}
            className="sdm-btn"
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="sdm-label">Simulate</p>
      <div className="sdm-list">
        {check('probeFails', 'Printer unreachable on Test connection')}
        {check('writeFails', 'Server errors on every save')}
        {check('lowMemory', 'Low memory (1 GB limit)')}
        {check('printerOffline', 'Printer offline (live status)')}
        {check('proxyHeaders', 'Proxy headers with exposure None')}
        {check('readOnly', 'Read-only mode (reload to apply)')}
        <label className="sdm-row">
          <input type="checkbox" checked={flags.slowUploads === true} onChange={(e) => flag('slowUploads', e.target.checked)} />
          Slow uploads (browser → PrintYard → printer)
        </label>
        <label className="sdm-row">
          Latency
          <input
            type="range"
            min={0}
            max={2000}
            step={100}
            value={flags.latency}
            onChange={(e) => flag('latency', Number(e.target.value))}
          />
          <span className="sdm-mono">{flags.latency}ms</span>
        </label>
      </div>
      <p className="sdm-label">Phase 2</p>
      <div className="sdm-list">
        <button type="button" className="sdm-btn" onClick={() => finishPrintSoon()}>
          Finish the running print (→ bed occupied)
        </button>
        <button type="button" className="sdm-btn" onClick={() => printerIdleSoon()}>
          Printer idle (bed clear)
        </button>
        <button type="button" className="sdm-btn" onClick={() => restartDemoPrint()}>
          Restart the demo print
        </button>
        <label className="sdm-row">
          Project builds
          <select
            value={buildFail}
            onChange={(e) => {
              const v = e.target.value as MockBuildFailure
              mockBuildFailure.set(v)
              setBuildFail(v)
            }}
          >
            <option value="none">succeed</option>
            <option value="projects.build_timeout">time out (504)</option>
            <option value="projects.build_failed">fail (500)</option>
          </select>
        </label>
        <button
          type="button"
          className="sdm-btn"
          onClick={() => {
            const f = addStressFile()
            if (f) window.location.assign(`/?tab=preview&file=${f.id}`)
          }}
        >
          Add a ~50 MB G-code and preview it
        </button>
      </div>
      <p className="sdm-label">
        Seeded users: <span className="sdm-mono">admin</span>, <span className="sdm-mono">maria</span> (limits),{' '}
        <span className="sdm-mono">jorge</span> (disabled) · password <span className="sdm-mono">{MOCK_PASSWORD}</span>
      </p>
      <button
        type="button"
        onClick={() => {
          mockControls.reset()
          window.location.assign('/setup')
        }}
        className="sdm-reset"
      >
        <RotateCcw size={13} />
        Reset everything
      </button>
    </div>
  )
}
