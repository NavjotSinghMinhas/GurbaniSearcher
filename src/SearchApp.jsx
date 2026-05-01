import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'
import { BG_PRESETS, getTranslation, renderGurmukhi } from './DisplayApp.jsx'
import './SearchApp.css'

const { toUnicode, toAscii, isGurmukhi } = gurmukhiUtils

const CHROME       = 'webkitSpeechRecognition' in window
const CHANNEL_NAME = 'gurbani-display'
const HISTORY_KEY  = 'gurbani-history'
const SETTINGS_KEY = 'gurbani-disp-settings'
const THEME_KEY    = 'gurbani-theme'
const MAX_HISTORY  = 50
const DEFAULT_SETTINGS = {
  fontSize: 48, transSize: 20, showTranslation: true, larivar: false, bg: 'dark',
}

const MODES = [
  { id: 'firstLetters', label: 'First Letters', hint: 'Finds verses containing those consecutive first letters anywhere — sorted by position' },
  { id: 'word',         label: 'Whole Word',    hint: 'Type an exact Gurmukhi word in Gurmukhi script or transliteration — e.g. ਨਾਮੁ or nwmu' },
  { id: 'anywhere',     label: 'Anywhere',      hint: 'Find any verse containing this substring — type in Gurmukhi or transliteration' },
  { id: 'english',      label: 'English',       hint: 'Search across all English translations' },
]

const KEYBOARD_LAYOUT = [
  { label: 'ਵਰਣਮਾਲਾ · Consonants', chars: ['ੳ','ਅ','ੲ','ਸ','ਹ','ਕ','ਖ','ਗ','ਘ','ਙ','ਚ','ਛ','ਜ','ਝ','ਞ','ਟ','ਠ','ਡ','ਢ','ਣ','ਤ','ਥ','ਦ','ਧ','ਨ','ਪ','ਫ','ਬ','ਭ','ਮ','ਯ','ਰ','ਲ','ਵ','ੜ','ਸ਼','ਖ਼','ਗ਼','ਜ਼','ਫ਼','ਲ਼'] },
  { label: 'ਲਗਾਂ · Vowel signs',   chars: ['ਾ','ਿ','ੀ','ੁ','ੂ','ੇ','ੈ','ੋ','ੌ','ੰ','ੱ','ਂ'] },
  { label: 'ਖ਼ਾਸ · Special',       chars: ['ੴ','ਃ'] },
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

function matchKirtan(transcript, verses) {
  const words = transcript.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const q = words.slice(0, 8).map(w => {
    const ch = isGurmukhi(w) ? toAscii(w.charAt(0)).charAt(0) : w.charAt(0)
    return (ch || '').toLowerCase()
  }).filter(Boolean).join('')
  if (q.length < 2) return null
  for (let len = Math.min(q.length, 6); len >= 2; len--) {
    const prefix = q.slice(0, len)
    let best = null, bestPos = Infinity
    for (const v of verses) {
      const pos = (v.FirstLetterEng || '').toLowerCase().indexOf(prefix)
      if (pos !== -1 && pos < bestPos) { best = v; bestPos = pos }
    }
    if (best) return best
  }
  return null
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
  const [showPreview, setShowPreview] = useState(false)

  /* ── BROADCAST PANEL ───────────────────────────────────────── */
  const [bcastVerse, setBcastVerse] = useState(null)
  const [bcastSvs,   setBcastSvs]   = useState([])
  const [bcastDv,    setBcastDv]    = useState(null)
  const [bcastLive,  setBcastLive]  = useState(false) // true = actively sending to display tab

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
  const kirtanApprovedRef  = useRef(false)
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

  /* ── BroadcastChannel ──────────────────────────────────────── */
  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = ch
    ch.onmessage = e => {
      if (e.data.type === 'ping' && bcastDvRef.current && bcastLiveRef.current) {
        ch.postMessage({
          type: 'sync',
          verse: bcastDvRef.current,
          settings: displaySettingsRef.current,
          voiceActive: kirtanModeRef.current === 'auto',
        })
      }
    }
    return () => { ch.close(); channelRef.current = null }
  }, [])

  function pushBroadcast(verse, settings, voiceActive = false) {
    channelRef.current?.postMessage({ type: 'sync', verse, settings, voiceActive })
  }

  function sendFullscreen() {
    channelRef.current?.postMessage({ type: 'fullscreen' })
  }

  function updateSetting(key, value) {
    setDisplaySettings(prev => {
      const next = { ...prev, [key]: value }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      if (bcastDvRef.current && bcastLiveRef.current) {
        channelRef.current?.postMessage({
          type: 'sync',
          verse: bcastDvRef.current,
          settings: next,
          voiceActive: kirtanModeRef.current === 'auto',
        })
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
        const svs  = bcastSvsRef.current
        const idx  = svs.findIndex(v => v.ID === bcastDvRef.current?.ID)
        const next = Math.max(0, Math.min(svs.length - 1, idx + dir))
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
          const idx  = svs.findIndex(v => v.ID === prev?.ID)
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
    /* eslint-disable no-undef */
    const R = new webkitSpeechRecognition()
    R.continuous = true; R.interimResults = true; R.lang = 'pa-IN'
    R.onresult = e => {
      let transcript = ''
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript
      setKirtanTranscript(transcript)
      const match = matchKirtan(transcript, verses)
      if (!match) return
      setKirtanCandidate(match)
      if (kirtanApprovedRef.current) {
        startBroadcast(match, getShabadVerses(match), false)
      }
    }
    R.onerror = () => {}
    R.onend   = () => { if (kirtanModeRef.current !== 'off') try { R.start() } catch { /* ok */ } }
    R.start()
    kirtanRecRef.current = R
    kirtanApprovedRef.current = false
    setKirtanMode('listening')
    setKirtanCandidate(null)
    setKirtanTranscript('')
  }

  function stopKirtan() {
    kirtanRecRef.current?.stop()
    kirtanRecRef.current = null
    kirtanApprovedRef.current = false
    setKirtanMode('off')
    setKirtanCandidate(null)
    setKirtanTranscript('')
    if (bcastDvRef.current) {
      channelRef.current?.postMessage({
        type: 'sync', verse: bcastDvRef.current,
        settings: displaySettingsRef.current, voiceActive: false,
      })
    }
  }

  function approveKirtanCandidate() {
    if (!kirtanCandidate) return
    kirtanApprovedRef.current = true
    setKirtanMode('auto')
    startBroadcast(kirtanCandidate, getShabadVerses(kirtanCandidate), true)
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
    setShowPreview(true)
    focusedPanelRef.current = 'preview'
  }

  function openFromHistory(entry) {
    const verse = verses.find(v => v.ID === entry.verseId)
    if (!verse) return
    const svs = entry.shabadId && shabadIndex.has(entry.shabadId)
      ? shabadIndex.get(entry.shabadId) : [verse]
    setPvVerse(verse); setPvSvs(svs); setPvDv(verse); setShowPreview(true)
    focusedPanelRef.current = 'preview'
  }

  function selectPvVerse(verse) {
    setPvDv(verse)
    focusedPanelRef.current = 'preview'
    /* deliberately does NOT broadcast */
  }

  /* ── broadcast panel actions ───────────────────────────────── */
  function startBroadcast(verse, svs, voiceActive = false) {
    setBcastVerse(verse)
    setBcastSvs(svs)
    setBcastDv(verse)
    setBcastLive(true)
    setShowPreview(false)
    pushBroadcast(verse, displaySettingsRef.current, voiceActive)
    saveHistory({
      id: `${verse.ID}_${Date.now()}`, timestamp: Date.now(),
      verseId: verse.ID,
      shabadId: verse.Shabads?.[0]?.ShabadID,
      gurmukhi: toUnicode(verse.Gurmukhi),
      source: verse.Source?.SourceEnglish,
      page: verse.PageNo,
      writer: verse.Writer?.WriterEnglish,
    })
  }

  /* "Send to Broadcast" from preview panel */
  function sendToBroadcast() {
    if (!pvDv) return
    startBroadcast(pvDv, pvSvs, kirtanModeRef.current === 'auto')
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
    setSearchHistory(prev => {
      const next = [entry, ...prev.filter(h => h.verseId !== entry.verseId)].slice(0, MAX_HISTORY)
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
            isBroadcasting={isBroadcasting}
            onSelectVerse={selectPvVerse}
            onSendToBroadcast={sendToBroadcast}
            onClose={() => { setShowPreview(false); setPvVerse(null) }}
            onFocus={() => { focusedPanelRef.current = 'preview' }}
          />
        )}

        {/* ── BROADCAST PANEL ── (locked, no close while live) */}
        {bcastPanelOpen && (
          <BroadcastPanel
            verse={bcastVerse}
            shabadVerses={bcastSvs}
            displayVerse={bcastDv}
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
  return (
    <div className="sa-rec-item">
      <button className="sa-rec-body" onClick={onOpen}>
        <p className="sa-rec-g">{entry.gurmukhi}</p>
        <div className="sa-rec-meta">
          {entry.source && <span>{entry.source}</span>}
          {entry.page   && <span>Ang {entry.page}</span>}
          <span className="sa-rec-time">{relTime(entry.timestamp)}</span>
        </div>
      </button>
      <button className="sa-rec-del" onClick={onDelete} title="Remove"><IconX /></button>
    </div>
  )
}

/* ── ShabadPreviewPanel ──────────────────────────────────────── */
/* Shows the shabad you're browsing. No display controls. Has close + send-to-broadcast. */
function ShabadPreviewPanel({ verse, shabadVerses, displayVerse, isBroadcasting, onSelectVerse, onSendToBroadcast, onClose, onFocus }) {
  const activeRef = useRef(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse?.ID])

  return (
    <aside className="sa-panel sa-preview-panel" onClick={onFocus}>
      <div className="sp-header">
        <div className="sp-meta">
          {verse?.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
          {verse?.Raag?.RaagEnglish     && <span>{verse.Raag.RaagEnglish}</span>}
          {verse?.PageNo                && <span>Ang {verse.PageNo}</span>}
          {verse?.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
        </div>
        <div className="sp-actions">
          <button className="sp-btn" onClick={onClose} title="Close preview"><IconX /></button>
        </div>
      </div>

      {/* send-to-broadcast is the primary action */}
      <button className="sp-broadcast-btn" onClick={onSendToBroadcast}>
        {isBroadcasting ? '↩ Replace Broadcast' : '▶ Send to Broadcast'}
      </button>

      <div className="sp-verses sp-verses-preview">
        <p className="sp-verses-hint">↑ ↓ arrow keys to navigate · click to select</p>
        {shabadVerses.map((v, i) => {
          const isActive = displayVerse?.ID === v.ID
          return (
            <div
              key={v.ID}
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
          )
        })}
      </div>
    </aside>
  )
}

/* ── BroadcastPanel ──────────────────────────────────────────── */
/* Locked to what is live. Shows display controls. No close button. */
function BroadcastPanel({ verse, shabadVerses, displayVerse, displaySettings, isLive, onSelectVerse, onUpdateSetting, onOpenDisplay, onFullscreen, onStop, onResume, onClose, onFocus }) {
  const preset    = BG_PRESETS[displaySettings.bg] || BG_PRESETS.dark
  const gText     = displayVerse ? renderGurmukhi(displayVerse.Gurmukhi, displaySettings.larivar) : ''
  const trans     = displayVerse && displaySettings.showTranslation ? getTranslation(displayVerse.Translations) : ''
  const activeRef = useRef(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse?.ID])

  return (
    <aside className="sa-panel sa-bcast-panel" onClick={onFocus}>

      <div className="sp-header">
        <button
          className={`sp-live-btn${isLive ? ' live' : ''}`}
          onClick={isLive ? onStop : onResume}
          title={isLive ? 'Stop broadcasting' : 'Resume broadcasting'}
        />
        <div className="sp-meta">
          {verse?.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
          {verse?.PageNo                && <span>Ang {verse.PageNo}</span>}
          {verse?.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
        </div>
        <div className="sp-actions">
          <button className="sp-btn" onClick={onFullscreen} title="Fullscreen broadcast screen"><IconFullscreen /></button>
          <button className="sp-btn" onClick={onOpenDisplay} title="Open broadcast screen"><IconExternalLink /></button>
          {!isLive && <button className="sp-btn" onClick={onClose} title="Close panel"><IconX /></button>}
        </div>
      </div>

      {/* live preview */}
      <div className="sp-preview" style={{ background: preset.bg, color: preset.fg }}>
        {displayVerse ? (
          <>
            <p className="sp-preview-g" style={{ fontSize: Math.min(displaySettings.fontSize, 26), fontFamily: 'var(--gurmukhi)' }}>{gText}</p>
            {trans && <p className="sp-preview-t" style={{ fontSize: Math.min(displaySettings.transSize, 14), color: preset.sub }}>{trans}</p>}
          </>
        ) : (
          <p className="sp-preview-empty" style={{ color: preset.sub }}>Select a verse below</p>
        )}
      </div>

      {/* display controls — only visible on broadcast panel */}
      <div className="sp-controls">
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Gurmukhi</span>
          <div className="sp-ctrl-group">
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.max(20, displaySettings.fontSize - 4))}>A−</button>
            <span className="sp-ctrl-val">{displaySettings.fontSize}px</span>
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.min(160, displaySettings.fontSize + 4))}>A+</button>
          </div>
        </div>
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Translation</span>
          <div className="sp-ctrl-group">
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('transSize', Math.max(10, (displaySettings.transSize || 20) - 2))}>a−</button>
            <span className="sp-ctrl-val">{displaySettings.transSize || 20}px</span>
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('transSize', Math.min(80, (displaySettings.transSize || 20) + 2))}>a+</button>
          </div>
        </div>
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Options</span>
          <div className="sp-ctrl-group">
            <button className={`sp-ctrl-btn${displaySettings.showTranslation ? ' active' : ''}`} onClick={() => onUpdateSetting('showTranslation', !displaySettings.showTranslation)}>Translation</button>
            <button className={`sp-ctrl-btn${displaySettings.larivar ? ' active' : ''}`} onClick={() => onUpdateSetting('larivar', !displaySettings.larivar)}>Larivar</button>
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
      </div>

      {/* verse list */}
      <div className="sp-verses">
        <p className="sp-verses-hint">↑ ↓ navigate · broadcasting updates live</p>
        {shabadVerses.map((v, i) => {
          const isActive = displayVerse?.ID === v.ID
          return (
            <div
              key={v.ID}
              ref={isActive ? activeRef : null}
              className={`sp-verse${isActive ? ' active' : ''}`}
              onClick={() => onSelectVerse(v)}
              role="button" tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && onSelectVerse(v)}
            >
              <span className="sp-verse-num">{i + 1}</span>
              <div className="sp-verse-body">
                <p className="sp-verse-g">{renderGurmukhi(v.Gurmukhi, displaySettings.larivar)}</p>
              </div>
            </div>
          )
        })}
      </div>
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
function IconSun() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
}
function IconMoon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
}
