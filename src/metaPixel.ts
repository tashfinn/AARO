type MetaPixelEventArgs = [string, ...unknown[]]
type MetaPixelFn = ((...args: MetaPixelEventArgs) => void) & {
  callMethod?: (...args: MetaPixelEventArgs) => void
  queue: MetaPixelEventArgs[]
  push?: MetaPixelFn
  loaded?: boolean
  version?: string
}

declare global {
  interface Window {
    fbq?: MetaPixelFn
    _fbq?: MetaPixelFn
  }
}

const pixelId = '1123980296909278'
let initialized = false

export function initMetaPixel() {
  if (!pixelId || typeof window === 'undefined' || initialized) return
  initialized = true

  const fbq = ((...args: MetaPixelEventArgs) => {
    if (fbq.callMethod) fbq.callMethod(...args)
    else fbq.queue.push(args)
  }) as MetaPixelFn

  fbq.queue = []
  fbq.push = fbq
  fbq.loaded = true
  fbq.version = '2.0'
  window.fbq = window._fbq = fbq

  const script = document.createElement('script')
  script.async = true
  script.src = 'https://connect.facebook.net/en_US/fbevents.js'
  document.head.appendChild(script)

  fbq('init', pixelId)
}

export function trackMetaEvent(event: string, parameters?: Record<string, string | number | string[]>) {
  if (!pixelId || typeof window === 'undefined') return
  initMetaPixel()
  window.fbq?.('track', event, ...(parameters ? [parameters] : []))
}
