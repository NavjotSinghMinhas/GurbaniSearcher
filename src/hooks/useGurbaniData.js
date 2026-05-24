import { useState, useEffect } from 'react'

const OPFS_FILE = 'gurbani.min.json'
const OPFS_DONE = 'gurbani.min.json.done'
const DATA_URL  = import.meta.env.DEV
  ? '/data/gurbani.min.json'
  : 'https://media.githubusercontent.com/media/NavjotSinghMinhas/GurbaniSearcher/main/public/data/gurbani.min.json'

const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
// Private/incognito browsing caps OPFS quota well below this on mobile. The
// scripture file alone is ~321 MB, so anything under 500 MB is unworkable.
const MIN_QUOTA_BYTES = 500 * 1024 * 1024

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
  const [errorKind, setErrorKind]             = useState(null)  // 'private-mobile' | null

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

      // Pre-flight: on mobile, private/incognito mode caps OPFS quota too low
      // to fit the 321 MB scripture file. Surface a clear message instead of
      // letting the worker fail with a generic DOMException mid-download.
      if (IS_MOBILE && navigator.storage?.estimate) {
        try {
          const { quota = 0 } = await navigator.storage.estimate()
          if (quota > 0 && quota < MIN_QUOTA_BYTES) {
            setErrorKind('private-mobile')
            setStatus('error')
            return
          }
        } catch { /* estimate unavailable — fall through and let the worker try */ }
      }

      if (_downloading) return
      _downloading = true

      setStatus('downloading')

      // The actual download runs in a worker so we can use
      // createSyncAccessHandle() — createWritable() on the main thread buffers
      // writes through memory and OOMs on mobile for a 321 MB file.
      const worker = new Worker(
        new URL('../workers/gurbaniDownloadWorker.js', import.meta.url),
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
          if (IS_MOBILE && isStorageQuotaError(msg.message)) {
            setErrorKind('private-mobile')
          }
          setError(msg.message)
          setStatus('error')
        }
      }

      worker.onerror = (e) => {
        worker.terminate()
        _downloading = false
        const message = e?.message || 'Download worker crashed'
        console.error('[GurbaniData]', e)
        if (IS_MOBILE && isStorageQuotaError(message)) {
          setErrorKind('private-mobile')
        }
        setError(message)
        setStatus('error')
      }

      worker.postMessage({ url: DATA_URL })
    } catch (err) {
      _downloading = false
      console.error('[GurbaniData]', err)
      if (IS_MOBILE && isStorageQuotaError(err?.message)) {
        setErrorKind('private-mobile')
      }
      setError(err.message)
      setStatus('error')
    }
  }

  return { status, progress, bytesDownloaded, totalBytes, speed, error, errorKind }
}

/* Heuristic: messages that point at OPFS quota or transient-storage failures
   (the common private-mode failure mode). The browser's DOMException reason
   is "The operation failed for an unknown transient reason (e.g. out of memory)";
   a quota check would say "Not enough storage". */
function isStorageQuotaError(message) {
  if (!message) return false
  return /transient reason|out of memory|quota|not enough storage/i.test(message)
}

/** Delete cached file and sentinel so the next load re-downloads. */
export async function clearGurbaniCache() {
  _downloading = false
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry(OPFS_FILE) } catch { /* ignore */ }
  try { await root.removeEntry(OPFS_DONE) } catch { /* ignore */ }
}
