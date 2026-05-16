import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'
import { BG_PRESETS, getTranslation, getTranslationOptions, renderGurmukhi } from './DisplayApp.jsx'
import './SearchApp.css'

const { toUnicode, toAscii, isGurmukhi } = gurmukhiUtils

const CHROME       = 'webkitSpeechRecognition' in window
const CHANNEL_NAME = 'gurbani-display'
const HISTORY_KEY  = 'gurbani-history'
const SETTINGS_KEY = 'gurbani-disp-settings'
const THEME_KEY    = 'gurbani-theme'
const MAX_HISTORY  = 50
const DEFAULT_SETTINGS = {
  fontSize: 48, transSize: 20, showTranslation: true, showMeta: true, larivar: false, bg: 'dark', verseCount: 1, translationKey: 'auto',
}

const MODES = [
  { id: 'firstLetters', label: 'First Letters', hint: 'Finds verses containing those consecutive first letters anywhere — sorted by position' },
  { id: 'word',         label: 'Whole Word',    hint: 'Type an exact Gurmukhi word in Gurmukhi script or transliteration — e.g. ਨਾਮੁ or nwmu' },
  { id: 'anywhere',     label: 'Anywhere',      hint: 'Find any verse containing this substring — type in Gurmukhi or transliteration' },
  { id: 'fuzzy',        label: 'Fuzzy',         hint: 'Matches verses where most words are similar — handles slight spelling or ending differences' },
  { id: 'english',      label: 'English',       hint: 'Search across all English translations' },
]

// Maryada (tradition) — each Banis_Shabad row carries existsSGPC / existsTaksal /
// existsBuddhaDal / existsMedium flags. Banis like Rehras Sahib differ across
// maryadas; without filtering we'd show the union of all of them.
const MARYADAS = [
  { id: 'SGPC',      flag: 'existsSGPC',      label: 'SGPC' },
  { id: 'Taksal',    flag: 'existsTaksal',    label: 'Taksal' },
  { id: 'BuddhaDal', flag: 'existsBuddhaDal', label: 'Buddha Dal' },
  { id: 'Medium',    flag: 'existsMedium',    label: 'Medium' },
]
const MARYADA_KEY = 'gurbani-maryada'
const DEFAULT_MARYADA = 'SGPC'

// Nitnem baanis surfaced at the top of the Baanis sidebar in this order
const NITNEM_BANI_IDS = [2, 4, 6, 7, 9, 10, 21, 23, 24]
// Banis the kirtan matcher will auto-attach as context when a recognised verse
// belongs to one. Listed in priority order — when a verse is in multiple of
// these (e.g. a Salok M9 line in both Rehras and Sukhmani), the earlier wins.
// We keep this curated rather than every bani in the data, so a generic
// "ਰਾਗੁ X" page-range doesn't get auto-promoted to a kirtan context.
const KIRTAN_AUTO_BANI_IDS = [
  2, 4, 6, 7, 9, 10, 21, 23, 24,  // nitnem
  31, 36, 27, 28, 11, 29, 3, 5,   // other common: Sukhmani, Dukh Bhanjani, Barah Maha, Lavaan, Akal Ustat, Shabad Hazare
  90,                              // Asa Di Vaar (last — large)
]
const NITNEM_LABELS = {
  2:  'Japji Sahib',
  4:  'Jaap Sahib',
  6:  'Tav Prasad Savaiye',
  7:  'Tav Prasad Savaiye (Deenan)',
  9:  'Chaupai Sahib',
  10: 'Anand Sahib',
  21: 'Rehras Sahib',
  23: 'Sohila Sahib',
  24: 'Ardas',
  31: 'Sukhmani Sahib',
  27: 'Barah Maha (Manjh)',
  36: 'Dukh Bhanjani Sahib',
  11: 'Lavaan',
  29: 'Akal Ustat',
  90: 'Asa Di Vaar',
  3:  'Shabad Hazare',
  5:  'Shabad Hazare Patshahi 10',
}

const KEYBOARD_LAYOUT = [
  { label: 'ਵਰਣਮਾਲਾ · Consonants', chars: ['ੳ','ਅ','ੲ','ਸ','ਹ','ਕ','ਖ','ਗ','ਘ','ਙ','ਚ','ਛ','ਜ','ਝ','ਞ','ਟ','ਠ','ਡ','ਢ','ਣ','ਤ','ਥ','ਦ','ਧ','ਨ','ਪ','ਫ','ਬ','ਭ','ਮ','ਯ','ਰ','ਲ','ਵ','ੜ','ਸ਼','ਖ਼','ਗ਼','ਜ਼','ਫ਼','ਲ਼'] },
  { label: 'ਲਗਾਂ · Vowel signs',   chars: ['ਾ','ਿ','ੀ','ੁ','ੂ','ੇ','ੈ','ੋ','ੌ','ੰ','ੱ','ਂ'] },
]

/* ── helpers ─────────────────────────────────────────────────── */

function normalizeQuery(q) { return isGurmukhi(q) ? toAscii(q) : q }

function runSearch(verses, query, mode) {
  if (!query.trim()) return []
  const q = normalizeQuery(query.trim()).toLowerCase()
  if (mode === 'firstLetters') {
    const qn = q.replace(/\s+/g, '')
    if (!qn) return []
    const scored = []
    for (const v of verses) {
      const idx = (v.FirstLetterEng || '').toLowerCase().indexOf(qn)
      if (idx !== -1) scored.push({ v, idx })
    }
    return scored.sort((a, b) => a.idx - b.idx).slice(0, 50).map(x => x.v)
  }
  if (mode === 'fuzzy') {
    const qWords = q.split(/\s+/).map(cleanWord).filter(w => w.length >= 2)
    if (qWords.length === 0) return []
    const minMatch = Math.max(1, Math.ceil(qWords.length * 0.5))
    const scored = []
    for (const v of verses) {
      const vWords = v.Gurmukhi.split(/\s+/).map(cleanWord).filter(w => w.length >= 2)
      const matches = wordMatchCount(qWords, vWords)
      if (matches >= minMatch) scored.push({ v, matches })
    }
    return scored.sort((a, b) => b.matches - a.matches).slice(0, 50).map(x => x.v)
  }
  const results = []
  for (const v of verses) {
    let hit = false
    if      (mode === 'word')     hit = v.Gurmukhi.split(/\s+/).some(w => w.replace(/[\][\d|(){}]/g, '').toLowerCase() === q)
    else if (mode === 'anywhere') hit = v.Gurmukhi.toLowerCase().includes(q)
    else                          hit = (v.Translations || '').toLowerCase().includes(q)
    if (hit) { results.push(v); if (results.length >= 50) break }
  }
  return results
}

// Strip verse structural markers; keep Gurmukhi ASCII case (ਕ=k, ਖ=K etc.)
function cleanWord(w) {
  return w.replace(/[<>\[\]|(){}0-9]/g, '')
}

// Fuzzy word match: allow 1 edit for words ≤6 chars, 2 edits for longer.
// Quick-reject on first char saves ~97% of comparisons in practice.
function fuzzyWordMatch(a, b) {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (la < 2 || lb < 2) return false
  const maxEdit = Math.max(la, lb) <= 6 ? 1 : 2
  if (Math.abs(la - lb) > maxEdit) return false
  if (la <= 5 && lb <= 5 && a[0] !== b[0]) return false
  let row = Array.from({length: lb + 1}, (_, j) => j)
  for (let i = 0; i < la; i++) {
    const nxt = [i + 1]
    let rowMin = i + 1
    for (let j = 0; j < lb; j++) {
      const v = a[i] === b[j] ? row[j] : 1 + Math.min(row[j + 1], nxt[j], row[j])
      nxt.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > maxEdit) return false
    row = nxt
  }
  return row[lb] <= maxEdit
}

// Count how many transcript words fuzzy-match at least one word in the verse
function wordMatchCount(tWords, vWords) {
  let n = 0
  for (const tw of tWords) {
    if (vWords.some(vw => fuzzyWordMatch(tw, vw))) n++
  }
  return n
}

// Context-aware kirtan matcher. Runs on every speech-recognition event —
// interim AND final — and scores verses on word-level fuzzy matches rather
// than waiting for Chrome's confidence to spike on a final.
//
// Key idea: an interim transcript like "Har Amrit Bhi" already has 2 settled
// words ("Har", "Amrit") plus a truncated trailing word ("Bhi") that is a
// prefix of "Bhinne". Matching this against the current shabad gives a strong
// signal long before Chrome commits the final "Har Amrit Bhinne Loyna".
//
// Tiers (combined match count → action):
//   in-context, same verse:        ≥1 match  (stay; strong inertia)
//   in-context, same shabad/bani:  ≥2 matches (cross-verse jump within ctx)
//   different shabad:              ≥3 matches + isFinal && conf≥0.6
//   discovery (no context):        ≥2.5 matches (interim OK)
//
// Cross-shabad is the one path gated to confident finals — partial transcripts
// can't pull the broadcast away from the current bani. Discovery (kirtan
// listening with nothing selected) runs on interims so a candidate shows up
// as soon as the singer has uttered ~3 recognisable words; otherwise we'd be
// stuck until Chrome finalises on a silence, which during continuous kirtan
// effectively only happens when the recogniser is stopped.
function smartMatchKirtan(speechResults, verses, contextVerse, contextShabadVerses, verseWordsMap) {
  if (!speechResults || speechResults.length === 0) return null

  // Build a rolling word window from the most recent results. Chrome can
  // finalise a chunk mid-kirtan and immediately start a fresh interim — if
  // we only read the latest chunk, a one-word interim like "Naam" appearing
  // after a finalised "Har Amrit Bhinne Loyna" would yank us to any verse
  // starting with "naam". Walking back through prior chunks (finalised or
  // not) gives the matcher the actual recent context to anchor on, even
  // when individual words are wrong/missing.
  const WINDOW = 8
  let isFinal = false, conf = 0, lastHasWords = false
  let recent = []
  for (let i = speechResults.length - 1; i >= 0; i--) {
    const r = speechResults[i]
    const words = r[0].transcript.trim().split(/\s+/).filter(Boolean)
      .map(w => cleanWord(isGurmukhi(w) ? toAscii(w) : w))
      .filter(w => w.length >= 2)
    if (i === speechResults.length - 1) {
      isFinal       = !!r.isFinal
      conf          = r[0].confidence || 0
      lastHasWords  = words.length > 0
    }
    recent = words.concat(recent)
    if (recent.length >= WINDOW + 2) break
  }
  if (recent.length === 0) return null

  const windowed = recent.length > WINDOW ? recent.slice(-WINDOW) : recent

  // The "trailing" word only makes sense when the latest chunk is interim AND
  // has at least one word — otherwise the windowed tail came from an already-
  // finalised chunk and should be treated as settled, not a prefix candidate.
  const trailingIsInterim = !isFinal && lastHasWords
  const settled  = trailingIsInterim ? windowed.slice(0, -1) : windowed
  const trailing = trailingIsInterim ? windowed[windowed.length - 1] : null
  if (settled.length === 0 && !trailing) return null

  const hasCtx = contextVerse != null
  const ctxSet = contextShabadVerses ? new Set(contextShabadVerses.map(v => v.ID)) : null
  // The one path still gated to confident finals — pulling out of the
  // current bani/shabad needs strong evidence.
  const allowCrossShabad = isFinal && conf >= 0.6

  // If we already have a shabad/bani context AND we won't promote out of it
  // this turn, only consider those verses — much faster than scanning 142k
  // every interim event.
  const pool = (hasCtx && !allowCrossShabad) ? contextShabadVerses : verses

  let best = null, bestScore = 0

  for (const v of pool) {
    let minMatch, inertia
    if (!hasCtx) {
      // Discovery: no surrounding shabad to anchor on, so demand a slightly
      // stricter word match than in-context — but DON'T require a final, or
      // a candidate never appears mid-singing.
      minMatch = 2.5; inertia = 0
    } else if (v.ID === contextVerse.ID) {
      minMatch = 1; inertia = 2
    } else if (ctxSet?.has(v.ID)) {
      minMatch = 2; inertia = 1
    } else {
      if (!allowCrossShabad) continue
      minMatch = 3; inertia = 0
    }

    const vWords = verseWordsMap.get(v.ID)
    if (!vWords || vWords.length === 0) continue

    let matched = wordMatchCount(settled, vWords)
    // Trailing partial word — full credit if it actually matches a verse
    // word (Chrome may have already committed it internally), half credit
    // if it's a prefix of some longer verse word (still being recognised).
    if (trailing) {
      if (vWords.some(vw => fuzzyWordMatch(trailing, vw))) matched += 1
      else if (trailing.length >= 2 && vWords.some(vw => vw.length > trailing.length && vw.startsWith(trailing))) matched += 0.5
    }
    if (matched < minMatch) continue

    const score = matched + inertia
    if (score > bestScore) { bestScore = score; best = v }
  }

  return best
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } }
  catch { return { ...DEFAULT_SETTINGS } }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') }
  catch { return [] }
}

function relTime(ts) {
  const d = Date.now() - ts
  if (d < 60000)     return 'just now'
  if (d < 3600000)   return `${Math.floor(d / 60000)}m ago`
  if (d < 86400000)  return `${Math.floor(d / 3600000)}h ago`
  if (d < 604800000) return `${Math.floor(d / 86400000)}d ago`
  return new Date(ts).toLocaleDateString()
}

/* ══════════════════════════════════════════════════════════════
   SearchApp
══════════════════════════════════════════════════════════════ */
export function SearchApp({ data }) {
  const verses = data?.Verse ?? []

  /* search */
  const [query,        setQuery]        = useState('')
  const [mode,         setMode]         = useState('firstLetters')
  const [results,      setResults]      = useState([])
  const [online,       setOnline]       = useState(navigator.onLine)
  const [showKeyboard, setShowKeyboard] = useState(false)

  /* theme */
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'dark')

  /* ── PREVIEW PANEL — the "browsing" view ────────────────────── */
  /* clicking a search result always lands here; does NOT touch broadcast */
  const [pvVerse,   setPvVerse]   = useState(null)   // anchor verse (from search click)
  const [pvSvs,     setPvSvs]     = useState([])     // shabad verses shown in preview
  const [pvDv,      setPvDv]      = useState(null)   // currently highlighted verse in preview
  const [pvBani,    setPvBani]    = useState(null)   // bani meta when preview is showing a whole bani
  const [pvSectionLabels, setPvSectionLabels] = useState(null)  // Map<rowId, label> for bani section dividers
  const [showPreview, setShowPreview] = useState(false)

  /* ── BAANIS SIDEBAR ────────────────────────────────────────── */
  const [showBanis, setShowBanis] = useState(false)
  const [maryada,   setMaryada]   = useState(() => localStorage.getItem(MARYADA_KEY) || DEFAULT_MARYADA)

  /* ── BROADCAST PANEL ───────────────────────────────────────── */
  const [bcastVerse, setBcastVerse] = useState(null)
  const [bcastSvs,   setBcastSvs]   = useState([])
  const [bcastDv,    setBcastDv]    = useState(null)
  const [bcastLive,  setBcastLive]  = useState(false) // true = actively sending to display tab
  const [bcastBani,  setBcastBani]  = useState(null)  // bani meta when broadcasting a whole bani
  const [bcastSectionLabels, setBcastSectionLabels] = useState(null)

  const bcastPanelOpen = bcastVerse !== null  // panel is visible (live or stopped)
  const isBroadcasting = bcastLive            // actively sending to display tab

  /* history */
  const [searchHistory, setSearchHistory] = useState(loadHistory)

  /* display settings (shared — apply to broadcast display only) */
  const [displaySettings, setDisplaySettings] = useState(loadSettings)

  /* kirtan voice */
  const [kirtanMode,       setKirtanMode]       = useState('off')
  const [kirtanCandidate,  setKirtanCandidate]  = useState(null)
  const [kirtanTranscript, setKirtanTranscript] = useState('')

  /* refs (stable across renders for callbacks/effects) */
  const channelRef         = useRef(null)
  const kirtanRecRef       = useRef(null)
  const kirtanModeRef      = useRef('off')
  const kirtanApprovedRef       = useRef(false)
  const kirtanVerseWordsRef     = useRef(null)   // pre-split verse words, built once on first start
  const kirtanShabadCandidateRef = useRef(null)  // pending shabad switch { shabadId, verse, count }
  const debounceRef        = useRef(null)
  const inputRef           = useRef(null)
  const bcastDvRef         = useRef(null)
  const bcastSvsRef        = useRef([])
  const bcastLiveRef       = useRef(false)
  const displaySettingsRef = useRef(displaySettings)
  const focusedPanelRef    = useRef('preview')

  useEffect(() => { kirtanModeRef.current      = kirtanMode      }, [kirtanMode])
  useEffect(() => { bcastDvRef.current         = bcastDv         }, [bcastDv])
  useEffect(() => { bcastSvsRef.current        = bcastSvs        }, [bcastSvs])
  useEffect(() => { bcastLiveRef.current       = bcastLive       }, [bcastLive])
  useEffect(() => { displaySettingsRef.current = displaySettings }, [displaySettings])

  /* ── theme ─────────────────────────────────────────────────── */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  /* ── shabad index ──────────────────────────────────────────── */
  const shabadIndex = useMemo(() => {
    const map = new Map()
    for (const v of verses) {
      for (const s of (v.Shabads || [])) {
        if (!map.has(s.ShabadID)) map.set(s.ShabadID, [])
        map.get(s.ShabadID).push(v)
      }
    }
    return map
  }, [verses])

  /* ── bani index ────────────────────────────────────────────── */
  /* For each Bani: ordered list of Verses (Custom/header rows skipped), wrapped
     with a unique __rowId so duplicate verses (e.g. refrains in Japji) are still
     distinct rows. Filtered to the selected maryada — Banis_Shabad lumps SGPC,
     Taksal, Buddha Dal and Medium variants together; reading the union shows
     verses that don't belong to the user's tradition. Bookmark seqs are looked
     up against the unfiltered row table so dividers still anchor to the first
     surviving verse of each section even when some rows are filtered out. */
  const baniInfo = useMemo(() => {
    const banisList     = data?.Banis           || []
    const banisShabad   = data?.Banis_Shabad    || []
    const banisBookmark = data?.Banis_Bookmarks || []
    const flag = (MARYADAS.find(m => m.id === maryada) || MARYADAS[0]).flag
    // Full row → seq lookup so bookmarks pointing at filtered-out rows still
    // resolve to a valid Seq and attach to the next surviving verse.
    const seqByRowId = new Map(banisShabad.map(r => [r.ID, r.Seq]))
    const byBani = new Map()
    for (const b of banisList) byBani.set(b.ID, { meta: b, lines: [], bookmarks: [] })
    for (const row of banisShabad) {
      if (!row[flag]) continue
      const bid = row.Bani?.ID
      const entry = byBani.get(bid)
      if (entry) entry.lines.push(row)
    }
    for (const bm of banisBookmark) {
      const entry = byBani.get(bm.Bani)
      if (entry) entry.bookmarks.push(bm)
    }
    for (const entry of byBani.values()) {
      entry.lines.sort((a, b) => a.Seq - b.Seq)
      const bms = entry.bookmarks
        .map(bm => ({ seq: seqByRowId.get(bm.BaniShabadID) ?? -1, gurmukhi: bm.Gurmukhi, sortSeq: bm.Seq }))
        .filter(bm => bm.seq !== -1)
        .sort((a, b) => a.seq - b.seq || a.sortSeq - b.sortSeq)
      entry.verses = []
      entry.sectionLabels = new Map()
      let bmIdx = 0
      let pendingLabel = null
      for (const line of entry.lines) {
        while (bmIdx < bms.length && bms[bmIdx].seq <= line.Seq) {
          pendingLabel = bms[bmIdx].gurmukhi
          bmIdx++
        }
        if (line.Verse) {
          const wrapped = { ...line.Verse, __rowId: line.ID }
          entry.verses.push(wrapped)
          if (pendingLabel) { entry.sectionLabels.set(line.ID, pendingLabel); pendingLabel = null }
        }
      }
      // Drop bookmarks for single-verse sections — a divider above an isolated
      // verse just adds visual noise without aiding navigation.
      const positions = []
      for (let i = 0; i < entry.verses.length; i++) {
        const rowId = entry.verses[i].__rowId ?? entry.verses[i].ID
        if (entry.sectionLabels.has(rowId)) positions.push({ idx: i, rowId })
      }
      for (let j = 0; j < positions.length; j++) {
        const cur  = positions[j]
        const next = positions[j + 1]
        const size = (next ? next.idx : entry.verses.length) - cur.idx
        if (size <= 1) entry.sectionLabels.delete(cur.rowId)
      }
    }
    return byBani
  }, [data, maryada])

  /* Reverse index: verseId → [baniId, …] so the kirtan matcher can auto-pick a
     bani context (e.g. recognise that a recognised verse is part of Rehras)
     even when the user didn't open the bani manually from the sidebar. */
  const verseToBani = useMemo(() => {
    const m = new Map()
    for (const entry of baniInfo.values()) {
      for (const v of entry.verses) {
        const list = m.get(v.ID)
        if (list) list.push(entry.meta.ID)
        else m.set(v.ID, [entry.meta.ID])
      }
    }
    return m
  }, [baniInfo])

  /* Pick the most useful bani for a verse. Priority:
       1. Caller's preferred bani if it contains the verse (current bcast/preview)
       2. First match from KIRTAN_AUTO_BANI_IDS in declared priority order
     Returns the full baniInfo entry (meta + verses + sectionLabels), or null
     if the verse isn't part of any auto-detect bani — caller should fall back
     to plain shabad context. */
  function findBaniForVerse(verseId, preferBaniId = null) {
    const baniIds = verseToBani.get(verseId)
    if (!baniIds || baniIds.length === 0) return null
    if (preferBaniId && baniIds.includes(preferBaniId)) {
      const e = baniInfo.get(preferBaniId)
      if (e?.verses.length > 0) return e
    }
    for (const id of KIRTAN_AUTO_BANI_IDS) {
      if (!baniIds.includes(id)) continue
      const e = baniInfo.get(id)
      if (e?.verses.length > 0) return e
    }
    return null
  }

  /* ── BroadcastChannel ──────────────────────────────────────── */
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = ch
    ch.onmessage = e => {
      if (e.data.type === 'ping' && bcastDvRef.current && bcastLiveRef.current) {
        pushBroadcast(bcastDvRef.current, displaySettingsRef.current, kirtanModeRef.current === 'auto')
      }
    }
    return () => { ch.close(); channelRef.current = null }
  }, [])

  function pushBroadcast(anchorVerse, settings, voiceActive = false, overrideSvs = null) {
    const svs = overrideSvs ?? bcastSvsRef.current
    const count = settings.verseCount || 1
    // Use indexOf so duplicate verses (same ID, different occurrence) resolve to the
    // exact row the user selected, not just the first match in the list.
    const idx = anchorVerse ? svs.indexOf(anchorVerse) : -1
    const broadcastVerses = idx !== -1
      ? svs.slice(idx, Math.min(idx + count, svs.length))
      : anchorVerse ? [anchorVerse] : []
    channelRef.current?.postMessage({ type: 'sync', verses: broadcastVerses, settings, voiceActive })
  }

  function sendFullscreen() {
    channelRef.current?.postMessage({ type: 'fullscreen' })
  }

  function updateSetting(key, value) {
    setDisplaySettings(prev => {
      const next = { ...prev, [key]: value }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      if (bcastDvRef.current && bcastLiveRef.current) {
        pushBroadcast(bcastDvRef.current, next, kirtanModeRef.current === 'auto')
      }
      return next
    })
  }

  /* ── online/offline ────────────────────────────────────────── */
  useEffect(() => {
    const up = () => setOnline(true)
    const dn = () => setOnline(false)
    window.addEventListener('online',  up)
    window.addEventListener('offline', dn)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', dn) }
  }, [])

  /* ── debounced search ──────────────────────────────────────── */
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!query.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(() => setResults(runSearch(verses, query, mode)), 280)
    return () => clearTimeout(debounceRef.current)
  }, [query, mode, verses])

  /* ── global arrow-key navigation ──────────────────────────── */
  useEffect(() => {
    function onKey(e) {
      if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return
      if (document.activeElement?.tagName === 'INPUT' && !bcastLiveRef.current) return
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      if (bcastSvsRef.current.length > 0) {
        const svs         = bcastSvsRef.current
        const count       = displaySettingsRef.current.verseCount || 1
        const idx         = bcastDvRef.current ? svs.indexOf(bcastDvRef.current) : -1
        const currentPage = Math.floor(idx / count)
        const totalPages  = Math.ceil(svs.length / count)
        const nextPage    = Math.max(0, Math.min(totalPages - 1, currentPage + dir))
        const next        = nextPage * count
        if (next !== idx) {
          const v = svs[next]
          setBcastDv(v)
          if (bcastLiveRef.current) {
            pushBroadcast(v, displaySettingsRef.current, kirtanModeRef.current === 'auto')
          }
        }
      } else if (showPreview) {
        setPvDv(prev => {
          const svs  = pvSvs
          const idx  = prev ? svs.indexOf(prev) : -1
          const next = Math.max(0, Math.min(svs.length - 1, idx + dir))
          return svs[next] ?? prev
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showPreview, pvSvs])

  /* ── kirtan voice ──────────────────────────────────────────── */
  function startKirtan() {
    if (!CHROME || !online) return
    // Build pre-split word map once; reused for every onresult call this session
    if (!kirtanVerseWordsRef.current) {
      const m = new Map()
      for (const v of verses) {
        m.set(v.ID, v.Gurmukhi.split(/\s+/).map(cleanWord).filter(w => w.length >= 2))
      }
      kirtanVerseWordsRef.current = m
    }
    const verseWordsMap = kirtanVerseWordsRef.current
    /* eslint-disable no-undef */
    const R = new webkitSpeechRecognition()
    R.continuous = true; R.interimResults = true; R.lang = 'pa-IN'
    R.onresult = e => {
      let transcript = ''
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript
      setKirtanTranscript(transcript)
      const approved = kirtanApprovedRef.current
      const match = smartMatchKirtan(
        e.results, verses,
        approved ? bcastDvRef.current  : null,
        approved ? bcastSvsRef.current : null,
        verseWordsMap
      )
      if (!match) return
      setKirtanCandidate(match)
      if (approved) {
        const svs = bcastSvsRef.current
        // For banis, bcastSvs holds wrapped rows ({ ...Verse, __rowId }); the
        // kirtan match comes from the raw `verses` array. Look up the wrapped
        // row by ID so bcastDv stays reference-equal to a bcastSvs entry —
        // otherwise the active highlight, indexOf, and arrow-key nav all break.
        const svsMatch = svs.find(v => v.ID === match.ID)
        if (svsMatch) {
          // Match is within the current shabad — navigate and clear any pending switch
          kirtanShabadCandidateRef.current = null
          setBcastDv(svsMatch)
          pushBroadcast(svsMatch, displaySettingsRef.current, true)
        } else {
          // Match is from a different shabad. Two fast paths first:
          //   a) If the current bcast verse AND the new match both live in
          //      the same auto-detect bani, this isn't really a shabad switch
          //      — it's the next pauri of the same bani. Skip the 3-retry
          //      and upgrade bcastSvs to the full bani so subsequent jumps
          //      stay "same shabad" forever after.
          //   b) Otherwise it's a genuine cross-shabad — keep the existing
          //      3-consecutive-match safeguard, but after committing, still
          //      try to attach a bani context for the new shabad.
          const currentVerseId = bcastDvRef.current?.ID
          const currentBaniIds = currentVerseId ? (verseToBani.get(currentVerseId) || []) : []
          const matchBaniIds   = verseToBani.get(match.ID) || []
          const sharedBaniId   = currentBaniIds.find(b => matchBaniIds.includes(b) && KIRTAN_AUTO_BANI_IDS.includes(b))
          if (sharedBaniId) {
            const entry = baniInfo.get(sharedBaniId)
            const wrapped = entry?.verses.find(v => v.ID === match.ID)
            if (entry && wrapped) {
              kirtanShabadCandidateRef.current = null
              startBroadcast(wrapped, entry.verses, true, entry.meta, entry.sectionLabels)
              return
            }
          }
          const shabadId = match.Shabads?.[0]?.ShabadID
          const prev = kirtanShabadCandidateRef.current
          if (prev?.shabadId === shabadId) {
            prev.count++
            prev.verse = match
            if (prev.count >= 3) {
              kirtanShabadCandidateRef.current = null
              const entry = findBaniForVerse(match.ID)
              const wrapped = entry?.verses.find(v => v.ID === match.ID)
              if (entry && wrapped) {
                startBroadcast(wrapped, entry.verses, true, entry.meta, entry.sectionLabels)
              } else {
                startBroadcast(match, getShabadVerses(match), true)
              }
            }
          } else {
            kirtanShabadCandidateRef.current = { shabadId, verse: match, count: 1 }
          }
        }
      }
    }
    R.onerror = () => {}
    R.onend   = () => { if (kirtanModeRef.current !== 'off') try { R.start() } catch { /* ok */ } }
    R.start()
    kirtanRecRef.current = R
    setKirtanCandidate(null)
    setKirtanTranscript('')
    // If something is already being broadcast, the user has already chosen the
    // shabad/bani — skip the listening + confirmation phase, lock onto that as
    // the context, and let kirtan auto-navigate within it. Cross-shabad
    // switches still need the existing 3-consecutive-match safeguard.
    if (bcastLiveRef.current && bcastDvRef.current) {
      kirtanApprovedRef.current = true
      setKirtanMode('auto')
      pushBroadcast(bcastDvRef.current, displaySettingsRef.current, true)
    } else {
      kirtanApprovedRef.current = false
      setKirtanMode('listening')
    }
  }

  function stopKirtan() {
    kirtanRecRef.current?.stop()
    kirtanRecRef.current = null
    kirtanApprovedRef.current = false
    kirtanShabadCandidateRef.current = null
    setKirtanMode('off')
    setKirtanCandidate(null)
    setKirtanTranscript('')
    if (bcastDvRef.current) {
      pushBroadcast(bcastDvRef.current, displaySettingsRef.current, false)
    }
  }

  function approveKirtanCandidate() {
    if (!kirtanCandidate) return
    kirtanApprovedRef.current = true
    setKirtanMode('auto')
    // Pick a bani context — first preferring the one already open, then any
    // bani in the curated KIRTAN_AUTO_BANI_IDS list that contains this verse.
    // If we find one, broadcasting the whole bani means subsequent within-bani
    // pauri jumps stay "same shabad" and skip the 3-retry safeguard entirely.
    const preferId  = pvBani?.ID ?? bcastBani?.ID ?? null
    const baniEntry = findBaniForVerse(kirtanCandidate.ID, preferId)
    const wrappedMatch = baniEntry?.verses.find(v => v.ID === kirtanCandidate.ID)
    if (wrappedMatch && baniEntry) {
      startBroadcast(wrappedMatch, baniEntry.verses, true, baniEntry.meta, baniEntry.sectionLabels)
      saveHistory(historyEntry(kirtanCandidate, baniEntry.meta))
    } else {
      startBroadcast(kirtanCandidate, getShabadVerses(kirtanCandidate), true)
      saveHistory(historyEntry(kirtanCandidate))
    }
  }

  /* ── shabad helpers ────────────────────────────────────────── */
  function getShabadVerses(verse) {
    const id = verse.Shabads?.[0]?.ShabadID
    return id && shabadIndex.has(id) ? shabadIndex.get(id) : [verse]
  }

  /* ── preview panel actions ─────────────────────────────────── */
  function openVerse(verse) {
    const svs = getShabadVerses(verse)
    setPvVerse(verse)
    setPvSvs(svs)
    setPvDv(verse)
    setPvBani(null)
    setPvSectionLabels(null)
    setShowPreview(true)
    focusedPanelRef.current = 'preview'
  }

  function openFromHistory(entry) {
    // Bani entries reopen the whole bani — verse counts may differ from when
    // the entry was saved (e.g. maryada changed), so re-derive from baniInfo.
    if (entry.baniId && baniInfo.get(entry.baniId)?.verses.length > 0) {
      openBani(entry.baniId)
      return
    }
    const verse = verses.find(v => v.ID === entry.verseId)
    if (!verse) return
    const svs = entry.shabadId && shabadIndex.has(entry.shabadId)
      ? shabadIndex.get(entry.shabadId) : [verse]
    setPvVerse(verse); setPvSvs(svs); setPvDv(verse); setShowPreview(true)
    setPvBani(null); setPvSectionLabels(null)
    focusedPanelRef.current = 'preview'
  }

  /* Switching maryada changes which verses belong to each bani, so any bani
     currently rendered in the preview holds a now-stale verse list. Close it
     and persist the choice; the user can re-open the bani to see the new view. */
  function changeMaryada(m) {
    setMaryada(m)
    localStorage.setItem(MARYADA_KEY, m)
    if (pvBani) {
      setShowPreview(false)
      setPvVerse(null); setPvSvs([]); setPvDv(null)
      setPvBani(null); setPvSectionLabels(null)
    }
  }

  /* Open an entire bani (Japji Sahib, Jaap Sahib, …) in the preview panel. */
  function openBani(baniId) {
    const entry = baniInfo.get(baniId)
    if (!entry || entry.verses.length === 0) return
    const first = entry.verses[0]
    setPvVerse(first)
    setPvSvs(entry.verses)
    setPvDv(first)
    setPvBani(entry.meta)
    setPvSectionLabels(entry.sectionLabels)
    setShowPreview(true)
    focusedPanelRef.current = 'preview'
  }

  function selectPvVerse(verse) {
    setPvDv(verse)
    focusedPanelRef.current = 'preview'
    /* deliberately does NOT broadcast */
  }

  /* ── broadcast panel actions ───────────────────────────────── */
  function startBroadcast(verse, svs, voiceActive = false, bani = null, sectionLabels = null) {
    setBcastVerse(verse)
    setBcastSvs(svs)
    setBcastDv(verse)
    setBcastLive(true)
    setBcastBani(bani)
    setBcastSectionLabels(sectionLabels)
    setShowPreview(false)
    // If kirtan is listening for a candidate, the user has just chosen what to
    // broadcast manually — promote straight to auto-navigate mode so kirtan
    // tracks this shabad/bani without another confirmation step.
    const willAutoVoice = voiceActive || kirtanModeRef.current === 'listening'
    if (kirtanModeRef.current === 'listening') {
      kirtanApprovedRef.current = true
      setKirtanMode('auto')
    }
    pushBroadcast(verse, displaySettingsRef.current, willAutoVoice, svs)
  }

  function historyEntry(verse, bani = null) {
    return {
      id: `${verse.ID}_${Date.now()}`, timestamp: Date.now(),
      verseId: verse.ID,
      shabadId: verse.Shabads?.[0]?.ShabadID,
      baniId:       bani?.ID || null,
      baniGurmukhi: bani ? toUnicode(bani.Gurmukhi) : null,
      baniLabel:    bani ? (NITNEM_LABELS[bani.ID] || bani.Token) : null,
      gurmukhi: toUnicode(verse.Gurmukhi),
      source: verse.Source?.SourceEnglish,
      page: verse.PageNo,
      writer: verse.Writer?.WriterEnglish,
    }
  }

  /* "Send to Broadcast" from preview panel — saves history (fresh search context) */
  function sendToBroadcast() {
    if (!pvDv) return
    startBroadcast(pvDv, pvSvs, kirtanModeRef.current === 'auto', pvBani, pvSectionLabels)
    saveHistory(historyEntry(pvVerse, pvBani))
  }

  /* stop live — panel stays open */
  function stopBroadcast() {
    setBcastLive(false)
    channelRef.current?.postMessage({ type: 'clear' })
  }

  /* resume sending current verse to display tab */
  function resumeBroadcast() {
    if (!bcastDvRef.current) return
    setBcastLive(true)
    pushBroadcast(bcastDvRef.current, displaySettingsRef.current, kirtanModeRef.current === 'auto')
  }

  /* fully close the broadcast panel */
  function closeBroadcastPanel() {
    setBcastVerse(null)
    setBcastSvs([])
    setBcastDv(null)
    setBcastLive(false)
    setBcastBani(null)
    setBcastSectionLabels(null)
  }

  function selectBcastVerse(verse) {
    setBcastDv(verse)
    focusedPanelRef.current = 'broadcast'
    if (bcastLiveRef.current) {
      pushBroadcast(verse, displaySettingsRef.current, kirtanModeRef.current === 'auto')
    }
  }

  /* ── history ───────────────────────────────────────────────── */
  function saveHistory(entry) {
    // Bani entries dedup against the same bani; non-bani entries dedup against
    // the same shabad. A bani and a shabad with the same id are NOT the same
    // (the bani holds many shabads), so they coexist.
    const keyOf = h => h.baniId ? `bani:${h.baniId}` : `shabad:${h.shabadId ?? 'none'}`
    const ek = keyOf(entry)
    setSearchHistory(prev => {
      const next = [entry, ...prev.filter(h => keyOf(h) !== ek)].slice(0, MAX_HISTORY)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }
  function deleteHistory(id) {
    setSearchHistory(prev => {
      const next = prev.filter(h => h.id !== id)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }
  function clearHistory() { setSearchHistory([]); localStorage.removeItem(HISTORY_KEY) }

  /* ── keyboard ──────────────────────────────────────────────── */
  function insertChar(char) {
    const inp = inputRef.current
    if (!inp) { setQuery(q => q + char); return }
    const s = inp.selectionStart ?? query.length, e = inp.selectionEnd ?? query.length
    setQuery(query.slice(0, s) + char + query.slice(e))
    requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(s + char.length, s + char.length) })
  }
  function deleteChar() {
    const inp = inputRef.current
    if (!inp) { setQuery(q => q.slice(0, -1)); return }
    const s = inp.selectionStart ?? query.length, e = inp.selectionEnd ?? query.length
    if (s !== e) { setQuery(query.slice(0, s) + query.slice(e)); requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(s, s) }) }
    else if (s > 0) { setQuery(query.slice(0, s - 1) + query.slice(s)); requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(s - 1, s - 1) }) }
  }

  function openDisplayTab() {
    const url = new URL(window.location.href)
    url.searchParams.set('display', '1')
    window.open(url.toString(), 'gurbani-display')
  }

  /* layout class drives CSS grid columns */
  const layoutCls = ['sa-layout',
    showBanis      && 'has-banis',
    showPreview    && 'has-preview',
    bcastPanelOpen && 'has-broadcast',
  ].filter(Boolean).join(' ')

  return (
    <div className="sa-app">

      {/* ── header ── */}
      <header className="sa-header">
        <div className="sa-header-left">
          <button
            className={`sa-banis-toggle${showBanis ? ' active' : ''}`}
            onClick={() => setShowBanis(v => !v)}
            title={showBanis ? 'Hide baanis' : 'Open baanis'}
          >
            <IconBook />
            <span>Baanis</span>
          </button>
          <img src="/icon.svg" className="sa-logo" alt="" aria-hidden="true" />
          <span className="sa-title">Gurbani Search</span>
        </div>
        <div className="sa-header-right">
          {isBroadcasting && (
            <span className="sa-on-air">
              <span className="sa-on-air-dot" />
              Broadcasting
            </span>
          )}
          <span
            className={`sa-net-dot ${online ? 'up' : 'down'}`}
            title={online ? 'Online — kirtan listening available' : 'Offline — kirtan listening unavailable'}
          />
          <span
            className="sa-net-label"
            title={online ? 'Online — kirtan listening available' : 'Offline — kirtan listening unavailable'}
          >{online ? 'Online' : 'Offline'}</span>
          <button
            className="sa-icon-btn"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      <div className={layoutCls}>

        {/* ── baanis sidebar (left) ── */}
        {showBanis && (
          <BaniSidebar
            baniInfo={baniInfo}
            activeBaniId={pvBani?.ID ?? null}
            maryada={maryada}
            onChangeMaryada={changeMaryada}
            onSelectBani={openBani}
            onClose={() => setShowBanis(false)}
          />
        )}

        {/* ── search column ── */}
        <div className="sa-main">
          <div className="sa-controls">
            <div className="sa-input-row">
              <div className="sa-input-wrap">
                <IconSearch className="sa-input-icon" />
                <input
                  ref={inputRef}
                  className="sa-input"
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); setResults([]); e.target.blur() } }}
                  placeholder="Search Gurbani…"
                  autoComplete="off" autoCorrect="off" spellCheck={false}
                />
                {query && (
                  <button className="sa-clear" onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus() }} aria-label="Clear">
                    <IconX />
                  </button>
                )}
              </div>
              <button className={`sa-kbd-toggle${showKeyboard ? ' active' : ''}`} onClick={() => setShowKeyboard(v => !v)} title="Gurmukhi keyboard">
                <IconKeyboard />
              </button>
            </div>

            {showKeyboard && <GurmukhiKeyboard onChar={insertChar} onDelete={deleteChar} onSpace={() => insertChar(' ')} />}

            <div className="sa-mode-row">
              {MODES.map(m => (
                <button key={m.id} className={`sa-mode${mode === m.id ? ' active' : ''}`} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="sa-hint">{MODES.find(m => m.id === mode)?.hint}</p>
          </div>

          {/* kirtan listener */}
          <div className="sa-kirtan">
            {kirtanMode === 'off' ? (
              <button
                className="sa-kirtan-start"
                onClick={startKirtan}
                disabled={!CHROME || !online}
                title={!CHROME ? 'Requires Chrome' : !online ? 'Requires internet' : undefined}
              >
                <IconMicLarge /> <span>Listen for Kirtan</span>
              </button>
            ) : (
              <div className="sa-kirtan-active">
                <div className="sa-kirtan-top">
                  <div className="sa-kirtan-status">
                    <span className={`sa-kirtan-dot ${kirtanMode === 'auto' ? 'auto' : 'listening'}`} />
                    {kirtanMode === 'auto' ? 'Auto-broadcasting kirtan' : 'Listening for kirtan…'}
                  </div>
                  <button className="sa-kirtan-stop" onClick={stopKirtan}>Stop</button>
                </div>
                {kirtanTranscript && <p className="sa-kirtan-transcript"><em>{kirtanTranscript}</em></p>}
                {kirtanCandidate ? (
                  <div className="sa-kirtan-candidate">
                    <p className="sa-kirtan-g">{toUnicode(kirtanCandidate.Gurmukhi)}</p>
                    <div className="sa-kirtan-cmeta">
                      {kirtanCandidate.Source?.SourceEnglish && <span>{kirtanCandidate.Source.SourceEnglish}</span>}
                      {kirtanCandidate.PageNo && <span>Ang {kirtanCandidate.PageNo}</span>}
                    </div>
                    {kirtanMode === 'listening' && (
                      <button className="sa-kirtan-approve" onClick={approveKirtanCandidate}>Confirm &amp; Broadcast</button>
                    )}
                    {kirtanMode === 'auto' && <span className="sa-kirtan-auto-label">Broadcasting automatically</span>}
                  </div>
                ) : (
                  <p className="sa-kirtan-waiting">Listening… start singing or playing kirtan near the microphone</p>
                )}
              </div>
            )}
          </div>

          {/* results / recent history */}
          <div className="sa-results">
            {query.trim() ? (
              <>
                {results.length === 0 && <p className="sa-empty">No results — try a different spelling or mode</p>}
                {results.map(v => (
                  <VerseCard
                    key={v.ID}
                    verse={v}
                    isSelected={pvVerse?.ID === v.ID}
                    onClick={() => openVerse(v)}
                  />
                ))}
                {results.length === 50 && <p className="sa-cap">Showing first 50 — refine your search to see more</p>}
              </>
            ) : (
              searchHistory.length > 0 && (
                <div className="sa-recent">
                  <div className="sa-recent-hdr">
                    <span className="sa-recent-title">Recent</span>
                    <button className="sa-recent-clear" onClick={clearHistory}>Clear all</button>
                  </div>
                  {searchHistory.map(entry => (
                    <RecentItem key={entry.id} entry={entry} onOpen={() => openFromHistory(entry)} onDelete={() => deleteHistory(entry.id)} />
                  ))}
                </div>
              )
            )}
          </div>
        </div>

        {/* ── PREVIEW PANEL ── (browsing; never auto-updates broadcast) */}
        {showPreview && (
          <ShabadPreviewPanel
            verse={pvVerse}
            shabadVerses={pvSvs}
            displayVerse={pvDv}
            bani={pvBani}
            sectionLabels={pvSectionLabels}
            isBroadcasting={isBroadcasting}
            onSelectVerse={selectPvVerse}
            onSendToBroadcast={sendToBroadcast}
            onClose={() => { setShowPreview(false); setPvVerse(null); setPvBani(null); setPvSectionLabels(null) }}
            onFocus={() => { focusedPanelRef.current = 'preview' }}
          />
        )}

        {/* ── BROADCAST PANEL ── (locked, no close while live) */}
        {bcastPanelOpen && (
          <BroadcastPanel
            verse={bcastVerse}
            shabadVerses={bcastSvs}
            displayVerse={bcastDv}
            bani={bcastBani}
            sectionLabels={bcastSectionLabels}
            displaySettings={displaySettings}
            isLive={isBroadcasting}
            onSelectVerse={selectBcastVerse}
            onUpdateSetting={updateSetting}
            onOpenDisplay={openDisplayTab}
            onFullscreen={sendFullscreen}
            onStop={stopBroadcast}
            onResume={resumeBroadcast}
            onClose={closeBroadcastPanel}
            onFocus={() => { focusedPanelRef.current = 'broadcast' }}
          />
        )}
      </div>
    </div>
  )
}

/* ── VerseCard ───────────────────────────────────────────────── */
function VerseCard({ verse, isSelected, onClick }) {
  return (
    <article
      className={`sa-card${isSelected ? ' selected' : ''}`}
      onClick={onClick}
      role="button" tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      <p className="sa-card-g">{toUnicode(verse.Gurmukhi)}</p>
      <footer className="sa-card-meta">
        {verse.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
        {verse.PageNo               && <span>Ang {verse.PageNo}</span>}
        {verse.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
      </footer>
    </article>
  )
}

/* ── RecentItem ──────────────────────────────────────────────── */
function RecentItem({ entry, onOpen, onDelete }) {
  const isBani = !!entry.baniId
  return (
    <div className={`sa-rec-item${isBani ? ' sa-rec-bani' : ''}`}>
      <button className="sa-rec-body" onClick={onOpen}>
        {isBani ? (
          <>
            <p className="sa-rec-g">{entry.baniGurmukhi}</p>
            <div className="sa-rec-meta">
              <span className="sa-rec-badge"><IconBookmark /> Baani</span>
              {entry.baniLabel && <span>{entry.baniLabel}</span>}
              <span className="sa-rec-time">{relTime(entry.timestamp)}</span>
            </div>
          </>
        ) : (
          <>
            <p className="sa-rec-g">{entry.gurmukhi}</p>
            <div className="sa-rec-meta">
              {entry.source && <span>{entry.source}</span>}
              {entry.page   && <span>Ang {entry.page}</span>}
              <span className="sa-rec-time">{relTime(entry.timestamp)}</span>
            </div>
          </>
        )}
      </button>
      <button className="sa-rec-del" onClick={onDelete} title="Remove"><IconX /></button>
    </div>
  )
}

/* ── ShabadPreviewPanel ──────────────────────────────────────── */
/* Shows the shabad you're browsing. No display controls. Has close + send-to-broadcast.
   When `bani` is set, the header shows the bani's Gurmukhi name and `sectionLabels`
   (rowId → label) renders dividers like "ਪਉੜੀ 1" inside the verse list. */
function ShabadPreviewPanel({ verse, shabadVerses, displayVerse, bani, sectionLabels, isBroadcasting, onSelectVerse, onSendToBroadcast, onClose, onFocus }) {
  const activeRef = useRef(null)
  const jumpRef   = useRef(null)
  const [outlineRequested, setOutlineMode] = useState(false)
  const [pendingJumpRowId, setPendingJumpRowId] = useState(null)
  const outlineItems = useMemo(() => buildOutlineItems(shabadVerses, sectionLabels), [shabadVerses, sectionLabels])
  // Derived — outline only renders when there are bookmarks to show. Avoids
  // state thrashing when the shabad changes or has no bookmarks at all.
  const outlineMode = outlineRequested && outlineItems.length > 0

  useEffect(() => {
    if (outlineMode) return
    // After an outline-jump, pin the bookmark to the top of the verse list.
    // scrollIntoView is unreliable for nested scroll containers, so compute
    // the offset against the .sp-verses scroller directly and set scrollTop.
    if (pendingJumpRowId != null && jumpRef.current) {
      const target = jumpRef.current
      const scroller = target.closest('.sp-verses')
      if (scroller) {
        const sRect = scroller.getBoundingClientRect()
        const tRect = target.getBoundingClientRect()
        scroller.scrollTop += (tRect.top - sRect.top) - 6
      } else {
        target.scrollIntoView({ block: 'start' })
      }
      setPendingJumpRowId(null)
      return  // skip the activeRef scroll on this pass
    }
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse, outlineMode, pendingJumpRowId])

  function jumpToSection(item) {
    setPendingJumpRowId(item.rowId)
    setOutlineMode(false)
    onSelectVerse(item.verse)
  }

  return (
    <aside className="sa-panel sa-preview-panel" onClick={onFocus}>
      <div className="sp-header">
        {bani ? (
          <div className="sp-bani-title">
            <span className="sp-bani-name">{toUnicode(bani.Gurmukhi)}</span>
            <span className="sp-bani-sub">{verse?.Source?.SourceEnglish || 'Baani'}</span>
          </div>
        ) : (
          <div className="sp-meta">
            {[verse?.Source?.SourceEnglish, verse?.Raag?.RaagEnglish, verse?.PageNo && `Ang ${verse.PageNo}`, verse?.Writer?.WriterEnglish].filter(Boolean).join(' · ')}
          </div>
        )}
        <div className="sp-actions">
          {outlineItems.length > 0 && (
            <button
              className={`sp-btn sp-outline-btn${outlineMode ? ' active' : ''}`}
              onClick={() => setOutlineMode(m => !m)}
              title={outlineMode ? 'Show verses' : 'Show outline'}
            >
              <IconBookmark />
            </button>
          )}
          <button className="sp-btn" onClick={onClose} title="Close preview"><IconX /></button>
        </div>
      </div>

      <button className="sp-broadcast-btn sp-go-live-btn" onClick={onSendToBroadcast}>
        ▶ Send to Broadcast
      </button>

      {outlineMode ? (
        <OutlineList items={outlineItems} onJump={jumpToSection} onBack={() => setOutlineMode(false)} />
      ) : (
        <div className="sp-verses sp-verses-preview">
          <p className="sp-verses-hint">↑ ↓ arrow keys to navigate · click to select</p>
          {shabadVerses.map((v, i) => {
            // Identity by reference, not ID — duplicate verses (refrains) share IDs.
            const isActive = displayVerse === v
            const rowId    = v.__rowId ?? v.ID
            const label    = sectionLabels?.get(rowId)
            const isJumpTarget = label && pendingJumpRowId === rowId
            return (
              <div key={v.__rowId ?? `${i}-${v.ID}`}>
                {label && <BookmarkLabel label={label} onZoomOut={() => setOutlineMode(true)} innerRef={isJumpTarget ? jumpRef : undefined} />}
                <div
                  ref={isActive ? activeRef : null}
                  className={`sp-verse${isActive ? ' active' : ''}`}
                  onClick={() => onSelectVerse(v)}
                  role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectVerse(v)}
                >
                  <span className="sp-verse-num">{i + 1}</span>
                  <div className="sp-verse-body">
                    <p className="sp-verse-g">{toUnicode(v.Gurmukhi)}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}

/* ── BaniSidebar ─────────────────────────────────────────────── */
/* Left panel listing baanis. Top section pins Nitnem in a curated order; below
   that, all remaining baanis (those with at least one verse) in their natural ID order. */
function BaniSidebar({ baniInfo, activeBaniId, maryada, onChangeMaryada, onSelectBani, onClose }) {
  const [filter, setFilter] = useState('')

  const { nitnem, other } = useMemo(() => {
    const seen = new Set()
    const nitnem = []
    for (const id of NITNEM_BANI_IDS) {
      const entry = baniInfo.get(id)
      if (entry && entry.verses.length > 0) { nitnem.push(entry); seen.add(id) }
    }
    const other = []
    for (const entry of baniInfo.values()) {
      if (seen.has(entry.meta.ID)) continue
      if (entry.verses.length === 0)  continue
      other.push(entry)
    }
    other.sort((a, b) => a.meta.ID - b.meta.ID)
    return { nitnem, other }
  }, [baniInfo])

  const q = filter.trim().toLowerCase()
  const matches = (entry) => {
    if (!q) return true
    const label = (NITNEM_LABELS[entry.meta.ID] || '').toLowerCase()
    const token = (entry.meta.Token || '').toLowerCase()
    const gur   = toUnicode(entry.meta.Gurmukhi || '').toLowerCase()
    return label.includes(q) || token.includes(q) || gur.includes(q)
  }
  const nitnemFiltered = nitnem.filter(matches)
  const otherFiltered  = other.filter(matches)

  return (
    <aside className="sa-panel sa-banis-panel">
      <div className="sp-header">
        <div className="sp-meta sb-title">Baanis</div>
        <div className="sp-actions">
          <button className="sp-btn" onClick={onClose} title="Hide baanis"><IconX /></button>
        </div>
      </div>

      <div className="sb-maryada">
        <label className="sb-maryada-label" htmlFor="sb-maryada-select">Maryada</label>
        <select
          id="sb-maryada-select"
          className="sb-maryada-select"
          value={maryada}
          onChange={e => onChangeMaryada(e.target.value)}
          title="Filters baani contents to this tradition"
        >
          {MARYADAS.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div className="sb-filter-wrap">
        <input
          className="sb-filter"
          type="search"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter baanis…"
          autoComplete="off" autoCorrect="off" spellCheck={false}
        />
      </div>

      <div className="sb-list">
        {nitnemFiltered.length > 0 && (
          <>
            <div className="sb-group-label">Nitnem</div>
            {nitnemFiltered.map(entry => (
              <BaniRow
                key={entry.meta.ID}
                entry={entry}
                active={activeBaniId === entry.meta.ID}
                onClick={() => onSelectBani(entry.meta.ID)}
              />
            ))}
          </>
        )}
        {otherFiltered.length > 0 && (
          <>
            <div className="sb-group-label">All baanis</div>
            {otherFiltered.map(entry => (
              <BaniRow
                key={entry.meta.ID}
                entry={entry}
                active={activeBaniId === entry.meta.ID}
                onClick={() => onSelectBani(entry.meta.ID)}
              />
            ))}
          </>
        )}
        {nitnemFiltered.length === 0 && otherFiltered.length === 0 && (
          <p className="sb-empty">No matching baanis</p>
        )}
      </div>
    </aside>
  )
}

function BaniRow({ entry, active, onClick }) {
  const label = NITNEM_LABELS[entry.meta.ID]
  return (
    <button className={`sb-row${active ? ' active' : ''}`} onClick={onClick}>
      <span className="sb-row-g">{toUnicode(entry.meta.Gurmukhi)}</span>
      <span className="sb-row-sub">
        {label || entry.meta.Token}
        <span className="sb-row-count"> · {entry.verses.length}</span>
      </span>
    </button>
  )
}

/* ── BroadcastPanel ──────────────────────────────────────────── */
/* Locked to what is live. Shows display controls. No close button.
   When `bani` is set, the header shows the bani's Gurmukhi name and `sectionLabels`
   renders dividers like "ਪਉੜੀ 1" inline in the verse list (mirrors preview panel). */
function BroadcastPanel({ verse, shabadVerses, displayVerse, bani, sectionLabels, displaySettings, isLive, onSelectVerse, onUpdateSetting, onOpenDisplay, onFullscreen, onStop, onResume, onClose, onFocus }) {
  const preset     = BG_PRESETS[displaySettings.bg] || BG_PRESETS.dark
  const count      = displaySettings.verseCount || 1
  // Identity by reference — duplicate verses (refrains) share IDs.
  const anchorIdx  = displayVerse ? shabadVerses.indexOf(displayVerse) : -1
  const verseWindow = anchorIdx !== -1
    ? shabadVerses.slice(anchorIdx, Math.min(anchorIdx + count, shabadVerses.length))
    : displayVerse ? [displayVerse] : []
  const transOpts  = getTranslationOptions(displayVerse?.Translations)
  const activeRef  = useRef(null)
  const [ctrlOpen, setCtrlOpen] = useState(false)
  const jumpRef = useRef(null)
  const [outlineRequested, setOutlineMode] = useState(false)
  const [pendingJumpRowId, setPendingJumpRowId] = useState(null)
  const outlineItems = useMemo(() => buildOutlineItems(shabadVerses, sectionLabels), [shabadVerses, sectionLabels])
  const outlineMode = outlineRequested && outlineItems.length > 0

  useEffect(() => {
    if (outlineMode) return
    if (pendingJumpRowId != null && jumpRef.current) {
      const target = jumpRef.current
      const scroller = target.closest('.sp-verses')
      if (scroller) {
        const sRect = scroller.getBoundingClientRect()
        const tRect = target.getBoundingClientRect()
        scroller.scrollTop += (tRect.top - sRect.top) - 6
      } else {
        target.scrollIntoView({ block: 'start' })
      }
      setPendingJumpRowId(null)
      return
    }
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse, outlineMode, pendingJumpRowId])

  function jumpToSection(item) {
    setPendingJumpRowId(item.rowId)
    setOutlineMode(false)
    onSelectVerse(item.verse)  // broadcast push happens inside selectBcastVerse if live
  }

  return (
    <aside className="sa-panel sa-bcast-panel" onClick={onFocus}>

      <div className="sp-header">
        {isLive && (
          <button
            className="sp-live-btn live"
            onClick={onStop}
            title="Stop broadcasting"
          />
        )}
        {bani ? (
          <div className="sp-bani-title">
            <span className="sp-bani-name">{toUnicode(bani.Gurmukhi)}</span>
            <span className="sp-bani-sub">{verse?.Source?.SourceEnglish || 'Baani'}</span>
          </div>
        ) : (
          <div className="sp-meta">
            {[verse?.Source?.SourceEnglish, verse?.Raag?.RaagEnglish, verse?.PageNo && `Ang ${verse.PageNo}`, verse?.Writer?.WriterEnglish].filter(Boolean).join(' · ')}
          </div>
        )}
        <div className="sp-actions">
          {outlineItems.length > 0 && (
            <button
              className={`sp-btn sp-outline-btn${outlineMode ? ' active' : ''}`}
              onClick={() => setOutlineMode(m => !m)}
              title={outlineMode ? 'Show verses' : 'Show outline'}
            >
              <IconBookmark />
            </button>
          )}
          {/* Close only appears when the broadcast is stopped — prevents an
              accidental dismiss while content is live on the display tab. */}
          {!isLive && (
            <button className="sp-btn" onClick={onClose} title="Close"><IconX /></button>
          )}
        </div>
      </div>

      {!isLive && (
        <button className="sp-broadcast-btn sp-go-live-btn" onClick={onResume}>
          ▶ Send to Broadcast
        </button>
      )}

      {isLive && <>

      {/* live preview */}
      <div className="sp-preview" style={{ background: preset.bg, color: preset.fg }}>
        <div className="sp-preview-actions">
          <button className="sp-preview-action-btn" onClick={onFullscreen} title="Fullscreen broadcast screen"><IconFullscreen /></button>
          <button className="sp-preview-action-btn" onClick={onOpenDisplay} title="Open broadcast screen"><IconExternalLink /></button>
        </div>
        {verseWindow.length > 0 ? (
          verseWindow.map((v, i) => {
            const g = renderGurmukhi(v.Gurmukhi, displaySettings.larivar)
            const t = displaySettings.showTranslation ? getTranslation(v.Translations, displaySettings.translationKey) : ''
            return (
              <div key={v.ID} className={`sp-preview-verse${i > 0 ? ' sp-preview-verse-sep' : ''}`}>
                <p className="sp-preview-g" style={{ fontSize: 28, fontFamily: 'var(--gurmukhi)' }}>{g}</p>
                {t && <p className="sp-preview-t" style={{ fontSize: 14, color: preset.sub }}>{t}</p>}
              </div>
            )
          })
        ) : (
          <p className="sp-preview-empty" style={{ color: preset.sub }}>Select a verse below</p>
        )}
      </div>

      {/* display controls */}
      <div className="sp-controls">
        <button className="sp-ctrl-toggle" onClick={() => setCtrlOpen(o => !o)}>
          <span>Display Options</span>
          <IconChevron open={ctrlOpen} />
        </button>
      {ctrlOpen && <div className="sp-ctrl-body">
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Gurmukhi</span>
          <div className="sp-ctrl-group">
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.max(20, displaySettings.fontSize - 4))}>A−</button>
            <span className="sp-ctrl-val">{displaySettings.fontSize}px</span>
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.min(160, displaySettings.fontSize + 4))}>A+</button>
          </div>
        </div>
        {transOpts.length > 0 && (
          <div className="sp-ctrl-row">
            <span className="sp-ctrl-label">Translation</span>
            <div className="sp-ctrl-group">
              <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('transSize', Math.max(10, (displaySettings.transSize || 20) - 2))}>a−</button>
              <span className="sp-ctrl-val">{displaySettings.transSize || 20}px</span>
              <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('transSize', Math.min(80, (displaySettings.transSize || 20) + 2))}>a+</button>
            </div>
          </div>
        )}
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Options</span>
          <div className="sp-ctrl-group">
            {transOpts.length > 0 && (
              <button className={`sp-ctrl-btn${displaySettings.showTranslation ? ' active' : ''}`} onClick={() => onUpdateSetting('showTranslation', !displaySettings.showTranslation)}>Translation</button>
            )}
            <button className={`sp-ctrl-btn${displaySettings.showMeta !== false ? ' active' : ''}`} onClick={() => onUpdateSetting('showMeta', displaySettings.showMeta === false ? true : false)}>Ang &amp; Source</button>
            <button className={`sp-ctrl-btn${displaySettings.larivar ? ' active' : ''}`} onClick={() => onUpdateSetting('larivar', !displaySettings.larivar)}>Larivar</button>
          </div>
        </div>
        {transOpts.length > 1 && displaySettings.showTranslation && (
          <div className="sp-ctrl-row">
            <span className="sp-ctrl-label">Language</span>
            <select
              className="sp-ctrl-select"
              value={displaySettings.translationKey || 'auto'}
              onChange={e => onUpdateSetting('translationKey', e.target.value)}
            >
              <option value="auto">Auto</option>
              {transOpts.map(opt => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Verses</span>
          <div className="sp-ctrl-group">
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('verseCount', Math.max(1, count - 1))}>−</button>
            <span className="sp-ctrl-val">{count}</span>
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('verseCount', Math.min(8, count + 1))}>+</button>
          </div>
        </div>
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Background</span>
          <div className="sp-ctrl-group">
            {Object.entries(BG_PRESETS).map(([key, p]) => (
              <button
                key={key}
                className={`sp-bg-btn${displaySettings.bg === key ? ' active' : ''}`}
                style={{ background: p.bg, boxShadow: displaySettings.bg === key ? `0 0 0 2px ${p.fg}` : '0 0 0 1px rgba(128,128,128,0.25)' }}
                onClick={() => onUpdateSetting('bg', key)}
                title={p.label}
              />
            ))}
          </div>
        </div>
      </div>}
      </div>

      </>}

      {/* verse list (or outline view when zoomed out) */}
      {outlineMode ? (
        <OutlineList items={outlineItems} onJump={jumpToSection} onBack={() => setOutlineMode(false)} />
      ) : (
        <div className="sp-verses">
          <p className="sp-verses-hint">↑ ↓ navigate · broadcasting updates live</p>
          {shabadVerses.map((v, i) => {
            // Identity by reference — duplicate verses (refrains) share IDs.
            const isAnchor   = displayVerse === v
            const isInWindow = anchorIdx !== -1 && i > anchorIdx && i < anchorIdx + count
            const rowId      = v.__rowId ?? v.ID
            const label      = sectionLabels?.get(rowId)
            const isJumpTarget = label && pendingJumpRowId === rowId
            return (
              <div key={v.__rowId ?? `${i}-${v.ID}`}>
                {label && <BookmarkLabel label={label} onZoomOut={() => setOutlineMode(true)} innerRef={isJumpTarget ? jumpRef : undefined} />}
                <div
                  ref={isAnchor ? activeRef : null}
                  className={`sp-verse${isAnchor ? ' active' : isInWindow ? ' in-window' : ''}`}
                  onClick={() => onSelectVerse(v)}
                  role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectVerse(v)}
                >
                  <span className="sp-verse-num">{i + 1}</span>
                  <div className="sp-verse-body">
                    <p className="sp-verse-g">{renderGurmukhi(v.Gurmukhi, displaySettings.larivar)}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}

/* ── GurmukhiKeyboard ────────────────────────────────────────── */
function GurmukhiKeyboard({ onChar, onDelete, onSpace }) {
  return (
    <div className="sa-kbd">
      {KEYBOARD_LAYOUT.map(group => (
        <div key={group.label} className="sa-kbd-group">
          <span className="sa-kbd-group-label">{group.label}</span>
          <div className="sa-kbd-keys">
            {group.chars.map(ch => (
              <button key={ch} className="sa-kbd-key" onMouseDown={e => { e.preventDefault(); onChar(ch) }}>{ch}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="sa-kbd-actions">
        <button className="sa-kbd-space" onMouseDown={e => { e.preventDefault(); onSpace() }}>Space</button>
        <button className="sa-kbd-del"   onMouseDown={e => { e.preventDefault(); onDelete() }}>⌫</button>
      </div>
    </div>
  )
}

/* ── Icons ───────────────────────────────────────────────────── */
function IconSearch({ className }) {
  return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
}
function IconX() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
}
function IconKeyboard() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/></svg>
}
function IconMicLarge() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
}
function IconExternalLink() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
}
function IconFullscreen() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
}
function IconChevron({ open }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9"/></svg>
}
function IconSun() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
}
function IconMoon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
}
function IconBook() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
}
function IconBookmark({ className }) {
  return <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
}
function IconArrowLeft() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
}
function IconArrowRight() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
}
function IconExpand() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
}

/* ── BookmarkLabel ───────────────────────────────────────────── */
/* Inline section header inside a bani verse list. Clicking zooms out to the
   bookmark outline. Visually distinct from verses: amber pill, bookmark icon,
   "zoom" icon at right hinting it's interactive. `innerRef` is used by the
   parent to scroll the bookmark itself into view after an outline-jump. */
function BookmarkLabel({ label, onZoomOut, innerRef }) {
  return (
    <button ref={innerRef} className="sp-section-label" onClick={onZoomOut} title="Show outline">
      <IconBookmark className="sp-section-icon" />
      <span className="sp-section-text">{toUnicode(label)}</span>
      <IconExpand />
    </button>
  )
}

/* ── OutlineList ─────────────────────────────────────────────── */
/* The "zoomed out" view: only bookmark titles, big tap targets, one per row.
   Clicking a row jumps to the section's first verse and exits outline mode. */
function OutlineList({ items, onJump, onBack }) {
  return (
    <div className="sp-outline">
      <button className="sp-outline-back" onClick={onBack}>
        <IconArrowLeft /> <span>Back to verses</span>
      </button>
      <p className="sp-outline-title">
        Outline <span className="sp-outline-count">· {items.length} sections</span>
      </p>
      {items.length === 0 && <p className="sp-outline-empty">No bookmarks in this bani</p>}
      {items.map((item, i) => (
        <button key={item.rowId} className="sp-outline-row" onClick={() => onJump(item)}>
          <span className="sp-outline-num">{i + 1}</span>
          <IconBookmark className="sp-outline-icon" />
          <span className="sp-outline-label">{toUnicode(item.label)}</span>
          <IconArrowRight />
        </button>
      ))}
    </div>
  )
}

/* Build the ordered list of bookmark items from a sectionLabels Map. */
function buildOutlineItems(shabadVerses, sectionLabels) {
  if (!sectionLabels || sectionLabels.size === 0) return []
  const items = []
  for (const v of shabadVerses) {
    const key = v.__rowId ?? v.ID
    const label = sectionLabels.get(key)
    if (label) items.push({ rowId: key, label, verse: v })
  }
  return items
}
