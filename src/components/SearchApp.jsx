import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'
import { BG_PRESETS, getTranslation, getTranslationOptions, renderGurmukhi, effectivePreset } from './DisplayApp.jsx'
import '../styles/SearchApp.css'

const { toUnicode, toAscii, isGurmukhi } = gurmukhiUtils

const CHROME       = 'webkitSpeechRecognition' in window
const IS_MOBILE    = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  || (typeof window !== 'undefined' && window.matchMedia?.('(hover: none) and (pointer: coarse)').matches)
const CHANNEL_NAME = 'gurbani-display'
const HISTORY_KEY  = 'gurbani-history'
const SETTINGS_KEY = 'gurbani-disp-settings'
const THEME_KEY    = 'gurbani-theme'
const ANNOUNCEMENT_KEY = 'gurbani-announcement'
const MAX_HISTORY  = 50
const DEFAULT_SETTINGS = {
  fontSize: 48, transSize: 20, showTranslation: true, showMeta: true, larivar: false, bg: 'dark', verseCount: 1, translationKey: 'auto',
  customFg: null, customBg: null, customBgImage: null,
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
const DEFAULT_MARYADA = 'Medium'

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
//   in-context, nearby (≤3 away):  ≥2 matches (cross-verse jump within ctx)
//   in-context, mid (≤10 away):    ≥3 matches (long-bani locality bias)
//   in-context, far (>10 away):    ≥4 matches (long-bani locality bias)
//   different shabad (final):      ≥3 matches + isFinal && conf≥0.6
//   different shabad (interim):    ≥4 matches + current shabad has <2 matches
//   discovery (no context):        ≥2.5 matches (interim OK)
//
// The in-context distance tiers protect against false jumps inside long
// banis (Sukhmani ~200 verses, Anand Sahib 40 pauris) where common kirtan
// words ("har", "naam", "guru", "prabh") let a distant pauri coincidentally
// outscore the next verse. Singers move pauri-by-pauri, so locality is a
// strong prior.
//
// Chrome rarely emits finals during continuous kirtan, so cross-shabad has a
// second trigger: when the rolling window's best in-context match drops below
// 2 ("the singer has clearly left the current shabad"), we let interims with
// ≥4 matched words pull out of the bani. Discovery (no context yet) always
// runs on interims so a candidate appears as soon as the singer has uttered
// ~3 recognisable words.
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
  // Cross-shabad has two acceptable triggers:
  //   1. Confident final (isFinal && conf≥0.6) — original strict gate.
  //   2. Interim where the rolling window has clearly LEFT the current shabad:
  //      best in-context match is <2 words. Chrome rarely emits finals during
  //      continuous kirtan, so without (2) we get stuck on the current shabad
  //      forever when the singer moves on.
  const strongFinal = isFinal && conf >= 0.6
  let leftContext = false
  if (hasCtx && !strongFinal) {
    let bestCtxMatch = 0
    for (const v of contextShabadVerses) {
      const vWords = verseWordsMap.get(v.ID)
      if (!vWords) continue
      const n = wordMatchCount(settled, vWords)
      if (n > bestCtxMatch) bestCtxMatch = n
      if (bestCtxMatch >= 2) break
    }
    leftContext = bestCtxMatch < 2
  }
  const allowCrossShabad = strongFinal || leftContext

  // If we already have a shabad/bani context AND we won't promote out of it
  // this turn, only consider those verses — much faster than scanning 142k
  // every interim event.
  const pool = (hasCtx && !allowCrossShabad) ? contextShabadVerses : verses

  // Identify the verse RIGHT AFTER the current one in the context. When the
  // singer is transitioning forward, recent words still partially match the
  // current verse (residual inertia) while new words match the next verse —
  // a small score boost on the next verse lets that "old tail + new head"
  // pattern outrank the current verse's inertia without waiting for the
  // current verse's matches to age out of the rolling window. Tail words
  // matching the next verse strengthen the boost further.
  const ctxIdx = (hasCtx && contextShabadVerses) ? contextShabadVerses.indexOf(contextVerse) : -1
  let nextInCtx = null
  let nextTailMatch = 0
  if (ctxIdx >= 0 && ctxIdx + 1 < contextShabadVerses.length) {
    nextInCtx = contextShabadVerses[ctxIdx + 1]
    const nextWords = verseWordsMap.get(nextInCtx.ID)
    if (nextWords && nextWords.length > 0) {
      // Look at the latest portion of the window (the bit Chrome is
      // currently producing) — if those words match the next verse, the
      // transition is happening RIGHT NOW.
      const tail = windowed.slice(-3)
      nextTailMatch = wordMatchCount(tail, nextWords)
    }
  }
  const poolIsCtx = (hasCtx && !allowCrossShabad)

  let best = null, bestScore = 0

  for (let i = 0; i < pool.length; i++) {
    const v = pool[i]
    let minMatch, inertia
    if (!hasCtx) {
      // Discovery: no surrounding shabad to anchor on, so demand a slightly
      // stricter word match than in-context — but DON'T require a final, or
      // a candidate never appears mid-singing.
      minMatch = 2.5; inertia = 0
    } else if (v.ID === contextVerse.ID) {
      minMatch = 1; inertia = 2
    } else if (ctxSet?.has(v.ID)) {
      // Distance-tiered threshold. Long banis (Sukhmani ~200 verses, Anand
      // Sahib 40 pauris) contain many verses that share common words
      // ("har", "naam", "guru", "prabh") — without a locality bias, a
      // distant pauri coincidentally hitting 2 matches beats the actual
      // next verse. Singers move pauri-by-pauri, so nearby positions stay
      // cheap and far ones require progressively stronger evidence.
      const distance = (poolIsCtx && ctxIdx >= 0) ? Math.abs(i - ctxIdx) : 0
      if (distance <= 3) {
        minMatch = 2; inertia = 1
      } else if (distance <= 10) {
        minMatch = 3; inertia = 0
      } else {
        minMatch = 4; inertia = 0
      }
    } else {
      if (!allowCrossShabad) continue
      // Interim-driven jumps (no confident final yet) demand stronger word
      // evidence than final-driven ones — protects against transient noise.
      minMatch = strongFinal ? 3 : 4; inertia = 0
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

    let score = matched + inertia
    // Sequential-transition boost. +1 baseline when v is the very next verse
    // in context, plus an extra +1 if the latest tail of the window already
    // matches it — when both fire, even a partial 1.5-word read of the next
    // verse can outrank the current verse holding 2-match inertia.
    if (v === nextInCtx) score += 1 + (nextTailMatch >= 2 ? 1 : 0)
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

function loadAnnouncement() {
  try {
    const raw = localStorage.getItem(ANNOUNCEMENT_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (obj.endAt && Date.now() >= obj.endAt) {
      localStorage.removeItem(ANNOUNCEMENT_KEY)
      return null
    }
    return obj
  } catch { return null }
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

  /* ── SHABAD PREVIEW TABS — the "browsing" view ──────────────── */
  /* clicking a search result opens (or re-selects) a tab here; never touches
     broadcast. Each tab is one shabad or one bani, identified by `sid`. Mobile
     keeps a single tab (the old one-preview-at-a-time behaviour); desktop lets
     several stay open at once. `key` is a stable per-slot id used for React
     keys and active-tab tracking; `sid` is the content identity used for dedup. */
  const [pvTabs,      setPvTabs]      = useState([])  // [{ key, sid, verse, svs, dv, bani, sectionLabels }]
  const [pvActiveKey, setPvActiveKey] = useState(null)
  const tabKeyRef     = useRef(0)

  const activeTab       = pvTabs.find(t => t.key === pvActiveKey) || null
  const showPreview     = activeTab != null
  const pvVerse         = activeTab?.verse ?? null
  const pvSvs           = activeTab?.svs ?? []
  const pvDv            = activeTab?.dv ?? null
  const pvBani          = activeTab?.bani ?? null
  const pvSectionLabels = activeTab?.sectionLabels ?? null

  /* ── RESULTS / BAANIS / RECENT tabs (under the search box) ──── */
  const [navTab,  setNavTab]  = useState('recent')  // 'results' | 'banis' | 'recent'
  const [maryada, setMaryada] = useState(() => localStorage.getItem(MARYADA_KEY) || DEFAULT_MARYADA)

  /* ── BROADCAST PANEL ───────────────────────────────────────── */
  const [bcastVerse, setBcastVerse] = useState(null)
  const [bcastSvs,   setBcastSvs]   = useState([])
  const [bcastDv,    setBcastDv]    = useState(null)
  const [bcastLive,  setBcastLive]  = useState(false) // true = actively sending to display tab
  const [bcastBani,  setBcastBani]  = useState(null)  // bani meta when broadcasting a whole bani
  const [bcastSectionLabels, setBcastSectionLabels] = useState(null)
  // Verses already covered in the current broadcast session. Keyed by __rowId
  // (banis) or verse ID (shabads). Reset whenever a new shabad/bani is loaded.
  // Presenter-only — never sent to the display tab.
  const [bcastSungIds, setBcastSungIds] = useState(() => new Set())

  const bcastPanelOpen = bcastVerse !== null  // panel is visible (live or stopped)
  const isBroadcasting = bcastLive            // actively sending to display tab

  /* announcement — custom overlay text shown on the broadcast screen, with
     optional repeat cycle and end time. Survives reload via localStorage. */
  const [announcement, setAnnouncement] = useState(loadAnnouncement)
  const [announcementVisible, setAnnouncementVisible] = useState(false)
  const [announcementOpen, setAnnouncementOpen] = useState(false)  // modal

  /* Mobile-only verse font size for the shabad preview panel. Mobile users
     don't have the desktop Display Options, so they get a quick A−/A+ between
     the Previous and Next buttons. */
  const [mobileFontSize, setMobileFontSize] = useState(() => {
    const n = parseInt(localStorage.getItem('gurbani-mobile-font') || '', 10)
    return Number.isFinite(n) && n >= 14 && n <= 36 ? n : 18
  })
  useEffect(() => { localStorage.setItem('gurbani-mobile-font', String(mobileFontSize)) }, [mobileFontSize])
  function changeMobileFontSize(delta) {
    setMobileFontSize(s => Math.max(14, Math.min(36, s + delta)))
  }

  /* Focus mode (mobile): double-tap the shabad area hides the app header,
     the panel meta header, and the bottom nav row, leaving just the verses.
     Toggled back the same way. */
  const [focusMode, setFocusMode] = useState(false)
  useEffect(() => {
    if (focusMode) document.body.classList.add('focus-mode')
    else document.body.classList.remove('focus-mode')
    return () => document.body.classList.remove('focus-mode')
  }, [focusMode])
  // Auto-exit focus mode when the preview panel closes — otherwise the body
  // class would keep the app header hidden with nothing on screen.
  useEffect(() => { if (!showPreview) setFocusMode(false) }, [showPreview])

  /* First-time hint toast: only on mobile, only until the user has seen it. */
  const [showFocusHint, setShowFocusHint] = useState(
    () => IS_MOBILE && localStorage.getItem('gurbani-focus-hint-seen') !== '1'
  )
  function dismissFocusHint() {
    setShowFocusHint(false)
    localStorage.setItem('gurbani-focus-hint-seen', '1')
  }
  function toggleFocusMode() {
    setFocusMode(f => !f)
    if (showFocusHint) dismissFocusHint()
  }

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
  const activeTabRef       = useRef(null)

  useEffect(() => { activeTabRef.current = activeTab }, [activeTab])
  useEffect(() => { kirtanModeRef.current      = kirtanMode      }, [kirtanMode])
  useEffect(() => { bcastDvRef.current         = bcastDv         }, [bcastDv])
  // Mark the currently-displayed verse as sung. Bani rows have __rowId so
  // refrains (same verse ID, different occurrence) are tracked separately.
  useEffect(() => {
    if (!bcastDv) return
    const key = bcastDv.__rowId ?? bcastDv.ID
    setBcastSungIds(prev => prev.has(key) ? prev : new Set(prev).add(key))
  }, [bcastDv])
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

  /* Sorted list of shabad IDs for prev/next navigation. Sequential ShabadIDs
     follow the order in the Granth. */
  const sortedShabadIds = useMemo(
    () => Array.from(shabadIndex.keys()).sort((a, b) => a - b),
    [shabadIndex]
  )

  function getSiblingShabad(currentShabadId, dir) {
    if (currentShabadId == null) return null
    const idx = sortedShabadIds.indexOf(currentShabadId)
    if (idx === -1) return null
    const next = idx + dir
    if (next < 0 || next >= sortedShabadIds.length) return null
    const v = shabadIndex.get(sortedShabadIds[next])
    if (!v || v.length === 0) return null
    return { shabadId: sortedShabadIds[next], verses: v }
  }

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

  /* Bani prev/next order: same logic the sidebar uses — Nitnem first in
     their curated order, then everything else with verses by ID. */
  const sortedBaniIds = useMemo(() => {
    const available = Array.from(baniInfo.values())
      .filter(e => e.verses.length > 0)
      .map(e => e.meta.ID)
    const nitnem = NITNEM_BANI_IDS.filter(id => available.includes(id))
    const seen = new Set(nitnem)
    const others = available.filter(id => !seen.has(id)).sort((a, b) => a - b)
    return [...nitnem, ...others]
  }, [baniInfo])

  function getSiblingBani(currentBaniId, dir) {
    if (currentBaniId == null) return null
    const idx = sortedBaniIds.indexOf(currentBaniId)
    if (idx === -1) return null
    const next = idx + dir
    if (next < 0 || next >= sortedBaniIds.length) return null
    return sortedBaniIds[next]
  }

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
      if (e.data.type === 'ping') {
        if (bcastDvRef.current && bcastLiveRef.current) {
          pushBroadcast(bcastDvRef.current, displaySettingsRef.current, kirtanModeRef.current === 'auto')
        }
        // Re-send announcement state so a freshly-loaded display tab catches up.
        if (announcementVisibleRef.current && announcementRef.current) {
          ch.postMessage({ type: 'announcement', visible: true, text: announcementRef.current.text })
        }
      }
    }
    return () => { ch.close(); channelRef.current = null }
  }, [])

  /* Announcement cycle. Each cycle = show for showSec, then hide for the rest
     of repeatSec. When endAt is reached, the announcement is cleared. */
  const announcementRef        = useRef(announcement)
  const announcementVisibleRef = useRef(false)
  useEffect(() => { announcementRef.current        = announcement        }, [announcement])
  useEffect(() => { announcementVisibleRef.current = announcementVisible }, [announcementVisible])

  useEffect(() => {
    if (announcement) localStorage.setItem(ANNOUNCEMENT_KEY, JSON.stringify(announcement))
    else localStorage.removeItem(ANNOUNCEMENT_KEY)
  }, [announcement])

  useEffect(() => {
    if (!announcement) { setAnnouncementVisible(false); return }
    let visTimer, nextTimer, endTimer
    let cancelled = false

    // Independent endAt cleanup — covers the indefinite-show case (showSec=0)
    // and snaps off mid-cycle the moment endAt is reached.
    if (announcement.endAt) {
      const delay = Math.max(0, announcement.endAt - Date.now())
      endTimer = setTimeout(() => {
        if (cancelled) return
        setAnnouncement(null)
        setAnnouncementVisible(false)
      }, delay)
    }

    function cycle() {
      if (cancelled) return
      if (announcement.endAt && Date.now() >= announcement.endAt) {
        setAnnouncement(null)
        setAnnouncementVisible(false)
        return
      }
      const cycleStart = Date.now()
      setAnnouncementVisible(true)
      // showSec <= 0 → indefinite: stays visible until endAt fires or user stops.
      if (announcement.showSec <= 0) return
      visTimer = setTimeout(() => {
        if (cancelled) return
        setAnnouncementVisible(false)
        if (announcement.repeatSec > 0) {
          const remaining = (announcement.repeatSec * 1000) - (Date.now() - cycleStart)
          nextTimer = setTimeout(cycle, Math.max(0, remaining))
        } else {
          setAnnouncement(null)  // one-shot
        }
      }, announcement.showSec * 1000)
    }

    cycle()
    return () => { cancelled = true; clearTimeout(visTimer); clearTimeout(nextTimer); clearTimeout(endTimer) }
  }, [announcement])

  useEffect(() => {
    if (announcementVisible && announcement) {
      channelRef.current?.postMessage({ type: 'announcement', visible: true, text: announcement.text })
    } else {
      channelRef.current?.postMessage({ type: 'announcement', visible: false })
    }
  }, [announcementVisible, announcement])

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
    if (IS_MOBILE) return
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

  /* Nav-tab follows the search box: typing jumps to Results, an empty box
     falls back to Recent. Only fires on the empty↔non-empty edge, so a manual
     pick of Baanis sticks until the box's emptiness actually flips. */
  const prevQueryEmptyRef = useRef(true)
  useEffect(() => {
    const empty = !query.trim()
    if (empty !== prevQueryEmptyRef.current) {
      prevQueryEmptyRef.current = empty
      setNavTab(empty ? 'recent' : 'results')
    }
  }, [query])

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
      } else if (activeTabRef.current) {
        const t    = activeTabRef.current
        const svs  = t.svs
        const idx  = t.dv ? svs.indexOf(t.dv) : -1
        const next = Math.max(0, Math.min(svs.length - 1, idx + dir))
        const nv   = svs[next]
        if (nv) setTabDv(t.key, nv)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
          // Threshold: forward sequential moves (singer going to the very next
          // shabad in Granth order) commit at 2 events — strong prior signal
          // since that's the typical kirtan flow. Any other cross-shabad jump
          // needs 3 events as the original safeguard.
          const curShabadId = bcastDvRef.current?.Shabads?.[0]?.ShabadID
          const curIdx = curShabadId != null ? sortedShabadIds.indexOf(curShabadId) : -1
          const isNextShabad = curIdx >= 0 && curIdx + 1 < sortedShabadIds.length && sortedShabadIds[curIdx + 1] === shabadId
          const threshold = isNextShabad ? 2 : 3
          const prev = kirtanShabadCandidateRef.current
          if (prev?.shabadId === shabadId) {
            prev.count++
            prev.verse = match
            if (prev.count >= threshold) {
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

  /* ── preview tab actions ───────────────────────────────────── */
  // Patch just the active tab's display verse — used by clicks and arrow keys.
  function setTabDv(key, dv) {
    setPvTabs(tabs => tabs.map(t => t.key === key ? { ...t, dv } : t))
  }

  // Open `tabData` as a tab. Desktop: if a tab with the same `sid` already
  // exists, re-select it and merge in the new payload (so a search click that
  // lands on an already-open shabad jumps to the searched verse); otherwise
  // append a new tab. Mobile: replace the single tab (no multi-tab UI).
  function openTab(tabData) {
    focusedPanelRef.current = 'preview'
    if (!IS_MOBILE) {
      const existing = pvTabs.find(t => t.sid === tabData.sid)
      if (existing) {
        setPvTabs(tabs => tabs.map(t => t.key === existing.key ? { ...t, ...tabData } : t))
        setPvActiveKey(existing.key)
        return existing.key
      }
    }
    const key = ++tabKeyRef.current
    const tab = { key, ...tabData }
    setPvTabs(tabs => IS_MOBILE ? [tab] : [...tabs, tab])
    setPvActiveKey(key)
    return key
  }

  function openVerse(verse) {
    const svs = getShabadVerses(verse)
    const shabadId = verse.Shabads?.[0]?.ShabadID
    openTab({ sid: `s:${shabadId ?? verse.ID}`, verse, svs, dv: verse, bani: null, sectionLabels: null })
    // Mobile has no broadcast → desktop's "Send to Broadcast" is the moment
    // history is normally saved. On mobile, opening the shabad IS the
    // commitment, so save here. Bani opens go through openBani and are
    // intentionally not recorded.
    if (IS_MOBILE) saveHistory(historyEntry(verse))
  }

  function openFromHistory(entry) {
    // Bani entries reopen the whole bani — verse counts may differ from when
    // the entry was saved (e.g. maryada changed), so re-derive from baniInfo.
    if (entry.baniId && baniInfo.get(entry.baniId)?.verses.length > 0) {
      openBani(entry.baniId)
      return
    }
    const verse = verses.find(v => v.ID === entry.verseId)
    if (verse) openVerse(verse)
  }

  /* Switching maryada changes which verses belong to each bani, so any open
     bani tab holds a now-stale verse list. Drop bani tabs and persist the
     choice; the user can re-open the bani to see the new view. */
  function changeMaryada(m) {
    setMaryada(m)
    localStorage.setItem(MARYADA_KEY, m)
    setPvTabs(tabs => {
      const next = tabs.filter(t => !t.bani)
      if (activeTab?.bani) setPvActiveKey(next[next.length - 1]?.key ?? null)
      return next
    })
  }

  /* Open an entire bani (Japji Sahib, Jaap Sahib, …) in a preview tab. */
  function openBani(baniId) {
    const entry = baniInfo.get(baniId)
    if (!entry || entry.verses.length === 0) return
    const first = entry.verses[0]
    openTab({ sid: `b:${baniId}`, verse: first, svs: entry.verses, dv: first, bani: entry.meta, sectionLabels: entry.sectionLabels })
  }

  function selectPvVerse(verse) {
    setTabDv(pvActiveKey, verse)
    focusedPanelRef.current = 'preview'
    /* deliberately does NOT broadcast */
  }

  function selectPreviewTab(key) {
    setPvActiveKey(key)
    focusedPanelRef.current = 'preview'
  }

  // Close one tab; if it was active, fall through to the neighbour that slides
  // into its slot (or the previous one when closing the last tab).
  function closePreviewTab(key) {
    setPvTabs(tabs => {
      const idx  = tabs.findIndex(t => t.key === key)
      const next = tabs.filter(t => t.key !== key)
      if (key === pvActiveKey) {
        const fallback = next[idx] || next[idx - 1] || null
        setPvActiveKey(fallback ? fallback.key : null)
      }
      return next
    })
  }

  function closeAllPreviewTabs() {
    setPvTabs([])
    setPvActiveKey(null)
  }

  /* ── broadcast panel actions ───────────────────────────────── */
  function startBroadcast(verse, svs, voiceActive = false, bani = null, sectionLabels = null) {
    setBcastVerse(verse)
    setBcastSvs(svs)
    setBcastDv(verse)
    setBcastLive(true)
    setBcastBani(bani)
    setBcastSectionLabels(sectionLabels)
    // New shabad/bani context — reset the sung-verse tracker so checkmarks
    // start fresh.
    setBcastSungIds(new Set([verse.__rowId ?? verse.ID]))
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

  // Replace the active tab's content in place (keeps its slot/key, updates sid).
  function replaceActiveTab(patch) {
    setPvTabs(tabs => tabs.map(t => t.key === pvActiveKey ? { ...t, ...patch } : t))
  }

  /* Walk to the previous/next shabad within the active tab. Banis are
     contiguous readings, not shabads, so nav is suppressed in bani mode. */
  function gotoSiblingShabadPreview(dir) {
    if (!activeTab || activeTab.bani) return
    const sib = getSiblingShabad(activeTab.verse?.Shabads?.[0]?.ShabadID, dir)
    if (!sib) return
    const first = sib.verses[0]
    replaceActiveTab({ sid: `s:${sib.shabadId}`, verse: first, svs: sib.verses, dv: first, bani: null, sectionLabels: null })
  }

  /* Prev/next baani — only meaningful when the active tab holds a bani. Swaps
     the bani in place within the same tab. */
  function gotoSiblingBaniPreview(dir) {
    if (!activeTab?.bani) return
    const nextId = getSiblingBani(activeTab.bani.ID, dir)
    if (nextId == null) return
    const entry = baniInfo.get(nextId)
    if (!entry || entry.verses.length === 0) return
    const first = entry.verses[0]
    replaceActiveTab({ sid: `b:${nextId}`, verse: first, svs: entry.verses, dv: first, bani: entry.meta, sectionLabels: entry.sectionLabels })
  }

  function gotoSiblingShabadBcast(dir) {
    if (bcastBani) return
    const sib = getSiblingShabad(bcastVerse?.Shabads?.[0]?.ShabadID, dir)
    if (!sib) return
    const first = sib.verses[0]
    // Manual nav overrides any in-flight kirtan cross-shabad tally.
    kirtanShabadCandidateRef.current = null
    if (bcastLive) {
      startBroadcast(first, sib.verses, kirtanModeRef.current === 'auto')
    } else {
      setBcastVerse(first); setBcastSvs(sib.verses); setBcastDv(first)
      setBcastBani(null); setBcastSectionLabels(null)
    }
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
    showPreview    && 'has-preview',
    bcastPanelOpen && 'has-broadcast',
  ].filter(Boolean).join(' ')

  return (
    <div className="sa-app">

      {/* ── header ── */}
      <header className="sa-header">
        <div className="sa-header-left">
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
          {!IS_MOBILE && (
            <>
              <span
                className={`sa-net-dot ${online ? 'up' : 'down'}`}
                title={online ? 'Online — kirtan listening available' : 'Offline — kirtan listening unavailable'}
              />
              <span
                className="sa-net-label"
                title={online ? 'Online — kirtan listening available' : 'Offline — kirtan listening unavailable'}
              >{online ? 'Online' : 'Offline'}</span>
            </>
          )}
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

          {/* kirtan listener — hidden on mobile: iOS lacks a Punjabi voice model
              and mobile Chrome's speech service is too flaky for live kirtan. */}
          {!IS_MOBILE && <div className="sa-kirtan">
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
          </div>}

          {/* Results / Baanis / Recent — the search box drives which tab is
              active (see the nav-tab effect); Baanis can also be picked by hand. */}
          <div className="sa-navtabs">
            <button className={`sa-navtab${navTab === 'results' ? ' active' : ''}`} onClick={() => setNavTab('results')}>
              Results{results.length > 0 && <span className="sa-navtab-count">{results.length}{results.length === 50 ? '+' : ''}</span>}
            </button>
            <button className={`sa-navtab${navTab === 'banis' ? ' active' : ''}`} onClick={() => setNavTab('banis')}>
              Baanis
            </button>
            <button className={`sa-navtab${navTab === 'recent' ? ' active' : ''}`} onClick={() => setNavTab('recent')}>
              Recent
            </button>
          </div>

          <div className="sa-results">
            {navTab === 'results' && (
              !query.trim()
                ? <p className="sa-empty">Type above to search Gurbani</p>
                : results.length === 0
                  ? <p className="sa-empty">No results — try a different spelling or mode</p>
                  : <>
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
            )}

            {navTab === 'banis' && (
              <BaniList
                baniInfo={baniInfo}
                activeBaniId={pvBani?.ID ?? null}
                maryada={maryada}
                onChangeMaryada={changeMaryada}
                onSelectBani={openBani}
              />
            )}

            {navTab === 'recent' && (
              searchHistory.length > 0 ? (
                <div className="sa-recent">
                  <div className="sa-recent-hdr">
                    <span className="sa-recent-title">Recent</span>
                    <button className="sa-recent-clear" onClick={clearHistory}>Clear all</button>
                  </div>
                  {searchHistory.map(entry => (
                    <RecentItem key={entry.id} entry={entry} onOpen={() => openFromHistory(entry)} onDelete={() => deleteHistory(entry.id)} />
                  ))}
                </div>
              ) : (
                <p className="sa-empty">No recent shabads yet</p>
              )
            )}
          </div>
        </div>

        {/* ── PREVIEW PANEL ── (browsing; never auto-updates broadcast) */}
        {showPreview && (
          <ShabadPreviewPanel
            tabs={pvTabs}
            activeKey={pvActiveKey}
            onSelectTab={selectPreviewTab}
            onCloseTab={closePreviewTab}
            onCloseAll={closeAllPreviewTabs}
            verse={pvVerse}
            shabadVerses={pvSvs}
            displayVerse={pvDv}
            bani={pvBani}
            sectionLabels={pvSectionLabels}
            isBroadcasting={isBroadcasting}
            mobileFontSize={mobileFontSize}
            onChangeMobileFontSize={changeMobileFontSize}
            focusMode={focusMode}
            onToggleFocusMode={toggleFocusMode}
            showFocusHint={showFocusHint}
            onDismissFocusHint={dismissFocusHint}
            onSelectVerse={selectPvVerse}
            onSendToBroadcast={sendToBroadcast}
            onPrevShabad={() => gotoSiblingShabadPreview(-1)}
            onNextShabad={() => gotoSiblingShabadPreview(1)}
            onPrevBani={() => gotoSiblingBaniPreview(-1)}
            onNextBani={() => gotoSiblingBaniPreview(1)}
            canPrevBani={!!pvBani && getSiblingBani(pvBani.ID, -1) != null}
            canNextBani={!!pvBani && getSiblingBani(pvBani.ID, 1) != null}
            canPrevShabad={!pvBani && !!getSiblingShabad(pvVerse?.Shabads?.[0]?.ShabadID, -1)}
            canNextShabad={!pvBani && !!getSiblingShabad(pvVerse?.Shabads?.[0]?.ShabadID, 1)}
            onClose={() => closePreviewTab(pvActiveKey)}
            onFocus={() => { focusedPanelRef.current = 'preview' }}
          />
        )}

        {/* ── BROADCAST PANEL ── (locked, no close while live) */}
        {/* Broadcasting is for desktop kirtan operators — hide on mobile. */}
        {bcastPanelOpen && !IS_MOBILE && (
          <BroadcastPanel
            verse={bcastVerse}
            shabadVerses={bcastSvs}
            displayVerse={bcastDv}
            bani={bcastBani}
            sectionLabels={bcastSectionLabels}
            sungIds={bcastSungIds}
            displaySettings={displaySettings}
            isLive={isBroadcasting}
            announcement={announcement}
            onOpenAnnouncement={() => setAnnouncementOpen(true)}
            onSelectVerse={selectBcastVerse}
            onUpdateSetting={updateSetting}
            onOpenDisplay={openDisplayTab}
            onFullscreen={sendFullscreen}
            onStop={stopBroadcast}
            onResume={resumeBroadcast}
            onPrevShabad={() => gotoSiblingShabadBcast(-1)}
            onNextShabad={() => gotoSiblingShabadBcast(1)}
            canPrevShabad={!bcastBani && !!getSiblingShabad(bcastVerse?.Shabads?.[0]?.ShabadID, -1)}
            canNextShabad={!bcastBani && !!getSiblingShabad(bcastVerse?.Shabads?.[0]?.ShabadID, 1)}
            onClose={closeBroadcastPanel}
            onFocus={() => { focusedPanelRef.current = 'broadcast' }}
          />
        )}

        {announcementOpen && (
          <AnnouncementModal
            initial={announcement}
            onSave={a => { setAnnouncement(a); setAnnouncementOpen(false) }}
            onCancel={() => setAnnouncementOpen(false)}
            onStop={() => { setAnnouncement(null); setAnnouncementOpen(false) }}
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
function ShabadPreviewPanel({ tabs, activeKey, onSelectTab, onCloseTab, onCloseAll, verse, shabadVerses, displayVerse, bani, sectionLabels, isBroadcasting, mobileFontSize, onChangeMobileFontSize, focusMode, onToggleFocusMode, showFocusHint, onDismissFocusHint, onSelectVerse, onSendToBroadcast, onPrevShabad, onNextShabad, canPrevShabad, canNextShabad, onPrevBani, onNextBani, canPrevBani, canNextBani, onClose, onFocus }) {
  const activeRef = useRef(null)
  const jumpRef   = useRef(null)
  const lastTapRef = useRef(0)
  const justJumpedRef = useRef(false)
  const [outlineRequested, setOutlineMode] = useState(false)
  const [pendingJumpRowId, setPendingJumpRowId] = useState(null)

  // Switching tabs is a context change — drop any outline/jump state so the
  // newly-shown tab starts on its verse list, scrolled to its active verse.
  useEffect(() => { setOutlineMode(false); setPendingJumpRowId(null) }, [activeKey])

  // Double-tap on the verses area toggles focus mode (mobile). Single taps
  // still let the verse onClick fire — both run, which is fine since
  // selecting a verse is a non-destructive action.
  function handleVersesTap() {
    const now = Date.now()
    if (now - lastTapRef.current < 350) {
      onToggleFocusMode?.()
      lastTapRef.current = 0
    } else {
      lastTapRef.current = now
    }
  }
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
      justJumpedRef.current = true
      setPendingJumpRowId(null)
      return
    }
    // setPendingJumpRowId(null) above triggers a second effect run — skip the
    // auto-scroll-to-active-verse on that pass so we stay at the jumped section.
    if (justJumpedRef.current) { justJumpedRef.current = false; return }
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse, outlineMode, pendingJumpRowId])

  function jumpToSection(item) {
    setPendingJumpRowId(item.rowId)
    setOutlineMode(false)
    onSelectVerse(item.verse)
  }

  return (
    <aside className="sa-panel sa-preview-panel" style={{ '--pv-font-size': `${mobileFontSize}px` }} onClick={onFocus}>
      {/* tab strip — desktop only; mobile keeps a single preview at a time */}
      {!IS_MOBILE && tabs.length > 0 && (
        <PreviewTabs
          tabs={tabs}
          activeKey={activeKey}
          onSelect={onSelectTab}
          onCloseTab={onCloseTab}
          onCloseAll={onCloseAll}
        />
      )}
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

      {!IS_MOBILE && (
        <button className="sp-broadcast-btn sp-go-live-btn" onClick={onSendToBroadcast}>
          ▶ Send to Broadcast
        </button>
      )}

      {outlineMode ? (
        <OutlineList items={outlineItems} onJump={jumpToSection} onBack={() => setOutlineMode(false)} />
      ) : (
        <div className="sp-verses sp-verses-preview" onClick={handleVersesTap}>
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

      {/* nav row: shabad mode (any screen) or bani mode (mobile only) */}
      {(!bani || IS_MOBILE) && (
        <div className="sp-shabad-nav">
          <button
            className="sp-shabad-nav-btn"
            onClick={bani ? onPrevBani : onPrevShabad}
            disabled={bani ? !canPrevBani : !canPrevShabad}
            title={bani ? 'Previous baani' : 'Previous shabad'}
          >
            <IconArrowLeft /> <span>{bani ? 'Prev baani' : 'Previous'}</span>
          </button>
          <div className="sp-font-controls" aria-label="Verse font size">
            <button
              className="sp-font-btn"
              onClick={() => onChangeMobileFontSize?.(-2)}
              disabled={mobileFontSize <= 14}
              aria-label="Decrease text size"
            >A−</button>
            <button
              className="sp-font-btn"
              onClick={() => onChangeMobileFontSize?.(2)}
              disabled={mobileFontSize >= 36}
              aria-label="Increase text size"
            >A+</button>
          </div>
          <button
            className="sp-shabad-nav-btn"
            onClick={bani ? onNextBani : onNextShabad}
            disabled={bani ? !canNextBani : !canNextShabad}
            title={bani ? 'Next baani' : 'Next shabad'}
          >
            <span>{bani ? 'Next baani' : 'Next'}</span> <IconArrowRight />
          </button>
        </div>
      )}

      {showFocusHint && (
        <div className="sp-focus-hint-backdrop" role="dialog" aria-modal="true">
          <div className="sp-focus-hint-card">
            <div className="sp-focus-hint-icon" aria-hidden="true">
              <span /><span />
            </div>
            <h3>Did you know?</h3>
            <p>Double-tapping the shabad area hides the header and controls — so you can read the verses without distractions.</p>
            <p className="sp-focus-hint-sub">Double-tapping again brings them back.</p>
            <button className="sp-focus-hint-ok" onClick={onDismissFocusHint}>Got it</button>
          </div>
        </div>
      )}
    </aside>
  )
}

/* ── PreviewTabs ─────────────────────────────────────────────── */
/* Desktop tab strip above the shabad preview. One chip per open shabad/bani;
   each chip selects its tab and carries its own close ×. The trailing button
   closes every tab at once. */
function PreviewTabs({ tabs, activeKey, onSelect, onCloseTab, onCloseAll }) {
  function tabLabel(t) {
    if (t.bani) return NITNEM_LABELS[t.bani.ID] || t.bani.Token || toUnicode(t.bani.Gurmukhi || '')
    return t.verse?.PageNo ? `Ang ${t.verse.PageNo}` : (t.verse?.Source?.SourceEnglish || 'Shabad')
  }
  return (
    <div className="sp-tabs">
      <div className="sp-tabs-scroll">
        {tabs.map(t => (
          <div
            key={t.key}
            className={`sp-tab${t.key === activeKey ? ' active' : ''}`}
            onClick={() => onSelect(t.key)}
            role="button" tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onSelect(t.key)}
            title={tabLabel(t)}
          >
            <span className="sp-tab-label">{tabLabel(t)}</span>
            <button
              className="sp-tab-close"
              onClick={e => { e.stopPropagation(); onCloseTab(t.key) }}
              title="Close tab"
            ><IconX /></button>
          </div>
        ))}
      </div>
      {tabs.length > 1 && (
        <button className="sp-tabs-closeall" onClick={onCloseAll} title="Close all tabs">Close all</button>
      )}
    </div>
  )
}

/* ── BaniList ────────────────────────────────────────────────── */
/* Baanis nav-tab body. Top section pins Nitnem in a curated order; below that,
   all remaining baanis (those with at least one verse) in their natural ID order. */
function BaniList({ baniInfo, activeBaniId, maryada, onChangeMaryada, onSelectBani }) {
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
    <div className="sa-bani-list">
      <div className="sb-maryada">
        <label className="sb-maryada-label" htmlFor="sb-maryada-select">Maryada</label>
        {IS_MOBILE ? (
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
        ) : (
          <div className="sb-maryada-pills" role="group" aria-label="Select maryada tradition">
            {MARYADAS.map(m => (
              <button
                key={m.id}
                className={`sb-maryada-pill${maryada === m.id ? ' active' : ''}`}
                onClick={() => onChangeMaryada(m.id)}
                title={`Filter baanis to ${m.label} tradition`}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
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
            <div className="sb-grid">
              {nitnemFiltered.map(entry => (
                <BaniRow
                  key={entry.meta.ID}
                  entry={entry}
                  active={activeBaniId === entry.meta.ID}
                  onClick={() => onSelectBani(entry.meta.ID)}
                />
              ))}
            </div>
          </>
        )}
        {otherFiltered.length > 0 && (
          <>
            <div className="sb-group-label">All baanis</div>
            <div className="sb-grid">
              {otherFiltered.map(entry => (
                <BaniRow
                  key={entry.meta.ID}
                  entry={entry}
                  active={activeBaniId === entry.meta.ID}
                  onClick={() => onSelectBani(entry.meta.ID)}
                />
              ))}
            </div>
          </>
        )}
        {nitnemFiltered.length === 0 && otherFiltered.length === 0 && (
          <p className="sb-empty">No matching baanis</p>
        )}
      </div>
    </div>
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

/* ── AnnouncementModal ───────────────────────────────────────── */
/* Presenter-only form for sending an overlay announcement to the broadcast
   screen. Supports one-shot OR repeating (show for X sec every Y sec) with
   an optional auto-stop time. */
function AnnouncementModal({ initial, onSave, onCancel, onStop }) {
  const [text,      setText]      = useState(initial?.text || '')
  const [showSec,   setShowSec]   = useState(initial?.showSec ?? '')
  const [repeatSec, setRepeatSec] = useState(initial?.repeatSec ?? '')
  const [endMin,    setEndMin]    = useState(() => {
    if (initial?.endAt) return Math.max(1, Math.round((initial.endAt - Date.now()) / 60000))
    return ''
  })

  function submit(e) {
    e?.preventDefault()
    const t = text.trim()
    if (!t) return
    const showNum = Number(showSec)
    const show = Number.isFinite(showNum) && showNum >= 0 ? showNum : 30
    const repeatNum = Number(repeatSec)
    const repeat = Number.isFinite(repeatNum) && repeatNum >= 0 ? repeatNum : 0
    // Guard against repeat shorter than show — would never hide. Doesn't
    // apply when show is indefinite (0), repeat is meaningless then.
    const safeRepeat = show > 0 && repeat > 0 && repeat <= show ? show + 5 : repeat
    const finalRepeat = show <= 0 ? 0 : safeRepeat  // indefinite ignores repeat
    const minutes = Math.max(0, Number(endMin) || 0)
    onSave({
      text: t,
      showSec: show,
      repeatSec: finalRepeat,
      endAt: minutes > 0 ? Date.now() + minutes * 60 * 1000 : null,
    })
  }

  return (
    <div className="ann-modal-backdrop" onClick={onCancel}>
      <form className="ann-modal" onClick={e => e.stopPropagation()} onSubmit={submit}>
        <div className="ann-modal-header">
          <h3>Announcement</h3>
          <button type="button" className="sp-btn" onClick={onCancel} title="Close"><IconX /></button>
        </div>
        <label className="ann-field">
          <span>Message</span>
          <textarea
            className="ann-textarea"
            rows={3}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="e.g. Black Toyota Camry, please move from the entrance"
            autoFocus
          />
        </label>
        <div className="ann-field-row">
          <label className="ann-field">
            <span>Show for (sec)</span>
            <input type="number" min="0" max="600" placeholder="∞" value={showSec} onChange={e => setShowSec(e.target.value)} />
          </label>
          <label className="ann-field">
            <span>Repeat every (sec)</span>
            <input type="number" min="0" max="3600" placeholder="off" value={repeatSec} onChange={e => setRepeatSec(e.target.value)} />
          </label>
          <label className="ann-field">
            <span>Stop after (min)</span>
            <input type="number" min="0" max="600" placeholder="never" value={endMin} onChange={e => setEndMin(e.target.value)} />
          </label>
        </div>
        <p className="ann-hint">
          {(() => {
            const show = Number(showSec)
            const rep  = Number(repeatSec)
            const end  = Number(endMin)
            if (show <= 0) {
              return end > 0
                ? `Stays on screen indefinitely, stopping after ${end} min.`
                : `Stays on screen until you stop it.`
            }
            if (rep > 0) {
              return end > 0
                ? `Shows every ${rep}s for ${show}s, stopping in ${end} min.`
                : `Shows every ${rep}s for ${show}s, until you stop it.`
            }
            return `One-shot — shows once for ${show}s.`
          })()}
        </p>
        <div className="ann-actions">
          {initial && onStop && (
            <button type="button" className="ann-stop-btn" onClick={onStop}>Stop</button>
          )}
          <button type="button" className="ann-cancel-btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="sp-broadcast-btn sp-go-live-btn ann-send-btn" disabled={!text.trim()}>
            <IconAirHorn /> {initial ? 'Update' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}

/* ── BroadcastPanel ──────────────────────────────────────────── */
/* Locked to what is live. Shows display controls. No close button.
   When `bani` is set, the header shows the bani's Gurmukhi name and `sectionLabels`
   renders dividers like "ਪਉੜੀ 1" inline in the verse list (mirrors preview panel). */
/* Read a user-selected image file, downscale it to fit within 1920x1920 and
   re-encode as JPEG at 0.85 quality. Keeps localStorage usage manageable
   (raw camera files can be 5–10 MB; the cap is ~1 MB after this pass).
   Also activates image mode (bg='image') so the upload is immediately visible. */
async function handleBgImageChange(e, onUpdateSetting) {
  const file = e.target?.files?.[0]
  if (!file) return
  try {
    const dataUrl = await downscaleImage(file, 1920, 0.85)
    onUpdateSetting('customBgImage', dataUrl)
    onUpdateSetting('bg', 'image')
  } catch (err) {
    console.error('[BgImage]', err)
    alert('Could not load that image. Try a different file.')
  }
  e.target.value = ''  // allow re-selecting the same file
}

function downscaleImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d').drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')) }
    img.src = url
  })
}

function BroadcastPanel({ verse, shabadVerses, displayVerse, bani, sectionLabels, sungIds, displaySettings, isLive, announcement, onOpenAnnouncement, onSelectVerse, onUpdateSetting, onOpenDisplay, onFullscreen, onStop, onResume, onPrevShabad, onNextShabad, canPrevShabad, canNextShabad, onClose, onFocus }) {
  const preset     = effectivePreset(displaySettings)
  const count      = displaySettings.verseCount || 1
  const previewStyle = preset.bgImage
    ? { backgroundColor: preset.bg, color: preset.fg, backgroundImage: `url(${preset.bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: preset.bg, color: preset.fg }
  // Identity by reference — duplicate verses (refrains) share IDs.
  const anchorIdx  = displayVerse ? shabadVerses.indexOf(displayVerse) : -1
  const verseWindow = anchorIdx !== -1
    ? shabadVerses.slice(anchorIdx, Math.min(anchorIdx + count, shabadVerses.length))
    : displayVerse ? [displayVerse] : []
  const transOpts  = getTranslationOptions(displayVerse?.Translations)
  const activeRef  = useRef(null)
  const [ctrlOpen, setCtrlOpen] = useState(false)
  const fileInputRef = useRef(null)
  const jumpRef = useRef(null)
  const justJumpedRef = useRef(false)
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
      justJumpedRef.current = true
      setPendingJumpRowId(null)
      return
    }
    if (justJumpedRef.current) { justJumpedRef.current = false; return }
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse, outlineMode, pendingJumpRowId])

  function jumpToSection(item) {
    setPendingJumpRowId(item.rowId)
    setOutlineMode(false)
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
      <div className="sp-preview" style={previewStyle}>
        <div className="sp-preview-actions">
          <button
            className={`sp-preview-action-btn sp-ann-action${announcement ? ' active' : ''}`}
            onClick={onOpenAnnouncement}
            title={announcement ? 'Announcement active — edit or stop' : 'Send announcement'}
          >
            <IconAirHorn />
          </button>
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
      <div className={`sp-ctrl-anim${ctrlOpen ? ' open' : ''}`} aria-hidden={!ctrlOpen}>
      <div className="sp-ctrl-clip">
      <div className="sp-ctrl-body">
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
        <div className="sp-ctrl-row sp-theme-row">
          <span className="sp-ctrl-label">Background</span>
          <div className="sp-ctrl-group sp-theme-group">
            {Object.entries(BG_PRESETS).map(([key, p]) => (
              <button
                key={key}
                className={`sp-bg-btn${displaySettings.bg === key ? ' active' : ''}`}
                style={{ background: p.bg, boxShadow: displaySettings.bg === key ? `0 0 0 2px ${p.fg}` : '0 0 0 1px rgba(128,128,128,0.25)' }}
                onClick={() => onUpdateSetting('bg', key)}
                title={p.label}
              />
            ))}

            <span className="sp-theme-or" aria-hidden="true">or</span>

            {/* image swatch — click activates (or uploads if empty);
                pencil overlay replaces; × removes */}
            <span className="sp-bg-image-wrap">
              <button
                className={`sp-bg-btn sp-bg-image-btn${displaySettings.customBgImage ? ' has-image' : ''}${displaySettings.bg === 'image' ? ' active' : ''}`}
                style={displaySettings.customBgImage
                  ? { backgroundImage: `url(${displaySettings.customBgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : undefined}
                onClick={() => {
                  if (!displaySettings.customBgImage) fileInputRef.current?.click()
                  else if (displaySettings.bg !== 'image') onUpdateSetting('bg', 'image')
                }}
                title={
                  !displaySettings.customBgImage ? 'Upload background image'
                  : displaySettings.bg === 'image' ? 'Image background active'
                  : 'Use this image'
                }
              >
                {!displaySettings.customBgImage && <IconImage />}
              </button>
              {displaySettings.customBgImage && (
                <button
                  className="sp-bg-image-edit"
                  onClick={() => fileInputRef.current?.click()}
                  title="Replace image"
                >
                  <IconPencil />
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => handleBgImageChange(e, onUpdateSetting)}
              />
            </span>
            {displaySettings.customBgImage && (
              <button
                className="sp-mini-clear"
                onClick={() => {
                  onUpdateSetting('customBgImage', null)
                  if (displaySettings.bg === 'image') onUpdateSetting('bg', 'dark')
                }}
                title="Remove image"
              >×</button>
            )}

            <label className="sp-color-pick" title="Text color">
              <input
                type="color"
                value={displaySettings.customFg || preset.fg}
                onChange={e => onUpdateSetting('customFg', e.target.value)}
              />
              <span>Aa</span>
            </label>
            {displaySettings.customFg && (
              <button className="sp-mini-clear" onClick={() => onUpdateSetting('customFg', null)} title="Reset text color">×</button>
            )}

            <label className="sp-color-pick" title="Background color">
              <input
                type="color"
                value={displaySettings.customBg || preset.bg}
                onChange={e => onUpdateSetting('customBg', e.target.value)}
              />
              <span>BG</span>
            </label>
            {displaySettings.customBg && (
              <button className="sp-mini-clear" onClick={() => onUpdateSetting('customBg', null)} title="Reset background color">×</button>
            )}
          </div>
        </div>
      </div>
      </div>
      </div>
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
            const isSung     = sungIds?.has(rowId)
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
                  <span className={`sp-verse-sung${isSung ? ' done' : ''}`} aria-hidden="true">
                    {isSung ? <IconCheck /> : ''}
                  </span>
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

      {!bani && (
        <div className="sp-shabad-nav">
          <button
            className="sp-shabad-nav-btn"
            onClick={onPrevShabad}
            disabled={!canPrevShabad}
            title="Previous shabad"
          >
            <IconArrowLeft /> <span>Previous</span>
          </button>
          <button
            className="sp-shabad-nav-btn"
            onClick={onNextShabad}
            disabled={!canNextShabad}
            title="Next shabad"
          >
            <span>Next</span> <IconArrowRight />
          </button>
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
function IconBookmark({ className }) {
  return <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
}
function IconCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
}
function IconImage() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><polyline points="21 15 16 10 5 21"/></svg>
}
function IconPencil() {
  return <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
}
function IconAirHorn() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* loudspeaker body — diagonal horn opening up-right */}
      <path d="M3 11 L21 6 L21 18 L3 13 Z" />
      {/* circular handle hanging below */}
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  )
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
