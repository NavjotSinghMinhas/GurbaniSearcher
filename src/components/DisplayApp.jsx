import { useState, useEffect, useRef } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'

const { toUnicode } = gurmukhiUtils

const CHANNEL_NAME = 'gurbani-display'
const SETTINGS_KEY = 'gurbani-disp-settings'

const DEFAULT_SETTINGS = {
  fontSize: 48, transSize: 20, showTranslation: true, showMeta: true, larivar: false, bg: 'dark', verseCount: 1, translationKey: 'auto',
}

export const BG_PRESETS = {
  dark:    { label: 'Dark',    bg: '#0e0c18', fg: '#ede8fc', sub: 'rgba(200,190,240,0.6)' },
  light:   { label: 'Light',   bg: '#f8f8f5', fg: '#1a1020', sub: 'rgba(30,10,50,0.6)'   },
  cream:   { label: 'Cream',   bg: '#f5edd6', fg: '#2a1a0a', sub: 'rgba(60,30,10,0.6)'   },
  saffron: { label: 'Saffron', bg: '#b84800', fg: '#ffffff', sub: 'rgba(255,255,255,0.82)' },
  navy:    { label: 'Navy',    bg: '#0a1628', fg: '#e8f4ff', sub: 'rgba(180,220,255,0.7)' },
}

const LANG_LABELS  = { en: 'English', pu: 'Punjabi', puu: 'Punjabi', pa: 'Punjabi', hi: 'Hindi', es: 'Spanish', fr: 'French' }
const TRANS_LABELS = { bdb: 'Bhai Manmohan Singh', ms: 'Manmohan Singh', ssk: 'Sant Singh Khalsa', ft: 'Faridkot Teeka', ss: 'Sahib Singh', sts: 'Sardar Tehal Singh', sn: 'Surjit Singh Nihal' }

export function getTranslation(translations, key = 'auto') {
  if (!translations) return ''
  try {
    const t = JSON.parse(translations)
    if (key && key !== 'auto') {
      const [lang, code] = key.split('.')
      return t?.[lang]?.[code] || ''
    }
    const en = t?.en || {}
    return en.bdb || en.ms || en.ssk || Object.values(en)[0] || ''
  } catch { return '' }
}

export function getTranslationOptions(translations) {
  if (!translations) return []
  try {
    const t = JSON.parse(translations)
    return Object.entries(t).flatMap(([lang, trans]) =>
      Object.entries(trans)
        .filter(([, text]) => {
          if (!text) return false
          // For Punjabi, skip ASCII-encoded entries — only keep Unicode Gurmukhi
          if (lang === 'pu' || lang === 'puu' || lang === 'pa') return /[਀-੿]/.test(text)
          return true
        })
        .map(([code]) => ({
          key: `${lang}.${code}`,
          label: `${LANG_LABELS[lang] || lang} · ${TRANS_LABELS[code] || code}`,
        }))
    )
  } catch { return [] }
}

export function renderGurmukhi(asciiText, larivar) {
  const u = toUnicode(asciiText)
  return larivar ? u.replace(/ /g, '') : u
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') } }
  catch { return { ...DEFAULT_SETTINGS } }
}

export function DisplayApp() {
  const [verses,       setVerses]       = useState([])
  const [settings,     setSettings]     = useState(loadSettings)
  const [voiceActive,  setVoiceActive]  = useState(false)
  const [showFs,       setShowFs]       = useState(true)
  const [fsPrompt,     setFsPrompt]     = useState(false)
  const channelRef = useRef(null)
  const hideTimerRef = useRef(null)

  useEffect(() => { document.title = 'Broadcast Screen' }, [])

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = ch
    ch.onmessage = e => {
      if (e.data.type === 'sync') {
        if (e.data.verses)      setVerses(e.data.verses)
        else if (e.data.verse)  setVerses([e.data.verse])
        if (e.data.settings) {
          setSettings(e.data.settings)
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(e.data.settings))
        }
        setVoiceActive(!!e.data.voiceActive)
      }
      if (e.data.type === 'clear') {
        setVerses([])
        setVoiceActive(false)
      }
      if (e.data.type === 'fullscreen') {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {})
        } else {
          setFsPrompt(true)
        }
      }
    }
    ch.postMessage({ type: 'ping' })
    return () => ch.close()
  }, [])

  function enterFullscreen() {
    document.documentElement.requestFullscreen().catch(() => {})
    setFsPrompt(false)
  }

  function toggleFs() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
    setFsPrompt(false)
  }

  /* auto-hide the fullscreen button after idle */
  function onMouseMove() {
    setShowFs(true)
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setShowFs(false), 3000)
  }

  const preset      = BG_PRESETS[settings.bg] || BG_PRESETS.dark
  const metaSize    = Math.max(11, Math.round((settings.transSize || 20) * 0.7))
  const firstVerse  = verses[0] ?? null

  return (
    <div
      className="disp-app"
      style={{ background: preset.bg, color: preset.fg }}
      onMouseMove={onMouseMove}
    >
      {/* fullscreen click-to-confirm prompt (browser requires user gesture) */}
      {fsPrompt && (
        <div className="disp-fs-prompt" onClick={enterFullscreen}>
          <span className="disp-fs-prompt-icon">⛶</span>
          <span>Click to go fullscreen</span>
        </div>
      )}

      {/* voice LIVE indicator */}
      {voiceActive && (
        <div className="disp-live" style={{ color: preset.sub }}>
          <span className="disp-live-dot" />
          LIVE
        </div>
      )}

      {/* fullscreen button — auto-hides */}
      <button
        className={`disp-fs-btn${showFs ? '' : ' hidden'}`}
        style={{ color: preset.sub }}
        onClick={toggleFs}
        title="Toggle fullscreen"
      >
        ⛶
      </button>

      <div className="disp-content">
        {verses.length === 0 ? (
          <div className="disp-waiting">
            <p className="disp-wait-gurmukhi" style={{ color: preset.fg }}>ਵਾਹਿਗੁਰੂ</p>
          </div>
        ) : (
          <div className="disp-verses">
            {verses.map((v, i) => {
              const gText = renderGurmukhi(v.Gurmukhi, settings.larivar)
              const trans = settings.showTranslation ? getTranslation(v.Translations, settings.translationKey) : ''
              return (
                <div key={v.ID} className={`disp-verse${i > 0 ? ' disp-verse-sep' : ''}`}>
                  <p
                    className="disp-gurmukhi"
                    style={{ fontSize: settings.fontSize, color: preset.fg, fontFamily: "'Noto Sans Gurmukhi', system-ui, sans-serif" }}
                  >
                    {gText}
                  </p>
                  {trans && (
                    <p className="disp-translation" style={{ fontSize: settings.transSize || 20, color: preset.sub }}>
                      {trans}
                    </p>
                  )}
                </div>
              )
            })}
            {settings.showMeta !== false && (
              <div className="disp-meta" style={{ fontSize: metaSize, color: preset.sub }}>
                {firstVerse?.Source?.SourceEnglish && <span>{firstVerse.Source.SourceEnglish}</span>}
                {firstVerse?.PageNo               && <span>Ang {firstVerse.PageNo}</span>}
                {firstVerse?.Writer?.WriterEnglish && <span>{firstVerse.Writer.WriterEnglish}</span>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
