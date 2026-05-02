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

      try { await root.removeEntry(OPFS_FILE) } catch { /* not there, fine */ }

      setStatus('downloading')

      const response = await fetch(DATA_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      // Detect Git LFS pointer served instead of real file (GitHub Pages + LFS)
      const preview = await response.clone().text().then(t => t.slice(0, 20))
      if (preview.startsWith('version https://git-')) {
        throw new Error('Data file is a Git LFS pointer — the real file is not hosted here. Re-upload the data file outside of Git LFS.')
      }

      const total = parseInt(response.headers.get('content-length') || '0', 10)
      setTotalBytes(total)

      const reader   = response.body.getReader()
      const handle   = await root.getFileHandle(OPFS_FILE, { create: true })
      const writable = await handle.createWritable()

      let received = 0
      const samples = []
      let lastSpeedTick = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writable.write(value)
          received += value.length

          const now = Date.now()
          samples.push({ time: now, bytes: value.length })
          while (samples.length > 1 && samples[0].time < now - 3000) samples.shift()

          if (now - lastSpeedTick > 600) {
            lastSpeedTick = now
            if (samples.length > 1) {
              const windowMs    = now - samples[0].time
              const windowBytes = samples.reduce((s, x) => s + x.bytes, 0)
              setSpeed(Math.round(windowBytes / (windowMs / 1000)))
            }
          }

          setBytesDownloaded(received)
          if (total > 0) setProgress(received / total)
        }
        await writable.close()
      } catch (err) {
        await writable.abort()
        try { await root.removeEntry(OPFS_FILE) } catch { /* ignore */ }
        throw err
      }

      // Sentinel written only after the full file is safely on disk
      const doneHandle   = await root.getFileHandle(OPFS_DONE, { create: true })
      const doneWritable = await doneHandle.createWritable()
      await doneWritable.write(new TextEncoder().encode('1'))
      await doneWritable.close()

      // Hand off to LoadingScreen for the parse phase
      setStatus('parsing')
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
