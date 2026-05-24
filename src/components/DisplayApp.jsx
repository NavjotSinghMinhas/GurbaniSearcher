import { useState, useEffect, useRef } from 'react'
import gurmukhiUtils from 'gurmukhi-utils'

const { toUnicode } = gurmukhiUtils

const CHANNEL_NAME = 'gurbani-display'
const SETTINGS_KEY = 'gurbani-disp-settings'

const DEFAULT_SETTINGS = {
  fontSize: 48, transSize: 20, showTranslation: true, showMeta: true, larivar: false, bg: 'dark', verseCount: 1, translationKey: 'auto',
  customFg: null, customBg: null, customBgImage: null,
}

export const BG_PRESETS = {
  dark:    { label: 'Dark',    bg: '#0e0c18', fg: '#ede8fc', sub: 'rgba(200,190,240,0.6)' },
  light:   { label: 'Light',   bg: '#f8f8f5', fg: '#1a1020', sub: 'rgba(30,10,50,0.6)'   },
  cream:   { label: 'Cream',   bg: '#f5edd6', fg: '#2a1a0a', sub: 'rgba(60,30,10,0.6)'   },
  saffron: { label: 'Saffron', bg: '#b84800', fg: '#ffffff', sub: 'rgba(255,255,255,0.82)' },
  navy:    { label: 'Navy',    bg: '#0a1628', fg: '#e8f4ff', sub: 'rgba(180,220,255,0.7)' },
}

/* Resolve effective background/foreground for the current settings. Custom
   color overrides win over the preset; when a custom fg is set, derive `sub`
   at 60% alpha so meta text stays legible. When `bg === 'image'` and a stored
   image exists, the image is rendered on top of the bg color; otherwise the
   image is preserved but not displayed (so presets can deactivate it without
   losing the upload). */
export function effectivePreset(settings) {
  const imageMode = settings.bg === 'image' && settings.customBgImage
  if (imageMode) {
    const fg = settings.customFg || '#ffffff'
    const bg = settings.customBg || '#000000'
    const sub = hexToRgba(fg, 0.6)
    return { fg, bg, sub, bgImage: settings.customBgImage, label: 'Image' }
  }
  const base = BG_PRESETS[settings.bg] || BG_PRESETS.dark
  const fg = settings.customFg || base.fg
  const bg = settings.customBg || base.bg
  const sub = settings.customFg ? hexToRgba(settings.customFg, 0.6) : base.sub
  return { fg, bg, sub, bgImage: null, label: base.label }
}

function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#')) return hex
  const h = hex.slice(1)
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16)
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16)
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
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
  const [announcement, setAnnouncement] = useState(null)
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
      if (e.data.type === 'announcement') {
        setAnnouncement(e.data.visible && e.data.text ? e.data.text : null)
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

  const preset      = effectivePreset(settings)
  const metaSize    = Math.max(11, Math.round((settings.transSize || 20) * 0.7))
  const firstVerse  = verses[0] ?? null
  const appStyle    = preset.bgImage
    ? { backgroundColor: preset.bg, color: preset.fg, backgroundImage: `url(${preset.bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: preset.bg, color: preset.fg }

  return (
    <div
      className="disp-app"
      style={appStyle}
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

      {/* announcement overlay — drawn over the verse content with high contrast */}
      {announcement && (
        <div className="disp-announcement">
          <p className="disp-announcement-text">{announcement}</p>
        </div>
      )}

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
