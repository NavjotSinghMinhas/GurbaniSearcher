const OPFS_FILE = 'gurbani.min.json'
const OPFS_DONE = 'gurbani.min.json.done'

const WRITE_BATCH_BYTES = 4 * 1024 * 1024

self.onmessage = async (e) => {
  const { url } = e.data
  let access = null
  let root = null
  let step = 'init'

  try {
    step = 'getDirectory'
    root = await navigator.storage.getDirectory()

    step = 'removeEntry'
    try { await root.removeEntry(OPFS_FILE) } catch { /* not there, fine */ }

    step = 'fetch'
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const total = parseInt(response.headers.get('content-length') || '0', 10)
    self.postMessage({ type: 'total', total })

    step = 'estimate'
    if (total > 0 && navigator.storage?.estimate) {
      try {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate()
        const available = Math.max(0, quota - usage)
        if (quota > 0 && available < total) {
          const fmt = (b) => (b / 1024 / 1024).toFixed(0) + ' MB'
          throw new Error(`Not enough storage: need ${fmt(total)}, only ${fmt(available)} available (quota ${fmt(quota)})`)
        }
      } catch (err) {
        if (err.message?.startsWith('Not enough storage')) throw err
      }
    }

    step = 'getFileHandle'
    const handle = await root.getFileHandle(OPFS_FILE, { create: true })

    step = 'createSyncAccessHandle'
    access = await handle.createSyncAccessHandle()

    step = 'truncate'
    access.truncate(0)
    if (total > 0) {
      try { access.truncate(total) } catch (err) {
        throw new Error(`Cannot reserve ${(total / 1024 / 1024).toFixed(0)} MB on disk: ${err.message}`)
      }
    }

    const reader = response.body.getReader()
    let received = 0
    let firstChunk = true
    let lastPost = 0

    let batch = []
    let batchBytes = 0

    const flushBatch = () => {
      if (batchBytes === 0) return
      const merged = new Uint8Array(batchBytes)
      let off = 0
      for (const c of batch) { merged.set(c, off); off += c.length }
      step = 'access.write'
      access.write(merged, { at: received })
      received += batchBytes
      batch = []
      batchBytes = 0
    }

    while (true) {
      step = 'reader.read'
      const { done, value } = await reader.read()
      if (done) break

      if (firstChunk) {
        firstChunk = false
        const preview = new TextDecoder().decode(value.slice(0, 20))
        if (preview.startsWith('version https://git-')) {
          throw new Error('Data file is a Git LFS pointer — host the file outside of Git LFS.')
        }
      }

      batch.push(value)
      batchBytes += value.length

      if (batchBytes >= WRITE_BATCH_BYTES) {
        flushBatch()
        const now = Date.now()
        if (now - lastPost > 100) {
          lastPost = now
          self.postMessage({ type: 'progress', received })
        }
      }
    }

    flushBatch()
    self.postMessage({ type: 'progress', received })

    step = 'flush'
    access.flush()
    step = 'close'
    access.close()
    access = null

    step = 'sentinel'
    const doneHandle = await root.getFileHandle(OPFS_DONE, { create: true })
    const doneAccess = await doneHandle.createSyncAccessHandle()
    doneAccess.write(new TextEncoder().encode('1'), { at: 0 })
    doneAccess.flush()
    doneAccess.close()

    self.postMessage({ type: 'done' })
  } catch (err) {
    if (access) { try { access.close() } catch { /* ignore */ } }
    if (root) { try { await root.removeEntry(OPFS_FILE) } catch { /* ignore */ } }
    const message = err?.message || String(err)
    self.postMessage({ type: 'error', message: `[${step}] ${message}` })
  }
}
