import { useState, useEffect } from 'react'

const OPFS_FILE = 'gurbani.min.json'
const OPFS_DONE = 'gurbani.min.json.done'
const DATA_URL  = import.meta.env.DEV
  ? '/data/gurbani.min.json'
  : 'https://media.githubusercontent.com/media/NavjotSinghMinhas/GurbaniSearcher/main/public/data/gurbani.min.json'

// Module-level guard: prevents concurrent downloads from React StrictMode's
// double-mount. Atomic because JS is single-threaded with no await between
// the guard check and the flag assignment.
let _downloading = false

export function useGurbaniData() {
  const [status, setStatus]                   = useState('checking')
  const [progress, setProgress]               = useState(0)
  const [bytesDownloaded, setBytesDownloaded] = useState(0)
  const [totalBytes, setTotalBytes]           = useState(0)
  const [speed, setSpeed]                     = useState(0)
  const [error, setError]                     = useState(null)

  useEffect(() => { init() }, [])

  async function init() {
    try {
      const root = await navigator.storage.getDirectory()

      // Sentinel exists → file is complete, LoadingScreen will handle the parse
      try {
        await root.getFileHandle(OPFS_DONE)
        setStatus('parsing')
        return
      } catch { /* sentinel missing — need to download */ }

      if (_downloading) return
      _downloading = true

      setStatus('downloading')

      // The actual download runs in a worker so we can use
      // createSyncAccessHandle() — createWritable() on the main thread buffers
      // writes through memory and OOMs on mobile for a 321 MB file.
      const worker = new Worker(
        new URL('./gurbaniDownloadWorker.js', import.meta.url),
        { type: 'module' }
      )

      let total = 0
      let lastReceived = 0
      const samples = []
      let lastSpeedTick = 0

      worker.onmessage = (e) => {
        const msg = e.data

        if (msg.type === 'total') {
          total = msg.total
          setTotalBytes(msg.total)
          return
        }

        if (msg.type === 'progress') {
          const now = Date.now()
          const delta = msg.received - lastReceived
          lastReceived = msg.received

          if (delta > 0) {
            samples.push({ time: now, bytes: delta })
            while (samples.length > 1 && samples[0].time < now - 3000) samples.shift()
          }

          if (now - lastSpeedTick > 600) {
            lastSpeedTick = now
            if (samples.length > 1) {
              const windowMs    = now - samples[0].time
              const windowBytes = samples.reduce((s, x) => s + x.bytes, 0)
              setSpeed(Math.round(windowBytes / (windowMs / 1000)))
            }
          }

          setBytesDownloaded(msg.received)
          if (total > 0) setProgress(msg.received / total)
          return
        }

        if (msg.type === 'done') {
          worker.terminate()
          setStatus('parsing')
          return
        }

        if (msg.type === 'error') {
          worker.terminate()
          _downloading = false
          console.error('[GurbaniData]', msg.message)
          setError(msg.message)
          setStatus('error')
        }
      }

      worker.onerror = (e) => {
        worker.terminate()
        _downloading = false
        const message = e?.message || 'Download worker crashed'
        console.error('[GurbaniData]', e)
        setError(message)
        setStatus('error')
      }

      worker.postMessage({ url: DATA_URL })
    } catch (err) {
      _downloading = false
      console.error('[GurbaniData]', err)
      setError(err.message)
      setStatus('error')
    }
  }

  return { status, progress, bytesDownloaded, totalBytes, speed, error }
}

/** Delete cached file and sentinel so the next load re-downloads. */
export async function clearGurbaniCache() {
  _downloading = false
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(OPFS_FILE) } catch { /* ignore */ }
  try { await root.removeEntry(OPFS_DONE) } catch { /* ignore */ }
}
