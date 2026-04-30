import { useState, useEffect, useRef, useCallback } from 'react'
import './SearchApp.css'

// Chrome is the only browser with webkitSpeechRecognition
const CHROME = 'webkitSpeechRecognition' in window

const MODES = [
  { id: 'firstLetters', label: 'First Letters',  hint: 'Type the first letter of each word — e.g. asjs finds "Awid scu jugwid scu"' },
  { id: 'word',         label: 'Whole Word',      hint: 'Finds verses that contain this exact Gurmukhi word anywhere' },
  { id: 'anywhere',    label: 'Anywhere',         hint: 'Finds any verse whose Gurmukhi text contains this substring' },
  { id: 'english',     label: 'English',          hint: 'Search across all English translations' },
]

function getTranslation(translations) {
  if (!translations) return ''
  try {
    const t = JSON.parse(translations)
    const en = t?.en || {}
    return en.bdb || en.ms || Object.values(en)[0] || ''
  } catch { return '' }
}

function runSearch(verses, query, mode) {
  if (!query.trim()) return []
  const q = query.trim().toLowerCase()
  const results = []

  for (const v of verses) {
    let hit = false

    if (mode === 'firstLetters') {
      hit = (v.FirstLetterEng || '').toLowerCase().startsWith(q.replace(/\s+/g, ''))

    } else if (mode === 'word') {
      // Split on whitespace, strip common Gurmukhi punctuation, exact match
      hit = v.Gurmukhi.split(/\s+/).some(
        w => w.replace(/[\][\d|(){}]/g, '').toLowerCase() === q
      )

    } else if (mode === 'anywhere') {
      hit = v.Gurmukhi.toLowerCase().includes(q)

    } else { // english
      hit = (v.Translations || '').toLowerCase().includes(q)
    }

    if (hit) {
      results.push(v)
      if (results.length >= 50) break
    }
  }

  return results
}

export function SearchApp({ data }) {
  const verses = data?.Verse ?? []

  const [query,        setQuery]        = useState('')
  const [mode,         setMode]         = useState('firstLetters')
  const [results,      setResults]      = useState([])
  const [voiceActive,  setVoiceActive]  = useState(false)
  const [interim,      setInterim]      = useState('')
  const [online,       setOnline]       = useState(navigator.onLine)
  const [chromeTip,    setChromeTip]    = useState(false)

  const recognitionRef = useRef(null)
  const debounceRef    = useRef(null)
  const inputRef       = useRef(null)
  const tipTimerRef    = useRef(null)

  // ── online / offline ────────────────────────────────────────
  useEffect(() => {
    const up   = () => setOnline(true)
    const down = () => { setOnline(false); stopVoice() }
    window.addEventListener('online',  up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  // ── debounced search ─────────────────────────────────────────
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (!query.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(() => setResults(runSearch(verses, query, mode)), 280)
    return () => clearTimeout(debounceRef.current)
  }, [query, mode, verses])

  // ── voice ────────────────────────────────────────────────────
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
    R.continuous      = true
    R.interimResults  = true
    R.lang            = 'pa-IN'

    R.onresult = e => {
      let fin = '', tmp = ''
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript
        else tmp += e.results[i][0].transcript
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
          <span className={`sa-net-dot ${online ? 'up' : 'down'}`} />
          <span className="sa-net-label">{online ? 'Online' : 'Offline'}</span>

          <div className="sa-mic-wrap">
            <button
              className={`sa-mic-btn${voiceActive ? ' active' : ''}`}
              onClick={voiceActive ? stopVoice : startVoice}
              aria-label={voiceActive ? 'Stop voice search' : 'Start voice search'}
              title={voiceActive ? 'Stop' : 'Voice search'}
            >
              {voiceActive ? <IconStop /> : <IconMic />}
            </button>
            {chromeTip && (
              <div className="sa-chrome-tip" role="tooltip">
                Voice search is Chrome only for now
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── search controls ── */}
      <div className="sa-controls">
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

        {voiceActive && (
          <div className="sa-listening" aria-live="polite">
            <span className="sa-listen-dot" />
            Listening…
            <button className="sa-stop-voice" onClick={stopVoice}>Stop</button>
          </div>
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

      {/* ── results ── */}
      <div className="sa-results">
        {results.length === 0 && query.trim() && (
          <p className="sa-empty">No results — try a different spelling or mode</p>
        )}

        {results.map(v => <VerseCard key={v.ID} verse={v} query={query} mode={mode} />)}

        {results.length === 50 && (
          <p className="sa-cap">Showing first 50 results — refine your search to see more</p>
        )}
      </div>
    </div>
  )
}

/* ── verse card ──────────────────────────────────────────── */
function VerseCard({ verse }) {
  const translation = getTranslation(verse.Translations)

  return (
    <article className="sa-card">
      <p className="sa-card-g">{verse.Gurmukhi}</p>
      {translation && <p className="sa-card-t">{translation}</p>}
      <footer className="sa-card-meta">
        {verse.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
        {verse.PageNo  && <span>Ang {verse.PageNo}</span>}
        {verse.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
      </footer>
    </article>
  )
}

/* ── icons ───────────────────────────────────────────────── */
function IconMic() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}

function IconX() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6"  y1="6" x2="18" y2="18"/>
    </svg>
  )
}
