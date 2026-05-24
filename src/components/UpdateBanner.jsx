import { useRegisterSW } from 'virtual:pwa-register/react'

export function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="update-banner" role="alert" aria-live="polite">
      <span>App updated — will apply on next restart</span>
      <div className="update-banner-actions">
        <button
          className="update-btn update-btn-primary"
          onClick={() => updateServiceWorker(true)}
        >
          Reload Now
        </button>
        <button
          className="update-btn update-btn-secondary"
          onClick={() => setNeedRefresh(false)}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
