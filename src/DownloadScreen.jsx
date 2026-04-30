import { useEffect, useState } from 'react'

const TIPS = [
  {
    icon: '🔍',
    title: 'Full Gurbani, offline, always with you',
    body: 'Gurbani existed before the internet, and it will exist beyond it. Neither is your search — every shabad, every granth, fully offline.',
  },
  {
    icon: '🎙️',
    title: 'Voice search needs internet',
    body: 'Every shabad sung in kirtan carries the Guru\'s words. Now you can find them, in real time, as the kirtan flows.',
  },
  {
    icon: '⚡',
    title: 'Instant results',
    body: 'Search by first letters, line fragments, or voice — results appear in milliseconds.',
  },
  {
    icon: '🔒',
    title: 'Stays on your device',
    body: 'Text search is completely local. Nothing leaves your device once the data is stored.',
  },
  {
    icon: '✅',
    title: 'One time only',
    body: 'This download happens just once. Every future load is instant, online or offline.',
  },
]

function fmt(bytes) {
  if (!bytes) return '—'
  return (bytes / 1024 / 1024).toFixed(0) + ' MB'
}

function fmtSpeed(bps) {
  if (!bps) return null
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
  return Math.round(bps / 1024) + ' KB/s'
}

function fmtEta(bytesRemaining, bps) {
  if (!bps || !bytesRemaining) return null
  const sec = Math.round(bytesRemaining / bps)
  if (sec < 10) return null          // too short to bother showing
  if (sec < 60) return `~${sec}s left`
  const m = Math.floor(sec / 60), s = sec % 60
  return `~${m}m ${s}s left`
}

export function DownloadScreen({ progress, bytesDownloaded, totalBytes, speed }) {
  const [tipIndex, setTipIndex] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setTipIndex(i => (i + 1) % TIPS.length)
    }, 10000)
    return () => clearInterval(id)
  }, [])

  const pct       = Math.round(progress * 100)
  const tip       = TIPS[tipIndex]
  const speedStr  = fmtSpeed(speed)
  const etaStr    = fmtEta(totalBytes - bytesDownloaded, speed)

  return (
    <div className="fullscreen-screen">
      <div className="screen-content">
        <img src="/icon.svg" className="screen-logo" alt="" aria-hidden="true" />

        <h1 className="screen-title">Gurbani Search</h1>

        <div className="dl-badge">One-time Setup</div>

        <div className="dl-progress-box">
          <p className="dl-progress-label">Setting up for offline use…</p>
          <div className="dl-progress-track">
            <div className="dl-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="dl-progress-meta">
            <span>
              {totalBytes > 0
                ? `${fmt(bytesDownloaded)} of ${fmt(totalBytes)}`
                : 'Starting download…'}
            </span>
            <span className="dl-speed-group">
              {speedStr && <span className="dl-speed">{speedStr}</span>}
              {etaStr   && <span className="dl-eta">{etaStr}</span>}
              <span className="dl-pct">{pct}%</span>
            </span>
          </div>
        </div>

        {/* key forces remount on each tip change, re-triggering the slide-in animation */}
        <div className="dl-tip" key={tipIndex}>
          <span className="dl-tip-icon" role="img" aria-hidden="true">{tip.icon}</span>
          <div>
            <p className="dl-tip-title">{tip.title}</p>
            <p className="dl-tip-body">{tip.body}</p>
          </div>
        </div>

        <div className="dl-indicators" role="tablist" aria-label="Tips">
          {TIPS.map((_, i) => (
            <span
              key={i}
              className={`dl-indicator${i === tipIndex ? ' active' : ''}`}
            />
          ))}
        </div>

        <p className="dl-footer">
          <span>Text search works offline</span>
          <span className="dl-footer-sep">·</span>
          <span>Voice mode requires internet</span>
          <span className="dl-footer-sep">·</span>
          <span>Voice search is Chrome only for now</span>
        </p>
      </div>
    </div>
  )
}
