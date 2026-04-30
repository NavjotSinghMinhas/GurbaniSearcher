import { useState } from 'react'
import { useGurbaniData } from './useGurbaniData.js'
import { DownloadScreen } from './DownloadScreen.jsx'
import { LoadingScreen } from './LoadingScreen.jsx'
import { UpdateBanner } from './UpdateBanner.jsx'
import { SearchApp } from './SearchApp.jsx'
import './App.css'

function App() {
  const { status, progress, bytesDownloaded, totalBytes, speed, error } = useGurbaniData()

  // Populated by LoadingScreen once it finishes reading + parsing from OPFS
  const [data, setData] = useState(null)

  if (status === 'error') {
    return (
      <div className="fullscreen-screen">
        <div className="screen-content">
          <img src="/icon.svg" className="screen-logo" alt="" aria-hidden="true" />
          <h1 className="screen-title">Gurbani Search</h1>
          <p style={{ color: 'var(--danger)', marginTop: 16, fontSize: 14 }}>
            Failed to load Gurbani data. Please refresh to try again.
          </p>
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

  // Show loading screen until data is in memory.
  // dataReady tells LoadingScreen it's safe to start reading from OPFS.
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

export default App
