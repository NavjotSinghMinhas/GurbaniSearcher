import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'
import { BG_PRESETS, getTranslation, renderGurmukhi } from './DisplayApp.jsx'
import './SearchApp.css'

const { toUnicode, toAscii, isGurmukhi } = gurmukhiUtils

const CHROME = 'webkitSpeechRecognition' in window

const MODES = [
  { id: 'firstLetters', label: 'First Letters', hint: 'Type the first letter of each word — e.g. snk or ਸਨਕ finds verses starting with those letters' },
  { id: 'word',         label: 'Whole Word',    hint: 'Type an exact Gurmukhi word in Gurmukhi script or transliteration — e.g. ਨਾਮੁ or nwmu' },
  { id: 'anywhere',     label: 'Anywhere',      hint: 'Find any verse containing this substring — type in Gurmukhi script or transliteration' },
  { id: 'english',      label: 'English',       hint: 'Search across all English translations' },
]

const CHANNEL_NAME = 'gurbani-display'
const HISTORY_KEY  = 'gurbani-history'
const SETTINGS_KEY = 'gurbani-disp-settings'
const MAX_HISTORY  = 50
const DEFAULT_SETTINGS = { fontSize: 48, showTranslation: true, larivar: false, bg: 'dark' }

function normalizeQuery(q) { return isGurmukhi(q) ? toAscii(q) : q }

function runSearch(verses, query, mode) {
  if (!query.trim()) return []
  const q = normalizeQuery(query.trim()).toLowerCase()
  const results = []
  for (const v of verses) {
    let hit = false
    if      (mode === 'firstLetters') hit = (v.FirstLetterEng || '').toLowerCase().startsWith(q.replace(/\s+/g, ''))
    else if (mode === 'word')         hit = v.Gurmukhi.split(/\s+/).some(w => w.replace(/[\][\d|(){}]/g, '').toLowerCase() === q)
    else if (mode === 'anywhere')     hit = v.Gurmukhi.toLowerCase().includes(q)
    else                              hit = (v.Translations || '').toLowerCase().includes(q)
    if (hit) { results.push(v); if (results.length >= 50) break }
  }
  return results
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

/* ── keyboard layout ─────────────────────────────────────────── */
const KEYBOARD_LAYOUT = [
  { label: 'ਵਰਣਮਾਲਾ · Consonants', chars: ['ੳ','ਅ','ੲ','ਸ','ਹ','ਕ','ਖ','ਗ','ਘ','ਙ','ਚ','ਛ','ਜ','ਝ','ਞ','ਟ','ਠ','ਡ','ਢ','ਣ','ਤ','ਥ','ਦ','ਧ','ਨ','ਪ','ਫ','ਬ','ਭ','ਮ','ਯ','ਰ','ਲ','ਵ','ੜ','ਸ਼','ਖ਼','ਗ਼','ਜ਼','ਫ਼','ਲ਼'] },
  { label: 'ਲਗਾਂ · Vowel signs',   chars: ['ਾ','ਿ','ੀ','ੁ','ੂ','ੇ','ੈ','ੋ','ੌ','ੰ','ੱ','ਂ'] },
  { label: 'ਖ਼ਾਸ · Special',       chars: ['ੴ','ਃ'] },
]

/* ══════════════════════════════════════════════════════════════════
   SearchApp
════════════════════════════════════════════════════════════════════ */
export function SearchApp({ data }) {
  const verses = data?.Verse ?? []

  /* search */
  const [query,        setQuery]        = useState('')
  const [mode,         setMode]         = useState('firstLetters')
  const [results,      setResults]      = useState([])
  const [voiceActive,  setVoiceActive]  = useState(false)
  const [interim,      setInterim]      = useState('')
  const [online,       setOnline]       = useState(navigator.onLine)
  const [chromeTip,    setChromeTip]    = useState(false)
  const [showKeyboard, setShowKeyboard] = useState(false)

  /* panel */
  const [selectedVerse, setSelectedVerse] = useState(null)
  const [shabadVerses,  setShabadVerses]  = useState([])
  const [displayVerse,  setDisplayVerse]  = useState(null)
  const [showPanel,     setShowPanel]     = useState(false)

  /* history */
  const [searchHistory, setSearchHistory] = useState(loadHistory)
  const [showHistory,   setShowHistory]   = useState(false)

  /* display settings */
  const [displaySettings, setDisplaySettings] = useState(loadSettings)

  const channelRef     = useRef(null)
  const recognitionRef = useRef(null)
  const debounceRef    = useRef(null)
  const inputRef       = useRef(null)
  const tipTimerRef    = useRef(null)

  /* shabad index — built once from all 142k verses */
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
  const displayVerseRef    = useRef(displayVerse)
  const shabadVersesRef    = useRef(shabadVerses)
  const displaySettingsRef = useRef(displaySettings)

  useEffect(() => { displayVerseRef.current    = displayVerse    }, [displayVerse])
  useEffect(() => { shabadVersesRef.current    = shabadVerses    }, [shabadVerses])
  useEffect(() => { displaySettingsRef.current = displaySettings }, [displaySettings])

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = ch
    ch.onmessage = e => {
      if (e.data.type === 'ping' && displayVerseRef.current) {
        ch.postMessage({ type: 'sync', verse: displayVerseRef.current, shabadVerses: shabadVersesRef.current, settings: displaySettingsRef.current })
      }
    }
    return () => { ch.close(); channelRef.current = null }
  }, [])

  function broadcast(verse, svs, settings) {
    channelRef.current?.postMessage({ type: 'sync', verse, shabadVerses: svs, settings })
  }

  function updateSetting(key, value) {
    setDisplaySettings(prev => {
      const next = { ...prev, [key]: value }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      if (displayVerseRef.current) broadcast(displayVerseRef.current, shabadVersesRef.current, next)
      return next
    })
  }

  /* ── online/offline ────────────────────────────────────────── */
  useEffect(() => {
    const up = () => setOnline(true)
    const dn = () => { setOnline(false); stopVoice() }
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

  /* ── voice ─────────────────────────────────────────────────── */
  function startVoice() {
    if (!CHROME) {
      setChromeTip(true)
      clearTimeout(tipTimerRef.current)
      tipTimerRef.current = setTimeout(() => setChromeTip(false), 3500)
      return
    }
    if (!online) return
    /* eslint-disable no-undef */
    const R = new webkitSpeechRecognition()
    R.continuous = true; R.interimResults = true; R.lang = 'pa-IN'
    R.onresult = e => {
      let fin = '', tmp = ''
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript
        else                      tmp += e.results[i][0].transcript
      }
      if (fin) setQuery(fin)
      setInterim(tmp)
    }
    R.onerror = () => stopVoice()
    R.onend   = () => { setVoiceActive(false); setInterim('') }
    R.start()
    recognitionRef.current = R
    setVoiceActive(true)
  }

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setVoiceActive(false)
    setInterim('')
  }, [])

  /* ── keyboard helpers ──────────────────────────────────────── */
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
    if (s !== e) {
      setQuery(query.slice(0, s) + query.slice(e))
      requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(s, s) })
    } else if (s > 0) {
      setQuery(query.slice(0, s - 1) + query.slice(s))
      requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(s - 1, s - 1) })
    }
  }

  /* ── open verse (from search result) ──────────────────────── */
  function openVerse(verse) {
    const shabadId = verse.Shabads?.[0]?.ShabadID
    const svs = shabadId && shabadIndex.has(shabadId)
      ? shabadIndex.get(shabadId)
      : [verse]

    setSelectedVerse(verse)
    setShabadVerses(svs)
    setDisplayVerse(verse)
    setShowPanel(true)
    setShowHistory(false)

    saveHistory({
      id:        `${verse.ID}_${Date.now()}`,
      timestamp: Date.now(),
      query,
      mode,
      verseId:   verse.ID,
      shabadId,
      gurmukhi:  toUnicode(verse.Gurmukhi),
      source:    verse.Source?.SourceEnglish,
      page:      verse.PageNo,
      writer:    verse.Writer?.WriterEnglish,
    })

    broadcast(verse, svs, displaySettings)
  }

  /* ── open verse from history ───────────────────────────────── */
  function openFromHistory(entry) {
    const verse = verses.find(v => v.ID === entry.verseId)
    if (!verse) return
    setQuery(entry.query || '')
    setMode(entry.mode || 'firstLetters')
    setShowHistory(false)

    const svs = entry.shabadId && shabadIndex.has(entry.shabadId)
      ? shabadIndex.get(entry.shabadId)
      : [verse]

    setSelectedVerse(verse)
    setShabadVerses(svs)
    setDisplayVerse(verse)
    setShowPanel(true)
    broadcast(verse, svs, displaySettings)
  }

  /* ── click verse in panel ──────────────────────────────────── */
  function selectDisplayVerse(verse) {
    setDisplayVerse(verse)
    broadcast(verse, shabadVerses, displaySettings)
  }

  /* ── history persistence ───────────────────────────────────── */
  function saveHistory(entry) {
    setSearchHistory(prev => {
      const filtered = prev.filter(h => h.verseId !== entry.verseId)
      const next = [entry, ...filtered].slice(0, MAX_HISTORY)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      return next
    })
  }

  function clearHistory() {
    setSearchHistory([])
    localStorage.removeItem(HISTORY_KEY)
  }

  function openDisplayTab() {
    const url = new URL(window.location.href)
    url.searchParams.set('display', '1')
    window.open(url.toString(), 'gurbani-display')
  }

  const displayValue = voiceActive && interim ? query + interim : query

  return (
    <div className="sa-app">

      {/* ── header ── */}
      <header className="sa-header">
        <div className="sa-header-left">
          <img src="/icon.svg" className="sa-logo" alt="" aria-hidden="true" />
          <span className="sa-title">Gurbani Search</span>
        </div>
        <div className="sa-header-right">
          <button
            className={`sa-icon-btn${showHistory ? ' active' : ''}`}
            onClick={() => { setShowHistory(v => !v); setShowPanel(false) }}
            title="Search history"
          >
            <IconHistory />
            {searchHistory.length > 0 && (
              <span className="sa-badge">{Math.min(searchHistory.length, 99)}</span>
            )}
          </button>
          <span className={`sa-net-dot ${online ? 'up' : 'down'}`} />
          <span className="sa-net-label">{online ? 'Online' : 'Offline'}</span>
          <div className="sa-mic-wrap">
            <button
              className={`sa-mic-btn${voiceActive ? ' active' : ''}`}
              onClick={voiceActive ? stopVoice : startVoice}
              aria-label={voiceActive ? 'Stop voice search' : 'Start voice search'}
            >
              {voiceActive ? <IconStop /> : <IconMic />}
            </button>
            {chromeTip && <div className="sa-chrome-tip">Voice search is Chrome only for now</div>}
          </div>
        </div>
      </header>

      {/* ── layout ── */}
      <div className={`sa-layout${showPanel || showHistory ? ' has-panel' : ''}`}>

        {/* search column */}
        <div className="sa-main">
          <div className="sa-controls">
            <div className="sa-input-row">
              <div className="sa-input-wrap">
                <IconSearch className="sa-input-icon" />
                <input
                  ref={inputRef}
                  className="sa-input"
                  type="search"
                  value={displayValue}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search Gurbani…"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {query && (
                  <button
                    className="sa-clear"
                    onClick={() => { setQuery(''); setResults([]); inputRef.current?.focus() }}
                    aria-label="Clear"
                  >
                    <IconX />
                  </button>
                )}
              </div>
              <button
                className={`sa-kbd-toggle${showKeyboard ? ' active' : ''}`}
                onClick={() => setShowKeyboard(v => !v)}
                title="Gurmukhi keyboard"
              >
                <IconKeyboard />
              </button>
            </div>

            {voiceActive && (
              <div className="sa-listening" aria-live="polite">
                <span className="sa-listen-dot" />
                Listening…
                <button className="sa-stop-voice" onClick={stopVoice}>Stop</button>
              </div>
            )}

            {showKeyboard && (
              <GurmukhiKeyboard
                onChar={insertChar}
                onDelete={deleteChar}
                onSpace={() => insertChar(' ')}
              />
            )}

            <div className="sa-mode-row">
              {MODES.map(m => (
                <button
                  key={m.id}
                  className={`sa-mode${mode === m.id ? ' active' : ''}`}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="sa-hint">{MODES.find(m => m.id === mode)?.hint}</p>
          </div>

          <div className="sa-results">
            {results.length === 0 && query.trim() && (
              <p className="sa-empty">No results — try a different spelling or mode</p>
            )}
            {results.map(v => (
              <VerseCard
                key={v.ID}
                verse={v}
                isSelected={selectedVerse?.ID === v.ID}
                onClick={() => openVerse(v)}
              />
            ))}
            {results.length === 50 && (
              <p className="sa-cap">Showing first 50 results — refine your search to see more</p>
            )}
          </div>
        </div>

        {/* shabad panel */}
        {showPanel && (
          <ShabadPanel
            verse={selectedVerse}
            shabadVerses={shabadVerses}
            displayVerse={displayVerse}
            displaySettings={displaySettings}
            onSelectVerse={selectDisplayVerse}
            onUpdateSetting={updateSetting}
            onOpenDisplay={openDisplayTab}
            onClose={() => { setShowPanel(false); setSelectedVerse(null); setShabadVerses([]) }}
          />
        )}

        {/* history drawer */}
        {showHistory && (
          <HistoryDrawer
            history={searchHistory}
            onOpen={openFromHistory}
            onClear={clearHistory}
            onClose={() => setShowHistory(false)}
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
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      <p className="sa-card-g">{toUnicode(verse.Gurmukhi)}</p>
      <footer className="sa-card-meta">
        {verse.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
        {verse.PageNo  && <span>Ang {verse.PageNo}</span>}
        {verse.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
      </footer>
    </article>
  )
}

/* ── ShabadPanel ─────────────────────────────────────────────── */
function ShabadPanel({ verse, shabadVerses, displayVerse, displaySettings, onSelectVerse, onUpdateSetting, onOpenDisplay, onClose }) {
  const preset    = BG_PRESETS[displaySettings.bg] || BG_PRESETS.dark
  const gText     = displayVerse ? renderGurmukhi(displayVerse.Gurmukhi, displaySettings.larivar) : ''
  const trans     = displayVerse && displaySettings.showTranslation ? getTranslation(displayVerse.Translations) : ''
  const activeRef = useRef(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [displayVerse?.ID])

  return (
    <aside className="sa-panel">

      {/* header */}
      <div className="sp-header">
        <div className="sp-meta">
          {verse?.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
          {verse?.Raag?.RaagEnglish     && <span>{verse.Raag.RaagEnglish}</span>}
          {verse?.PageNo                && <span>Ang {verse.PageNo}</span>}
        </div>
        <div className="sp-actions">
          <button className="sp-btn" onClick={onOpenDisplay} title="Open display tab">
            <IconExternalLink />
          </button>
          <button className="sp-btn" onClick={onClose} title="Close panel">
            <IconX />
          </button>
        </div>
      </div>

      {/* live preview */}
      <div
        className="sp-preview"
        style={{ background: preset.bg, color: preset.fg }}
      >
        {displayVerse ? (
          <>
            <p
              className="sp-preview-g"
              style={{ fontSize: Math.min(displaySettings.fontSize, 32), fontFamily: "'Noto Sans Gurmukhi', system-ui, sans-serif" }}
            >
              {gText}
            </p>
            {trans && (
              <p className="sp-preview-t" style={{ color: preset.sub }}>
                {trans}
              </p>
            )}
          </>
        ) : (
          <p className="sp-preview-empty" style={{ color: preset.sub }}>
            Select a verse below to preview
          </p>
        )}
      </div>

      {/* display controls */}
      <div className="sp-controls">
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Font size</span>
          <div className="sp-ctrl-group">
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.max(20, displaySettings.fontSize - 4))}>A−</button>
            <span className="sp-ctrl-val">{displaySettings.fontSize}px</span>
            <button className="sp-ctrl-btn" onClick={() => onUpdateSetting('fontSize', Math.min(160, displaySettings.fontSize + 4))}>A+</button>
          </div>
        </div>
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Options</span>
          <div className="sp-ctrl-group">
            <button
              className={`sp-ctrl-btn${displaySettings.showTranslation ? ' active' : ''}`}
              onClick={() => onUpdateSetting('showTranslation', !displaySettings.showTranslation)}
              title="Toggle English translation"
            >
              Translation
            </button>
            <button
              className={`sp-ctrl-btn${displaySettings.larivar ? ' active' : ''}`}
              onClick={() => onUpdateSetting('larivar', !displaySettings.larivar)}
              title="Larivar — connected text style"
            >
              Larivar
            </button>
          </div>
        </div>
        <div className="sp-ctrl-row">
          <span className="sp-ctrl-label">Background</span>
          <div className="sp-ctrl-group">
            {Object.entries(BG_PRESETS).map(([key, p]) => (
              <button
                key={key}
                className={`sp-bg-btn${displaySettings.bg === key ? ' active' : ''}`}
                style={{ background: p.bg, boxShadow: displaySettings.bg === key ? `0 0 0 2px ${p.fg}` : '0 0 0 1px rgba(255,255,255,0.12)' }}
                onClick={() => onUpdateSetting('bg', key)}
                title={p.label}
              />
            ))}
          </div>
        </div>
      </div>

      {/* verse list */}
      <div className="sp-verses">
        {shabadVerses.map((v, i) => {
          const isActive = displayVerse?.ID === v.ID
          return (
            <div
              key={v.ID}
              ref={isActive ? activeRef : null}
              className={`sp-verse${isActive ? ' active' : ''}`}
              onClick={() => onSelectVerse(v)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && onSelectVerse(v)}
            >
              <span className="sp-verse-num">{i + 1}</span>
              <div className="sp-verse-body">
                <p className="sp-verse-g">
                  {renderGurmukhi(v.Gurmukhi, displaySettings.larivar)}
                </p>
                {v.Writer?.WriterGurmukhi && (
                  <span className="sp-verse-writer">{v.Writer.WriterGurmukhi}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

/* ── HistoryDrawer ───────────────────────────────────────────── */
function HistoryDrawer({ history, onOpen, onClear, onClose }) {
  return (
    <aside className="sa-panel sa-history">
      <div className="sp-header">
        <span className="sp-title">Recent Searches</span>
        <div className="sp-actions">
          {history.length > 0 && (
            <button className="sp-btn sp-btn-danger" onClick={onClear} title="Clear all history">
              <IconTrash />
            </button>
          )}
          <button className="sp-btn" onClick={onClose} title="Close">
            <IconX />
          </button>
        </div>
      </div>

      <div className="sa-hist-list">
        {history.length === 0 && (
          <p className="sa-hist-empty">No history yet — click any search result to save it here.</p>
        )}
        {history.map(entry => (
          <button key={entry.id} className="sa-hist-item" onClick={() => onOpen(entry)}>
            <p className="sa-hist-g">{entry.gurmukhi}</p>
            <div className="sa-hist-meta">
              {entry.source && <span>{entry.source}</span>}
              {entry.page   && <span>Ang {entry.page}</span>}
              {entry.query  && <span className="sa-hist-query">"{entry.query}"</span>}
              <span className="sa-hist-time">{relTime(entry.timestamp)}</span>
            </div>
          </button>
        ))}
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
              <button key={ch} className="sa-kbd-key" onMouseDown={e => { e.preventDefault(); onChar(ch) }}>
                {ch}
              </button>
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
function IconMic() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8"  y1="23" x2="16" y2="23"/>
    </svg>
  )
}

function IconStop() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2"/>
    </svg>
  )
}

function IconSearch({ className }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6"  x2="6"  y2="18"/>
      <line x1="6"  y1="6"  x2="18" y2="18"/>
    </svg>
  )
}

function IconKeyboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="13" rx="2"/>
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>
    </svg>
  )
}

function IconHistory() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
      <polyline points="12 7 12 12 15 15"/>
    </svg>
  )
}

function IconExternalLink() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
      <polyline points="15 3 21 3 21 9"/>
      <line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  )
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  )
}
