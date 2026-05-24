import { useState } from 'react'
import { useGurbaniData } from '../hooks/useGurbaniData.js'
import { DownloadScreen } from './DownloadScreen.jsx'
import { LoadingScreen } from './LoadingScreen.jsx'
import { UpdateBanner } from './UpdateBanner.jsx'
import { SearchApp } from './SearchApp.jsx'
import { DisplayApp } from './DisplayApp.jsx'
import '../styles/App.css'

const IS_DISPLAY = new URLSearchParams(window.location.search).has('display')

function GurbaniApp() {
  const { status, progress, bytesDownloaded, totalBytes, speed, error, errorKind } = useGurbaniData()
  const [data, setData] = useState(null)

  if (status === 'error' && errorKind === 'private-mobile') {
    return (
      <div className="fullscreen-screen">
        <div className="screen-content">
          <img src="/icon.svg" className="screen-logo" alt="" aria-hidden="true" />
          <h1 className="screen-title">Gurbani Search</h1>
          <p style={{ color: 'var(--danger)', marginTop: 16, fontSize: 16, fontWeight: 600 }}>
            Private browsing isn't supported on mobile
          </p>
          <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6, maxWidth: 360, opacity: 0.85 }}>
            Gurbani Search saves about 321 MB of scripture to your device so it can work fully offline. Private/incognito tabs on mobile cap storage too low to fit the data.
          </p>
          <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6, maxWidth: 360, opacity: 0.85 }}>
            Please open this page in a regular browser tab.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="fullscreen-screen">
        <div className="screen-content">
          <img src="/icon.svg" className="screen-logo" alt="" aria-hidden="true" />
          <h1 className="screen-title">Gurbani Search</h1>
          <p style={{ color: 'var(--danger)', marginTop: 16, fontSize: 14 }}>
            Failed to load Gurbani data. Please refresh to try again.
          </p>
          {error && (
            <p style={{ color: 'var(--muted, #888)', marginTop: 8, fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-word', maxWidth: 360 }}>
              {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (status === 'downloading') {
    return (
      <DownloadScreen
        progress={progress}
        bytesDownloaded={bytesDownloaded}
        totalBytes={totalBytes}
        speed={speed}
      />
    )
  }

  if (!data) {
    return (
      <LoadingScreen
        dataReady={status === 'parsing'}
        onReady={setData}
      />
    )
  }

  return (
    <>
      <UpdateBanner />
      <SearchApp data={data} />
    </>
  )
}

function App() {
  return IS_DISPLAY ? <DisplayApp /> : <GurbaniApp />
}

export default App
