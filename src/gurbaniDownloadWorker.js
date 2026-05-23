const OPFS_FILE = 'gurbani.min.json'
const OPFS_DONE = 'gurbani.min.json.done'

self.onmessage = async (e) => {
  const { url } = e.data
  let access = null
  let root = null

  try {
    root = await navigator.storage.getDirectory()

    try { await root.removeEntry(OPFS_FILE) } catch { /* not there, fine */ }

    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const total = parseInt(response.headers.get('content-length') || '0', 10)
    self.postMessage({ type: 'total', total })

    const handle = await root.getFileHandle(OPFS_FILE, { create: true })
    access = await handle.createSyncAccessHandle()

    const reader = response.body.getReader()
    let received = 0
    let firstChunk = true
    let lastPost = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      if (firstChunk) {
        firstChunk = false
        const preview = new TextDecoder().decode(value.slice(0, 20))
        if (preview.startsWith('version https://git-')) {
          throw new Error('Data file is a Git LFS pointer — host the file outside of Git LFS.')
        }
      }

      access.write(value, { at: received })
      received += value.length

      const now = Date.now()
      if (now - lastPost > 100) {
        lastPost = now
        self.postMessage({ type: 'progress', received })
      }
    }

    self.postMessage({ type: 'progress', received })

    access.flush()
    access.close()
    access = null

    const doneHandle = await root.getFileHandle(OPFS_DONE, { create: true })
    const doneAccess = await doneHandle.createSyncAccessHandle()
    doneAccess.write(new TextEncoder().encode('1'), { at: 0 })
    doneAccess.flush()
    doneAccess.close()

    self.postMessage({ type: 'done' })
  } catch (err) {
    if (access) { try { access.close() } catch { /* ignore */ } }
    if (root) { try { await root.removeEntry(OPFS_FILE) } catch { /* ignore */ } }
    self.postMessage({ type: 'error', message: err?.message || String(err) })
  }
}
