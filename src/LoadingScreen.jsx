import { useEffect, useState } from 'react'

const FACTS = [
  '36 Saints. 31 Ragas. One truth — gifted to every soul, without exception.',
  'Composed over 200 years, in 22 languages — Gurbani was always meant for all of humanity.',
  'Every Shabad is set to a Raga — the Guru knew truth reaches the heart deepest through music.',
  'The only scripture in the world compiled by its own Gurus during their own lifetimes.',
  'Hindu Bhagats, Muslim Sufis, Sikh Gurus — their voices joined as one in Sri Guru Granth Sahib Ji.',
  'Guru Nanak Dev Ji walked over 28,000 km across four Udaasis so no soul would be left without the Guru\'s word.',
  '5,894 Shabads — each a langar for the spirit, free and unconditional, open to all who seek.',
  'Wherever Gurbani is sung, there is no hunger, no division — only the one light.',
  'Guru Gobind Singh Ji declared Sri Guru Granth Sahib Ji the eternal living Guru in 1708 — the word itself became the Guru, forever.',
  'Bhagat Ravidas Ji, born into a caste society deemed untouchable, has 41 Shabads in Sri Guru Granth Sahib Ji — Gurbani saw no hierarchy.',
  'Sheikh Farid Ji, a 12th-century Muslim Sufi, has 134 verses in Sri Guru Granth Sahib Ji — the Guru\'s home never had walls.',
  'An Akhand Paath — an unbroken recitation of all of Sri Guru Granth Sahib Ji — takes 48 continuous hours to complete.',
  'Gurbani has been translated into dozens of languages — the Guru\'s light refuses to be held in one tongue.',
  'The Mul Mantar opens Gurbani with a portrait of the divine in just a few words — scholars have spent lifetimes within its depth.',
  'Harmandir Sahib has four entrances, facing all four directions — an architecture that mirrors Gurbani: open to all, from everywhere.',
  'Guru Nanak Dev Ji said: there is no Hindu, there is no Muslim — Gurbani was written for a humanity that had not yet caught up.',
  'Bhagat Kabir Ji — a Muslim weaver — has the most Shabads of any Bhagat in Sri Guru Granth Sahib Ji, with over 500 verses.',
  'Gurbani flows in Sanskrit, Arabic, Persian, Braj Bhasha, and Punjabi — it spoke every tongue of its age so no heart would feel foreign.',
]

/**
 * Props:
 *   dataReady — true once the OPFS file is confirmed complete (status === 'parsing')
 *   onReady(data) — called with the parsed JSON once loading is done
 */
export function LoadingScreen({ dataReady, onReady }) {
  const [factIndex] = useState(
    () => Math.floor(Math.random() * FACTS.length)
  )

  // Read + parse from OPFS as soon as the file is confirmed ready
  useEffect(() => {
    if (!dataReady) return

    let cancelled = false

    async function load() {
      const root   = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle('gurbani.min.json')
      const file   = await handle.getFile()
      const text   = await file.text()

      if (cancelled) return

      if (text.startsWith('version https://git-')) {
        // Stale LFS pointer cached — wipe and reload so it re-downloads the real file
        try { await root.removeEntry('gurbani.min.json') }      catch { /* ignore */ }
        try { await root.removeEntry('gurbani.min.json.done') } catch { /* ignore */ }
        window.location.reload()
        return
      }

      onReady(JSON.parse(text))
    }

    load().catch(err => console.error('[LoadingScreen] OPFS read failed:', err))
    return () => { cancelled = true }
  }, [dataReady, onReady])

  return (
    <div className="fullscreen-screen">
      <div className="screen-content">
        <img src="/icon.svg" className="screen-logo pulse" alt="" aria-hidden="true" />

        <h1 className="screen-title">Gurbani Search</h1>

        <div className="ls-bounce-row" role="status" aria-label="Loading">
          <span className="ls-bounce-dot" />
          <span className="ls-bounce-dot" />
          <span className="ls-bounce-dot" />
        </div>

        <p className="ls-label">Initializing search engine</p>

        {/* key re-mounts the element on each fact change, triggering the slide-in */}
        <p className="ls-sublabel ls-fact" key={factIndex}>{FACTS[factIndex]}</p>
      </div>
    </div>
  )
}
