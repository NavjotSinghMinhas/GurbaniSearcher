import { useState, useEffect, useRef, useCallback } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'
import './SearchApp.css'

const { toUnicode, toAscii, isGurmukhi } = gurmukhiUtils

// Chrome is the only browser with webkitSpeechRecognition
const CHROME = 'webkitSpeechRecognition' in window

const MODES = [
  { id: 'firstLetters', label: 'First Letters',  hint: 'Type the first letter of each word — e.g. snk or ਸਨਕ finds verses starting with those letters' },
  { id: 'word',         label: 'Whole Word',      hint: 'Type an exact Gurmukhi word in Gurmukhi script or transliteration — e.g. ਨਾਮੁ or nwmu' },
  { id: 'anywhere',    label: 'Anywhere',         hint: 'Find any verse containing this substring — type in Gurmukhi script or transliteration' },
  { id: 'english',     label: 'English',          hint: 'Search across all English translations' },
]

// If input is Unicode Gurmukhi, convert to ASCII encoding used in the data
function normalizeQuery(q) {
  return isGurmukhi(q) ? toAscii(q) : q
}

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
  const q = normalizeQuery(query.trim()).toLowerCase()
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
  const [showKeyboard, setShowKeyboard] = useState(false)

  const recognitionRef = useRef(null)
  const debounceRef    = useRef(null)
  const inputRef       = useRef(null)
  const tipTimerRef    = useRef(null)

  function insertChar(char) {
    const input = inputRef.current
    if (!input) { setQuery(q => q + char); return }
    const start = input.selectionStart ?? query.length
    const end   = input.selectionEnd   ?? query.length
    const next  = query.slice(0, start) + char + query.slice(end)
    setQuery(next)
    requestAnimationFrame(() => {
      input.focus()
      input.setSelectionRange(start + char.length, start + char.length)
    })
  }

  function deleteChar() {
    const input = inputRef.current
    if (!input) { setQuery(q => q.slice(0, -1)); return }
    const start = input.selectionStart ?? query.length
    const end   = input.selectionEnd   ?? query.length
    if (start !== end) {
      const next = query.slice(0, start) + query.slice(end)
      setQuery(next)
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start, start) })
    } else if (start > 0) {
      const next = query.slice(0, start - 1) + query.slice(start)
      setQuery(next)
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(start - 1, start - 1) })
    }
  }

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
            aria-label={showKeyboard ? 'Hide Gurmukhi keyboard' : 'Show Gurmukhi keyboard'}
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
      <p className="sa-card-g">{toUnicode(verse.Gurmukhi)}</p>
      {translation && <p className="sa-card-t">{translation}</p>}
      <footer className="sa-card-meta">
        {verse.Source?.SourceEnglish && <span>{verse.Source.SourceEnglish}</span>}
        {verse.PageNo  && <span>Ang {verse.PageNo}</span>}
        {verse.Writer?.WriterEnglish && <span>{verse.Writer.WriterEnglish}</span>}
      </footer>
    </article>
  )
}

/* ── gurmukhi keyboard ───────────────────────────────────── */

const KEYBOARD_LAYOUT = [
  {
    label: 'ਵਰਣਮਾਲਾ · Consonants',
    chars: ['ੳ','ਅ','ੲ','ਸ','ਹ','ਕ','ਖ','ਗ','ਘ','ਙ','ਚ','ਛ','ਜ','ਝ','ਞ','ਟ','ਠ','ਡ','ਢ','ਣ','ਤ','ਥ','ਦ','ਧ','ਨ','ਪ','ਫ','ਬ','ਭ','ਮ','ਯ','ਰ','ਲ','ਵ','ੜ','ਸ਼','ਖ਼','ਗ਼','ਜ਼','ਫ਼','ਲ਼'],
  },
  {
    label: 'ਲਗਾਂ · Vowel signs',
    chars: ['ਾ','ਿ','ੀ','ੁ','ੂ','ੇ','ੈ','ੋ','ੌ','ੰ','ੱ','ਂ'],
  },
  {
    label: 'ਖ਼ਾਸ · Special',
    chars: ['ੴ','ਃ'],
  },
]

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
        <button className="sa-kbd-space" onMouseDown={e => { e.preventDefault(); onSpace() }}>
          Space
        </button>
        <button className="sa-kbd-del" onMouseDown={e => { e.preventDefault(); onDelete() }}>
          ⌫
        </button>
      </div>
    </div>
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

function IconKeyboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="13" rx="2"/>
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M10 14h4"/>
    </svg>
  )
}
