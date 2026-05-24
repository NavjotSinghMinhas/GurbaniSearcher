// Memory-efficient streaming parser for gurbani.min.json.
//
// The file is a single root object whose values are all arrays of objects:
//   {"Banis":[{...},{...},…], "Banis_Shabad":[…], "Verse":[…], …}
//
// `await file.text() + JSON.parse(text)` holds the entire 321 MB string AND
// the 200-400 MB parsed tree in memory simultaneously — peak ~600 MB+, which
// reliably trips the per-tab memory limit on mobile Chrome and crashes the
// page. This parser walks the file's byte stream one chunk at a time and
// JSON.parses array elements as they are completed, keeping only the growing
// result tree in memory. Peak ≈ result tree alone (~200-400 MB), well inside
// the mobile budget. Bonus: each `await reader.read()` yields to the event
// loop, so the UI stays responsive during the parse and progress can render.

export async function streamParseGurbani(blob, onProgress) {
  const result   = {}
  const reader   = blob.stream().getReader()
  const decoder  = new TextDecoder()
  const total    = blob.size
  let bytesRead  = 0

  let state       = 'init'   // init | topobj | key | colon | value | array | object | done
  let currentKey  = ''
  let currentArr  = null
  let buf         = ''
  let objDepth    = 0
  let inStr       = false
  let esc         = false

  function feed(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (state === 'object') {
        buf += ch
        if (esc) { esc = false; continue }
        if (inStr) {
          if (ch === '\\') esc = true
          else if (ch === '"') inStr = false
          continue
        }
        if (ch === '"') { inStr = true; continue }
        if (ch === '{') { objDepth++; continue }
        if (ch === '}') {
          if (--objDepth === 0) {
            currentArr.push(JSON.parse(buf))
            buf = ''
            state = 'array'
          }
        }
        continue
      }
      const code = ch.charCodeAt(0)
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue
      switch (state) {
        case 'init':
          if (ch === '{') state = 'topobj'
          break
        case 'topobj':
          if (ch === '}')      state = 'done'
          else if (ch === '"') { state = 'key'; currentKey = ''; esc = false }
          break
        case 'key':
          if (esc)             { currentKey += ch; esc = false }
          else if (ch === '\\') { esc = true; currentKey += ch }
          else if (ch === '"') { state = 'colon' }
          else                 { currentKey += ch }
          break
        case 'colon':
          if (ch === ':') state = 'value'
          break
        case 'value':
          if (ch === '[') {
            currentArr = []
            result[currentKey] = currentArr
            state = 'array'
          }
          break
        case 'array':
          if (ch === ']')      { currentArr = null; state = 'topobj' }
          else if (ch === '{') { buf = '{'; objDepth = 1; inStr = false; esc = false; state = 'object' }
          break
        case 'done':
        default:
          break
      }
    }
  }

  let lastPct = -1
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytesRead += value.byteLength
    feed(decoder.decode(value, { stream: true }))
    if (onProgress && total > 0) {
      const pct = Math.floor((bytesRead / total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        onProgress(bytesRead / total)
        // `await reader.read()` yields a microtask but the browser doesn't
        // get a paint window if subsequent chunks resolve immediately (OPFS
        // chunks come back from a cached file with effectively zero IO wait).
        // setTimeout(0) is a macrotask, so the renderer can flush a frame
        // between progress updates — without this the percentage often jumps
        // straight from 0% to 100% with no intermediate paint.
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
  }
  const tail = decoder.decode()
  if (tail) feed(tail)
  return result
}
