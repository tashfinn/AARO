type ShareProduct = {
  id?: string
  sourceId?: string
  title?: string
  description?: string
  image?: string
  price?: number
  category?: string
}

type ShareTier = { quantity?: number; mode?: string; value?: number; discountKind?: string; freeDelivery?: boolean }
type ShareOffer = {
  id?: string
  title?: string
  kind?: string
  value?: number
  discountKind?: string
  quantity?: number
  freeQuantity?: number
  productId?: string
  productIds?: string[]
  thumbnailProductIds?: string[]
  tiers?: ShareTier[]
}

type ShareMetadata = { title: string; description: string; image: string; type: 'product' | 'website' }

const defaultMetadata: ShareMetadata = {
  title: 'AARO — Everyday, a little better',
  description: 'Discover thoughtfully selected fashion, home, beauty and everyday finds at AARO.',
  image: '/images/premium-earth-tone-apparel-display.jpg',
  type: 'website',
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character)
}

function absoluteImage(value: unknown, origin: string) {
  if (typeof value !== 'string' || !value.trim()) return new URL(defaultMetadata.image, origin).href
  try {
    const image = new URL(value, origin)
    return ['https:', 'http:'].includes(image.protocol) ? image.href : new URL(defaultMetadata.image, origin).href
  } catch {
    return new URL(defaultMetadata.image, origin).href
  }
}

function money(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? `৳${Math.round(amount).toLocaleString('en-BD')}` : ''
}

function offerText(offer: ShareOffer) {
  const tiers = Array.isArray(offer.tiers) ? [...offer.tiers].sort((a, b) => Number(a.quantity || 0) - Number(b.quantity || 0)) : []
  if (tiers.length) {
    return tiers.slice(0, 3).map((tier) => {
      const quantity = Number(tier.quantity) || 1
      if (tier.mode === 'price') return `Buy any ${quantity} for ${money(tier.value)}${tier.freeDelivery ? ' with free delivery' : ''}`
      if (tier.mode === 'discount') return `Buy any ${quantity}, save ${tier.discountKind === 'percent' ? `${tier.value}%` : money(tier.value)}${tier.freeDelivery ? ' with free delivery' : ''}`
      return `Buy any ${quantity} with free delivery`
    }).join(' · ')
  }
  if (offer.kind === 'quantity_discount' && Number(offer.quantity) === 1 && offer.discountKind === 'percent') return `${offer.value}% off each selected product`
  if (offer.kind === 'special_price') return `Special price ${money(offer.value)}`
  if (offer.kind === 'quantity_discount') return `Buy ${Number(offer.quantity) || 1}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}`
  if (offer.kind === 'buy_x_get_y_free') return `Buy ${Number(offer.quantity) || 1}, get ${Number(offer.freeQuantity) || 1} free`
  if (offer.kind === 'free_delivery') return 'Free delivery on your order'
  if (offer.kind === 'bundle') return `Bundle price ${money(offer.value)}`
  return 'Explore this special offer from AARO.'
}

async function apiJson<T>(base: string, path: string): Promise<T | null> {
  try {
    const response = await fetch(`${base}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500) })
    return response.ok ? await response.json() as T : null
  } catch {
    return null
  }
}

function fetchProductPreview(base: string, productId: string) {
  const publicId = productId.replace(/^shopbase-/, '')
  return apiJson<ShareProduct>(base, `/api/products/${encodeURIComponent(publicId)}`)
}

async function getMetadata(type: string, id: string, base: string): Promise<ShareMetadata | null> {
  if (type === 'product' && id) {
    const product = await apiJson<ShareProduct>(base, `/api/products/${encodeURIComponent(id)}`)
    if (!product?.title) return null
    const description = [product.category, product.description, product.price ? money(product.price) : ''].filter(Boolean).join(' · ')
    return { title: `${product.title} | AARO`, description: description.slice(0, 300) || 'Shop this find at AARO.', image: product.image || defaultMetadata.image, type: 'product' }
  }

  if ((type === 'offer' && id) || type === 'offers') {
    const offers = await apiJson<ShareOffer[]>(base, '/api/offers')
    const offer = type === 'offers' ? offers?.[0] : offers?.find((item) => item.id === id)
    if (!offer) return null
    const ids = offer.thumbnailProductIds?.length ? offer.thumbnailProductIds : (offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : [])
    const previewProducts = await Promise.all(ids.slice(0, 3).map((productId) => fetchProductPreview(base, productId)))
    const imageProduct = previewProducts[Math.min(1, previewProducts.length - 1)] || previewProducts[0]
    const productNames = previewProducts.map((product) => product?.title).filter(Boolean).slice(0, 2).join(' and ')
    const description = [offerText(offer), productNames].filter(Boolean).join(' · ')
    return { title: `${type === 'offers' ? 'Offers for you' : offer.title || 'Special offer'} | AARO`, description: description.slice(0, 300), image: imageProduct?.image || defaultMetadata.image, type: 'website' }
  }

  return null
}

function pageHtml(metadata: ShareMetadata, canonicalUrl: string) {
  const title = escapeHtml(metadata.title)
  const description = escapeHtml(metadata.description)
  const image = escapeHtml(absoluteImage(metadata.image, new URL(canonicalUrl).origin))
  const canonical = escapeHtml(canonicalUrl)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}"><meta property="og:type" content="${metadata.type}"><meta property="og:site_name" content="AARO"><meta property="og:url" content="${canonical}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${image}"><meta property="og:image:alt" content="${title}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${description}"><meta name="twitter:image" content="${image}"></head><body><main><h1>${title}</h1><p>${description}</p><a href="${canonical}">Open this page at AARO</a></main></body></html>`
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const origin = url.origin
  const apiBase = (process.env.AARO_API_URL || process.env.VITE_API_URL || '').replace(/\/$/, '')
  const metadata = apiBase ? await getMetadata(url.searchParams.get('type') || '', url.searchParams.get('id') || '', apiBase) : null
  const canonicalPath = url.searchParams.get('canonicalPath') || '/'
  let canonicalUrl = new URL('/', origin)
  try {
    const candidate = new URL(canonicalPath, origin)
    if (candidate.origin === origin && candidate.pathname.startsWith('/')) canonicalUrl = candidate
  } catch { /* Keep the share URL on this site's origin. */ }
  const response = new Response(pageHtml(metadata || defaultMetadata, canonicalUrl.href), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
    },
  })
  return response
}
