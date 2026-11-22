import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleDollarSign, Clock3, Copy, Download, Eye, EyeOff,
  Heart, House, Image as ImageIcon, LayoutDashboard, LoaderCircle, Menu, Minus,
  Package, Pencil, Phone, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, UserRound,
  ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles, Tags, TicketPercent, Trash2,
  Truck, Upload, UsersRound, X, Moon, Sun, LogOut, Mail
} from 'lucide-react'
import { initialState } from './data'
import { initMetaPixel, trackMetaEvent } from './metaPixel'
import { manualCategoryGroups } from './data/category-groups'
import type { CategoryGroup, Coupon, DeliveryZone, OfferDeal, OfferTier, Order, OrderStatus, Product, StoreContent, StoreState } from './types'
import locationData from './data/bangladesh-locations.json'

const STORAGE_KEY = 'aaro-live-store-v1'
const WISHLIST_KEY = 'aaro-wishlist-v1'
const CART_KEY = 'aaro-cart-v1'
const USER_KEY = 'aaro-user-v1'
const THEME_KEY = 'aaro-theme-v1'
const AUTH_TOKEN_KEY = 'aaro-auth-token-v1'
const ADMIN_TOKEN_KEY = 'aaro-admin-token-v1'
const ADMIN_SESSION_TOKEN_KEY = 'aaro-admin-session-token-v1'
const CATEGORY_GROUPS_KEY = 'aaro-category-groups-v1'
const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/$/, '') || ''
type Address = { id: string; label?: string; recipient: string; phone: string; area: string; district?: string; thana?: string; address: string; comments?: string; isDefault?: boolean }
type BangladeshDistrict = { name: string; areas: { name: string; zone: DeliveryZone }[] }
type DeliverySavings = { minimum: number; maximum: number }
const bangladeshDistricts = locationData.districts as BangladeshDistrict[]
const getDeliveryZone = (district: string, thana: string): DeliveryZone => {
  const area = bangladeshDistricts.find((item) => item.name === district)?.areas.find((item) => item.name === thana)
  return area?.zone || 'outside'
}
type AccountProfile = { id: string; name: string; email: string; phone: string; addresses: Address[]; defaultAddressId?: string }
type StorePage = 'shop' | 'trending' | 'offers' | 'combos' | 'category' | 'wishlist' | 'account' | 'terms' | 'delivery' | 'contact'
type AdminTab = 'overview' | 'products' | 'categories' | 'offers' | 'orders' | 'content' | 'sync' | 'email'
type CartLine = { productId: string; quantity: number; size?: string; options?: Record<string, string>; productSnapshot?: Product }
function cartProductSnapshot(product: Product): Product {
  return {
    id: product.id, title: product.title, category: product.category, price: product.price,
    image: product.image, description: product.description || '', rating: product.rating || 0,
    reviews: product.reviews || 0, stock: product.stock || 0, active: product.active,
    updatedAt: product.updatedAt || '', source: product.source,
    ...(product.sizes?.length ? { sizes: [...product.sizes] } : {}),
    ...(product.sizeChart ? { sizeChart: product.sizeChart } : {}),
    ...(product.options?.length ? { options: product.options.map((option) => ({ name: option.name, values: [...option.values] })) } : {}),
  }
}

function cartLineKey(line: CartLine) {
  const options = Object.entries(line.options || {}).sort(([left], [right]) => left.localeCompare(right))
  return `${line.productId}\u0000${line.size || ''}\u0000${JSON.stringify(options)}`
}
function hasRequiredProductChoices(product: Product, line: Pick<CartLine, 'size' | 'options'>) {
  const sizeOption = product.options?.find((option) => /^size$/i.test(option.name))
  return (!(product.sizes?.length || sizeOption?.values.length) || Boolean(line.size || line.options?.[sizeOption?.name || 'Size'])) && (product.options || []).every((option) => /^size$/i.test(option.name) || !option.values.length || Boolean(line.options?.[option.name]))
}
function offerTierAllocations(offer: OfferDeal, quantity: number) {
  let remaining = quantity
  return [...(offer.tiers || [])].sort((a, b) => b.quantity - a.quantity).flatMap((tier) => {
    const groups = Math.floor(remaining / tier.quantity)
    remaining -= groups * tier.quantity
    return groups ? [{ tier, groups }] : []
  })
}
function consumeOfferUnits(lines: { quantity: number; product: Product }[], units: number, cheapestFirst = false) {
  let remaining = Math.max(0, units)
  const candidates = lines.map(({ quantity, product }) => ({ quantity, price: product.price }))
  if (cheapestFirst) candidates.sort((a, b) => a.price - b.price)
  let retail = 0
  for (const line of candidates) {
    const count = Math.min(remaining, line.quantity)
    retail += count * line.price
    remaining -= count
    if (!remaining) break
  }
  return retail
}
function offerTierSavings(offer: OfferDeal, lines: { quantity: number; product: Product }[]) {
  // Tier savings are calculated against the undiscounted unit price. Cart
  // products may already carry the one-item tier price for display.
  const candidates = lines.map(({ quantity, product }) => ({ quantity, price: regularProductPrice(product) }))
  const totalQuantity = candidates.reduce((sum, line) => sum + line.quantity, 0)
  let savings = 0
  for (const { tier, groups } of offerTierAllocations(offer, totalQuantity)) {
    let units = groups * tier.quantity
    let eligibleRetail = 0
    for (const line of candidates) {
      const count = Math.min(units, line.quantity)
      eligibleRetail += count * line.price
      line.quantity -= count
      units -= count
      if (!units) break
    }
    const tierSaving = tier.mode === 'price' ? Math.max(0, eligibleRetail - groups * tier.value) : tier.mode === 'none' ? 0 : tier.discountKind === 'percent' ? eligibleRetail * tier.value / 100 : groups * tier.value
    savings += Math.min(eligibleRetail, tierSaving)
  }
  return savings
}
function offerTierSummary(offer: OfferDeal, products: Product[] = []) {
  if (!offer.tiers?.length) return ''
  const prices = products.map((product) => product.price).filter((price) => Number.isFinite(price) && price > 0)
  const highestPrice = prices.length ? Math.max(...prices) : 0
  const pricesDiffer = prices.some((price) => price !== prices[0])
  return [...offer.tiers].sort((a, b) => a.quantity - b.quantity).map((tier) => {
    const saveAmount = tier.mode === 'price' && highestPrice ? Math.max(0, tier.quantity * highestPrice - tier.value) : 0
    const savingNote = saveAmount > 0 ? ` (save ${pricesDiffer ? 'up to ' : ''}${money(saveAmount)})` : ''
    return `${tier.mode === 'price' ? `Buy any ${tier.quantity} for ${money(tier.value)}${savingNote}` : tier.mode === 'none' ? `Buy any ${tier.quantity} · Free delivery` : `Buy any ${tier.quantity}, save ${tier.discountKind === 'percent' ? `${tier.value}%` : money(tier.value)}`}${tier.freeDelivery && tier.mode !== 'none' ? ' + free delivery' : ''}`
  }).join('\n')
}
function offerDealSummary(offer: OfferDeal, products: Product[] = []) {
  if (offer.kind === 'special_price') return `Special price ${money(offer.value)}`
  if (offer.kind === 'quantity_discount') return offer.quantity === 1 && offer.discountKind === 'percent' ? `${offer.value}% off each selected product` : `Buy ${offer.quantity}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}`
  if (offer.kind === 'buy_multiple') return offerTierSummary(offer, products) || `Buy ${offer.quantity}${['discount', 'both'].includes(offer.reward || 'discount') ? `, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}` : ''}${['free_delivery', 'both'].includes(offer.reward || '') ? ' + free delivery' : ''}`
  if (offer.kind === 'buy_x_get_y_free') return `Buy ${offer.quantity}, get ${offer.freeQuantity} free`
  if (offer.kind === 'bundle') return `Bundle price ${money(offer.value)}`
  return offer.value > 0 ? `Free delivery on orders over ${money(offer.value)}` : 'Free delivery on your order'
}
function applySingleItemOfferPrice(product: Product, offers: OfferDeal[]) {
  const eligibleOffers = offers.filter((offer) => offer.active && (offer.productIds?.length ? offer.productIds : [offer.productId]).includes(product.id))
  const prices = eligibleOffers.flatMap((offer) => {
    if (offer.kind === 'special_price') return [offer.value]
    if (offer.kind === 'quantity_discount' && offer.quantity === 1) return [offer.discountKind === 'percent' ? product.price * (1 - offer.value / 100) : product.price - offer.value]
    if (offer.kind === 'buy_multiple') return (offer.tiers || []).filter((tier) => tier.quantity === 1).map((tier) => tier.mode === 'price' ? tier.value : tier.mode === 'discount' ? tier.discountKind === 'percent' ? product.price * (1 - tier.value / 100) : product.price - tier.value : product.price)
    return []
  }).filter((price) => Number.isFinite(price) && price > 0 && price < product.price)
  if (!prices.length) return product
  const originalPrice = product.originalPrice ?? product.compareAt ?? product.price
  const price = Math.min(...prices)
  return { ...product, originalPrice, discountedPrice: price, compareAt: originalPrice, price }
}
function regularProductPrice(product: Product) {
  return Math.max(product.originalPrice ?? product.compareAt ?? product.price, product.price)
}
async function compressImageFile(file: File, maxWidth = 1400, maxHeight = 1000, quality = 0.78) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not prepare the image.')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/webp', quality)
}
async function compressSocialShareImage(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1200 / bitmap.width, 630 / bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not prepare the image.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.88)
}
function parseOptionLines(value: string): { name: string; values: string[] }[] {
  return value.split(/\r?\n/).map((line) => {
    const separator = line.indexOf(':')
    return separator > 0 ? { name: line.slice(0, separator).trim(), values: line.slice(separator + 1).split(',').map((item) => item.trim()).filter(Boolean) } : null
  }).filter((option): option is { name: string; values: string[] } => Boolean(option?.name && option.values.length))
}

function slideCategoryCarousel(carousel: HTMLDivElement, direction: -1 | 1) {
  const card = carousel.querySelector<HTMLElement>('.category-tile')
  if (!card) return
  const max = Math.max(0, carousel.scrollWidth - carousel.clientWidth)
  const from = carousel.scrollLeft
  const step = card.getBoundingClientRect().width + 15
  const to = Math.max(0, Math.min(max, from + direction * step))
  if (Math.abs(to - from) < 2) {
    if (direction > 0) carousel.scrollTo({ left: 0 })
    else carousel.scrollTo({ left: max })
    return
  }
  const start = performance.now()
  const duration = 500
  const animate = (now: number) => {
    const progress = Math.min(1, (now - start) / duration)
    const eased = 1 - Math.pow(1 - progress, 4)
    carousel.scrollLeft = from + (to - from) * eased
    if (progress < 1) requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)
}

function mergeCategoryGroups(saved: CategoryGroup[], live: CategoryGroup[]): CategoryGroup[] {
  if (!saved.length) return live.length ? live : manualCategoryGroups
  const normalize = (value: string) => value.normalize('NFKC').replace(/[\u200c\u200d]/g, '').replace(/[\s\u00a0\-–—_.,:;|]+/g, '').toLocaleLowerCase()
  return saved.map((group) => {
    const current = live.find((item) => item.id === group.id)
    if (!current) return group
    const children = group.children.map((child) => {
      const match = current.children.find((item) => child.sourceId && item.sourceId === child.sourceId)
        || current.children.find((item) => normalize(item.name) === normalize(child.name))
      return match ? { ...child, sourceId: child.sourceId || match.sourceId } : child
    })
    const known = new Set(children.map((child) => child.sourceId || normalize(child.name)))
    for (const child of current.children) {
      const key = child.sourceId || normalize(child.name)
      if (!known.has(key)) children.push(child)
    }
    return { ...group, children }
  })
}

function slugify(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'item' }
const categoryEnglishSlugs: Record<string, string> = {
  'বেসিক টি-শার্ট': 'basic-t-shirt', 'প্রিন্টেড টি-শার্ট': 'printed-t-shirt', 'পলো শার্ট': 'polo-shirt', 'সলিড হুডি': 'solid-hoodie', 'কন্ট্রাস্ট হুডি': 'contrast-hoodie', 'পাফার জ্যাকেট': 'puffer-jacket', 'ভার্সিটি জ্যাকেট': 'varsity-jacket', 'ডেনিম শার্ট': 'denim-shirt', 'ডেনিম জ্যাকেট': 'denim-jacket', 'ফুল স্লিভ টি-শার্ট': 'full-sleeve-t-shirt', 'প্রিন্ট শার্ট': 'printed-shirt', 'সলিড শার্ট': 'solid-shirt', 'চেক শার্ট': 'check-shirt', 'গাউন & কুর্তি': 'gown-and-kurti', 'রেডিমেড থ্রিপিস': 'ready-made-three-piece', 'আনস্টিচড থ্রিপিস': 'unstitched-three-piece', 'শাড়ি': 'saree', 'হিজাব & নিকাব': 'hijab-and-niqab', 'বোরকা': 'burqa', 'ছাতা': 'umbrellas', 'গ্যাজেটস': 'gadgets', 'ঘড়ি': 'watches', 'হেডফোন': 'headphones', 'ফ্যান': 'fans', 'পার্স ব্যাগ': 'purse-bags', 'মেয়েদের ব্যাগ': 'womens-bags', 'ছেলেদের ব্যাগ': 'mens-bags'
}
function categoryPathSlug(name: string, fallback = '') { return categoryEnglishSlugs[name] || (/^[\x00-\x7F]+$/.test(name) ? slugify(name) : fallback || `category-${Array.from(name).map((character) => (character.codePointAt(0) || 0).toString(36)).join('-')}`) }
function originalPriceOf(product: Product) { return product.originalPrice ?? product.compareAt ?? product.price }
function salePercentOf(product: Product) {
  const original = originalPriceOf(product)
  const selling = product.discountedPrice ?? product.price
  return original > selling && original > 0 ? Math.round(((original - selling) / original) * 100) : 0
}
function storePath(page: StorePage, category = 'All', groups: CategoryGroup[] = [], sourceId = '', parentId = '') {
  if (page === 'delivery') return '/delivery-returns'
  if (page === 'contact') return '/contact-us'
  if (page === 'terms') return '/terms'
  if (page === 'trending' || page === 'offers' || page === 'combos' || page === 'wishlist') return `/${page}`
  if (page !== 'category' || category === 'All') return '/'
  const parent = groups.find((group) => group.id === parentId) || groups.find((group) => group.children.some((item) => item.name === category && (!sourceId || item.sourceId === sourceId)))
  const childIndex = parent?.children.findIndex((item) => item.sourceId === sourceId && sourceId || item.name === category) ?? -1
  const child = parent && childIndex >= 0 ? parent.children[childIndex] : undefined
  return parent ? `/category/${slugify(parent.name)}${child ? `/${categoryPathSlug(child.name, child.sourceId ? `subcategory-${child.sourceId}` : `subcategory-${child.sortOrder ?? childIndex + 1}`)}` : ''}` : `/category/${categoryPathSlug(category)}`
}
function productPath(product: Product) {
  const key = product.source === 'shopbase' ? product.sourceId || product.id.replace(/^shopbase-/, '') : product.id
  return `/product/${slugify(product.title)}/${encodeURIComponent(key)}`
}

function productIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  if (parts[0] === 'product' && parts[2]) return decodeURIComponent(parts[2])
  if (parts[0] === 'product' && parts[1]) return decodeURIComponent(parts[1])
  // Keep older product links working while all newly generated links use clean slugs.
  if (parts[0] === 'category' && parts.length >= 5) return decodeURIComponent(parts[4])
  return parts[0] === 'products' && parts.length > 2 ? decodeURIComponent(parts[parts.length - 1]) : null
}
function initialStorePage(): StorePage {
  const path = window.location.pathname
  const first = path.split('/').filter(Boolean)[0] || ''
  if (first === 'account') return 'account'
  if (first === 'trending' || first === 'offers' || first === 'combos' || first === 'wishlist' || first === 'terms') return first
  if (first === 'category') return 'category'
  if (first === 'delivery-returns') return 'delivery'
  if (first === 'contact-us') return 'contact'
  return 'shop'
}

function readState(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...initialState }
    const saved = JSON.parse(raw) as Partial<StoreState>
    const savedContent = (saved.content && typeof saved.content === 'object' ? saved.content : {}) as Partial<StoreContent>
    const content = { ...initialState.content, ...savedContent } as StoreContent; content.heroSlides = Array.isArray(content.heroSlides) ? content.heroSlides.filter((slide) => slide && typeof slide.image === 'string' && typeof slide.title === 'string' && typeof slide.description === 'string' && typeof slide.cta === 'string' && typeof slide.link === 'string').map((slide) => ({ ...slide, mobileImage: typeof slide.mobileImage === 'string' ? slide.mobileImage : '' })) : initialState.content.heroSlides; if (!content.heroSlides.length) content.heroSlides = [initialState.content.heroSlides[0]]
    content.categoryImages = content.categoryImages && typeof content.categoryImages === 'object' ? content.categoryImages : {}
    for (const key of ['heroTitle', 'heroSubtitle', 'heroImage', 'heroCta', 'offerTitle', 'offerSubtitle', 'offerImage', 'announcement'] as const) {
      if (typeof content[key] !== 'string') content[key] = initialState.content[key]
    }
    content.trendingIds = Array.isArray(content.trendingIds) ? content.trendingIds.filter((id): id is string => typeof id === 'string') : []
    content.offerIds = Array.isArray(content.offerIds) ? content.offerIds.filter((id): id is string => typeof id === 'string') : []
    content.combos = Array.isArray(content.combos) ? content.combos.filter((combo) => combo && typeof combo.title === 'string' && typeof combo.subtitle === 'string' && typeof combo.image === 'string' && Number.isFinite(combo.price)) : []
    content.deliveryInDhaka = Number.isFinite(content.deliveryInDhaka) ? content.deliveryInDhaka : initialState.content.deliveryInDhaka
    content.deliverySubDhaka = Number.isFinite(content.deliverySubDhaka) ? content.deliverySubDhaka : initialState.content.deliverySubDhaka
    content.deliveryOutsideDhaka = Number.isFinite(content.deliveryOutsideDhaka) ? content.deliveryOutsideDhaka : initialState.content.deliveryOutsideDhaka
    if (content.heroImage.startsWith('https://images.unsplash.com/photo-1490481651871-ab68de25d43d')) content.heroImage = '/images/warm-boutique-clothing-display-v2.png'
    if (content.deliveryInDhaka === 60 && content.deliveryOutsideDhaka === 120 && !Number.isFinite(savedContent.deliverySubDhaka)) {
      content.deliveryInDhaka = 70
      content.deliverySubDhaka = 100
    }
    const products = Array.isArray(saved.products) ? saved.products.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && typeof item.description === 'string' && Number.isFinite(item.price)) : []
    const categories = Array.isArray(saved.categories) ? saved.categories.filter((item): item is string => typeof item === 'string') : [...initialState.categories]
    const coupons = Array.isArray(saved.coupons) ? saved.coupons.filter((item): item is Coupon => Boolean(item && typeof item.code === 'string' && (item.kind === 'percent' || item.kind === 'amount') && Number.isFinite(item.value) && typeof item.active === 'boolean')) : []
    const offers = Array.isArray(saved.offers) ? saved.offers.filter((item): item is OfferDeal => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.productId === 'string' && ['special_price', 'quantity_discount', 'buy_multiple', 'buy_x_get_y_free', 'bundle', 'free_delivery'].includes(item.kind) && Number.isFinite(item.value) && typeof item.active === 'boolean')) : []
    const orders = Array.isArray(saved.orders) ? saved.orders.filter((item): item is Order => Boolean(item && typeof item.id === 'string' && item.customer && typeof item.customer.phone === 'string' && Array.isArray(item.items) && Number.isFinite(item.total))) : []
    return { ...initialState, ...saved, products, categories: categories.length ? categories : [...initialState.categories], coupons, offers, orders, views: Number.isFinite(saved.views) ? Number(saved.views) : 0, content }
  } catch { return { ...initialState, content: { ...initialState.content }, products: [], categories: [...initialState.categories], coupons: [], offers: [], orders: [], views: 0 } }
}

function money(amount: number) { return `৳${Math.max(0, Math.round(amount)).toLocaleString('en-BD')}` }
function deliverySavingsText(deliverySavings: DeliverySavings) {
  return deliverySavings.minimum === deliverySavings.maximum
    ? `${money(deliverySavings.minimum)} saved`
    : `${money(deliverySavings.minimum)} to ${money(deliverySavings.maximum)} saved`
}
function dateLabel(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) }
function dateTimeLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unknown time' : new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' }).format(date) }
function durationLabel(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
function csvCell(value: unknown) { return `"${String(value ?? '').replace(/"/g, '""')}"` }
function syncErrorLabel(error: string) {
  if (/OTP|CAPTCHA|additional verification/i.test(error)) return 'ShopBase requires an interactive verification step. Hosted automatic sign-in cannot pass this by itself; save a fresh session cookie after signing in.'
  if (/hosted login is not configured|save the ShopBase phone number and password/i.test(error)) return 'The saved ShopBase cookie expired. Add your ShopBase login once in Hosted automatic sign-in, then retry.'
  if (/rejected the saved hosted login/i.test(error)) return 'ShopBase rejected the hosted login. Update the phone number or password in Product sync, then retry.'
  if (/ShopBase denied.*HTTP (401|403)|redirected to login|session secret was rejected/i.test(error)) return 'ShopBase rejected the saved session cookie. It has likely expired or been logged out; sign in to ShopBase again, copy a fresh cookie, save it, then retry.'
  if (/SHOPBASE_SESSION_COOKIE is missing/i.test(error)) return 'The ShopBase session cookie is not configured in GitHub Actions secrets. Save a fresh cookie from this page, then retry.'
  if (/GITHUB_ACTIONS_TOKEN|GitHub rejected/i.test(error)) return 'GitHub rejected the Actions token. Check that the Render API token has Actions read and write access for the sync repository.'
  if (/failed before the importer|without writing importer progress/i.test(error)) return 'GitHub Actions stopped before the catalog importer reported a result. This does not confirm a cookie problem; open the linked Actions run for the failing step.'
  if (/No categories found|category links matched|categories parsed|Zero product cards found/i.test(error)) return 'ShopBase did not provide the category or product list the importer expects. This does not confirm an expired cookie; the saved session may need attention, or ShopBase may have changed its catalog page. Open the linked Actions run for details. Existing products were left untouched.'
  return error
}
function shortDate(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short' }).format(new Date(value)) }
function readAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || sessionStorage.getItem(ADMIN_SESSION_TOKEN_KEY) || '' }
function parseCsvRows(input: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { cell += '"'; index += 1 }
      else if (character === '"') quoted = false
      else cell += character
    } else if (character === '"' && cell.length === 0) quoted = true
    else if (character === ',') { row.push(cell); cell = '' }
    else if (character === '\n') { row.push(cell.replace(/\r$/, '')); if (row.some((value) => value.trim())) rows.push(row); row = []; cell = '' }
    else cell += character
  }
  if (quoted) throw new Error('The CSV has an unfinished quoted field. Check the last row and save the file again.')
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); if (row.some((value) => value.trim())) rows.push(row) }
  return rows
}
function ImageView({ src, alt, className = '', loading = 'lazy' }: { src: string; alt: string; className?: string; loading?: 'lazy' | 'eager' }) {
  const [imageState, setImageState] = useState<'loading' | 'loaded' | 'failed'>(() => src ? 'loading' : 'failed')
  useEffect(() => { setImageState(src ? 'loading' : 'failed') }, [src])
  return <img src={src} alt={alt} loading={loading} decoding="async" fetchPriority={loading === 'eager' ? 'high' : 'low'} className={`image-view ${imageState === 'loading' ? 'image-view-loading' : ''} ${imageState === 'failed' ? 'image-view-failed' : ''} ${className}`} onLoad={() => setImageState('loaded')} onError={() => setImageState('failed')} />
}

function HeroCarouselPhoto({ src, mobileSrc, alt, loading, priority = false }: { src: string; mobileSrc: string; alt: string; loading: 'lazy' | 'eager'; priority?: boolean }) {
  return <div className="hero-photo-frame">
    <picture><source media="(max-width: 600px)" srcSet={mobileSrc || src} /><img src={src} alt={alt} loading={loading} fetchPriority={priority ? 'high' : 'low'} decoding="async" className="hero-carousel-photo" /></picture>
  </div>
}

function CategoryLoadingCards() {
  return <div className="category-loading-wrap" role="status" aria-label="Loading categories"><div className="loading-caption"><span className="loading-orbit" />Loading categories</div><div className="category-loading-grid">{[0,1,2,3].map((item) => <div className="category-loading-card" key={item}><span /><i /></div>)}</div></div>
}

function ProductLoadingSection({ title }: { title: string }) {
  return <section className="product-loading-section page-width" role="status" aria-label={title}><div className="product-loading-heading"><i /><b>{title}</b><span className="loading-caption"><span className="loading-orbit" />Loading products</span></div><div className="product-loading-grid">{[0,1,2,3].map((item) => <div className="product-loading-card" key={item}><span /><i /><i /><small /></div>)}</div></section>
}

function PriceSortMenu({ value, onChange }: { value: 'recommended' | 'low-high' | 'high-low'; onChange: (value: 'recommended' | 'low-high' | 'high-low') => void }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key) }
  }, [open])
  const options = [{ value: 'recommended' as const, label: 'Recommended' }, { value: 'low-high' as const, label: 'Price: low to high' }, { value: 'high-low' as const, label: 'Price: high to low' }]
  return <div className={`price-sort-menu ${open ? 'is-open' : ''}`} ref={menuRef}><span>SORT BY</span><button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((state) => !state)}>{options.find((option) => option.value === value)?.label}<ChevronDown size={16} /></button>{open && <div className="price-sort-options" role="listbox" aria-label="Sort products">{options.map((option) => <button type="button" role="option" aria-selected={value === option.value} className={value === option.value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false) }}>{option.label}{value === option.value && <Check size={15} />}</button>)}</div>}</div>
}

function OfferCollectionsLoading() {
  return <div className="offer-collection-grid offer-collection-loading" role="status" aria-label="Loading offer products">{[0, 1].map((item) => <div className="offer-collection-skeleton" key={item}><div className="offer-collection-skeleton-art"><span /></div><div className="offer-collection-skeleton-copy"><i /><b /><span /><span /><em /></div></div>)}</div>
}

function OfferCollectionImageStrip({ ids, products, title }: { ids: string[]; products: Product[]; title: string }) {
  if (!ids.length) return <div className="offer-collection-images"><div className="offer-collection-image-placeholder"><Tags size={22} /></div></div>
  return <div className="offer-collection-images">{ids.slice(0, 3).map((id, index) => {
    const product = products.find((item) => item.id === id)
    const positionClass = `offer-collection-image-${index + 1}`
    return product
      ? <ImageView key={id} className={`offer-collection-image ${positionClass}`} src={product.image} alt={`${title}: ${product.title}`} loading="eager" />
      : <div key={id} className={`offer-collection-image-placeholder ${positionClass}`} aria-label={`Loading ${title} thumbnail`}><span className="loading-orbit" /></div>
  })}</div>
}

function IconButton({ label, onClick, children, className = '' }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return <button type="button" aria-label={label} title={label} onClick={(event) => { event.stopPropagation(); onClick() }} className={`icon-button ${className}`}>{children}</button>
}

function StatusPill({ status }: { status: OrderStatus }) {
  const color = status === 'Delivered' ? 'status-green' : status === 'Cancelled' ? 'status-red' : status === 'Pending confirmation' ? 'status-amber' : status === 'Shipped' ? 'status-blue' : 'status-teal'
  return <span className={`status-pill ${color}`}><i />{status}</span>
}

export default function App() {
  const [state, setState] = useState<StoreState>(() => {
    const next = readState()
    next.views += 1
    return next
  })
  const [page, setPage] = useState<StorePage>(initialStorePage)
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(() => window.location.pathname.split('/').filter(Boolean)[0] === 'offers' ? decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '') || null : null)
  const [heroSlide, setHeroSlide] = useState(0)
  const [heroCarouselPaused, setHeroCarouselPaused] = useState(false)
  const heroTouchStartX = useRef<number | null>(null)
  const heroImages = state.content.heroSlides.map((slide) => slide.image)
  const activeHeroSlide = heroImages.length ? heroSlide % heroImages.length : 0
  useEffect(() => {
    setHeroSlide((current) => heroImages.length ? current % heroImages.length : 0)
  }, [heroImages.length])
  useEffect(() => {
    if (page !== 'shop' || heroCarouselPaused || heroImages.length < 2) return
    const timer = window.setTimeout(() => setHeroSlide((current) => (current + 1) % heroImages.length), 5000)
    return () => window.clearTimeout(timer)
  }, [page, heroCarouselPaused, heroSlide, heroImages.length])
  const moveHeroCarousel = (direction: -1 | 1) => {
    const count = heroImages.length
    if (count < 2) return
    setHeroSlide((current) => (current + direction + count) % count)
  }
  const heroSlides = state.content.heroSlides
  const [category, setCategory] = useState('All')
  const [selectedCategorySourceId, setSelectedCategorySourceId] = useState('')
  const [selectedParentCategoryId, setSelectedParentCategoryId] = useState('')
  const categoryCarouselRef = useRef<HTMLDivElement>(null)
  const homeCategoryRequestRef = useRef(false)
  const [homeCategoryPage, setHomeCategoryPage] = useState({ nextOffset: 0, hasMore: false, loading: false })
  const [dismissedHomeCategories, setDismissedHomeCategories] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem('aaro-dismissed-home-categories') || '[]') } catch { return [] } })
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null'); if (!Array.isArray(value)) return manualCategoryGroups; const valid = value.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))).map((group) => ({ ...group, children: group.children.filter((child) => child && typeof child.name === 'string' && (child.sourceId === undefined || typeof child.sourceId === 'string')) })); return valid.length ? valid : manualCategoryGroups } catch { return manualCategoryGroups } })
  const [manualCategories, setManualCategories] = useState<string[]>([])
  const [manualCategoryVisibility, setManualCategoryVisibility] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  const [prioritySearchProducts, setPrioritySearchProducts] = useState<Product[]>([])
  const [prioritySearchLoading, setPrioritySearchLoading] = useState(false)
  const [prioritySearchError, setPrioritySearchError] = useState('')
  const [searchPlaceholder, setSearchPlaceholder] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [activeCategoryMenuId, setActiveCategoryMenuId] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [cart, setCart] = useState<CartLine[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(CART_KEY) || '[]')
      if (!Array.isArray(value)) return []
      return value.filter((line): line is CartLine => Boolean(
        line && typeof line.productId === 'string' && Number.isFinite(line.quantity) && line.quantity > 0 &&
        (line.size === undefined || typeof line.size === 'string') &&
        (line.options === undefined || (typeof line.options === 'object' && line.options !== null && !Array.isArray(line.options) && Object.values(line.options).every((item) => typeof item === 'string')))
      )).map((line) => {
        const snapshot = line.productSnapshot as Product | undefined
        const validSnapshot = snapshot && typeof snapshot.id === 'string' && typeof snapshot.title === 'string' && typeof snapshot.category === 'string' && typeof snapshot.image === 'string' && Number.isFinite(snapshot.price)
        return { ...line, ...(validSnapshot ? { productSnapshot: snapshot } : { productSnapshot: undefined }) }
      })
    } catch { return [] }
  })
  const [cartOpen, setCartOpen] = useState(false)
  useEffect(() => {
    if (!cartOpen) return
    const body = document.body
    const root = document.documentElement
    const scrollY = window.scrollY
    const old = { bodyPosition: body.style.position, bodyTop: body.style.top, bodyLeft: body.style.left, bodyRight: body.style.right, bodyWidth: body.style.width, bodyOverflow: body.style.overflow, rootOverflow: root.style.overflow }
    root.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    return () => {
      body.style.position = old.bodyPosition
      body.style.top = old.bodyTop
      body.style.left = old.bodyLeft
      body.style.right = old.bodyRight
      body.style.width = old.bodyWidth
      body.style.overflow = old.bodyOverflow
      root.style.overflow = old.rootOverflow
      window.scrollTo(0, scrollY)
    }
  }, [cartOpen])
  const [checkout, setCheckout] = useState(() => window.location.pathname === '/checkout')
  const [selectedDistrict, setSelectedDistrict] = useState('')
  const [selectedThana, setSelectedThana] = useState('')
  const deliveryZone = getDeliveryZone(selectedDistrict, selectedThana)
  const [productRouteId, setProductRouteId] = useState<string | null>(productIdFromPath)
  const [routeProduct, setRouteProduct] = useState<Product | null>(null)
  const [routeProductLoading, setRouteProductLoading] = useState(() => Boolean(productIdFromPath()))
  const [routeProductError, setRouteProductError] = useState('')
  const productReturnState = useRef<{ page: StorePage; category: string; categorySourceId: string; parentCategoryId: string; submittedQuery: string; minPrice: number; maxPrice: number; priceSort: 'recommended' | 'low-high' | 'high-low'; scrollY: number } | null>(null)
  const selectedProduct = useMemo(() => state.products.find((product) => product.id === productRouteId || product.sourceId === productRouteId || slugify(product.title) === productRouteId) || (routeProduct && (routeProduct.id === productRouteId || routeProduct.sourceId === productRouteId) ? routeProduct : null), [productRouteId, routeProduct, state.products])
  const [wishlist, setWishlist] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] } catch { return [] } })
  const [user, setUser] = useState<string | null>(() => localStorage.getItem(USER_KEY))
  const [accountToken, setAccountToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY) || '')
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null)
  const [customerOrders, setCustomerOrders] = useState<Order[]>([])
  const [authRoute, setAuthRoute] = useState<'login' | 'register' | null>(() => !localStorage.getItem(AUTH_TOKEN_KEY) ? window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : null : null)
  const [adminRoute] = useState(() => window.location.pathname === '/admin')
  const [adminToken, setAdminToken] = useState(readAdminToken)
  const [adminSessionChecking, setAdminSessionChecking] = useState(() => window.location.pathname === '/admin' && Boolean(readAdminToken()) && Boolean(API_BASE))
  const [adminProductList, setAdminProductList] = useState<Product[]>([])
  const [adminProductsLoading, setAdminProductsLoading] = useState(false)
  const [adminProductsMoreLoading, setAdminProductsMoreLoading] = useState(false)
  const [adminProductsHasMore, setAdminProductsHasMore] = useState(false)
  const [adminProductsNextOffset, setAdminProductsNextOffset] = useState(0)
  const [adminProductsTotal, setAdminProductsTotal] = useState(0)
  const [adminProductsSearch, setAdminProductsSearch] = useState('')
  const [adminProductsSort, setAdminProductsSort] = useState('name-asc')
  const adminProductsRequestId = useRef(0)
  const [adminProductsError, setAdminProductsError] = useState('')
  const [adminImportedCount, setAdminImportedCount] = useState<number | null>(null)
  const [adminCategoryProductCounts, setAdminCategoryProductCounts] = useState<Record<string, number>>({})
  const [darkTheme, setDarkTheme] = useState(() => localStorage.getItem(THEME_KEY) === 'dark')
  const [toast, setToast] = useState('')
  const [admin, setAdmin] = useState(false)
  const [storeIsLive, setStoreIsLive] = useState(true)
  const [storeStatusBusy, setStoreStatusBusy] = useState(false)
  const [mediaMigrationBusy, setMediaMigrationBusy] = useState(false)
  const [mediaMigrationStatus, setMediaMigrationStatus] = useState<{ configured: boolean; cloudinaryImages: number; inlineImages: number } | null>(null)
  const [mediaMigrationMessage, setMediaMigrationMessage] = useState('')
  const [storeMenuOpen, setStoreMenuOpen] = useState(false)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null)
  const [productFormOpen, setProductFormOpen] = useState(false)
  const [categoryNameEditor, setCategoryNameEditor] = useState<{ groupId: string; childName?: string; value: string } | null>(null)
  const [categoryImageEditor, setCategoryImageEditor] = useState<{ name: string; value: string } | null>(null)
  const [contentDraft, setContentDraft] = useState<StoreContent>(() => state.content)
  const [previewSlide, setPreviewSlide] = useState(0)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [minPrice, setMinPrice] = useState(0)
  const [maxPrice, setMaxPrice] = useState(10000)
  const [priceSort, setPriceSort] = useState<'recommended' | 'low-high' | 'high-low'>('recommended')
  const [categoryNavigationSearch, setCategoryNavigationSearch] = useState('')
  const [categoryProductSearch, setCategoryProductSearch] = useState('')
  const currentCatalogListingKey = page === 'shop' && submittedQuery.trim() ? `search:${submittedQuery.trim().toLocaleLowerCase()}:${priceSort}` : page === 'category' ? `category:${selectedCategorySourceId}:${selectedParentCategoryId}:${category}:${priceSort}:${categoryProductSearch.trim().toLocaleLowerCase()}` : ''
  const [productsToShow, setProductsToShow] = useState(50)

  const [couponInput, setCouponInput] = useState('')
  const [coupon, setCoupon] = useState<Coupon | null>(null)
  const [orderFilter, setOrderFilter] = useState('All orders')
  const [orderSearch, setOrderSearch] = useState('')
  const [categoryInput, setCategoryInput] = useState('')
  const [couponFormOpen, setCouponFormOpen] = useState(false)
  const [offerFormOpen, setOfferFormOpen] = useState(false)
  const [editingOffer, setEditingOffer] = useState<OfferDeal | null>(null)
  const [lastSync, setLastSync] = useState(localStorage.getItem('aaro-last-import') || '')
  // Render the storefront from the local snapshot immediately; refresh the live catalog in the background.
  const [catalogLoading, setCatalogLoading] = useState(() => Boolean(import.meta.env.VITE_API_URL))
  const [offersLoading, setOffersLoading] = useState(() => Boolean(API_BASE))
  const [offersError, setOffersError] = useState('')
  const offersFetchedRef = useRef(false)
  const [offerProductPage, setOfferProductPage] = useState<{ offerId: string; products: Product[]; total: number; nextOffset: number; hasMore: boolean; loading: boolean; loadingMore: boolean; error: string }>({ offerId: '', products: [], total: 0, nextOffset: 0, hasMore: false, loading: false, loadingMore: false, error: '' })
  const offerProductsRequestId = useRef(0)
  const [listingProductIds, setListingProductIds] = useState<string[]>([])
  const [listingPage, setListingPage] = useState<{ key: string; total: number; nextOffset: number; hasMore: boolean; loadingMore: boolean; error: string }>({ key: '', total: 0, nextOffset: 0, hasMore: false, loadingMore: false, error: '' })
  const listingPageRequestId = useRef(0)
  const [catalogError, setCatalogError] = useState(false)
  const [productViewCounts, setProductViewCounts] = useState<Record<string, number>>({})
  const [catalogRefreshTick, setCatalogRefreshTick] = useState(0)
  const [priorityTrendingIds, setPriorityTrendingIds] = useState<string[]>([])
  const [trendingPage, setTrendingPage] = useState({ nextOffset: 20, hasMore: true, loadingMore: false, error: '' })
  const [priorityHomeCategoryNames, setPriorityHomeCategoryNames] = useState<string[]>([])
  const catalogMetadataLoaded = useRef(false)
  const backgroundCatalogStarted = useRef(false)
  const [importNote, setImportNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setContentDraft(state.content) }, [state.content])

  useEffect(() => {
    if (query || showSearch) { setSearchPlaceholder(''); return }
    setSearchPlaceholder('')
    const examples = ['hoodies', 'everyday shirts', 'new arrivals', 'something lovely']
    let word = 0
    let position = 0
    let deleting = false
    let timer = 0
    const tick = () => {
      const current = examples[word]
      position += deleting ? -1 : 1
      setSearchPlaceholder(current.slice(0, Math.max(0, position)))
      if (!deleting && position >= current.length) { deleting = true; timer = window.setTimeout(tick, 850); return }
      if (deleting && position <= 0) { deleting = false; word = (word + 1) % examples.length; timer = window.setTimeout(tick, 180); return }
      timer = window.setTimeout(tick, 78)
    }
    timer = window.setTimeout(tick, 350)
    return () => window.clearTimeout(timer)
  }, [query, showSearch])

  useEffect(() => {
    const needle = query.trim()
    if (!API_BASE || needle.length < 2 || needle.toLocaleLowerCase() === submittedQuery.trim().toLocaleLowerCase()) {
      setPrioritySearchProducts([])
      setPrioritySearchLoading(false)
      setPrioritySearchError('')
      return
    }
    setPrioritySearchLoading(true)
    setPrioritySearchError('')
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ kind: 'search', search: needle, limit: '6' })
      fetch(`${API_BASE}/api/catalog-priority?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`Search returned ${response.status}`)
          return response.json() as Promise<{ products?: unknown }>
        })
        .then((result) => {
          if (!Array.isArray(result.products)) throw new Error('The catalog returned an invalid search response.')
          const products = result.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const }))
          setPrioritySearchProducts(products)
          setPrioritySearchLoading(false)
          if (products.length) setState((current) => ({ ...current, products: [...new Map([...products, ...current.products].map((product) => [product.id, { ...current.products.find((existing) => existing.id === product.id), ...product }])).values()] }))
        })
        .catch((error) => { if (!(error instanceof DOMException && error.name === 'AbortError')) { setPrioritySearchLoading(false); setPrioritySearchError(error instanceof Error ? error.message : 'The product catalog could not be searched.') } })
    }, 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [query, submittedQuery])

  useEffect(() => {
    if (admin || adminRoute || page !== 'offers' || !API_BASE || offersFetchedRef.current && catalogRefreshTick === 0) return
    let current = true
    const controller = new AbortController()
    setOffersLoading(true)
    setOffersError('')
    fetch(`${API_BASE}/api/offers`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Offers returned ${response.status}`)
        return response.json() as Promise<unknown>
      })
      .then((offers) => {
        if (!current) return
        setState((state) => ({ ...state, offers: Array.isArray(offers) ? offers as OfferDeal[] : [] }))
        offersFetchedRef.current = true
      })
      .catch((error) => { if (current && !(error instanceof DOMException && error.name === 'AbortError')) { console.warn('Offer details could not be refreshed.', error); setOffersError(error instanceof Error ? error.message : 'Offers could not be loaded.') } })
      .finally(() => { if (current) setOffersLoading(false) })
    return () => { current = false; controller.abort() }
  }, [admin, adminRoute, page, catalogRefreshTick])

  useEffect(() => {
    if (!API_BASE) return
    fetch(`${API_BASE}/api/store-status`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<{ isLive?: unknown }> : null)
      .then((status) => { if (typeof status?.isLive === 'boolean') setStoreIsLive(status.isLive) })
      .catch(() => { /* Keep the storefront available if the status API is temporarily unreachable. */ })
  }, [])

  useEffect(() => {
    if (!API_BASE) return
    let current = true
    fetch(`${API_BASE}/api/storefront-hero`)
      .then((response) => response.ok ? response.json() as Promise<{ heroSlides?: unknown }> : null)
      .then((result) => {
        if (!current || !Array.isArray(result?.heroSlides)) return
        const slides = result.heroSlides.filter((slide): slide is StoreContent['heroSlides'][number] => Boolean(slide && typeof slide === 'object' && typeof (slide as StoreContent['heroSlides'][number]).image === 'string' && typeof (slide as StoreContent['heroSlides'][number]).title === 'string' && typeof (slide as StoreContent['heroSlides'][number]).description === 'string' && typeof (slide as StoreContent['heroSlides'][number]).cta === 'string' && typeof (slide as StoreContent['heroSlides'][number]).link === 'string')).map((slide) => ({ ...slide, image: slide.image.startsWith('/') ? `${API_BASE}${slide.image}` : slide.image, mobileImage: typeof slide.mobileImage === 'string' ? slide.mobileImage.startsWith('/') ? `${API_BASE}${slide.mobileImage}` : slide.mobileImage : '' }))
        if (slides.length) setState((state) => ({ ...state, content: { ...state.content, heroSlides: slides } }))
      })
      .catch(() => { /* Keep the saved local carousel if the live settings request fails. */ })
    return () => { current = false }
  }, [])

  async function toggleStoreStatus() {
    if (!API_BASE || !adminToken || storeStatusBusy) return
    setStoreStatusBusy(true)
    try {
      const response = await fetch(`${API_BASE}/api/admin/store-status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ isLive: !storeIsLive }),
      })
      const result = await response.json()
      if (!response.ok || typeof result.isLive !== 'boolean') throw new Error(result.detail || 'Store status could not be changed.')
      setStoreIsLive(result.isLive)
      notify(result.isLive ? 'Store is live.' : 'Store is closed to customers.')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Store status could not be changed.')
    } finally { setStoreStatusBusy(false) }
  }

  useEffect(() => {
    if (!mobileMenu) {
      setCategoryMenuOpen(false)
      setActiveCategoryMenuId('')
      return
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [mobileMenu])

  useEffect(() => {
    const localState = { ...state, products: state.products.filter((product) => product.source !== 'shopbase') }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(localState))
    } catch (error) {
      // Browser storage is only a small cache; large imported catalogs and
      // uploaded data URLs must not prevent the storefront from rendering.
      if (!(error instanceof DOMException) || !['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error.name)) return
      try {
        const compactState = { ...localState, products: localState.products.map((product) => ({ ...product, image: product.image.startsWith('data:') ? '' : product.image, images: product.images?.filter((image) => !image.startsWith('data:')) })) }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(compactState))
      } catch {
        try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage is unavailable; live API data remains usable. */ }
      }
    }
  }, [state])
  useEffect(() => { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)) }, [wishlist])
  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)) }, [cart])
  useEffect(() => {
    localStorage.setItem(THEME_KEY, darkTheme ? 'dark' : 'light')
    document.documentElement.classList.toggle('theme-dark', darkTheme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', darkTheme ? '#0A0B0D' : '#f4f6f1')
  }, [darkTheme])
  useEffect(() => { localStorage.setItem(CATEGORY_GROUPS_KEY, JSON.stringify(categoryGroups)) }, [categoryGroups])
  useEffect(() => {
    const syncRoute = () => {
      const path = window.location.pathname
      const parts = path.split('/').filter(Boolean)
      if (accountToken && (path === '/login' || path === '/register')) {
        history.replaceState({ aaroRoute: true }, '', '/account')
        setAuthRoute(null)
        setPage('account')
        setCheckout(false)
        return
      }
      setAuthRoute(path === '/login' ? 'login' : path === '/register' ? 'register' : null)
      setProductRouteId(productIdFromPath())
      setCheckout(path === '/checkout')
      if (parts[0] === 'offers') { setPage('offers'); setSelectedOfferId(parts[1] ? decodeURIComponent(parts[1]) : null); return }
      setSelectedOfferId(null)
      if (parts[0] === 'account') setPage('account')
      else if (parts[0] === 'delivery-returns') setPage('delivery')
      else if (parts[0] === 'contact-us') setPage('contact')
      else if (['trending', 'offers', 'combos', 'wishlist', 'terms'].includes(parts[0] || '')) setPage(parts[0] as StorePage)
      else if (parts[0] === 'category') {
        const parent = categoryGroups.find((group) => slugify(group.name) === parts[1])
        const child = parent?.children.find((item, index) => slugify(item.name) === parts[2] || categoryPathSlug(item.name, item.sourceId ? `subcategory-${item.sourceId}` : `subcategory-${item.sortOrder ?? index + 1}`) === parts[2])
        setPage('category')
        setSelectedParentCategoryId(parent?.id || '')
        setSelectedCategorySourceId(child?.sourceId || '')
        setCategory(child?.name || parent?.name || 'All')
      } else if (path !== '/admin' && !productIdFromPath() && path !== '/checkout' && path !== '/login' && path !== '/register') {
        setPage('shop')
        setCategory('All')
        setSelectedParentCategoryId('')
        setSelectedCategorySourceId('')
      }
    }
    syncRoute()
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [accountToken, categoryGroups])
  useEffect(() => {
    if (!accountToken || !API_BASE) { setAccountProfile(null); setCustomerOrders([]); return }
    const headers = { Authorization: `Bearer ${accountToken}` }
    Promise.all([fetch(`${API_BASE}/api/account`, { headers }), fetch(`${API_BASE}/api/orders`, { headers })])
      .then(async ([profileResponse, ordersResponse]) => {
        if (profileResponse.status === 401 || ordersResponse.status === 401) {
          const error = new Error('Account session expired.')
          error.name = 'AccountSessionExpired'
          throw error
        }
        if (!profileResponse.ok) throw new Error('Account details are temporarily unavailable.')
        const profile = await profileResponse.json() as AccountProfile
        setAccountProfile(profile)
        if (ordersResponse.ok) setCustomerOrders(await ordersResponse.json() as Order[])
        else notify('Your account is still signed in, but order history could not be refreshed.')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AccountSessionExpired') {
          setAccountToken(''); setUser(null); setAccountProfile(null); localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(USER_KEY)
          return
        }
        notify('Your account is still signed in, but account details could not be refreshed.')
      })
  }, [accountToken])
  useEffect(() => {
    if (!adminRoute || !adminToken || !API_BASE) { setAdminSessionChecking(false); return }
    let current = true
    setAdminSessionChecking(true)
    const headers = { Authorization: `Bearer ${adminToken}` }
    fetch(`${API_BASE}/api/admin/session`, { cache: 'no-store', headers })
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as { detail?: string }
        if (response.status === 401 || response.status === 403) {
          const error = new Error(result.detail || 'Admin session expired.')
          error.name = 'AdminSessionExpired'
          throw error
        }
        if (!response.ok) {
          if (current) { setAdmin(true); notify('Your admin session is kept active, but the server could not confirm it right now.') }
          return
        }
        if (current) setAdmin(true)
      })
      .catch((error: unknown) => {
        if (!current) return
        if (error instanceof Error && error.name === 'AdminSessionExpired') {
          localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY); setAdminToken(''); setAdmin(false)
          return
        }
        setAdmin(true)
        notify('Your admin session is kept active, but the server could not be reached to confirm it.')
      })
      .finally(() => { if (current) setAdminSessionChecking(false) })
    return () => { current = false }
  }, [adminRoute, adminToken])
  useEffect(() => {
    if (!admin || !adminToken || !API_BASE || !['offers', 'orders', 'sync', 'categories', 'content'].includes(adminTab)) return
    let current = true
    const headers: RequestInit = { cache: 'no-store', headers: { Authorization: `Bearer ${adminToken}` } }
    const jobs: Promise<void>[] = []
    if (adminTab === 'offers') jobs.push(fetch(`${API_BASE}/api/catalog-priority?kind=offers&limit=90`, { cache: 'no-store' }).then(async (response) => {
      const result = await response.json() as { products?: unknown }
      if (!current || !response.ok || !Array.isArray(result.products)) return
      const offerProducts = result.products.filter((item): item is Product => Boolean(item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && 'title' in item && typeof item.title === 'string' && 'category' in item && typeof item.category === 'string' && 'image' in item && typeof item.image === 'string' && 'price' in item && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const }))
      setState((previous) => ({ ...previous, products: [...new Map([...previous.products, ...offerProducts].map((product) => [product.id, product])).values()].sort((a, b) => a.title.localeCompare(b.title)) }))
    }))
    if (adminTab === 'offers') jobs.push(Promise.all([fetch(`${API_BASE}/api/admin/coupons`, headers), fetch(`${API_BASE}/api/admin/offers`, headers)]).then(async ([couponResponse, offerResponse]) => {
      const [coupons, offers] = await Promise.all([couponResponse.json(), offerResponse.json()]) as [unknown, unknown]
      if (!current) return
      setState((previous) => ({ ...previous, ...(couponResponse.ok && Array.isArray(coupons) ? { coupons: coupons as Coupon[] } : {}), ...(offerResponse.ok && Array.isArray(offers) ? { offers: offers as OfferDeal[] } : {}) }))
      if (!couponResponse.ok || !offerResponse.ok) notify('Offers or coupons could not be refreshed. Your session is still active.')
    }))
    if (adminTab === 'orders') jobs.push(fetch(`${API_BASE}/api/admin/orders`, headers).then(async (response) => {
      const orders: unknown = await response.json()
      if (!current) return
      if (response.ok && Array.isArray(orders)) setState((previous) => ({ ...previous, orders: orders as Order[] }))
      else notify('Orders could not be refreshed. Your session is still active.')
    }))
    if (adminTab === 'content') jobs.push(fetch(`${API_BASE}/api/admin/storefront`, headers).then(async (response) => {
      const result = await response.json() as { content?: unknown; categoryGroups?: unknown; manualCategories?: unknown; manualCategoryVisibility?: unknown }
      if (!current || !response.ok) return
      if (result.content && typeof result.content === 'object' && !Array.isArray(result.content)) setState((previous) => ({ ...previous, content: { ...previous.content, ...(result.content as Partial<StoreContent>) } }))
      if (Array.isArray(result.categoryGroups)) setCategoryGroups(result.categoryGroups.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))))
      if (Array.isArray(result.manualCategories)) setManualCategories(result.manualCategories.filter((name): name is string => typeof name === 'string'))
      if (result.manualCategoryVisibility && typeof result.manualCategoryVisibility === 'object' && !Array.isArray(result.manualCategoryVisibility)) setManualCategoryVisibility(Object.fromEntries(Object.entries(result.manualCategoryVisibility).filter((item): item is [string, boolean] => typeof item[1] === 'boolean')))
    }))
    if (adminTab === 'content') jobs.push(fetch(`${API_BASE}/api/admin/storefront-media/status`, headers).then(async (response) => {
      const result = await response.json() as { configured?: unknown; cloudinaryImages?: unknown; inlineImages?: unknown }
      if (current && response.ok && typeof result.configured === 'boolean' && Number.isFinite(result.cloudinaryImages) && Number.isFinite(result.inlineImages)) setMediaMigrationStatus({ configured: result.configured, cloudinaryImages: Number(result.cloudinaryImages), inlineImages: Number(result.inlineImages) })
    }))
    if (adminTab === 'sync' || adminTab === 'categories') jobs.push(fetch(`${API_BASE}/api/admin/catalog-summary`, headers).then(async (response) => {
      const result = await response.json() as { importedProducts?: unknown; categoryCounts?: unknown }
      if (current && response.ok && Number.isFinite(result.importedProducts) && adminTab === 'sync') setAdminImportedCount(Number(result.importedProducts))
      if (current && response.ok && result.categoryCounts && typeof result.categoryCounts === 'object' && !Array.isArray(result.categoryCounts)) setAdminCategoryProductCounts(Object.fromEntries(Object.entries(result.categoryCounts).filter((item): item is [string, number] => typeof item[1] === 'number' && Number.isFinite(item[1]))))
    }))
    Promise.all(jobs).catch(() => { if (current) notify('This admin section could not be reached. Your session is still active.') })
    return () => { current = false }
  }, [admin, adminTab, adminToken, catalogRefreshTick])
  async function loadAdminProductPage(offset: number, append: boolean, searchTerm = adminProductsSearch, sortTerm = 'name-asc') {
    if (!API_BASE || !adminToken || (append && adminProductsMoreLoading)) return
    const requestId = ++adminProductsRequestId.current
    setAdminProductsError('')
    if (append) setAdminProductsMoreLoading(true)
    else { setAdminProductsLoading(true); setAdminProductsMoreLoading(false); setAdminProductList([]); setAdminProductsTotal(0); setAdminProductsHasMore(false); setAdminProductsNextOffset(0) }
    try {
      const params = new URLSearchParams({ offset: String(offset), limit: '50' })
      if (searchTerm.trim()) params.set('search', searchTerm.trim())
      if (sortTerm !== 'name-asc') params.set('sort', sortTerm)
      const response = await fetch(`${API_BASE}/api/admin/products?${params.toString()}`, { cache: 'no-store', headers: { Authorization: `Bearer ${adminToken}` } })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not load the product catalog.')
      if (requestId !== adminProductsRequestId.current) return
      const page = Array.isArray(result) ? { products: result, hasMore: false, nextOffset: result.length, total: result.length } : result as { products?: unknown; hasMore?: boolean; nextOffset?: number; total?: number }
      const products = Array.isArray(page.products) ? page.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))) : []
      setAdminProductList((existing) => {
        const ids = new Set(append ? existing.map((product) => product.id) : [])
        return [...(append ? existing : []), ...products.filter((product) => !ids.has(product.id))]
      })
      setAdminProductsNextOffset(Number.isInteger(page.nextOffset) ? page.nextOffset! : offset + products.length)
      setAdminProductsHasMore(Boolean(page.hasMore))
      if (Number.isFinite(page.total)) setAdminProductsTotal(Number(page.total))
    } catch (error) { if (requestId === adminProductsRequestId.current) { const message = error instanceof Error ? error.message : 'Could not load the product catalog.'; setAdminProductsError(message); notify(message) } }
    finally { if (requestId === adminProductsRequestId.current) append ? setAdminProductsMoreLoading(false) : setAdminProductsLoading(false) }
  }
  async function loadMoreCatalogListing() {
    if (!API_BASE || !currentCatalogListingKey || listingPage.key !== currentCatalogListingKey || !listingPage.hasMore || listingPage.loadingMore) return
    const requestId = ++listingPageRequestId.current
    const offset = listingPage.nextOffset
    setListingPage((current) => ({ ...current, loadingMore: true, error: '' }))
    try {
      const params = new URLSearchParams({ kind: currentCatalogListingKey.startsWith('search:') ? 'search' : 'category', offset: String(offset), limit: currentCatalogListingKey.startsWith('search:') ? '12' : '50' })
      if (priceSort !== 'recommended') params.set('sort', priceSort)
      if (currentCatalogListingKey.startsWith('search:')) params.set('search', submittedQuery.trim())
      else if (selectedCategorySourceId) params.set('category_source_id', selectedCategorySourceId)
      else if (selectedParentCategoryId) params.set('parent_category_id', selectedParentCategoryId)
      else if (category !== 'All') params.set('category', category)
      if (!currentCatalogListingKey.startsWith('search:') && categoryProductSearch.trim()) params.set('search', categoryProductSearch.trim())
      const response = await fetch(`${API_BASE}/api/catalog-priority?${params.toString()}`, { cache: 'no-store' })
      const result = await response.json() as { products?: unknown; total?: number; hasMore?: boolean; nextOffset?: number; detail?: string }
      if (!response.ok) throw new Error(result.detail || 'The next group of products could not be loaded.')
      if (requestId !== listingPageRequestId.current) return
      const products = Array.isArray(result.products) ? result.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const })) : []
      setState((current) => {
        const byId = new Map(current.products.map((product) => [product.id, product]))
        for (const product of products) byId.set(product.id, { ...byId.get(product.id), ...product })
        return { ...current, products: [...byId.values()].sort((a, b) => a.title.localeCompare(b.title)) }
      })
      setListingProductIds((current) => [...current, ...products.map((product) => product.id).filter((id) => !current.includes(id))])
      const nextOffset = Number.isInteger(result.nextOffset) ? Number(result.nextOffset) : offset + products.length
      setListingPage((current) => ({ ...current, total: Number.isFinite(result.total) ? Number(result.total) : current.total, nextOffset, hasMore: Boolean(result.hasMore) && products.length > 0, loadingMore: false }))
      setProductsToShow((count) => count + products.length)
    } catch (error) {
      if (requestId === listingPageRequestId.current) setListingPage((current) => ({ ...current, loadingMore: false, error: error instanceof Error ? error.message : 'The next group of products could not be loaded.' }))
    }
  }
  async function loadMoreTrending() {
    if (!API_BASE || trendingPage.loadingMore || !trendingPage.hasMore) return
    setTrendingPage((current) => ({ ...current, loadingMore: true, error: '' }))
    try {
      const response = await fetch(`${API_BASE}/api/catalog-priority?kind=trending&offset=${trendingPage.nextOffset}&limit=20`, { cache: 'no-store' })
      const result = await response.json() as { products?: unknown; nextOffset?: number; hasMore?: boolean; detail?: string }
      if (!response.ok) throw new Error(result.detail || 'Could not load more trending products.')
      const products = Array.isArray(result.products) ? result.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))) : []
      setState((current) => {
        const byId = new Map(current.products.map((product) => [product.id, product]))
        for (const product of products) byId.set(product.id, { ...byId.get(product.id), ...product })
        return { ...current, products: [...byId.values()] }
      })
      setPriorityTrendingIds((current) => [...current, ...products.map((product) => product.id).filter((id) => !current.includes(id))])
      setTrendingPage({ nextOffset: Number.isInteger(result.nextOffset) ? Number(result.nextOffset) : trendingPage.nextOffset + products.length, hasMore: Boolean(result.hasMore) && products.length > 0, loadingMore: false, error: '' })
    } catch (error) {
      setTrendingPage((current) => ({ ...current, loadingMore: false, error: error instanceof Error ? error.message : 'Could not load more trending products.' }))
    }
  }
  async function loadOfferProductPage(offerId: string, offset = 0, append = false, sortTerm = priceSort) {
    if (!API_BASE || append && (offerProductPage.loadingMore || !offerProductPage.hasMore)) return
    const requestId = ++offerProductsRequestId.current
    setOfferProductPage((current) => append ? { ...current, loadingMore: true, error: '' } : { offerId, products: [], total: 0, nextOffset: 0, hasMore: false, loading: true, loadingMore: false, error: '' })
    try {
      const params = new URLSearchParams({ kind: 'offer', offer_id: offerId, offset: String(offset), limit: '50' })
      if (sortTerm !== 'recommended') params.set('sort', sortTerm)
      const response = await fetch(`${API_BASE}/api/catalog-priority?${params.toString()}`, { cache: 'no-store' })
      const result = await response.json() as { products?: unknown; total?: number; hasMore?: boolean; nextOffset?: number; detail?: string }
      if (!response.ok) throw new Error(result.detail || 'Offer products could not be loaded.')
      if (requestId !== offerProductsRequestId.current) return
      const products = Array.isArray(result.products) ? result.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const })) : []
      setState((current) => ({ ...current, products: [...new Map([...current.products, ...products].map((product) => [product.id, { ...current.products.find((existing) => existing.id === product.id), ...product }])).values()].sort((a, b) => a.title.localeCompare(b.title)) }))
      setOfferProductPage((current) => ({ offerId, products: append ? [...current.products, ...products.filter((product) => !current.products.some((existing) => existing.id === product.id))] : products, total: Number.isFinite(result.total) ? Number(result.total) : products.length, nextOffset: Number.isInteger(result.nextOffset) ? Number(result.nextOffset) : offset + products.length, hasMore: Boolean(result.hasMore), loading: false, loadingMore: false, error: '' }))
    } catch (error) {
      if (requestId === offerProductsRequestId.current) {
        const message = error instanceof Error ? error.message : 'Offer products could not be loaded.'
        setOfferProductPage((current) => ({ ...current, offerId, loading: false, loadingMore: false, error: message }))
        notify(message)
      }
    }
  }
  useEffect(() => {
    if (!admin || !adminToken || !API_BASE || adminTab !== 'products') return
    setAdminProductsLoading(true)
    setAdminProductList([])
    setAdminProductsHasMore(false)
    setAdminProductsNextOffset(0)
    setAdminProductsTotal(0)
    void loadAdminProductPage(0, false)
  }, [admin, adminTab, adminToken])
  useEffect(() => {
    if (adminRoute || admin) { setCatalogLoading(false); return }
    const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
    if (!apiUrl) {
      if (import.meta.env.PROD) {
        setCatalogError(true)
        setState((current) => ({ ...current, products: current.products.filter((product) => product.source === 'custom') }))
      }
      setCatalogLoading(false)
      return
    }
    let cancelled = false
    listingPageRequestId.current += 1
    const mergeProducts = (items: Product[]) => {
      if (!items.length) return
      setState((current) => {
        const byId = new Map(current.products.map((product) => [product.id, product]))
        for (const product of items) byId.set(product.id, { ...byId.get(product.id), ...product })
        const merged = [...byId.values()]
        return { ...current, products: merged.sort((a, b) => a.title.localeCompare(b.title)) }
      })
    }
    const parseProducts = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const })) : []
    setCatalogLoading(true)
    const loadCatalog = async () => {
      try {
        if (!catalogMetadataLoaded.current || catalogRefreshTick > 0) { void (async () => {
          const response = await fetch(`${apiUrl}/api/catalog-page?offset=0&limit=1&include_meta=true`)
          if (!response.ok) throw new Error(`Catalog metadata returned ${response.status}`)
          const catalog = await response.json() as { categories?: unknown; categoryGroups?: unknown; categoryGroupsManaged?: boolean; manualCategories?: unknown; manualCategoryVisibility?: unknown; manualCategoriesManaged?: boolean; content?: unknown; lastSync?: string; productViewCounts?: unknown }
          if (cancelled) return
          const catalogCategories = Array.isArray(catalog.categories) ? catalog.categories.filter((item): item is string => typeof item === 'string') : []
          const catalogGroups = Array.isArray(catalog.categoryGroups) ? catalog.categoryGroups.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))).map((group) => ({ ...group, children: group.children.filter((child) => child && typeof child.name === 'string') })) : []
          const categoryVisibility = catalog.manualCategoryVisibility && typeof catalog.manualCategoryVisibility === 'object' && !Array.isArray(catalog.manualCategoryVisibility) ? Object.fromEntries(Object.entries(catalog.manualCategoryVisibility).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')) : {}
          setManualCategoryVisibility(categoryVisibility)
          if (catalog.productViewCounts && typeof catalog.productViewCounts === 'object' && !Array.isArray(catalog.productViewCounts)) setProductViewCounts(Object.fromEntries(Object.entries(catalog.productViewCounts as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0)))
          const rawSavedGroups: unknown = JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null')
          const savedGroups = Array.isArray(rawSavedGroups) ? rawSavedGroups.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))) : []
          setCategoryGroups(catalog.categoryGroupsManaged ? catalogGroups : mergeCategoryGroups(savedGroups, catalogGroups))
          setState((current) => {
            const customCategories = current.categories.filter((item) => item !== 'All' && !initialState.categories.includes(item))
            const serverManualCategories = Array.isArray(catalog.manualCategories) ? catalog.manualCategories.filter((item): item is string => typeof item === 'string') : []
            const retainedManualCategories = catalog.manualCategoriesManaged ? serverManualCategories : customCategories
            const content = catalog.content && typeof catalog.content === 'object' && !Array.isArray(catalog.content) ? { ...current.content, ...(catalog.content as Partial<StoreState['content']>) } : current.content
            if (content.deliveryInDhaka === 60 && content.deliveryOutsideDhaka === 120 && !Number.isFinite((catalog.content as Partial<StoreState['content']> | undefined)?.deliverySubDhaka)) { content.deliveryInDhaka = 70; content.deliverySubDhaka = 100 }
            return { ...current, categories: [...new Set(['All', ...catalogCategories, ...retainedManualCategories])], content }
          })
          setManualCategories(catalog.manualCategoriesManaged && Array.isArray(catalog.manualCategories) ? catalog.manualCategories.filter((item): item is string => typeof item === 'string') : state.categories.filter((item) => item !== 'All' && !initialState.categories.includes(item) && !catalogCategories.includes(item)))
          if (typeof catalog.lastSync === 'string') { setLastSync(catalog.lastSync); localStorage.setItem('aaro-last-import', catalog.lastSync) }
          else { setLastSync(''); localStorage.removeItem('aaro-last-import') }
          catalogMetadataLoaded.current = true
        })().catch((error) => console.warn('Catalog metadata refresh failed.', error)) }

        const isSearch = page === 'shop' && Boolean(submittedQuery.trim())
        const kind = isSearch ? 'search' : page === 'shop' || page === 'combos' ? 'home' : page === 'trending' ? 'trending' : page === 'offers' ? selectedOfferId ? null : 'offers' : page === 'category' ? 'category' : null
        let targetedNextOffset = 0
        let targetedHasMore = false
        if (kind) {
          const params = new URLSearchParams({ kind, limit: kind === 'home' ? '50' : kind === 'trending' ? '20' : kind === 'offers' ? '90' : kind === 'search' ? '12' : '50' })
          if ((kind === 'category' || kind === 'search') && priceSort !== 'recommended') params.set('sort', priceSort)
          if (page === 'category') {
            if (selectedCategorySourceId) params.set('category_source_id', selectedCategorySourceId)
            else if (selectedParentCategoryId) params.set('parent_category_id', selectedParentCategoryId)
            else if (category !== 'All') params.set('category', category)
            if (categoryProductSearch.trim()) params.set('search', categoryProductSearch.trim())
          }
          if (isSearch) params.set('search', submittedQuery.trim())
          const response = await fetch(`${apiUrl}/api/catalog-priority?${params.toString()}`)
          if (!response.ok) throw new Error(`Priority product feed returned ${response.status}`)
          const feed = await response.json() as { products?: unknown; categoryProducts?: unknown; categoryHasMore?: boolean; nextCategoryOffset?: number; trendingIds?: unknown; hasMore?: boolean; nextOffset?: number; total?: number }
          if (cancelled) return
          const priorityProducts = parseProducts(feed.products)
          const homeCategoryProducts = kind === 'home' ? parseProducts(feed.categoryProducts) : []
          mergeProducts([...priorityProducts, ...homeCategoryProducts])
          if (kind === 'home') {
            if (homeCategoryProducts.length) setPriorityHomeCategoryNames((current) => [...new Set([...current, ...homeCategoryProducts.map((product) => product.category).filter(Boolean)])])
            setHomeCategoryPage((current) => current.nextOffset > 0 ? current : { nextOffset: Number.isInteger(feed.nextCategoryOffset) ? Number(feed.nextCategoryOffset) : 0, hasMore: Boolean(feed.categoryHasMore), loading: false })
          }
          if ((kind === 'home' || kind === 'trending') && Array.isArray(feed.trendingIds)) setPriorityTrendingIds(feed.trendingIds.filter((id): id is string => typeof id === 'string').slice(0, 20))
          if (kind === 'trending') setTrendingPage({ nextOffset: Number.isInteger(feed.nextOffset) ? Number(feed.nextOffset) : priorityProducts.length, hasMore: Boolean(feed.hasMore), loadingMore: false, error: '' })
          targetedNextOffset = Number.isInteger(feed.nextOffset) ? feed.nextOffset! : priorityProducts.length
          targetedHasMore = Boolean(feed.hasMore)
          if (kind === 'search' || kind === 'category') {
            setListingProductIds(priorityProducts.map((product) => product.id))
            setListingPage({ key: currentCatalogListingKey, total: Number.isFinite(feed.total) ? Number(feed.total) : priorityProducts.length, nextOffset: targetedNextOffset, hasMore: targetedHasMore, loadingMore: false, error: '' })
          }
        }
        if (!cancelled) { setCatalogError(false); setCatalogLoading(false) }
        if (kind === 'home' || kind === 'trending') {
          window.setTimeout(() => {
            if (backgroundCatalogStarted.current) return
            backgroundCatalogStarted.current = true
            void (async () => {
              let nextOffset = 0
              try {
                while (true) {
                  const response = await fetch(`${apiUrl}/api/catalog-page?offset=${nextOffset}&limit=400&include_meta=false`)
                  if (!response.ok) throw new Error(`Catalog page returned ${response.status}`)
                  const catalog = await response.json() as { products?: unknown; hasMore?: boolean; nextOffset?: number }
                  const pageProducts = parseProducts(catalog.products)
                  mergeProducts(pageProducts)
                  nextOffset = Number.isInteger(catalog.nextOffset) ? catalog.nextOffset! : nextOffset + pageProducts.length
                  if (!catalog.hasMore || !pageProducts.length) break
                }
              } catch (error) { console.warn('Background catalog loading paused.', error) }
            })()
          }, 900)
        }
      } catch (error) {
        console.warn('AARO live catalog API unavailable.', error)
        if (!cancelled) { setCatalogError(!(page === 'offers' && !selectedOfferId)); setCatalogLoading(false) }
      }
    }
    void loadCatalog()
    return () => { cancelled = true }
  }, [admin, adminRoute, catalogRefreshTick, page, category, selectedCategorySourceId, selectedParentCategoryId, submittedQuery, selectedOfferId, priceSort, categoryProductSearch])
  useEffect(() => {
    if (admin || adminRoute || page !== 'offers' || !selectedOfferId) {
      offerProductsRequestId.current += 1
      setOfferProductPage({ offerId: '', products: [], total: 0, nextOffset: 0, hasMore: false, loading: false, loadingMore: false, error: '' })
      return
    }
    if (offersLoading || !state.offers.some((offer) => offer.id === selectedOfferId && offer.active)) return
    void loadOfferProductPage(selectedOfferId)
    return () => { offerProductsRequestId.current += 1 }
  }, [admin, adminRoute, page, selectedOfferId, offersLoading, state.offers, catalogRefreshTick])
  useEffect(() => {
    let current = true
    setRouteProduct(null)
    setRouteProductError('')
    if (!productRouteId) { setRouteProductLoading(false); return () => { current = false } }
    const inMemory = state.products.some((product) => product.id === productRouteId || product.sourceId === productRouteId || slugify(product.title) === productRouteId)
    if (inMemory) { setRouteProductLoading(false); return () => { current = false } }
    const routeParts = window.location.pathname.split('/').filter(Boolean)
    const hasProductKey = routeParts[0] === 'product' ? routeParts.length >= 3 : routeParts[0] === 'category' ? routeParts.length >= 5 : routeParts[0] === 'products' && routeParts.length > 2
    if (!API_BASE || !hasProductKey) { setRouteProductLoading(false); return () => { current = false } }
    setRouteProductLoading(true)
    const lookupId = productRouteId.replace(/^shopbase-/, '')
    fetch(`${API_BASE}/api/products/${encodeURIComponent(lookupId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(result.detail || 'This product could not be found.')
        if (current) setRouteProduct(result as Product)
      })
      .catch((error) => { if (current) setRouteProductError(error instanceof Error ? error.message : 'This product could not be loaded.') })
      .finally(() => { if (current) setRouteProductLoading(false) })
    return () => { current = false }
  }, [productRouteId])
  useEffect(() => {
    if (admin || authRoute || window.location.pathname.startsWith('/admin')) return
    initMetaPixel()
    trackMetaEvent('PageView')
  }, [admin, authRoute, page, category, submittedQuery, productRouteId, checkout, selectedOfferId])
  useEffect(() => {
    if (!selectedProduct || !productRouteId || admin) return
    trackMetaEvent('ViewContent', {
      content_ids: [selectedProduct.sourceId || selectedProduct.id],
      content_type: 'product',
      content_name: selectedProduct.title,
      value: selectedProduct.price,
      currency: 'BDT',
    })
  }, [selectedProduct?.id, productRouteId, admin])
  useEffect(() => {
    if (!submittedQuery.trim() || admin) return
    trackMetaEvent('Search', { search_string: submittedQuery.trim() })
  }, [submittedQuery, admin])
  useEffect(() => {
    if (!checkout || admin) return
    trackMetaEvent('InitiateCheckout', {
      content_ids: cartItems.map((line) => line.product.sourceId || line.product.id),
      content_type: 'product',
      num_items: cartItems.reduce((total, line) => total + line.quantity, 0),
      value: subtotal,
      currency: 'BDT',
    })
  }, [checkout, admin])
  useEffect(() => {
    if (!selectedProduct || !API_BASE) return
    let current = true
    fetch(`${API_BASE}/api/products/${encodeURIComponent(selectedProduct.id)}/view`, { method: 'POST', keepalive: true })
      .then((response) => response.ok ? response.json() as Promise<{ productId: string; views: number }> : null)
      .then((result) => { if (current && result && Number.isFinite(result.views)) setProductViewCounts((counts) => ({ ...counts, [result.productId]: result.views })) })
      .catch(() => { /* Product browsing remains available if view counting is temporarily offline. */ })
    return () => { current = false }
  }, [selectedProduct?.id])
  useEffect(() => {
    if (!admin || adminTab !== 'overview' || !API_BASE) return
    let current = true
    fetch(`${API_BASE}/api/product-views`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<Record<string, unknown>> : null)
      .then((result) => { if (current && result) setProductViewCounts(Object.fromEntries(Object.entries(result).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0))) })
      .catch(() => { /* Keep the last shared counts during brief network issues. */ })
    return () => { current = false }
  }, [admin, adminTab])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])
  const activeProducts = useMemo(() => state.products.filter((product) => {
    if (!product.active) return false
    const matchesChild = (child: CategoryGroup['children'][number]) => product.categorySourceId ? child.sourceId === product.categorySourceId : child.name.toLocaleLowerCase() === product.category.toLocaleLowerCase()
    const matchingGroup = categoryGroups.find((group) => product.parentCategoryId ? group.id === product.parentCategoryId : group.children.some(matchesChild))
    const matchingChild = matchingGroup?.children.find(matchesChild)
    if (matchingGroup?.showInStorefront === false || matchingChild?.showInStorefront === false) return false
    const manualSetting = Object.entries(manualCategoryVisibility).find(([name]) => name.toLocaleLowerCase() === product.category.toLocaleLowerCase())
    return manualSetting?.[1] !== false
  }).map((product) => applySingleItemOfferPrice(product, state.offers)), [categoryGroups, manualCategoryVisibility, state.offers, state.products])
  const storefrontCategoryGroups = categoryGroups.filter((group) => group.showInStorefront !== false).map((group) => ({ ...group, children: group.children.filter((child) => child.showInStorefront !== false) }))
  const coupleGiftGroup = storefrontCategoryGroups.find((group) => group.id === 'couple-gifts')
  const coupleGiftSubcategories = coupleGiftGroup?.children.reduce<CategoryGroup['children']>((unique, child) => {
    const canonicalName = child.name.replace(/শাড়ী/g, 'শাড়ি').replace(/শাড়ি/g, 'শাড়ি')
    const existingIndex = unique.findIndex((item) => item.name.replace(/শাড়ী/g, 'শাড়ি').replace(/শাড়ি/g, 'শাড়ি') === canonicalName)
    if (existingIndex < 0) { unique.push(child); return unique }
    const existing = unique[existingIndex]
    const productCount = (item: CategoryGroup['children'][number]) => state.products.filter((product) => (item.sourceId && String(product.categorySourceId || '') === String(item.sourceId)) || ((!item.sourceId || !product.categorySourceId) && product.category.toLocaleLowerCase() === item.name.toLocaleLowerCase())).length
    if (productCount(child) > productCount(existing)) unique[existingIndex] = child
    return unique
  }, []) || []
  const storefrontCategoriesWithDuplicateCleanup = storefrontCategoryGroups.map((group) => group.id === 'couple-gifts' ? { ...group, children: coupleGiftSubcategories } : group)
  const categorySearchTerm = categoryNavigationSearch.trim().toLocaleLowerCase()
  const visibleCategoryGroups = categorySearchTerm ? storefrontCategoriesWithDuplicateCleanup.filter((group) => group.name.toLocaleLowerCase().includes(categorySearchTerm) || group.children.some((child) => child.name.toLocaleLowerCase().includes(categorySearchTerm))) : storefrontCategoriesWithDuplicateCleanup
  const visibleSubcategories = (visibleCategoryGroups.find((group) => group.id === selectedParentCategoryId)?.children || []).filter((child) => !categorySearchTerm || child.name.toLocaleLowerCase().includes(categorySearchTerm) || (visibleCategoryGroups.find((group) => group.id === selectedParentCategoryId)?.name || '').toLocaleLowerCase().includes(categorySearchTerm))
  const catalogMaxPrice = Math.max(1000, ...activeProducts.map((product) => product.price))
  useEffect(() => { setProductsToShow(50) }, [category, submittedQuery, page, minPrice, maxPrice, priceSort])
  const visibleProducts = useMemo(() => {
    const needle = submittedQuery.trim().toLowerCase()
    const parentChildren = selectedParentCategoryId ? categoryGroups.find((group) => group.id === selectedParentCategoryId)?.children || [] : []
    const parentChildIds = parentChildren.flatMap((child) => child.sourceId ? [child.sourceId] : [])
    const isServerPagedListing = Boolean(currentCatalogListingKey)
    let products = isServerPagedListing
      ? listingPage.key === currentCatalogListingKey ? listingProductIds.map((id) => activeProducts.find((product) => product.id === id)).filter((product): product is Product => Boolean(product)) : []
      : activeProducts
    if (page === 'trending') products = priorityTrendingIds.length ? priorityTrendingIds.map((id) => products.find((product) => product.id === id)).filter((product): product is Product => Boolean(product)) : products.filter((product) => product.trending).sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0)).slice(0, 20)
    if (page === 'offers') {
      const dealProductIds = new Set(state.offers.filter((offer) => offer.active).flatMap((offer) => offer.productIds?.length ? offer.productIds : [offer.productId]))
      const featured = products.filter((product) => state.content.offerIds.includes(product.id) || product.offer || dealProductIds.has(product.id))
      products = featured.length ? featured : products.filter((product) => product.compareAt && product.compareAt > product.price)
    }
    if (page === 'wishlist') products = products.filter((product) => wishlist.includes(product.id))
    if (page === 'category' && category !== 'All') {
      const parent = categoryGroups.find((group) => group.id === selectedParentCategoryId)
      const selectedChild = parentChildren.find((child) => (selectedCategorySourceId && child.sourceId === selectedCategorySourceId) || child.name === category)
      if (selectedCategorySourceId) {
        products = products.filter((product) => String(product.categorySourceId || '') === String(selectedCategorySourceId))
      } else if (parent && selectedChild) {
        products = products.filter((product) => (product.category === selectedChild.name && (!product.parentCategoryId || product.parentCategoryId === parent.id)) || Boolean(selectedChild.sourceId && String(product.categorySourceId || '') === String(selectedChild.sourceId)))
      } else if (parent) {
        products = products.filter((product) => parentChildIds.includes(String(product.categorySourceId || '')) || parentChildren.some((child) => child.name === product.category))
      } else {
        products = products.filter((product) => product.category === category)
      }
    }
    if (needle && !isServerPagedListing) products = products.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle))
    if (page === 'category') products = products.filter((product) => product.price >= minPrice && product.price <= maxPrice)
    if (!isServerPagedListing && priceSort === 'low-high') products = [...products].sort((a, b) => a.price - b.price)
    else if (!isServerPagedListing && priceSort === 'high-low') products = [...products].sort((a, b) => b.price - a.price)
    else if (page !== 'trending' && !isServerPagedListing) products = [...products].sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0))
    return products
  }, [activeProducts, currentCatalogListingKey, listingPage.key, listingProductIds, category, categoryGroups, maxPrice, minPrice, page, priceSort, priorityTrendingIds, productViewCounts, selectedCategorySourceId, selectedParentCategoryId, submittedQuery, state.content.offerIds, state.content.trendingIds, state.offers, wishlist])
  const searchSuggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    // Offer products should remain discoverable even when their category is
    // hidden from the general storefront category navigation.
    const offerProductIds = new Set(state.offers.filter((offer) => offer.active).flatMap((offer) => offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : []))
    const productsById = new Map(activeProducts.map((product) => [product.id, product]))
    prioritySearchProducts.forEach((product) => { if (product.active) productsById.set(product.id, applySingleItemOfferPrice(product, state.offers)) })
    state.products.filter((product) => product.active && offerProductIds.has(product.id)).forEach((product) => {
      if (!productsById.has(product.id)) productsById.set(product.id, applySingleItemOfferPrice(product, state.offers))
    })
    const priority = new Map(prioritySearchProducts.map((product, index) => [product.id, index]))
    return [...productsById.values()].filter((product) => `${product.title} ${product.category} ${product.description} ${product.sourceId || ''} ${product.id}`.toLowerCase().includes(needle) || Boolean(product.sourceId && product.sourceId.toLowerCase().replace(/^shopbase-/, '').includes(needle.replace(/^shopbase-/, '')))).sort((a, b) => (priority.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b.id) ?? Number.MAX_SAFE_INTEGER)).slice(0, 5)
  }, [activeProducts, prioritySearchProducts, query, state.offers, state.products])
  const cartItems = useMemo(() => cart.map((line) => {
    const product = activeProducts.find((item) => item.id === line.productId) || line.productSnapshot
    return { ...line, product: product ? applySingleItemOfferPrice(product, state.offers) : undefined }
  }).filter((line): line is CartLine & { product: Product } => Boolean(line.product)), [activeProducts, cart, state.offers])
  const singleItemOfferSavings = (line: CartLine & { product: Product }) => {
    const offers = state.offers.filter((offer) => offer.active && (offer.productIds?.length ? offer.productIds : [offer.productId]).includes(line.productId))
    const hasSingleItemOffer = offers.some((offer) => offer.kind === 'special_price' || offer.kind === 'quantity_discount' && offer.quantity === 1 || offer.kind === 'buy_multiple' && offer.tiers?.some((tier) => tier.quantity === 1))
    return hasSingleItemOffer ? Math.max(0, regularProductPrice(line.product) - line.product.price) * line.quantity : 0
  }
  const singleItemSavingsTotal = cartItems.reduce((sum, line) => sum + singleItemOfferSavings(line), 0)
  const subtotal = cartItems.reduce((sum, line) => sum + line.product.price * line.quantity, 0) + singleItemSavingsTotal
  const offerSavings = state.offers.filter((offer) => offer.active && offer.kind !== 'bundle' && offer.kind !== 'free_delivery').reduce((sum, offer) => {
    const targetIds = [...new Set(offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : [])]
    const eligibleLines = cartItems.filter((line) => targetIds.includes(line.productId))
    const quantity = eligibleLines.reduce((total, line) => total + line.quantity, 0)
    if (!quantity) return sum
    if (offer.kind === 'buy_multiple' && offer.tiers?.length) return sum + offerTierSavings(offer, eligibleLines)
    if (offer.kind === 'special_price' || offer.kind === 'quantity_discount' && offer.quantity === 1) return sum + eligibleLines.reduce((saving, line) => saving + singleItemOfferSavings(line), 0)
    if (offer.kind === 'quantity_discount' || offer.kind === 'buy_multiple') {
      const groups = Math.floor(quantity / Math.max(1, offer.quantity))
      const eligibleQuantity = groups * Math.max(1, offer.quantity)
      if (!eligibleQuantity || offer.kind === 'buy_multiple' && !['discount', 'both'].includes(offer.reward || 'discount')) return sum
      const eligibleRetail = consumeOfferUnits(eligibleLines, eligibleQuantity)
      const saving = offer.discountKind === 'percent' ? eligibleRetail * offer.value / 100 : groups * offer.value
      return sum + Math.min(eligibleRetail, saving)
    }
    const freeCount = Math.floor(quantity / (Math.max(1, offer.quantity) + Math.max(1, offer.freeQuantity))) * Math.max(1, offer.freeQuantity)
    return sum + consumeOfferUnits(eligibleLines, freeCount, true)
  }, 0)
  const bundleSavings = state.offers.filter((offer) => offer.active && offer.kind === 'bundle').reduce((sum, offer) => {
    const ids = [...new Set(offer.productIds || [])]
    if (ids.length < 2) return sum
    const bundleCount = Math.min(...ids.map((id) => Math.floor(cart.filter((line) => line.productId === id).reduce((quantity, line) => quantity + line.quantity, 0) / Math.max(1, offer.quantity))))
    if (!bundleCount) return sum
    const bundleRetail = ids.reduce((total, id) => total + (state.products.find((product) => product.id === id)?.price || 0), 0)
    return sum + Math.max(0, bundleRetail - offer.value) * bundleCount
  }, 0)
  const couponDiscount = coupon && coupon.active && subtotal >= (coupon.minimum || 0) ? Math.min(subtotal, coupon.kind === 'percent' ? subtotal * coupon.value / 100 : coupon.value) : 0
  // Keep the breakdown in the same order as order validation: product offers,
  // bundles, then coupon. This prevents one source from claiming savings that
  // already exceed the remaining subtotal.
  const appliedOfferSavings = Math.min(subtotal, offerSavings)
  const appliedBundleSavings = Math.min(Math.max(0, subtotal - appliedOfferSavings), bundleSavings)
  const appliedCouponSavings = Math.min(Math.max(0, subtotal - appliedOfferSavings - appliedBundleSavings), couponDiscount)
  const discount = appliedOfferSavings + appliedBundleSavings + appliedCouponSavings
  const hasDeliveryLocation = Boolean(selectedDistrict && selectedThana)
  const selectedDeliveryFee = !hasDeliveryLocation ? state.content.deliveryInDhaka : deliveryZone === 'city' ? state.content.deliveryInDhaka : deliveryZone === 'sub_dhaka' ? state.content.deliverySubDhaka : state.content.deliveryOutsideDhaka
  const freeDeliveryApplied = state.offers.some((offer) => {
    if (!offer.active) return false
    if (offer.kind === 'free_delivery') return subtotal >= offer.value
    if (offer.kind !== 'buy_multiple') return false
    const targetIds = [...new Set(offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : [])]
    const quantity = cart.filter((line) => targetIds.includes(line.productId)).reduce((total, line) => total + line.quantity, 0)
    return offer.tiers?.length ? offerTierAllocations(offer, quantity).some(({ tier }) => tier.freeDelivery) : ['free_delivery', 'both'].includes(offer.reward || '') && quantity >= Math.max(1, offer.quantity)
  })
  const deliveryFee = freeDeliveryApplied ? 0 : selectedDeliveryFee
  const deliverySavings: DeliverySavings | null = freeDeliveryApplied ? selectedDistrict && selectedThana
    ? { minimum: selectedDeliveryFee, maximum: selectedDeliveryFee }
    : { minimum: Math.min(state.content.deliveryInDhaka, state.content.deliverySubDhaka, state.content.deliveryOutsideDhaka), maximum: Math.max(state.content.deliveryInDhaka, state.content.deliverySubDhaka, state.content.deliveryOutsideDhaka) }
    : null
  const revenue = state.orders.filter((order) => !['Cancelled', 'Pending confirmation'].includes(order.status)).reduce((sum, order) => sum + order.total, 0)
  const customerCount = new Set(state.orders.map((order) => order.customer.phone)).size

  function notify(message: string) { setToast(message) }
  function updateState(updater: (current: StoreState) => StoreState) { setState((current) => updater(current)) }
  function showStore(pageToShow: StorePage, nextCategory = 'All', sourceCategoryId = '', parentCategoryId = '') {
    setAdmin(false); setAuthRoute(null); setCheckout(false); setActiveCategoryMenuId(''); setPage(pageToShow); setSelectedOfferId(null); setCategory(nextCategory); setSelectedCategorySourceId(sourceCategoryId); setSelectedParentCategoryId(parentCategoryId); setQuery(''); setSubmittedQuery(''); setProductRouteId(null); setCategoryMenuOpen(false); setMobileMenu(false); history.pushState({ aaroRoute: true }, '', storePath(pageToShow, nextCategory, categoryGroups, sourceCategoryId, parentCategoryId)); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function openOfferCollection(offerId: string) {
    setSelectedOfferId(offerId)
    history.pushState({ aaroRoute: true, offerId }, '', `/offers/${encodeURIComponent(offerId)}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function closeOfferCollection() {
    setSelectedOfferId(null)
    history.pushState({ aaroRoute: true }, '', '/offers')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function showAuth(mode: 'login' | 'register') {
    setAuthRoute(mode); setAdmin(false); setMobileMenu(false); setProductRouteId(null); setCheckout(false)
    history.pushState({}, '', `/${mode}`); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function showAccount() {
    setAdmin(false); setAuthRoute(null); setCheckout(false); setProductRouteId(null); setPage('account');
    history.pushState({}, '', '/account'); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function signOutCustomer() {
    setUser(null); setAccountToken(''); setAccountProfile(null); setCustomerOrders([]);
    localStorage.removeItem(USER_KEY); localStorage.removeItem(AUTH_TOKEN_KEY)
    if (page === 'account') { setPage('shop'); history.replaceState({}, '', '/') }
    notify('You are signed out')
  }
  function beginCheckout() {
    if (!cartItems.length) return
    const missingChoice = cartItems.find(({ product, ...line }) => !hasRequiredProductChoices(product, line))
    if (missingChoice) { notify(`Choose ${missingChoice.product.sizes?.length && !missingChoice.size ? 'a size' : 'the required product options'} before checkout.`); setCartOpen(true); return }
    setCartOpen(false)
    setCheckout(true)
    history.pushState({ aaroCheckout: true }, '', '/checkout')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function returnToBag() {
    setCheckout(false)
    setSelectedDistrict('')
    setSelectedThana('')
    history.replaceState({}, '', '/')
    setCartOpen(true)
  }
  function openProduct(product: Product) {
    productReturnState.current = { page, category, categorySourceId: selectedCategorySourceId, parentCategoryId: selectedParentCategoryId, submittedQuery, minPrice, maxPrice, priceSort, scrollY: window.scrollY }
    setAdmin(false); setProductRouteId(product.id); setShowSearch(false); setQuery(''); setSubmittedQuery(''); setCategoryMenuOpen(false)
    history.pushState({ productId: product.id, aaroProduct: true }, '', productPath(product)); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function closeProduct() {
    const returnState = productReturnState.current
    if (history.state?.aaroProduct) history.back()
    else { history.replaceState({}, '', '/'); setProductRouteId(null) }
    if (!returnState) return
    setPage(returnState.page); setCategory(returnState.category); setSelectedCategorySourceId(returnState.categorySourceId); setSelectedParentCategoryId(returnState.parentCategoryId); setSubmittedQuery(returnState.submittedQuery); setMinPrice(returnState.minPrice); setMaxPrice(returnState.maxPrice); setPriceSort(returnState.priceSort)
    window.setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: returnState.scrollY, behavior: 'instant' as ScrollBehavior }))), 80)
  }
  function submitSearch() {
    setSubmittedQuery(query.trim()); setPage('shop'); setCategory('All'); setShowSearch(false); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function addToCart(product: Product, quantity = 1, size = '', options: Record<string, string> = {}) {
    trackMetaEvent('AddToCart', {
      content_ids: [product.sourceId || product.id],
      content_type: 'product',
      content_name: product.title,
      num_items: quantity,
      value: product.price * quantity,
      currency: 'BDT',
    })
    setCart((current) => {
      const nextLine: CartLine = { productId: product.id, quantity, productSnapshot: cartProductSnapshot(product), ...(size ? { size } : {}), ...(Object.keys(options).length ? { options } : {}) }
      const nextKey = cartLineKey(nextLine)
      const existing = current.find((line) => cartLineKey(line) === nextKey)
      return existing ? current.map((line) => cartLineKey(line) === nextKey ? { ...line, quantity: line.quantity + quantity, productSnapshot: nextLine.productSnapshot } : line) : [...current, nextLine]
    })
    setCartOpen(true); setCheckout(false); notify(`${product.title} added to your bag`)
  }
  function updateCartLine(line: CartLine, patch: Partial<Pick<CartLine, 'size' | 'options'>>) {
    setCart((current) => {
      const oldKey = cartLineKey(line)
      const target = current.find((entry) => cartLineKey(entry) === oldKey)
      if (!target) return current
      const updated = { ...target, ...patch }
      if (patch.size === '') delete updated.size
      const nextKey = cartLineKey(updated)
      const duplicate = current.find((entry) => cartLineKey(entry) === nextKey && cartLineKey(entry) !== oldKey)
      if (duplicate) return current.filter((entry) => cartLineKey(entry) !== oldKey && cartLineKey(entry) !== nextKey).concat({ ...duplicate, quantity: duplicate.quantity + target.quantity })
      return current.map((entry) => cartLineKey(entry) === oldKey ? updated : entry)
    })
  }
  function setCartSize(line: CartLine, size: string) { const options = Object.fromEntries(Object.entries(line.options || {}).filter(([name]) => !/^size$/i.test(name))); updateCartLine(line, { size, options }) }
  function setCartOption(line: CartLine, name: string, value: string) {
    const options = { ...(line.options || {}) }
    if (value) options[name] = value
    else delete options[name]
    updateCartLine(line, { options })
  }
  function setQuantity(line: CartLine, quantity: number) {
    setCart((current) => quantity <= 0 ? current.filter((entry) => cartLineKey(entry) !== cartLineKey(line)) : current.map((entry) => cartLineKey(entry) === cartLineKey(line) ? { ...entry, quantity } : entry))
  }
  function toggleWish(productId: string) {
    const already = wishlist.includes(productId)
    setWishlist((current) => already ? current.filter((id) => id !== productId) : [...current, productId])
    notify(already ? 'Removed from your wishlist' : 'Saved to your wishlist')
  }
  async function applyCoupon() {
    const code = couponInput.trim().toUpperCase()
    if (!code) { notify('Enter a coupon code first.'); return }
    if (!API_BASE) { notify('Coupon validation is unavailable until the catalog service connects.'); return }
    try {
      const response = await fetch(`${API_BASE}/api/coupons/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, subtotal }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'That coupon code is not active.')
      setCoupon(result.coupon as Coupon)
      notify(`${result.coupon.code} applied`)
    } catch (cause) {
      setCoupon(null)
      notify(cause instanceof Error ? cause.message : 'Could not validate that coupon. Please try again.')
    }
  }
  async function placeOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!cartItems.length) return
    const missingChoice = cartItems.find(({ product, ...line }) => !hasRequiredProductChoices(product, line))
    if (missingChoice) { notify(`Choose ${missingChoice.product.sizes?.length && !missingChoice.size ? 'a size' : 'the required product options'} before placing the order.`); setCheckout(false); setCartOpen(true); history.replaceState({}, '', '/'); return }
    const form = new FormData(event.currentTarget)
    const district = String(form.get('district') || '')
    const thana = String(form.get('thana') || '')
    const zone = getDeliveryZone(district, thana)
    const area = `${thana}, ${district}`
    const fee = freeDeliveryApplied ? 0 : zone === 'city' ? state.content.deliveryInDhaka : zone === 'sub_dhaka' ? state.content.deliverySubDhaka : state.content.deliveryOutsideDhaka
    const newOrder: Order = {
      id: `AR-${Math.floor(1000 + Math.random() * 9000)}`,
      createdAt: new Date().toISOString(),
      customer: { name: String(form.get('name')), phone: String(form.get('phone')), area, district, thana, address: String(form.get('address')), comments: String(form.get('comments') || '').trim() || undefined },
      items: cartItems.map((line) => ({ productId: line.productId, title: line.product.title, image: line.product.image, price: line.product.price, quantity: line.quantity, ...(line.size ? { size: line.size } : {}), ...(line.options && Object.keys(line.options).length ? { options: line.options } : {}) })),
      subtotal, delivery: fee, deliveryZone: zone, discount, total: Math.max(0, subtotal + fee - discount), coupon: coupon?.code, status: 'Pending confirmation'
    }
    let orderNumber = newOrder.id
    try {
      const response = await fetch(`${API_BASE}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}) }, body: JSON.stringify(newOrder) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Order could not be saved.')
      if (typeof result.id === 'string') orderNumber = result.id
      updateState((current) => ({ ...current, orders: [result as Order, ...current.orders] }))
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not save your order. Please try again.'); return }
    trackMetaEvent('Purchase', {
      content_ids: cartItems.map((line) => line.product.sourceId || line.product.id),
      content_type: 'product',
      num_items: cartItems.reduce((total, line) => total + line.quantity, 0),
      value: newOrder.total,
      currency: 'BDT',
    })
    history.replaceState({}, '', '/')
    setCart([]); setCoupon(null); setCouponInput(''); setCheckout(false); setCartOpen(false); setSelectedDistrict(''); setSelectedThana(''); notify(`Order ${orderNumber} received.`)
  }
  async function startEditProduct(product?: Product) {
    if (product?.source === 'shopbase' && API_BASE && adminToken) {
      try {
        const response = await fetch(`${API_BASE}/api/admin/products/${encodeURIComponent(product.id)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${adminToken}` } })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load product details.')
        setEditingProduct(result as Product)
      } catch (error) { notify(error instanceof Error ? error.message : 'Could not load product details.'); return }
    } else setEditingProduct(product || null)
    setProductFormOpen(true)
  }
  async function viewAdminProduct(product: Product) {
    if (product.source === 'shopbase' && API_BASE && adminToken) {
      try {
        const response = await fetch(`${API_BASE}/api/admin/products/${encodeURIComponent(product.id)}`, { cache: 'no-store', headers: { Authorization: `Bearer ${adminToken}` } })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load product details.')
        setViewingProduct(result as Product)
      } catch (error) { notify(error instanceof Error ? error.message : 'Could not load product details.'); return }
    } else setViewingProduct(product)
  }
  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nextCategory = String(form.get('category'))
    const originalPrice = Number(form.get('originalPrice'))
    const discountedValue = String(form.get('discountedPrice') || '').trim()
    const discountedPrice = discountedValue ? Number(discountedValue) : undefined
    let images: string[] = []
    try { const parsed: unknown = JSON.parse(String(form.get('images') || '[]')); if (Array.isArray(parsed)) images = parsed.filter((image): image is string => typeof image === 'string' && image.trim().length > 0) } catch { /* The editor supplies a valid image list. */ }
    if (!images.length) { notify('Add at least one product image.'); return }
    if (discountedPrice !== undefined && (!Number.isFinite(discountedPrice) || discountedPrice >= originalPrice)) { notify('Discounted selling price must be lower than the original price.'); return }
    const selectedCategoryGroup = categoryGroups.find((group) => group.children.some((child) => child.name === nextCategory))
    const selectedCategoryChild = selectedCategoryGroup?.children.find((child) => child.name === nextCategory)
    const categoryUnchanged = editingProduct?.category === nextCategory
    const product: Product = {
      id: editingProduct?.id || `custom-${Date.now()}`,
      title: String(form.get('title')).trim(), category: nextCategory,
      price: discountedPrice ?? originalPrice, originalPrice, discountedPrice, compareAt: discountedPrice !== undefined ? originalPrice : undefined,
      image: images[0], images, description: String(form.get('description')).trim(), retailerPrice: editingProduct?.retailerPrice,
      rating: editingProduct?.rating || 5, reviews: editingProduct?.reviews || 0,
      badge: String(form.get('badge') || '') || undefined, stock: Number(form.get('stock') || 0),
      active: form.get('active') === 'on' && Number(form.get('stock') || 0) > 0, trending: form.get('trending') === 'on', offer: form.get('offer') === 'on',
      source: editingProduct?.source || 'custom', sourceId: editingProduct?.sourceId, addedAt: editingProduct?.addedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
      sizes: String(form.get('sizes') || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
      sizeChart: String(form.get('sizeChart') || '').trim() || undefined, details: editingProduct?.details,
      attributes: editingProduct?.attributes, options: parseOptionLines(String(form.get('options') || '')),
      categorySourceId: selectedCategoryChild?.sourceId || (categoryUnchanged ? editingProduct?.categorySourceId : undefined),
      parentCategory: selectedCategoryGroup?.name || (categoryUnchanged ? editingProduct?.parentCategory : undefined),
      parentCategoryId: selectedCategoryGroup?.id || (categoryUnchanged ? editingProduct?.parentCategoryId : undefined)
    }
    if (API_BASE && adminToken) {
      try {
        const response = await fetch(`${API_BASE}/api/admin/products`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(product) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Product changes could not be saved.')
      } catch (error) { notify(error instanceof Error ? error.message : 'Product changes could not be saved.'); return }
    }
    updateState((current) => ({ ...current, products: current.products.some((item) => item.id === product.id) ? current.products.map((item) => item.id === product.id ? product : item) : [product, ...current.products] }))
    setAdminProductList((current) => editingProduct ? current.map((item) => item.id === product.id ? product : item) : [product, ...current])
    setProductFormOpen(false); setEditingProduct(null); notify(editingProduct ? 'Product updated' : 'Product added')
  }
  async function deleteProduct(productId: string) {
    if (API_BASE && adminToken) {
      try {
        const response = await fetch(`${API_BASE}/api/admin/products/${encodeURIComponent(productId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Product could not be removed.')
      } catch (error) { notify(error instanceof Error ? error.message : 'Product could not be removed.'); return }
    }
    updateState((current) => ({ ...current, products: current.products.filter((item) => item.id !== productId), content: { ...current.content, trendingIds: current.content.trendingIds.filter((id) => id !== productId), offerIds: current.content.offerIds.filter((id) => id !== productId) } }))
    setAdminProductList((current) => current.flatMap((item) => item.id !== productId ? [item] : item.source === 'shopbase' ? [{ ...item, active: false }] : []))
    notify('Product removed from your catalog')
  }
  async function updateOrderStatus(orderId: string, status: OrderStatus) {
    if (adminToken && API_BASE) { const response = await fetch(`${API_BASE}/api/admin/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ status }) }); if (!response.ok) { notify('Order status could not be saved.'); return } }
    updateState((current) => ({ ...current, orders: current.orders.map((order) => order.id === orderId ? { ...order, status } : order) }))
    notify(`Order marked ${status.toLowerCase()}`)
  }
  async function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = categoryInput.trim()
    if (!value || state.categories.some((item) => item.toLowerCase() === value.toLowerCase())) return
    const nextManual = [...manualCategories, value]
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ manualCategories: nextManual }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Category could not be saved.') }
      catch (error) { notify(error instanceof Error ? error.message : 'Category could not be saved.'); return }
    }
    setManualCategories(nextManual); updateState((current) => ({ ...current, categories: [...current.categories, value] })); setCategoryInput(''); notify('Category added')
  }
  async function removeCategory(value: string) {
    if (value === 'All') return
    const nextManual = manualCategories.filter((item) => item !== value)
    const nextVisibility = { ...manualCategoryVisibility }; delete nextVisibility[value]
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ manualCategories: nextManual, manualCategoryVisibility: nextVisibility }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Category could not be removed.') }
      catch (error) { notify(error instanceof Error ? error.message : 'Category could not be removed.'); return }
    }
    setManualCategoryVisibility(nextVisibility)
    setManualCategories(nextManual); updateState((current) => ({ ...current, categories: current.categories.filter((item) => item !== value) })); notify('Category removed')
  }
  async function persistCategoryGroups(nextGroups: CategoryGroup[]) {
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ categoryGroups: nextGroups }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Category changes could not be saved.') }
      catch (error) { notify(error instanceof Error ? error.message : 'Category changes could not be saved.'); return false }
    }
    setCategoryGroups(nextGroups); return true
  }
  async function toggleCategoryGroupVisibility(groupId: string, visible: boolean) {
    const next = categoryGroups.map((group) => group.id === groupId ? { ...group, showInStorefront: visible } : group)
    if (await persistCategoryGroups(next)) { setCatalogRefreshTick((tick) => tick + 1); notify(visible ? 'Category group shown in storefront' : 'Category group hidden from storefront') }
  }
  async function toggleSubcategoryVisibility(groupId: string, childName: string, visible: boolean) {
    const next = categoryGroups.map((group) => group.id !== groupId ? group : { ...group, children: group.children.map((child) => child.name === childName ? { ...child, showInStorefront: visible } : child) })
    if (await persistCategoryGroups(next)) { setCatalogRefreshTick((tick) => tick + 1); notify(visible ? 'Category shown in storefront' : 'Category hidden from storefront') }
  }
  async function deleteSubcategory(groupId: string, sourceId: string) {
    const next = categoryGroups.map((group) => group.id !== groupId ? group : { ...group, children: group.children.filter((child) => child.sourceId !== sourceId) })
    if (await persistCategoryGroups(next)) { setCatalogRefreshTick((tick) => tick + 1); notify('Subcategory removed from the storefront') }
  }
  async function toggleManualCategoryVisibility(name: string, visible: boolean) {
    const next = { ...manualCategoryVisibility, [name]: visible }
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ manualCategoryVisibility: next }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Category visibility could not be saved.') }
      catch (error) { notify(error instanceof Error ? error.message : 'Category visibility could not be saved.'); return }
    }
    setManualCategoryVisibility(next)
    setCatalogRefreshTick((tick) => tick + 1)
    notify(visible ? 'Category shown in storefront' : 'Category hidden from storefront')
  }
  async function saveCategoryImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!categoryImageEditor) return
    const value = categoryImageEditor.value.trim()
    if (!value) { notify('Choose a product image or upload a category image.'); return }
    const content = { ...state.content, categoryImages: { ...state.content.categoryImages, [categoryImageEditor.name]: value } }
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ content }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Category image could not be saved.') }
      catch (error) { notify(error instanceof Error ? error.message : 'Category image could not be saved.'); return }
    }
    updateState((current) => ({ ...current, content }))
    setCategoryImageEditor(null)
    notify('Homepage category image saved')
  }
  async function editCategoryGroup(groupId: string) {
    const group = categoryGroups.find((item) => item.id === groupId)
    if (!group) return
    setCategoryNameEditor({ groupId, value: group.name })
  }
  async function editSubcategory(groupId: string, childName: string) {
    const group = categoryGroups.find((item) => item.id === groupId)
    const child = group?.children.find((item) => item.name === childName)
    if (!group || !child) return
    setCategoryNameEditor({ groupId, childName, value: child.name })
  }
  async function saveCategoryName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!categoryNameEditor) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') || '').trim()
    if (!name) return
    const { groupId, childName } = categoryNameEditor
    const next = categoryGroups.map((group) => group.id !== groupId ? group : childName
      ? { ...group, children: group.children.map((child) => child.name === childName ? { ...child, name } : child) }
      : { ...group, name })
    if (await persistCategoryGroups(next)) { notify(childName ? 'Subcategory saved to the catalog' : 'Parent category saved to the catalog'); setCategoryNameEditor(null) }
  }
  async function saveCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const nextCoupon: Coupon = { code: String(form.get('code')).trim().toUpperCase(), kind: form.get('kind') === 'amount' ? 'amount' : 'percent', value: Number(form.get('value')), minimum: Number(form.get('minimum')) || undefined, active: true }
    if (nextCoupon.kind === 'percent' && nextCoupon.value > 100) { notify('A percentage coupon cannot exceed 100%.'); return }
    if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(nextCoupon) }); if (!response.ok) { const result = await response.json().catch(() => ({})); notify(result.detail || 'Coupon could not be saved to the server.'); return } }
    updateState((current) => ({ ...current, coupons: [...current.coupons.filter((item) => item.code !== nextCoupon.code), nextCoupon] })); setCouponFormOpen(false); notify('Coupon saved')
  }
  async function saveOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const selectedKind = String(form.get('kind'))
    const kind = (selectedKind === 'percentage_each' ? 'quantity_discount' : selectedKind) as OfferDeal['kind']
    const productIds = form.getAll('productIds').map(String).filter(Boolean)
    const tiers: OfferTier[] = []
    for (let index = 0; ; index += 1) {
      const quantity = Number(form.get(`tierQuantity-${index}`))
      if (form.get(`tierQuantity-${index}`) == null) break
      if (!quantity) { notify('Enter a quantity for every reward tier.'); return }
      const mode = String(form.get(`tierMode-${index}`) || 'discount') as OfferTier['mode']
      tiers.push({ quantity, mode, value: Number(form.get(`tierValue-${index}`)) || 0, discountKind: String(form.get(`tierDiscountKind-${index}`) || 'percent') as OfferTier['discountKind'], freeDelivery: mode === 'none' || form.get(`tierFreeDelivery-${index}`) === 'on' })
    }
    const editingIndex = editingOffer ? state.offers.findIndex((offer) => offer.id === editingOffer.id) : -1
    const nextSortOrder = editingOffer
      ? editingOffer.sortOrder ?? Math.max(0, editingIndex)
      : Math.max(-1, ...state.offers.map((offer, index) => offer.sortOrder ?? index)) + 1
    const nextOffer: OfferDeal = { title: String(form.get('title') || '').trim(), shareImage: String(form.get('shareImage') || '').trim(), id: editingOffer?.id || `offer-${Date.now()}`, productId: productIds[0] || '', productIds: kind === 'free_delivery' ? [] : productIds, productCount: kind === 'free_delivery' ? activeProducts.length : productIds.length, ...(kind !== 'free_delivery' ? { thumbnailProductIds: form.getAll('thumbnailProductIds').map(String).slice(0, 3) } : {}), ...(kind === 'buy_multiple' && tiers.length ? { tiers } : {}), kind, value: Number(form.get('value')) || 0, discountKind: String(form.get('discountKind') || 'percent') as OfferDeal['discountKind'], quantity: Number(form.get('quantity')) || 1, freeQuantity: Number(form.get('freeQuantity')) || 1, ...(kind === 'buy_multiple' ? { reward: String(form.get('reward') || 'discount') as OfferDeal['reward'] } : {}), active: editingOffer?.active ?? true, sortOrder: nextSortOrder }
    if (kind !== 'free_delivery' && new Set(productIds).size < (kind === 'bundle' ? 2 : 1)) { notify(kind === 'bundle' ? 'Choose at least two different products for the bundle.' : 'Choose at least one product for this offer.'); return }
    if (kind === 'free_delivery' && nextOffer.value < 0) { notify('Enter a valid minimum order amount.'); return }
    if (kind === 'buy_multiple' && tiers.length && (tiers.some((tier) => tier.quantity < 1 || tier.value < 0 || tier.mode === 'discount' && tier.value <= 0 || tier.mode === 'discount' && tier.discountKind === 'percent' && tier.value > 100 || tier.mode === 'price' && productIds.some((id) => { const product = state.products.find((item) => item.id === id); return product && tier.value >= tier.quantity * product.price }) || tier.mode === 'none' && !tier.freeDelivery) || new Set(tiers.map((tier) => tier.quantity)).size !== tiers.length)) { notify('Check each quantity tier: use unique quantities and valid set prices or discounts.'); return }
    if ((nextOffer.kind === 'quantity_discount' || nextOffer.kind === 'buy_multiple' && ['discount', 'both'].includes(nextOffer.reward || '')) && nextOffer.discountKind === 'percent' && nextOffer.value > 100) { notify('A percentage offer cannot exceed 100%.'); return }
    let offerToSave = nextOffer
    if (API_BASE && adminToken) {
      const response = await fetch(`${API_BASE}/api/admin/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(nextOffer) })
      const result = await response.json().catch(() => ({})) as Partial<OfferDeal> & { detail?: string }
      if (!response.ok) { notify(result.detail || 'Offer could not be saved.'); return }
      offerToSave = { ...nextOffer, ...result }
    }
    updateState((current) => {
      const existingIndex = current.offers.findIndex((offer) => offer.id === offerToSave.id)
      if (existingIndex === -1) return { ...current, offers: [...current.offers, offerToSave] }
      const offers = [...current.offers]
      offers[existingIndex] = offerToSave
      return { ...current, offers }
    })
    setOfferFormOpen(false); setEditingOffer(null); notify(editingOffer ? 'Offer updated' : 'Offer saved')
  }
  async function toggleOffer(id: string) { const offer = state.offers.find((item) => item.id === id); if (!offer) return; const updated = { ...offer, active: !offer.active }; if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(updated) }); if (!response.ok) { notify('Offer could not be updated.'); return } }; updateState((current) => ({ ...current, offers: current.offers.map((item) => item.id === id ? updated : item) })) }
  async function deleteOffer(id: string) { if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/offers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } }); if (!response.ok) { notify('Offer could not be deleted.'); return } }; updateState((current) => ({ ...current, offers: current.offers.filter((item) => item.id !== id) })); notify('Offer deleted') }
  async function toggleCoupon(code: string) { const item = state.coupons.find((entry) => entry.code === code); if (!item) return; const updated = { ...item, active: !item.active }; if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(updated) }); if (!response.ok) { notify('Coupon could not be updated on the server.'); return } }; updateState((current) => ({ ...current, coupons: current.coupons.map((entry) => entry.code === code ? updated : entry) })) }
  async function deleteCoupon(code: string) { if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons/${encodeURIComponent(code)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } }); if (!response.ok) { notify('Coupon could not be deleted from the server.'); return } }; updateState((current) => ({ ...current, coupons: current.coupons.filter((item) => item.code !== code) })); if (coupon?.code === code) { setCoupon(null); setCouponInput('') }; notify(`Coupon ${code} deleted`) }
  async function saveContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const combos = state.content.combos.map((combo, index) => ({ ...combo, title: String(form.get(`comboTitle${index}`) || combo.title), subtitle: String(form.get(`comboSubtitle${index}`) || combo.subtitle), image: String(form.get(`comboImage${index}`) || combo.image), price: Number(form.get(`comboPrice${index}`) || combo.price) }))
    // Hero images now live only in heroSlides. Clear legacy single-hero fields
    // so a banner image is not duplicated in the saved catalog document.
    const content: StoreContent = { ...state.content, heroTitle: '', heroSubtitle: '', heroImage: '', heroCta: '', heroSlides: contentDraft.heroSlides, offerTitle: String(form.get('offerTitle')), offerSubtitle: String(form.get('offerSubtitle')), offerImage: String(form.get('offerImage')), socialShareImage: contentDraft.socialShareImage || '', announcement: String(form.get('announcement')), combos, deliveryInDhaka: Number(form.get('deliveryInDhaka')), deliverySubDhaka: Number(form.get('deliverySubDhaka')), deliveryOutsideDhaka: Number(form.get('deliveryOutsideDhaka')) }
    let savedContent = content
    if (API_BASE && adminToken) {
      try { const response = await fetch(`${API_BASE}/api/admin/storefront`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ content }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Storefront changes could not be saved.'); if (result.content && typeof result.content === 'object') savedContent = { ...content, ...result.content } as StoreContent }
      catch (error) { notify(error instanceof Error ? error.message : 'Storefront changes could not be saved.'); return }
    }
    updateState((current) => ({ ...current, content: savedContent }))
    setContentDraft(savedContent)
    notify('Storefront content saved')
  }
  async function migrateStorefrontMedia() {
    if (!API_BASE || !adminToken || mediaMigrationBusy) return
    setMediaMigrationBusy(true)
    try {
      const response = await fetch(`${API_BASE}/api/admin/storefront-media/migrate`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.detail || 'Uploaded images could not be moved to Cloudinary.')
      if (result.content && typeof result.content === 'object') {
        const content = { ...state.content, ...result.content } as StoreContent
        setContentDraft(content)
        updateState((current) => ({ ...current, content }))
      }
      const uploaded = Number(result.uploaded) || 0
      const remaining = Number(result.remainingInlineImages) || 0
      setMediaMigrationMessage(remaining > 0 ? `Migration incomplete: ${remaining.toLocaleString()} inline image${remaining === 1 ? '' : 's'} remain.` : uploaded ? `Success: ${uploaded.toLocaleString()} image${uploaded === 1 ? '' : 's'} moved to Cloudinary. No inline images remain.` : 'Success: all uploaded images were already on Cloudinary.')
      const statusResponse = await fetch(`${API_BASE}/api/admin/storefront-media/status`, { cache: 'no-store', headers: { Authorization: `Bearer ${adminToken}` } })
      const status = await statusResponse.json().catch(() => ({})) as { configured?: unknown; cloudinaryImages?: unknown; inlineImages?: unknown }
      if (statusResponse.ok && typeof status.configured === 'boolean' && Number.isFinite(status.cloudinaryImages) && Number.isFinite(status.inlineImages)) setMediaMigrationStatus({ configured: status.configured, cloudinaryImages: Number(status.cloudinaryImages), inlineImages: Number(status.inlineImages) })
      notify(remaining > 0 ? `${remaining.toLocaleString()} image${remaining === 1 ? '' : 's'} still need Cloudinary migration.` : uploaded ? `${uploaded.toLocaleString()} uploaded image${uploaded === 1 ? '' : 's'} moved to Cloudinary.` : 'Uploaded images are already using CDN URLs.')
    } catch (error) { const message = error instanceof Error ? error.message : 'Uploaded images could not be moved to Cloudinary.'; setMediaMigrationMessage(`Failed: ${message}`); notify(message) }
    finally { setMediaMigrationBusy(false) }
  }
  function updateHeroSlide(index: number, changes: Partial<StoreContent['heroSlides'][number]>) {
    setContentDraft((current) => ({ ...current, heroSlides: current.heroSlides.map((slide, slideIndex) => slideIndex === index ? { ...slide, ...changes } : slide) }))
  }
  function addHeroSlide() {
    const slide = { image: '', mobileImage: '', title: 'New collection', description: '', cta: 'Explore', link: '/offers' }
    setContentDraft((current) => { setPreviewSlide(current.heroSlides.length); return { ...current, heroSlides: [...current.heroSlides, slide] } })
  }
  function moveHeroSlide(index: number, direction: -1 | 1) {
    setContentDraft((current) => {
      const target = index + direction
      if (target < 0 || target >= current.heroSlides.length) return current
      const heroSlides = [...current.heroSlides]
      ;[heroSlides[index], heroSlides[target]] = [heroSlides[target], heroSlides[index]]
      setPreviewSlide((preview) => preview === index ? target : preview === target ? index : preview)
      return { ...current, heroSlides }
    })
  }
  function removeHeroSlide(index: number) {
    setContentDraft((current) => { if (current.heroSlides.length <= 1) return current; const next = current.heroSlides.filter((_, slideIndex) => slideIndex !== index); setPreviewSlide((preview) => Math.max(0, Math.min(preview >= index ? preview - 1 : preview, next.length - 1))); return { ...current, heroSlides: next } })
  }
  async function uploadHeroSlideImage(index: number, file: File | undefined, mobile: boolean) {
    if (!file) return
    try { const image = await compressImageFile(file, mobile ? 1800 : 2880, mobile ? 2250 : 1680, 0.9); updateHeroSlide(index, mobile ? { mobileImage: image } : { image }) }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not prepare this image.') }
  }
  async function uploadSocialThumbnail(file: File | undefined) {
    if (!file) return
    try { const socialShareImage = await compressSocialShareImage(file); setContentDraft((current) => ({ ...current, socialShareImage })) }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not prepare this image.') }
  }
  function logoutAdmin() {
    localStorage.removeItem(ADMIN_TOKEN_KEY)
    sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY)
    setAdminToken('')
    setAdmin(false)
    setMobileMenu(false)
    window.scrollTo({ top: 0 })
  }
  function importCsv(file?: File) {
    if (!file) return
    if (!API_BASE || !adminToken) { setImportNote('CSV import needs the catalog service and an active admin session.'); return }
    if (file.size > 20 * 1024 * 1024) { setImportNote('Choose a CSV file smaller than 20 MB.'); return }
    const reader = new FileReader()
    reader.onload = async () => {
      let rows: string[][]
      try { rows = parseCsvRows(String(reader.result || '')) }
      catch (error) { setImportNote(error instanceof Error ? error.message : 'Could not read the CSV file.'); return }
      if (rows.length < 2) { setImportNote('The file looks empty. Upload a CSV with a header row and product rows.'); return }
      const headers = rows[0].map((item, index) => (index === 0 ? item.replace(/^\uFEFF/, '') : item).trim().toLowerCase().replaceAll(' ', '_'))
      const value = (cells: string[], ...keys: string[]) => { const index = headers.findIndex((header) => keys.includes(header)); return index >= 0 ? (cells[index] || '').trim() : '' }
      const parsed: Product[] = rows.slice(1).flatMap((cells, index) => {
        const title = value(cells, 'title', 'name', 'product_name')
        if (!title) return []
        const sourceId = value(cells, 'source_id', 'sku', 'id')
        const rawPrice = Number(value(cells, 'price', 'suggested_price', 'retail_price'))
        const rawStock = Number(value(cells, 'stock', 'availability'))
        if (!Number.isFinite(rawPrice) || rawPrice <= 0 || !Number.isInteger(rawStock) || rawStock < 0) return []
        const image = value(cells, 'image', 'image_url', 'images')
        return {
          id: 'csv-' + (sourceId || `${Date.now()}-${index}`),
          title, category: value(cells, 'category') || 'Imported', price: rawPrice,
          compareAt: Number(value(cells, 'compare_at', 'suggested_price')) || undefined,
          image: image || '/images/product-placeholder.svg',
          description: value(cells, 'description', 'details'),
          rating: 0, reviews: 0, stock: rawStock,
          active: Boolean(image) && rawStock > 0, source: 'custom' as const, sourceId: sourceId || undefined, updatedAt: new Date().toISOString()
        } satisfies Product
      })
      if (!parsed.length) { setImportNote('No products were found. Expected a title/name column.'); return }
      if (parsed.length > 2000) { setImportNote('A single import can contain at most 2,000 products.'); return }
      setImportNote('Saving products to the catalog…')
      try {
        const response = await fetch(`${API_BASE}/api/admin/products/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ products: parsed }) })
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'The CSV products could not be saved.')
      } catch (error) { setImportNote(error instanceof Error ? error.message : 'The CSV products could not be saved.'); return }
      updateState((current) => {
        const existing = new Map(current.products.map((product) => [product.sourceId || product.id, product]))
        for (const product of parsed) existing.set(product.sourceId || product.id, { ...existing.get(product.sourceId || product.id), ...product })
        const categories = [...new Set([...current.categories, ...parsed.map((product) => product.category)])]
        return { ...current, products: [...existing.values()], categories }
      })
      setImportNote(`${parsed.length} products from ${file.name} were saved to the catalog. Rows without an image or stock are hidden until completed in Products.`)
    }
    reader.onerror = () => setImportNote('The selected CSV file could not be read. Try saving it as UTF-8 and upload again.')
    reader.readAsText(file, 'UTF-8')
  }

  const navItems: { label: string; icon: typeof LayoutDashboard; tab: AdminTab }[] = [
    { label: 'Overview', icon: LayoutDashboard, tab: 'overview' }, { label: 'Products', icon: Package, tab: 'products' },
    { label: 'Categories', icon: Tags, tab: 'categories' }, { label: 'Offers & coupons', icon: TicketPercent, tab: 'offers' },
    { label: 'Orders', icon: ShoppingCart, tab: 'orders' }, { label: 'Storefront', icon: Sparkles, tab: 'content' }, { label: 'Product sync', icon: RotateCcw, tab: 'sync' }, { label: 'Email notifications', icon: Mail, tab: 'email' }
  ]
  const formatPageTitle = page === 'trending' ? 'Trending now' : page === 'offers' ? 'Offers for you' : page === 'category' ? category === 'All' ? 'All products' : category : page === 'wishlist' ? 'Your wishlist' : page === 'terms' ? 'Terms & Conditions' : page === 'delivery' ? 'Delivery & Returns' : page === 'contact' ? 'Contact us' : 'The AARO edit'
  const selectedTrendingProducts = priorityTrendingIds.length ? priorityTrendingIds.map((id) => activeProducts.find((product) => product.id === id)).filter((product): product is Product => Boolean(product)) : activeProducts.filter((product) => product.trending).sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0)).slice(0, 20)
  const homeTrendingProducts = selectedTrendingProducts.slice(0, 20)
  const dealProductIds = new Set(state.offers.filter((offer) => offer.active).flatMap((offer) => offer.productIds?.length ? offer.productIds : [offer.productId]))
  const selectedOfferProducts = activeProducts.filter((product) => state.content.offerIds.includes(product.id) || product.offer || dealProductIds.has(product.id))
  const discountedProducts = activeProducts.filter((product) => salePercentOf(product) > 0)
  const homeOfferProducts = (selectedOfferProducts.length ? selectedOfferProducts : discountedProducts).slice(0, 4)
  const activeProductOffers = state.offers.filter((offer) => offer.active).sort((a, b) => (a.sortOrder ?? state.offers.indexOf(a)) - (b.sortOrder ?? state.offers.indexOf(b)))
  const offerCollections: { id: string; title: string; description: string; products: Product[]; previewProducts: Product[]; thumbnailProductIds: string[]; offer: OfferDeal | null; coupon: Coupon | null; storewide: boolean }[] = [
    ...activeProductOffers.map((offer) => {
      const targetIds = offer.kind === 'free_delivery' ? [] : offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : []
      const products = offer.kind === 'free_delivery' ? activeProducts : activeProducts.filter((product) => targetIds.includes(product.id))
      const thumbnailProductIds = (offer.thumbnailProductIds?.length ? offer.thumbnailProductIds : targetIds).slice(0, 3)
      const chosenThumbnails = thumbnailProductIds.map((id) => activeProducts.find((product) => product.id === id)).filter((product): product is Product => Boolean(product))
      return { id: offer.id, title: offer.title || offerDealSummary(offer, products), description: offerDealSummary(offer, products), products, previewProducts: chosenThumbnails.slice(0, 3), thumbnailProductIds, offer, coupon: null as Coupon | null, storewide: offer.kind === 'free_delivery' }
    }),
    ...state.coupons.filter((coupon) => coupon.active).map((coupon) => ({ id: `coupon-${coupon.code}`, title: coupon.code, description: `${coupon.kind === 'percent' ? `${coupon.value}% off` : `${money(coupon.value)} off`}${coupon.minimum ? ` on orders over ${money(coupon.minimum)}` : ''}`, products: activeProducts, previewProducts: [], thumbnailProductIds: [] as string[], offer: null as OfferDeal | null, coupon, storewide: true }))
  ]
  const selectedOfferCollection = offerCollections.find((collection) => collection.id === selectedOfferId)
  const offerPageProducts = (offerProductPage.offerId === selectedOfferId ? offerProductPage.products : [])
    .map((product) => applySingleItemOfferPrice(product, [...state.offers, ...(selectedOfferCollection?.offer ? [selectedOfferCollection.offer] : [])]))
    .sort((left, right) => priceSort === 'low-high' ? left.price - right.price || left.title.localeCompare(right.title) : priceSort === 'high-low' ? right.price - left.price || left.title.localeCompare(right.title) : 0)
  const selectedOfferCount = selectedOfferCollection?.offer?.productCount ?? selectedOfferCollection?.offer?.productIds?.length ?? selectedOfferCollection?.products.length ?? 0
  const categoryShuffleSeed = useRef(Math.random()).current
  const homeCategoryNames = useMemo(() => {
    const loadedNames = [...new Set(priorityHomeCategoryNames.filter((name) => activeProducts.some((product) => product.category === name)))]
    if (loadedNames.length) return loadedNames
    return state.categories.filter((item) => item !== 'All').map((category) => ({ category, score: [...category].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619), Math.floor(categoryShuffleSeed * 0xffffffff)) >>> 0 })).sort((a, b) => a.score - b.score).slice(0, 12).map((item) => item.category)
  }, [activeProducts, categoryShuffleSeed, priorityHomeCategoryNames, state.categories])
  const homeCategories = useMemo(() => homeCategoryNames.map((category) => ({ category, products: activeProducts.filter((product) => product.category === category) })).filter((item) => item.products.length > 0), [activeProducts, homeCategoryNames])
  const visibleHomeCategories = homeCategories.filter(({ category: name }) => !dismissedHomeCategories.includes(name))
  const loadMoreHomeCategories = useCallback(async () => {
    if (!API_BASE || !homeCategoryPage.hasMore || homeCategoryRequestRef.current) return
    const requestedOffset = homeCategoryPage.nextOffset
    homeCategoryRequestRef.current = true
    setHomeCategoryPage((current) => ({ ...current, loading: true }))
    try {
      const response = await fetch(`${API_BASE}/api/catalog-priority?kind=home_categories&category_offset=${requestedOffset}`)
      if (!response.ok) throw new Error(`Homepage categories returned ${response.status}`)
      const feed = await response.json() as { categoryProducts?: unknown; categoryHasMore?: boolean; nextCategoryOffset?: number }
      const products = Array.isArray(feed.categoryProducts) ? feed.categoryProducts.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && Number.isFinite(item.price))).map((product) => ({ ...product, source: product.source === 'custom' ? 'custom' as const : 'shopbase' as const })) : []
      if (products.length) {
        setState((current) => {
          const byId = new Map(current.products.map((product) => [product.id, product]))
          for (const product of products) byId.set(product.id, { ...byId.get(product.id), ...product })
          return { ...current, products: [...byId.values()].sort((a, b) => a.title.localeCompare(b.title)) }
        })
        setPriorityHomeCategoryNames((current) => [...new Set([...current, ...products.map((product) => product.category).filter(Boolean)])])
      }
      setHomeCategoryPage({ nextOffset: Number.isInteger(feed.nextCategoryOffset) ? Number(feed.nextCategoryOffset) : requestedOffset, hasMore: Boolean(feed.categoryHasMore), loading: false })
    } catch (error) {
      console.warn('Could not load more homepage categories.', error)
      setHomeCategoryPage((current) => ({ ...current, loading: false }))
    } finally {
      homeCategoryRequestRef.current = false
    }
  }, [homeCategoryPage.hasMore, homeCategoryPage.nextOffset])
  useEffect(() => {
    const carousel = categoryCarouselRef.current
    if (!carousel) return
    const loadAtEnd = () => {
      const distanceToEnd = carousel.scrollWidth - carousel.clientWidth - carousel.scrollLeft
      if (distanceToEnd <= Math.max(120, carousel.clientWidth * 0.3)) void loadMoreHomeCategories()
    }
    carousel.addEventListener('scroll', loadAtEnd, { passive: true })
    return () => carousel.removeEventListener('scroll', loadAtEnd)
  }, [loadMoreHomeCategories])
  useEffect(() => {
    const carousel = categoryCarouselRef.current
    if (!carousel || visibleHomeCategories.length < 2) return
    const timer = window.setInterval(() => {
      slideCategoryCarousel(carousel, 1)
    }, 4500)
    return () => window.clearInterval(timer)
  }, [visibleHomeCategories.length])
  const dismissHomeCategory = (name: string) => {
    const next = [...dismissedHomeCategories, name]
    sessionStorage.setItem('aaro-dismissed-home-categories', JSON.stringify(next))
    setDismissedHomeCategories(next)
  }

  return <>
    {admin ? <div className={`admin-shell ${darkTheme ? 'theme-dark' : ''}`}>
      <aside className={`admin-sidebar ${mobileMenu ? 'admin-sidebar-open' : ''}`}>
        <div className="admin-brand"><button className="admin-brand-home" onClick={() => { setAdminTab('overview'); setMobileMenu(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }} aria-label="Go to admin overview"><img className="brand-mark-image" src="/images/aaro-favicon.png" alt="" /><span>AARO</span></button><IconButton label="Close menu" className="mobile-only" onClick={() => setMobileMenu(false)}><X size={18} /></IconButton></div>
        <div className={`admin-store-control ${storeMenuOpen ? 'is-open' : ''}`}>
          <button type="button" className={`admin-store-pill ${storeIsLive ? 'is-live' : 'is-closed'}`} onClick={() => setStoreMenuOpen((open) => !open)} aria-expanded={storeMenuOpen} aria-haspopup="menu"><span className="store-live-dot" />{storeIsLive ? 'Live store' : 'Store closed'}<ChevronDown size={15} /></button>
          {storeMenuOpen && <div className="store-status-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setStoreMenuOpen(false); void toggleStoreStatus() }} disabled={storeStatusBusy}>{storeStatusBusy ? 'Saving…' : storeIsLive ? 'Close store' : 'Open store'}</button></div>}
        </div>
        <p className="sidebar-caption">WORKSPACE</p>
        <nav className="admin-nav">{navItems.map(({ label, icon: Icon, tab }) => <button key={tab} className={adminTab === tab ? 'active' : ''} onClick={() => { setAdminTab(tab); setMobileMenu(false) }}><Icon size={18} /><span>{label}</span>{tab === 'orders' && state.orders.filter((order) => order.status === 'Pending confirmation').length > 0 && <b>{state.orders.filter((order) => order.status === 'Pending confirmation').length}</b>}</button>)}</nav>
        <div className="sidebar-bottom"><div className="admin-profile"><div className="avatar"><img src="/images/aaro-favicon.png" alt="" /></div><div><strong>Store admin</strong><small>AARO</small></div></div><button className="back-store" onClick={() => window.location.assign('/')}><House size={17} /> View storefront <ArrowUpRight size={15} /></button><button className="admin-logout-button" onClick={logoutAdmin}><LogOut size={17} /> Log out</button></div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><button className="mobile-menu-trigger" onClick={() => setMobileMenu(true)}><Menu size={20} /></button><div><p className="eyebrow">AARO <span>/</span> {navItems.find((item) => item.tab === adminTab)?.label.toUpperCase()}</p><h1>{adminTab === 'overview' ? 'Good morning, Admin' : navItems.find((item) => item.tab === adminTab)?.label}</h1></div><div className="admin-top-actions"><span className="date-chip"><CalendarDays size={15} /> {dateLabel(new Date().toISOString())}</span><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle admin-theme-toggle" onClick={() => setDarkTheme((current) => !current)}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><button className="admin-view-store" onClick={() => window.location.assign('/')}>View store <ArrowUpRight size={15} /></button><button className="admin-logout-button admin-logout-top" onClick={logoutAdmin}><LogOut size={16} /> Log out</button><div className="avatar avatar-small"><img src="/images/aaro-favicon.png" alt="" /></div></div></header>
        <div className="admin-content">
          {adminTab === 'overview' && <AdminOverview state={state} revenue={revenue} customerCount={customerCount} productViews={Object.values(productViewCounts).reduce((sum, count) => sum + count, 0)} onTab={setAdminTab} updateOrderStatus={updateOrderStatus} /> }
          {adminTab === 'products' && <AdminProducts products={adminProductList} loading={adminProductsLoading} moreLoading={adminProductsMoreLoading} hasMore={adminProductsHasMore} total={adminProductsTotal} error={adminProductsError} onSearch={(value) => { setAdminProductsSearch(value); void loadAdminProductPage(0, false, value, adminProductsSort) }} onLoadMore={(sort) => void loadAdminProductPage(adminProductsNextOffset, true, adminProductsSearch, sort)} onSortChange={(sort) => { setAdminProductsSort(sort); void loadAdminProductPage(0, false, adminProductsSearch, sort) }} productViewCounts={productViewCounts} categoryGroups={categoryGroups} offers={state.offers} apiBase={API_BASE} token={adminToken} onBulkApplied={() => void loadAdminProductPage(0, false, adminProductsSearch)} onCheckAvailability={async (product) => { const headers = { Authorization: `Bearer ${adminToken}` }; const base = `${API_BASE}/api/admin/products/${encodeURIComponent(product.id)}/availability-check`; const started = await fetch(base, { method: 'POST', headers }); const startResult = await started.json().catch(() => ({})); if (!started.ok) throw new Error(startResult.detail || 'Could not start the availability check.'); for (let attempt = 0; attempt < 240; attempt += 1) { await new Promise((resolve) => window.setTimeout(resolve, 2000)); const response = await fetch(`${base}/${encodeURIComponent(startResult.checkId)}`, { headers, cache: 'no-store' }); const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.detail || 'Could not read availability check status.'); if (result.status === 'complete') return Boolean(result.available); if (result.status === 'failed') throw new Error(result.error || 'The ShopBase check failed.') } throw new Error('The availability check is taking longer than expected. Check sync progress and refresh this product later.') }} onAdd={() => startEditProduct()} onView={viewAdminProduct} onEdit={startEditProduct} onDelete={deleteProduct} />}
          {adminTab === 'categories' && <CategoriesAdmin categories={state.categories} categoryGroups={categoryGroups} products={adminProductList} productCounts={adminCategoryProductCounts} content={state.content} manualCategoryVisibility={manualCategoryVisibility} categoryInput={categoryInput} onCategoryInput={setCategoryInput} onAdd={addCategory} onRemove={removeCategory} onDeleteChild={(groupId, sourceId) => void deleteSubcategory(groupId, sourceId)} onEditGroup={editCategoryGroup} onEditChild={editSubcategory} onCategoryImage={(name) => setCategoryImageEditor({ name, value: state.content.categoryImages?.[name] || '' })} onToggleGroup={(id, visible) => void toggleCategoryGroupVisibility(id, visible)} onToggleChild={(id, name, visible) => void toggleSubcategoryVisibility(id, name, visible)} onToggleManual={(name, visible) => void toggleManualCategoryVisibility(name, visible)} />}
          {adminTab === 'offers' && <AdminOffers state={state} products={activeProducts} apiBase={API_BASE} token={adminToken} onNewCoupon={() => setCouponFormOpen(true)} onNewOffer={() => { setEditingOffer(null); setOfferFormOpen(true) }} onEditOffer={(offer) => { setEditingOffer(offer); setOfferFormOpen(true) }} toggleCoupon={toggleCoupon} deleteCoupon={deleteCoupon} toggleOffer={toggleOffer} deleteOffer={deleteOffer} onEdit={startEditProduct} updateState={updateState} notify={notify} />}
          {adminTab === 'orders' && <AdminOrders orders={state.orders} filter={orderFilter} setFilter={setOrderFilter} search={orderSearch} setSearch={setOrderSearch} onStatus={updateOrderStatus} />}
          {adminTab === 'content' && <section className="content-grid"><div className="panel content-editor"><div className="panel-heading"><div><h2>Storefront & campaigns</h2><p>Manage the homepage, promo banner, combos, and delivery estimates.</p></div><span className="saved-badge"><CheckCircle2 size={15} /> Saved to the catalog</span></div><form className="settings-form" onSubmit={saveContent}><label>Announcement bar<input name="announcement" defaultValue={state.content.announcement} /></label><h3 className="settings-subhead">Homepage & default link thumbnail</h3><p className="form-help">This is the default thumbnail for the homepage, offers listing, and product links. Individual offers can have their own thumbnail in Edit offer. Upload an image (recommended: 1200 × 630 px).</p><input type="hidden" name="socialShareImage" value={contentDraft.socialShareImage || ""} /><div className="social-thumbnail-uploader"><div className="social-thumbnail-preview">{contentDraft.socialShareImage ? <ImageView src={contentDraft.socialShareImage} alt="Homepage sharing thumbnail" /> : <div><ImageIcon size={24} /><span>No thumbnail uploaded</span></div>}</div><div><label className="secondary-button product-upload-button"><Upload size={16} />{contentDraft.socialShareImage ? "Replace thumbnail" : "Upload thumbnail"}<input type="file" accept="image/*" onChange={(event) => { void uploadSocialThumbnail(event.target.files?.[0]); event.currentTarget.value = "" }} /></label>{contentDraft.socialShareImage && <button type="button" className="secondary-button" onClick={() => setContentDraft((current) => ({ ...current, socialShareImage: "" }))}>Remove thumbnail</button>}</div></div><h3 className="settings-subhead">Hero carousel slides</h3><p className="form-help">Leave a headline, supporting text, or button text blank to hide it on that banner. For crisp banners, use desktop 16:7 (2880 × 1260 px or larger) and phone 4:5 (1800 × 2250 px). Uploads keep more detail while staying optimized.</p>{contentDraft.heroSlides.map((slide, index) => <div className="combo-editor" key={`hero-slide-${index}`}><div className="hero-slide-editor-heading"><b>Banner {index + 1}</b><div className="hero-slide-order"><button type="button" className="secondary-button" aria-label={`Move banner ${index + 1} earlier`} title="Move earlier" onClick={() => moveHeroSlide(index, -1)} disabled={index === 0}><ChevronUp size={16} /></button><button type="button" className="secondary-button" aria-label={`Move banner ${index + 1} later`} title="Move later" onClick={() => moveHeroSlide(index, 1)} disabled={index === contentDraft.heroSlides.length - 1}><ChevronDown size={16} /></button><button type="button" className="secondary-button" onClick={() => removeHeroSlide(index)} disabled={contentDraft.heroSlides.length <= 1}><Trash2 size={15} /> Remove banner</button></div></div><label>Desktop image URL<input value={slide.image} onChange={(event) => updateHeroSlide(index, { image: event.target.value })} /></label><label>Upload desktop image<input type="file" accept="image/*" onChange={(event) => uploadHeroSlideImage(index, event.target.files?.[0], false)} /></label><label>Phone image URL<input value={slide.mobileImage || ""} placeholder="Optional — uses desktop image if blank" onChange={(event) => updateHeroSlide(index, { mobileImage: event.target.value })} /></label><label>Upload phone image<input type="file" accept="image/*" onChange={(event) => uploadHeroSlideImage(index, event.target.files?.[0], true)} /></label><label>Headline<textarea rows={2} value={slide.title} onChange={(event) => updateHeroSlide(index, { title: event.target.value })} /></label><label>Supporting text<textarea rows={2} value={slide.description} onChange={(event) => updateHeroSlide(index, { description: event.target.value })} /></label><div className="settings-two"><label>Button text<input value={slide.cta} onChange={(event) => updateHeroSlide(index, { cta: event.target.value })} /></label><label>Button destination<input value={slide.link} onChange={(event) => updateHeroSlide(index, { link: event.target.value })} placeholder="/offers, /trending, / or full URL" /></label></div></div>)}<button type="button" className="secondary-button add-hero-slide" onClick={addHeroSlide}><Plus size={16} /> Add banner</button><h3 className="settings-subhead">Promotional banner</h3><label>Banner headline<textarea name="offerTitle" rows={2} defaultValue={state.content.offerTitle} /></label><label>Banner supporting line<textarea name="offerSubtitle" rows={2} defaultValue={state.content.offerSubtitle} /></label><label>Banner image URL<input name="offerImage" defaultValue={state.content.offerImage} /></label><h3 className="settings-subhead">Homepage combo cards</h3>{state.content.combos.map((combo, index) => <div className="combo-editor" key={`${combo.title}-${index}`}><b>Combo 0{index + 1}</b><label>Title<input name={`comboTitle${index}`} defaultValue={combo.title} /></label><div className="settings-two"><label>Subtitle<input name={`comboSubtitle${index}`} defaultValue={combo.subtitle} /></label><label>Price from (৳)<input name={`comboPrice${index}`} type="number" defaultValue={combo.price} /></label></div><label>Image URL<input name={`comboImage${index}`} defaultValue={combo.image} /></label></div>)}<h3 className="settings-subhead">Delivery charges</h3><div className="settings-two"><label>Dhaka city (৳)<input name="deliveryInDhaka" type="number" min="0" defaultValue={state.content.deliveryInDhaka} /></label><label>Sub-Dhaka (৳)<input name="deliverySubDhaka" type="number" min="0" defaultValue={state.content.deliverySubDhaka} /></label><label>Outside Dhaka (৳)<input name="deliveryOutsideDhaka" type="number" min="0" defaultValue={state.content.deliveryOutsideDhaka} /></label></div><p className="form-help">Default delivery charges are ৳70 in Dhaka city, ৳100 in Sub-Dhaka, and ৳120 outside Dhaka.</p><div className="settings-two"><div><p className="form-help">Move existing manually uploaded product, offer, and storefront images from MongoDB to Cloudinary. New uploads mirror automatically when saved.</p><p className={`form-help media-migration-status ${mediaMigrationStatus?.inlineImages === 0 && mediaMigrationStatus.configured ? 'success' : mediaMigrationStatus?.configured ? 'pending' : 'warning'}`} role="status">{mediaMigrationBusy ? 'Migration in progress…' : !mediaMigrationStatus ? 'Checking image storage status…' : !mediaMigrationStatus.configured ? 'Cloudinary is not configured on the API service.' : mediaMigrationStatus.inlineImages === 0 ? `Verified: ${mediaMigrationStatus.cloudinaryImages.toLocaleString()} uploaded images on Cloudinary; none remain in MongoDB as inline data.` : `${mediaMigrationStatus.inlineImages.toLocaleString()} inline image${mediaMigrationStatus.inlineImages === 1 ? '' : 's'} still need migration. ${mediaMigrationStatus.cloudinaryImages.toLocaleString()} already on Cloudinary.`}</p>{mediaMigrationMessage && <p className="form-help media-migration-result" role="status">{mediaMigrationMessage}</p>}<button type="button" className="secondary-button" onClick={() => { setMediaMigrationMessage(''); void migrateStorefrontMedia() }} disabled={mediaMigrationBusy}>{mediaMigrationBusy ? 'Moving images to CDN…' : 'Move uploaded images to Cloudinary'}</button></div><button className="primary-button"><Check size={17} /> Save storefront</button></div></form></div><div className="panel preview-panel"><div className="panel-heading"><div><h3>Homepage preview</h3><p>How the edit appears to customers</p></div><button className="subtle-icon" onClick={() => window.location.assign('/')} aria-label="Open storefront"><ArrowUpRight size={17} /></button></div><div className="mini-carousel">{[-1, 0, 1].map((offset) => { const index = (previewSlide + offset + contentDraft.heroSlides.length) % contentDraft.heroSlides.length; const slide = contentDraft.heroSlides[index]; return <button type="button" key={offset} className={`mini-carousel-card mini-carousel-${offset === 0 ? 'active' : offset < 0 ? 'left' : 'right'}`} onClick={() => setPreviewSlide(index)}><ImageView src={slide.image} alt="" /><span className="mini-carousel-shade" /><span className="mini-carousel-copy">{slide.title.trim() && <b>{slide.title}</b>}{slide.description.trim() && <small>{slide.description.split(/\r?\n/).map((line, lineIndex) => <span className="hero-description-line" key={`${index}-preview-description-${lineIndex}`}>{line}</span>)}</small>}{slide.cta.trim() && <i>{slide.cta} <ArrowRight size={12} /></i>}</span></button> })}<div className="mini-carousel-dots">{contentDraft.heroSlides.map((_, index) => <button key={index} className={previewSlide === index ? 'active' : ''} aria-label={`Preview slide ${index + 1}`} onClick={() => setPreviewSlide(index)} />)}</div></div><div className="preview-note"><ShieldCheck size={17} /> Storefront settings are shared through the catalog API.</div></div></section>}
          {adminTab === 'sync' && <SyncPanel lastSync={lastSync} importedCount={adminImportedCount} onLastSync={(value) => { setLastSync(value); localStorage.setItem('aaro-last-import', value) }} onSyncComplete={() => { backgroundCatalogStarted.current = false; catalogMetadataLoaded.current = false; setCatalogRefreshTick((tick) => tick + 1) }} importNote={importNote} fileRef={fileRef} onImport={importCsv} products={state.products} apiBase={API_BASE} token={adminToken} />}
          {adminTab === 'email' && <OrderEmailSettingsPanel apiBase={API_BASE} token={adminToken} notify={notify} />}
        </div>
      </main>
      {mobileMenu && <button className="admin-backdrop" onClick={() => setMobileMenu(false)} aria-label="Close menu" />}
      {productFormOpen && <ProductEditor product={editingProduct} categories={[...new Set([...state.categories.filter((item) => item !== 'All'), ...categoryGroups.flatMap((group) => group.children.map((child) => child.name))])]} onClose={() => setProductFormOpen(false)} onSave={saveProduct} />}
      {categoryNameEditor && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCategoryNameEditor(null)}><section className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CATEGORY</span><h2>Rename {categoryNameEditor.childName ? 'subcategory' : 'parent category'}</h2></div><IconButton label="Close category editor" onClick={() => setCategoryNameEditor(null)}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={saveCategoryName}><label>Category name<input name="name" required maxLength={180} defaultValue={categoryNameEditor.value} autoFocus /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setCategoryNameEditor(null)}>Cancel</button><button className="primary-button"><Check size={16} /> Save name</button></div></form></section></div>}
      {categoryImageEditor && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCategoryImageEditor(null)}><section className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / HOMEPAGE CATEGORY</span><h2>Choose an image for {categoryImageEditor.name}</h2></div><IconButton label="Close image picker" onClick={() => setCategoryImageEditor(null)}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={saveCategoryImage}><label>Use a product photo<select value={categoryImageEditor.value.startsWith('data:') ? '' : categoryImageEditor.value} onChange={(event) => setCategoryImageEditor((current) => current ? { ...current, value: event.target.value } : current)}><option value="">Choose a product</option>{adminProductList.filter((product) => product.image && product.category === categoryImageEditor.name).concat(adminProductList.filter((product) => product.image && product.category !== categoryImageEditor.name)).map((product) => <option value={product.image} key={product.id}>{product.title} · {product.category}</option>)}</select></label><label>Or upload a category image<input type="file" accept="image/*" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const value = await compressImageFile(file, 1000, 1000); setCategoryImageEditor((current) => current ? { ...current, value } : current) } catch (error) { notify(error instanceof Error ? error.message : 'Could not prepare this image.') } }} /></label>{categoryImageEditor.value && <div className="category-image-preview"><ImageView src={categoryImageEditor.value} alt={`${categoryImageEditor.name} preview`} /></div>}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setCategoryImageEditor(null)}>Cancel</button><button className="primary-button"><Check size={16} /> Save image</button></div></form></section></div>}
      {viewingProduct && <AdminProductViewer product={viewingProduct} onClose={() => setViewingProduct(null)} onEdit={() => { const product = viewingProduct; setViewingProduct(null); void startEditProduct(product) }} />}
      {couponFormOpen && <CouponEditor onClose={() => setCouponFormOpen(false)} onSave={saveCoupon} />}
      {offerFormOpen && <OfferEditor offer={editingOffer} products={activeProducts} apiBase={API_BASE} onClose={() => { setOfferFormOpen(false); setEditingOffer(null) }} onSave={saveOffer} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div> : adminRoute ? adminSessionChecking && adminToken ? <main className="admin-login-page"><div className="login-modal" role="status">Restoring your admin session…</div></main> : <AdminLogin apiBase={API_BASE} onSuccess={(token, rememberMe) => { localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY); (rememberMe ? localStorage : sessionStorage).setItem(rememberMe ? ADMIN_TOKEN_KEY : ADMIN_SESSION_TOKEN_KEY, token); setAdminToken(token); setAdmin(true) }} /> : !storeIsLive ? <main className={`store-closed-page ${darkTheme ? 'theme-dark' : ''}`}><span className="wordmark">AARO<span>.</span></span><h1>We’ll be back soon</h1><p>Our store is temporarily closed while we make a few updates. Please check back shortly.</p></main> : (authRoute || (page === 'account' && !accountToken)) ? <AccountAccessPage key={authRoute || 'login'} mode={authRoute || 'login'} apiBase={API_BASE} darkTheme={darkTheme} onToggleTheme={() => setDarkTheme((current) => !current)} onModeChange={showAuth} onBack={() => showStore('shop')} onAuth={(token, identifier) => { setAccountToken(token); localStorage.setItem(AUTH_TOKEN_KEY, token); setUser(identifier); localStorage.setItem(USER_KEY, identifier); showAccount() }} /> : <div className={`storefront ${darkTheme ? 'theme-dark' : ''} ${mobileMenu ? 'storefront-menu-open' : ''}`}>
      <div className="announcement"><Sparkles size={14} /><span>{state.content.announcement}</span><button onClick={() => showStore('offers')}>Shop offers <ArrowRight size={13} /></button></div>
      <header className={`site-header ${mobileMenu ? 'mobile-menu-active' : ''}`}>
        <div className="header-main page-width"><button className="mobile-menu-trigger storefront-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Open navigation"><Menu size={22} /></button><button className="wordmark" onClick={() => showStore('shop')} aria-label="AARO home"><img src={darkTheme ? "/images/aaro-logo-lime-transparent.png" : "/images/aaro-logo-orange.png"} alt="AARO" /></button>
          {mobileMenu && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
          <div className={`desktop-nav ${mobileMenu ? 'desktop-nav-open' : ''}`}><div className="mobile-nav-heading"><strong>Browse AARO</strong><button type="button" onClick={() => { setMobileMenu(false); setCategoryMenuOpen(false); setActiveCategoryMenuId('') }} aria-label="Close navigation"><X size={20} /></button></div><button className={page === 'shop' ? 'nav-current' : ''} onClick={() => showStore('shop')}>Discover</button><div className={`category-nav ${categoryMenuOpen ? 'category-nav-open' : ''}`} onMouseEnter={() => { if (!window.matchMedia('(max-width: 780px)').matches) setCategoryMenuOpen(true) }} onMouseLeave={() => { if (!window.matchMedia('(max-width: 780px)').matches) { setCategoryMenuOpen(false); setActiveCategoryMenuId('') } }}><button aria-expanded={categoryMenuOpen} onClick={() => setCategoryMenuOpen((open) => !open)}>Categories <ChevronDown size={14} /></button><div className={`category-dropdown ${activeCategoryMenuId ? 'category-dropdown-expanded' : ''}`}><div className="category-menu-list">{storefrontCategoryGroups.map((group) => <section className={`category-menu-group ${activeCategoryMenuId === group.id ? 'category-menu-group-active' : ''}`} key={group.id} onMouseEnter={() => { if (!window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId(group.id) }} onFocus={() => { if (!window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId(group.id) }}><button className="category-menu-parent" aria-expanded={activeCategoryMenuId === group.id} onClick={() => { if (window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId((active) => active === group.id ? '' : group.id); else showStore('category', group.name, '', group.id) }}>{group.name}<ArrowRight size={13} /></button><div className="category-menu-inline-children">{group.children.map((child) => <button className="category-menu-child" key={`${group.id}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', group.id)}>{child.name}</button>)}</div></section>)}</div>{activeCategoryMenuId && (() => { const group = storefrontCategoryGroups.find((item) => item.id === activeCategoryMenuId); return group ? <div className="category-menu-subcategories"><button className="category-menu-view-all" onClick={() => showStore('category', group.name, '', group.id)}>Shop all {group.name}<ArrowRight size={13} /></button>{group.children.map((child) => <button className="category-menu-child" key={`${group.id}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', group.id)}>{child.name}</button>)}</div> : null })()}</div></div><button className={page === 'trending' ? 'nav-current' : ''} onClick={() => showStore('trending')}>Trending now</button><button className={page === 'offers' ? 'nav-current' : ''} onClick={() => showStore('offers')}>Offers</button></div>
          <div className="header-actions"><form className={`search-wrap ${showSearch ? 'search-focused' : ''}`} onSubmit={(event) => { event.preventDefault(); submitSearch() }}><Search size={18} />{!query && !showSearch && <span className="search-placeholder" aria-hidden="true"><span className="search-placeholder-fixed">Search</span><span className="search-placeholder-changing">{searchPlaceholder}<i>|</i></span></span>}<input ref={searchRef} value={query} onFocus={() => setShowSearch(true)} onChange={(event) => { setQuery(event.target.value); setShowSearch(Boolean(event.target.value.trim())) }} onKeyDown={(event) => { if (event.key === 'Escape') { setShowSearch(false); setQuery('') } }} placeholder="" aria-label="Search products" />{query && <button type="button" onClick={() => { setQuery(''); setSubmittedQuery(''); searchRef.current?.focus() }} aria-label="Clear search"><X size={15} /></button>}</form><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle" onClick={() => setDarkTheme((current) => !current)}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><IconButton label={user ? 'Your profile' : 'Account login'} onClick={() => user ? showAccount() : showAuth('login')}><UserRound size={20} /></IconButton><IconButton label={`Wishlist, ${wishlist.length} saved`} onClick={() => { setPage('wishlist'); setCategory('All'); setQuery(''); setSubmittedQuery(''); setShowSearch(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Heart size={19} /><i className="action-count">{wishlist.length}</i></IconButton><IconButton label={`Shopping bag, ${cart.reduce((sum, line) => sum + line.quantity, 0)} items`} onClick={() => { setCartOpen(true); setCheckout(false); if (window.location.pathname === '/checkout') history.replaceState({}, '', '/') }}><ShoppingBag size={19} /><i className="action-count">{cart.reduce((sum, line) => sum + line.quantity, 0)}</i></IconButton></div>
        </div>
        {showSearch && query && <div className="search-suggestions page-width"><div><span>QUICK RESULTS</span><button onClick={submitSearch}>View all results <ArrowRight size={13} /></button></div>{searchSuggestions.map((product) => <button key={product.id} className="suggestion-item" onClick={() => openProduct(product)}><ImageView src={product.image} alt="" /><span>{product.title}<small>{product.category}</small></span><b>{money(product.price)}</b></button>)}{!searchSuggestions.length && <p className="empty-search" role={prioritySearchError ? 'alert' : 'status'}>{prioritySearchLoading ? <><span className="loading-orbit" /> Searching products…</> : query.trim().length < 2 ? 'Type at least 2 characters to search.' : prioritySearchError ? 'Quick search is temporarily unavailable. Choose “View all results” to try again.' : 'No products found. Try another search.'}</p>}</div>}
      </header>
      <main onClick={(event) => { if (showSearch && !(event.target as HTMLElement).closest('.search-wrap,.search-suggestions')) setShowSearch(false) }}>
        <>
        {catalogError && (page !== 'shop' || Boolean(submittedQuery)) && <div className="catalog-warning" role="status">The live catalog could not be reached. Showing any saved products available in this browser.</div>}
        {productRouteId && !selectedProduct ? routeProductLoading || catalogLoading ? <div className="product-route-loading page-width" role="status"><span className="loading-orbit" />Loading this product…</div> : <div className="product-route-loading page-width" role="alert"><b>{routeProductError || 'This product could not be found.'}</b><button className="text-link" onClick={() => showStore('shop')}>Back to shopping</button></div> : checkout ? <CheckoutPage cartItems={cartItems} cartLineCount={cart.length} catalogLoading={catalogLoading} subtotal={subtotal} delivery={state.content.deliveryInDhaka} subDhakaDelivery={state.content.deliverySubDhaka} outsideDelivery={state.content.deliveryOutsideDhaka} district={selectedDistrict} thana={selectedThana} onDistrict={setSelectedDistrict} onThana={setSelectedThana} offerSavings={appliedOfferSavings} deliverySavings={deliverySavings} bundleSavings={appliedBundleSavings} couponSavings={appliedCouponSavings} total={subtotal + deliveryFee - discount} freeDelivery={freeDeliveryApplied} coupon={coupon} onPlaceOrder={placeOrder} onBack={returnToBag} /> : selectedProduct ? <ProductPage product={selectedProduct} offers={state.offers.filter((item) => item.active && (item.productIds?.includes(selectedProduct.id) || item.productId === selectedProduct.id))} relatedProducts={activeProducts.filter((item) => item.categorySourceId === selectedProduct.categorySourceId && item.id !== selectedProduct.id).slice(0, 4)} wishlist={wishlist} wished={wishlist.includes(selectedProduct.id)} onClose={closeProduct} onWish={toggleWish} onOpen={openProduct} onSeeRelated={() => showStore('category', selectedProduct.category, selectedProduct.categorySourceId || '', selectedProduct.parentCategoryId || '')} onAdd={(product, quantity, size, options) => { addToCart(product, quantity, size, options) }} /> : <>
        {page === 'shop' && !submittedQuery && <><section className="hero page-width"><div className="hero-art" onTouchStart={(event) => { setHeroCarouselPaused(true); heroTouchStartX.current = event.touches[0]?.clientX ?? null }} onTouchEnd={(event) => { const start = heroTouchStartX.current; const end = event.changedTouches[0]?.clientX; if (start !== null && end !== undefined && Math.abs(end - start) > 45) moveHeroCarousel(end < start ? 1 : -1); heroTouchStartX.current = null; setHeroCarouselPaused(false) }} aria-label="AARO featured collections"><div className="hero-carousel-track">{heroImages.map((image, index) => { const next = (activeHeroSlide + 1) % heroImages.length; const previous = (activeHeroSlide - 1 + heroImages.length) % heroImages.length; const role = index === activeHeroSlide ? 0 : index === next ? 1 : index === previous ? 2 : 3; const slide = heroSlides[index]; return <article key={`${index}-${image}`} className={`hero-carousel-card hero-carousel-image-${role} ${role === 0 ? 'hero-carousel-active' : ''}`} aria-hidden={role === 3} aria-label={role === 1 ? `Show next banner ${index + 1}` : role === 2 ? `Show previous banner ${index + 1}` : undefined} onClick={() => { if (role === 1 || role === 2) setHeroSlide(index) }} onKeyDown={(event) => { if ((role === 1 || role === 2) && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setHeroSlide(index) } }} role={role === 0 || role === 3 ? undefined : 'button'} tabIndex={role === 0 || role === 3 ? -1 : 0}><HeroCarouselPhoto src={image} mobileSrc={slide.mobileImage || ""} alt="AARO fashion collection" loading={role === 3 ? "lazy" : "eager"} priority={role === 0} /><span className="hero-carousel-shade" /><div className="hero-carousel-copy">{slide.title.trim() && <h1>{slide.title.split(/\r?\n/).map((line, lineIndex) => <span className="hero-title-line" key={`${index}-title-${lineIndex}`}>{line}</span>)}</h1>}{slide.description.trim() && <p>{slide.description.split(/\r?\n/).map((line, lineIndex) => <span className="hero-description-line" key={`${index}-description-${lineIndex}`}>{line}</span>)}</p>}{slide.cta.trim() && <button className="hero-slide-cta" tabIndex={role === 0 ? 0 : -1} onMouseEnter={() => setHeroCarouselPaused(true)} onMouseLeave={() => setHeroCarouselPaused(false)} onClick={() => { const target = slide.link.trim(); if (target === '/offers') showStore('offers'); else if (target === '/trending') showStore('trending'); else if (target === '/') showStore('shop'); else if (target) window.location.assign(target) }}>{slide.cta} <ArrowRight size={17} /></button>}</div></article> })}</div><button type="button" className="hero-side-hit hero-side-hit-prev" aria-label="Show previous banner" onClick={() => moveHeroCarousel(-1)} /><button type="button" className="hero-side-hit hero-side-hit-next" aria-label="Show next banner" onClick={() => moveHeroCarousel(1)} /></div><div className="hero-carousel-dots" aria-label="Choose featured collection">{heroImages.map((_, index) => <button key={index} className={activeHeroSlide === index ? 'active' : ''} aria-label={`Show featured collection ${index + 1}`} onClick={() => setHeroSlide(index)} />)}</div></section>
          <section className="service-strip page-width"><div><span className="service-icon"><Truck size={19} /></span><span><b>Delivery across Bangladesh</b><small>Dhaka & beyond</small></span></div><div><span className="service-icon"><ShieldCheck size={19} /></span><span><b>Thoughtful, trusted picks</b><small>Picked with care</small></span></div><div><span className="service-icon"><RotateCcw size={19} /></span><span><b>Easy order support</b><small>We’re here to help</small></span></div><div><span className="service-icon"><Package size={19} /></span><span><b>10,000+ products</b><small>Across 100+ categories</small></span></div></section>
          <section className="category-section page-width"><div className="section-heading"><div><span className="section-kicker">A LITTLE BIT OF EVERYTHING</span><h2>Find your kind of good.</h2></div><div className="category-carousel-controls"><button aria-label="Previous categories" onClick={() => categoryCarouselRef.current && slideCategoryCarousel(categoryCarouselRef.current, -1)}><ChevronLeft size={18} /></button><button aria-label="Next categories" onClick={() => { const carousel = categoryCarouselRef.current; if (!carousel) return; const distanceToEnd = carousel.scrollWidth - carousel.clientWidth - carousel.scrollLeft; slideCategoryCarousel(carousel, 1); if (distanceToEnd <= Math.max(120, carousel.clientWidth * 0.45)) void loadMoreHomeCategories() }}><ChevronRight size={18} /></button><button className="text-link" onClick={() => showStore('category', 'All')}>Browse all Categories <ArrowRight size={16} /></button></div></div><div className="category-tiles" ref={categoryCarouselRef}>{catalogLoading && !visibleHomeCategories.length ? <CategoryLoadingCards /> : visibleHomeCategories.map(({ category: categoryName, products }, index) => <button className="category-tile" style={{ animationDelay: `${Math.min(index, 8) * 55}ms` }} key={categoryName} onClick={() => showStore('category', categoryName)}><ImageView src={state.content.categoryImages?.[categoryName] || products[0].image} alt={categoryName} /><span className="tile-overlay" /><span className="tile-copy"><b>{categoryName}</b><i>Explore <ArrowRight size={15} /></i></span><span className="category-dismiss" role="button" aria-label={`Hide ${categoryName} for this session`} onClick={(event) => { event.stopPropagation(); dismissHomeCategory(categoryName) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); dismissHomeCategory(categoryName) } }}>×</span></button>)}</div>{homeCategoryPage.loading && <p className="home-category-loading" role="status"><span className="loading-orbit" /> Loading more categories…</p>}</section>
          {catalogLoading && homeTrendingProducts.length === 0 && <ProductLoadingSection title="Trending now" />} {homeTrendingProducts.length > 0 && <ProductSection title="Trending now" kicker="POPULAR RIGHT NOW" products={homeTrendingProducts} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('trending')} />}
          {homeOfferProducts.length > 0 && <><OfferBanner state={state} onShop={() => showStore('offers')} /><ProductSection title="A good deal, indeed." kicker="CURRENT OFFERS" products={homeOfferProducts} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('offers')} compact /></>}
          </>}
        {page === 'terms' && !submittedQuery && <section className="terms-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Terms & Conditions</span></div><article className="terms-card"><span className="legal-kicker">AARO / CUSTOMER TERMS</span><h1>Terms &amp; Conditions</h1><p className="terms-lead">These simple terms explain what to expect when placing an order with AARO.</p><h2>Products and prices</h2><p>We do our best to show accurate product photos, descriptions, prices, and availability. Colors may look slightly different on different screens, and availability can change before an order is confirmed.</p><h2>Placing an order</h2><p>Please provide accurate delivery details and contact information. We may contact you to confirm your order or clarify its details. An order is confirmed once AARO has reviewed and accepted it.</p><h2>Payment and delivery</h2><p>Product prices are shown in Bangladeshi taka. Any delivery charge will be shown before you submit your order. Available payment methods and delivery details are provided during checkout.</p><h2>Order changes</h2><p>If you need to correct or cancel an order, contact us as soon as possible. We may be unable to change an order after it has been prepared or handed to the courier.</p><p>For parcel inspection, returns, and exchanges, please read our <button className="terms-inline-link" onClick={() => showStore('delivery')}>Delivery &amp; Returns policy</button>.</p><button className="dark-button" onClick={() => showStore('shop')}>Continue shopping <ArrowRight size={16} /></button></article></section>}
        {page === 'delivery' && !submittedQuery && <section className="legal-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Delivery & Returns</span></div><article className="legal-card"><span className="legal-kicker">AARO / DELIVERY CARE</span><h1>Delivery & Returns</h1><p className="legal-intro">We deliver across Bangladesh. Here are the delivery charges and what to do if there is a problem with your order.</p><section><h2>Delivery charges</h2><ul><li><b>Dhaka city:</b> {money(state.content.deliveryInDhaka)}</li><li><b>Sub-Dhaka:</b> {money(state.content.deliverySubDhaka)}</li><li><b>Outside Dhaka:</b> {money(state.content.deliveryOutsideDhaka)}</li></ul><p>Any applicable delivery charge will be shown during checkout before you place your order.</p><p><b>Estimated delivery:</b> Dhaka city and Sub-Dhaka: 2–3 days. Outside Dhaka: 5–6 days.</p></section><section><h2>Order confirmation</h2><p>We may call the phone number on your order to confirm it. Please provide an active number and stay reachable. We cannot confirm an order if we are unable to reach you.</p></section><section><h2>Check your parcel at delivery</h2><p>Please check your product while the courier is present. If it is damaged, incorrect, or has another issue, tell the courier immediately and contact us at once.</p></section><section><h2>Returns and exchanges</h2><p>If you ask to return or exchange an item after the courier has left, an additional delivery charge will apply. Products that have been used or damaged after delivery cannot be returned. We will review the issue with you before arranging a return or exchange.</p></section><p className="legal-contact-note">For help with a delivery or return, contact us with your order number and the phone number used for the order.</p><button className="dark-button delivery-contact-button" onClick={() => showStore('contact')}>Contact us <ArrowRight size={16} /></button></article></section>}
        {page === 'contact' && !submittedQuery && <section className="legal-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Contact us</span></div><article className="legal-card contact-card"><span className="legal-kicker">AARO / HERE TO HELP</span><h1>Contact us</h1><p className="legal-intro">Questions about a product, delivery, or an order? Contact AARO using either option below.</p><div className="contact-options"><a href="https://wa.me/8801731955291" target="_blank" rel="noopener noreferrer"><span className="contact-option-icon"><Phone size={20} /></span><span><small>WHATSAPP</small><b>+880 1731 955 291</b><i>Chat with us on WhatsApp <ArrowUpRight size={15} /></i></span></a><a href="mailto:aaro.shop.bd@gmail.com"><span className="contact-option-icon"><Mail size={20} /></span><span><small>EMAIL</small><b>aaro.shop.bd@gmail.com</b><i>Send us an email <ArrowUpRight size={15} /></i></span></a></div><p className="contact-help-note">For order support, include your order number and the phone number used when placing it.</p></article></section>}
        {page === 'account' && (accountProfile ? <AccountDashboard apiBase={API_BASE} token={accountToken} profile={accountProfile} orders={customerOrders} onProfile={setAccountProfile} onSignOut={signOutCustomer} notify={notify} /> : <div className="catalog-message page-loading-status" role="status"><span className="loading-orbit" />Loading your account…</div>)}
        {(page !== 'shop' && page !== 'combos' && page !== 'account' && page !== 'terms' && page !== 'delivery' && page !== 'contact') || submittedQuery ? <section className="listing-page page-width">
          <div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>{submittedQuery ? 'Search results' : page === 'category' ? category : formatPageTitle}</span></div>
          <div className="listing-heading"><div><span className="section-kicker">{page === 'offers' ? selectedOfferCollection ? `OFFER COLLECTION / ${selectedOfferCount.toLocaleString()} FINDS` : `THE AARO EDIT / ${offerCollections.length} OFFERS` : `THE AARO EDIT / ${visibleProducts.length} FINDS`}</span><h1>{submittedQuery ? `Results for “${submittedQuery}”` : page === 'offers' && selectedOfferCollection ? selectedOfferCollection.title : formatPageTitle}</h1><p>{page === 'offers' && selectedOfferCollection ? selectedOfferCollection.description : page === 'offers' ? 'Browse a good deal by collection. Open one to see all eligible finds and offer details.' : page === 'trending' ? 'The pieces customers keep coming back for.' : page === 'wishlist' ? 'All the things you have saved for later.' : 'Good things, picked with your everyday in mind.'}</p></div>{(page === 'category' || page === 'trending' || page === 'wishlist' || page === 'offers' && Boolean(selectedOfferId) || page === 'shop' && Boolean(submittedQuery)) && <PriceSortMenu value={priceSort} onChange={(value) => { setPriceSort(value); if (page === 'offers' && selectedOfferId) void loadOfferProductPage(selectedOfferId, 0, false, value) }} />}{page === 'category' && <button className="filter-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={16} /> Filters <ChevronDown size={14} /></button>}{page === 'offers' && selectedOfferId && <button className="secondary-button offer-back-button" onClick={closeOfferCollection}><ChevronLeft size={16} /> All offers</button>}</div>
          {page === 'category' && <>
            <div className="category-search-tools">
              <label className="category-navigation-search"><Search size={17} /><input type="search" value={categoryNavigationSearch} onChange={(event) => setCategoryNavigationSearch(event.target.value)} placeholder="Search categories and subcategories" aria-label="Search categories and subcategories" />{categoryNavigationSearch && <button type="button" aria-label="Clear category search" onClick={() => setCategoryNavigationSearch('')}>×</button>}</label>
              <label className="category-navigation-search category-product-search"><Search size={17} /><input type="search" value={categoryProductSearch} onChange={(event) => setCategoryProductSearch(event.target.value)} placeholder={`Search products in ${category === 'All' ? 'all categories' : category}`} aria-label="Search products in this category" />{categoryProductSearch && <button type="button" aria-label="Clear product search" onClick={() => setCategoryProductSearch('')}>×</button>}</label>
            </div>
            <div className="filter-chips">{visibleCategoryGroups.map((group) => <button className={selectedParentCategoryId === group.id ? 'selected' : ''} key={group.id} onClick={() => showStore('category', group.name, '', group.id)}>{group.name}</button>)}{!visibleCategoryGroups.length && <span className="category-search-empty">No categories match.</span>}</div>
            {selectedParentCategoryId && <div className="filter-chips subcategory-chips">{visibleSubcategories.map((child) => <button className={category === child.name ? 'selected' : ''} key={`${selectedParentCategoryId}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', selectedParentCategoryId)}>{child.name}</button>)}</div>}
          </>}
          {page === 'category' && filtersOpen && <div className="catalog-filters"><label className="sort-control">Sort by<select value={priceSort} onChange={(event) => setPriceSort(event.target.value as typeof priceSort)}><option value="recommended">Recommended</option><option value="low-high">Price: low to high</option><option value="high-low">Price: high to low</option></select></label><div className="price-range"><div className="price-range-heading"><b>Price range</b><span>{money(minPrice)} – {money(Math.min(maxPrice, catalogMaxPrice))}</span></div><label>Minimum price<input aria-label="Minimum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(minPrice, catalogMaxPrice)} onChange={(event) => setMinPrice(Math.min(Number(event.target.value), maxPrice))} /></label><label>Maximum price<input aria-label="Maximum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(maxPrice, catalogMaxPrice)} onChange={(event) => setMaxPrice(Math.max(Number(event.target.value), minPrice))} /></label></div><button className="reset-filters" onClick={() => { setMinPrice(0); setMaxPrice(catalogMaxPrice); setPriceSort('recommended') }}>Reset filters</button></div>}
          {page === 'offers' && !selectedOfferId ? offersLoading && !offerCollections.length ? <OfferCollectionsLoading /> : offersError && !offerCollections.length ? <div className="empty-state" role="alert"><Tags size={27} /><h3>Offers could not be loaded</h3><p>{offersError}</p><button className="dark-button" onClick={() => { offersFetchedRef.current = false; setCatalogRefreshTick((tick) => tick + 1) }}>Try again <ArrowRight size={16} /></button></div> : offerCollections.length ? <div className="offer-collection-grid">{offerCollections.map((collection) => <button type="button" className="offer-collection-card" key={collection.id} onClick={() => openOfferCollection(collection.id)}><div className="offer-collection-art"><OfferCollectionImageStrip ids={collection.thumbnailProductIds} products={activeProducts} title={collection.title} /><span className="offer-collection-count">{collection.offer ? `${(collection.offer.productCount ?? collection.offer.productIds?.length ?? 0).toLocaleString()} ${(collection.offer.productCount ?? collection.offer.productIds?.length ?? 0) === 1 ? 'product' : 'products'}` : collection.storewide ? 'Storewide' : `${collection.products.length.toLocaleString()} products`}</span></div><div className="offer-collection-copy"><span className="section-kicker">{collection.storewide ? 'STOREWIDE OFFER' : 'THE AARO DEAL EDIT'}</span><h2>{collection.title}</h2><p>{collection.description.split("\n").map((line, index) => <span className="offer-summary-line" key={`${collection.id}-summary-${index}`}>{line}</span>)}</p><span className="offer-collection-link">Explore offer <ArrowRight size={16} /></span></div></button>)}</div> : <div className="empty-state"><Tags size={27} /><h3>No offers available right now</h3><p>Check back soon for new product deals and savings.</p><button className="dark-button" onClick={() => showStore('shop')}>Explore all products <ArrowRight size={16} /></button></div> : page === 'offers' && selectedOfferId ? (offersLoading && !selectedOfferCollection || catalogLoading && (!selectedOfferCollection || selectedOfferCollection.products.length === 0)) ? <ProductLoadingSection title="Loading offer" /> : selectedOfferCollection ? <><div className="offer-detail-banner"><Tags size={20} /><div><small>Offer details</small><b>{selectedOfferCollection.coupon ? selectedOfferCollection.description : selectedOfferCollection.offer ? offerDealSummary(selectedOfferCollection.offer, selectedOfferCollection.products) : selectedOfferCollection.description}</b>{selectedOfferCollection.offer?.kind === 'buy_multiple' && <span>Mix and match any items in this offer to unlock these deals.</span>}{selectedOfferCollection.storewide && selectedOfferCollection.offer?.kind === 'free_delivery' && <span>Choose your delivery area at checkout to see the offer applied.</span>}</div>{selectedOfferCollection.coupon && <button type="button" className="coupon-copy-button" onClick={() => { void navigator.clipboard?.writeText(selectedOfferCollection.coupon?.code || ''); notify(`${selectedOfferCollection.coupon?.code || 'Coupon'} copied`) }}>Copy {selectedOfferCollection.coupon.code} <Copy size={14} /></button>}</div>{offerPageProducts.length ? <><div className="product-grid listing-grid">{offerPageProducts.map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} />)}</div>{offerProductPage.hasMore && <button className="load-more-button" disabled={offerProductPage.loadingMore} onClick={() => void loadOfferProductPage(selectedOfferId!, offerProductPage.nextOffset, true, priceSort)}>{offerProductPage.loadingMore ? 'Loading more products…' : 'Load more products'} <span>Showing {offerPageProducts.length.toLocaleString()} of {(offerProductPage.total || selectedOfferCount).toLocaleString()}</span></button>}{offerProductPage.error && <p className="form-error" role="alert">{offerProductPage.error}</p>}</> : offerProductPage.error ? <div className="empty-state" role="alert"><Tags size={27} /><h3>Offer products could not be loaded</h3><p>{offerProductPage.error}</p><button className="secondary-button" onClick={() => void loadOfferProductPage(selectedOfferId!)}><RefreshCw size={15} /> Try again</button></div> : offerProductPage.loading || offersLoading ? <ProductLoadingSection title="Loading offer products" /> : <div className="empty-state"><Tags size={27} /><h3>No active products in this offer</h3><p>The products in this offer may have been hidden or removed.</p><button className="secondary-button" onClick={closeOfferCollection}><ChevronLeft size={16} /> All offers</button></div>}</> : <div className="empty-state"><Tags size={27} /><h3>This offer is no longer available</h3><button className="secondary-button" onClick={closeOfferCollection}><ChevronLeft size={16} /> All offers</button></div> : visibleProducts.length ? <><div className="product-grid listing-grid">{visibleProducts.slice(0, productsToShow).map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} />)}</div>{(visibleProducts.length > productsToShow || listingPage.key === currentCatalogListingKey && listingPage.hasMore) && <button className="load-more-button" disabled={listingPage.loadingMore} onClick={() => visibleProducts.length > productsToShow ? setProductsToShow((count) => Math.min(count + 48, visibleProducts.length)) : void loadMoreCatalogListing()}>{listingPage.loadingMore ? 'Loading more products…' : 'Load more products'} <span>Showing {Math.min(productsToShow, visibleProducts.length).toLocaleString()} of {(listingPage.key === currentCatalogListingKey ? listingPage.total : visibleProducts.length).toLocaleString()}</span></button>}{page === 'trending' && trendingPage.hasMore && <button className="load-more-button" disabled={trendingPage.loadingMore} onClick={() => void loadMoreTrending()}>{trendingPage.loadingMore ? <><span className="loading-orbit" aria-hidden="true" /> Loading more products…</> : 'Load more'}<span>Showing {selectedTrendingProducts.length.toLocaleString()} products</span></button>}{page === 'trending' && trendingPage.error && <p className="form-error" role="alert">{trendingPage.error} <button type="button" onClick={() => void loadMoreTrending()}>Try again</button></p>}{listingPage.error && listingPage.key === currentCatalogListingKey && <p className="form-error" role="alert">{listingPage.error}</p>}</> : catalogLoading ? <ProductLoadingSection title={submittedQuery ? 'Searching products' : 'Loading products'} /> : catalogError ? <div className="empty-state" role="alert"><Search size={27} /><h3>The live catalog could not be reached</h3><p>Your search has not been marked as empty. Try the catalog again in a moment.</p><button className="dark-button" onClick={() => setCatalogRefreshTick((tick) => tick + 1)}>Try again <ArrowRight size={16} /></button></div> : <div className="empty-state"><Search size={27} /><h3>{page === 'wishlist' ? 'Nothing saved just yet' : 'No finds in this range'}</h3><p>{page === 'wishlist' ? 'Tap the heart on anything you love and it will show up here.' : 'Adjust the price range or browse another category.'}</p><button className="dark-button" onClick={() => { setQuery(''); showStore('shop') }}>Explore all products <ArrowRight size={16} /></button></div>}
        </section> : null}
        {page === 'combos' && !submittedQuery && <section className="listing-page page-width combo-list-page"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Combos</span></div><div className="listing-heading"><div><span className="section-kicker">AARO, ALL TOGETHER</span><h1>The good things set.</h1><p>Considered combinations for gifting, keeping, or making your day.</p></div></div><div className="combo-grid">{state.content.combos.map((combo, index) => <div className="combo-card combo-card-static" key={combo.title}><div className={`combo-photo combo-photo-${index + 1}`}><ImageView src={combo.image} alt={combo.title} /><span>THE SET EDIT</span><b>0{index + 1}</b></div><div><span>{combo.subtitle}</span><strong>{combo.title}</strong><small>From {money(combo.price)} <ArrowRight size={14} /></small></div><button className="dark-button" onClick={() => showStore('shop')}>Browse products <ArrowRight size={15} /></button></div>)}</div></section>}
        
        </>}
        </>
      </main>
      <footer className="site-footer"><div className="footer-main page-width"><div className="footer-brand"><button className="wordmark" onClick={() => showStore('shop')}><img src="/images/aaro-logo-lime-transparent.png" alt="AARO" /></button><p>Good finds for bright everyday living.</p><div className="footer-socials" aria-label="Follow AARO"><a href="https://www.facebook.com/aarostorebd" target="_blank" rel="noreferrer" aria-label="AARO on Facebook"><img src="/images/facebook.svg" alt="" /></a><a href="https://www.instagram.com/aarostorebd" target="_blank" rel="noreferrer" aria-label="AARO on Instagram"><img src="/images/instagram.svg" alt="" /></a><a href="https://www.tiktok.com/@aarostorebd" target="_blank" rel="noreferrer" aria-label="AARO on TikTok"><img src="/images/tiktok.svg" alt="" /></a></div></div><div className="footer-column"><b>Discover</b><button onClick={() => showStore('trending')}>Trending now</button><button onClick={() => showStore('offers')}>Offers</button></div><div className="footer-column"><b>Helpful things</b><button onClick={() => showStore('terms')}>Terms & Conditions</button><button onClick={() => showStore('delivery')}>Delivery & returns</button><button onClick={() => showStore('contact')}>Contact us</button><button onClick={() => user ? showAccount() : showAuth('login')}>Your account</button></div><div className="footer-contact"><span className="section-kicker">A LITTLE HELP?</span><p>Questions, ideas, or a product request?</p><button onClick={() => showStore('contact')}>Say hello <ArrowRight size={15} /></button></div></div><div className="footer-bottom page-width"><span>© 2026 AARO. All rights reserved.</span><span>Designed for the everyday, with a little extra.</span></div></footer>
      {cartOpen && <CartDrawer cartItems={cartItems} subtotal={subtotal} delivery={state.content.deliveryInDhaka} subDhakaDelivery={state.content.deliverySubDhaka} outsideDelivery={state.content.deliveryOutsideDhaka} offerSavings={appliedOfferSavings} deliverySavings={deliverySavings} bundleSavings={appliedBundleSavings} couponSavings={appliedCouponSavings} coupon={coupon} couponInput={couponInput} setCouponInput={setCouponInput} applyCoupon={applyCoupon} clearCoupon={() => setCoupon(null)} onQuantity={setQuantity} onSize={setCartSize} onOption={setCartOption} onClose={() => setCartOpen(false)} onCheckout={beginCheckout} onShop={() => { setCartOpen(false); showStore('shop') }} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>}
  </>
}

function ProductCard({ product, wished, onWish, onOpen, onAdd }: { product: Product; wished: boolean; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void }) {
  const salePercent = salePercentOf(product)
  const [addedPulse, setAddedPulse] = useState(false)
  const pulseTimer = useRef<number | null>(null)
  const pulseFrame = useRef<number | null>(null)
  useEffect(() => () => { if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current); if (pulseFrame.current !== null) window.cancelAnimationFrame(pulseFrame.current) }, [])
  const handleAdd = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current)
    if (pulseFrame.current !== null) window.cancelAnimationFrame(pulseFrame.current)
    setAddedPulse(false)
    pulseFrame.current = window.requestAnimationFrame(() => {
      setAddedPulse(true)
      pulseTimer.current = window.setTimeout(() => setAddedPulse(false), 650)
    })
    onAdd(product)
  }
  return <article className="product-card"><div className="product-image" onClick={() => onOpen(product)} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen(product)}><ImageView src={product.image} alt={product.title} />{product.badge && <span className="product-badge">{product.badge}</span>}{salePercent > 0 && <span className="product-badge product-sale-badge">{salePercent}% OFF</span>}<IconButton label={wished ? 'Remove from wishlist' : 'Add to wishlist'} className={`wishlist-button ${wished ? 'wished' : ''}`} onClick={() => onWish(product.id)}><Heart size={17} fill={wished ? 'currentColor' : 'none'} /></IconButton><button className={`quick-add quick-add-icon ${addedPulse ? 'is-added' : ''}`} aria-label="Add to bag" title="Add to bag" onClick={handleAdd}><ShoppingBag size={18} /></button></div><div className="product-info"><button className="product-category" onClick={() => onOpen(product)}>{product.category}</button><button className="product-name" onClick={() => onOpen(product)}>{product.title}</button><div className="product-meta"><span className="price">{money(product.price)}{product.compareAt && <del>{money(product.compareAt)}</del>}</span></div></div></article>
}

function ProductSection({ title, kicker, products, wishlist, onWish, onOpen, onAdd, onSeeAll, compact = false }: { title: string; kicker: string; products: Product[]; wishlist: string[]; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void; onSeeAll: () => void; compact?: boolean }) {
  return <section className={`product-section page-width ${compact ? 'compact-section' : ''}`}><div className="section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><button className="text-link" onClick={onSeeAll}>View all <ArrowRight size={16} /></button></div>{products.length ? <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={onWish} onOpen={onOpen} onAdd={onAdd} />)}</div> : <p className="empty-row">Add products to this collection from the moderator panel.</p>}</section>
}

function OfferBanner({ state, onShop }: { state: StoreState; onShop: () => void }) {
  return <section className="offer-banner page-width"><div className="offer-visual"><ImageView src={state.content.offerImage} alt="A featured AARO offer edit" /><span className="offer-seal"><b>JUST A</b><strong>little<br />extra</strong><i>✳</i></span><span className="offer-count">THE OFFER EDIT&nbsp; / &nbsp;LITTLE EXTRAS</span></div><div className="offer-copy"><span className="section-kicker">GOOD FINDS, GOOD TIMING</span><h2>{state.content.offerTitle.split('\n').map((line, index) => <span key={index}>{line}{index === 0 && <br />}</span>)}</h2><p>{state.content.offerSubtitle}</p><button className="dark-button" onClick={onShop}>Shop the offers <ArrowRight size={16} /></button><small>Offers can change as availability updates.</small></div></section>
}

function CartDrawer({ cartItems, subtotal, delivery, subDhakaDelivery, outsideDelivery, offerSavings, deliverySavings, bundleSavings, couponSavings, coupon, couponInput, setCouponInput, applyCoupon, clearCoupon, onQuantity, onSize, onOption, onClose, onCheckout, onShop }: { cartItems: (CartLine & { product: Product })[]; subtotal: number; delivery: number; subDhakaDelivery: number; outsideDelivery: number; offerSavings: number; deliverySavings: DeliverySavings | null; bundleSavings: number; couponSavings: number; coupon: Coupon | null; couponInput: string; setCouponInput: (value: string) => void; applyCoupon: () => void; clearCoupon: () => void; onQuantity: (line: CartLine, qty: number) => void; onSize: (line: CartLine, size: string) => void; onOption: (line: CartLine, name: string, value: string) => void; onClose: () => void; onCheckout: () => void; onShop: () => void }) {
  const [closing, setClosing] = useState(false)
  const [opened, setOpened] = useState(false)
  const closeTimer = useRef<number | null>(null)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setOpened(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])
  const requestClose = (afterClose = onClose) => {
    if (closing) return
    setClosing(true)
    setOpened(false)
    closeTimer.current = window.setTimeout(afterClose, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 220 : 720)
  }
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])
  return <div className={`modal-backdrop drawer-backdrop ${closing ? 'is-closing' : ''}`} onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <aside className={`cart-drawer ${opened ? 'is-open' : ''} ${closing ? 'is-closing' : ''}`}>
      <div className="drawer-head"><div><span className="section-kicker">AARO / YOUR BAG</span><h2>Your bag ({cartItems.reduce((sum, line) => sum + line.quantity, 0)})</h2></div><IconButton label="Close bag" onClick={() => requestClose()}><X size={20} /></IconButton></div>
      {cartItems.length ? <>
        <div className="free-delivery"><span><Truck size={16} /><span className="delivery-zones">Dhaka {money(delivery)} · Sub-Dhaka {money(subDhakaDelivery)} · Outside Dhaka {money(outsideDelivery)}</span></span><small>Choose the correct delivery zone at checkout.</small></div>
        <div className="cart-lines">{cartItems.map((line) => { const { product, quantity, size, options } = line; const sizeOption=product.options?.find((option)=>/^size$/i.test(option.name)); const availableSizes=product.sizes?.length?product.sizes:sizeOption?.values||[]; return <div className="cart-line" key={cartLineKey(line)}><ImageView src={product.image} alt={product.title} /><div className="cart-line-copy"><span>{product.category}</span><b>{product.title}</b>{availableSizes.length ? <label className="cart-size-select">Size<select value={size || ''} onChange={(event) => onSize(line, event.target.value)}><option value="">Choose size</option>{availableSizes.map((option) => <option key={option} value={option}>{option}</option>)}</select></label> : null}{(product.options || []).filter((option) => !/^size$/i.test(option.name)).map((option) => <label className="cart-size-select" key={option.name}>{option.name}<select value={options?.[option.name] || ''} onChange={(event) => onOption(line, option.name, event.target.value)}><option value="">Choose {option.name.toLowerCase()}</option>{option.values.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>)}<strong>{money(product.price)}{product.compareAt && product.compareAt > product.price && <del>{money(product.compareAt)}</del>}</strong><div className="quantity-control"><button aria-label="Decrease quantity" onClick={() => onQuantity(line, quantity - 1)}><Minus size={13} /></button><span>{quantity}</span><button aria-label="Increase quantity" onClick={() => onQuantity(line, quantity + 1)}><Plus size={13} /></button></div></div><button className="remove-line" onClick={() => onQuantity(line, 0)} aria-label={`Remove ${product.title}`}><X size={16} /></button></div> })}</div>
        <div className="coupon-row"><TicketPercent size={17} /><input value={couponInput} onChange={(event) => setCouponInput(event.target.value.toUpperCase())} placeholder="Coupon code" /><button onClick={applyCoupon}>{coupon ? 'Applied' : 'Apply'}</button></div>
        {coupon && <div className="coupon-applied"><CheckCircle2 size={14} /> {coupon.code} is on this order <button onClick={() => { setCouponInput(''); clearCoupon() }}>Remove</button></div>}
        {cartItems.some(({ product, ...line }) => !hasRequiredProductChoices(product, line)) && <p className="cart-choice-alert" role="status">Choose a size and any required options for each item before checkout.</p>}
        <div className="drawer-summary"><div className="bag-subtotal-row"><span>Subtotal</span><b>{money(subtotal)}</b></div>{offerSavings > 0 && <div className="discount-line"><span>Offer savings</span><b>−{money(offerSavings)}</b></div>}{deliverySavings && <div className="discount-line"><span>Free delivery</span><b>{deliverySavingsText(deliverySavings)}</b></div>}{bundleSavings > 0 && <div className="discount-line"><span>Bundle savings</span><b>−{money(bundleSavings)}</b></div>}{couponSavings > 0 && <div className="discount-line"><span>Coupon {coupon ? `(${coupon.code})` : 'saving'}</span><b>−{money(couponSavings)}</b></div>}{(offerSavings + bundleSavings + couponSavings) > 0 && <div className="discounted-subtotal-row"><span>Discounted subtotal</span><b>{money(Math.max(0, subtotal - offerSavings - bundleSavings - couponSavings))}</b></div>}<button className="dark-button checkout-submit" disabled={cartItems.some(({ product, ...line }) => !hasRequiredProductChoices(product, line))} onClick={() => requestClose(onCheckout)}>Continue to checkout <ArrowRight size={17} /></button><p><ShieldCheck size={14} /> Cash on delivery · Guest checkout available</p></div>
      </> : <div className="empty-cart"><div><ShoppingBag size={28} /></div><h3>Your bag has room to grow.</h3><p>Find something lovely for your everyday.</p><button className="dark-button" onClick={() => requestClose(onShop)}>Explore <ArrowRight size={16} /></button></div>}
    </aside>
  </div>
}
function CheckoutPage({ cartItems, cartLineCount, catalogLoading, subtotal, delivery, subDhakaDelivery, outsideDelivery, district, thana, onDistrict, onThana, offerSavings, deliverySavings, bundleSavings, couponSavings, total, freeDelivery, coupon, onPlaceOrder, onBack }: { cartItems: (CartLine & { product: Product })[]; cartLineCount: number; catalogLoading: boolean; subtotal: number; delivery: number; subDhakaDelivery: number; outsideDelivery: number; district: string; thana: string; onDistrict: (district: string) => void; onThana: (thana: string) => void; offerSavings: number; deliverySavings: DeliverySavings | null; bundleSavings: number; couponSavings: number; total: number; freeDelivery: boolean; coupon: Coupon | null; onPlaceOrder: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) {
  if (catalogLoading && cartItems.length < cartLineCount) return <section className="checkout-page page-width"><div className="empty-state checkout-cart-restoring" role="status"><span className="loading-orbit" /><h1>Restoring your bag</h1><p>Loading your saved products. Your items are still here.</p></div></section>
  if (!cartItems.length) return <section className="checkout-page page-width"><div className="empty-state"><ShoppingBag size={27} /><h1>Your bag is empty</h1><p>Add products to your bag before checking out.</p><button className="dark-button" onClick={onBack}>Return to bag <ArrowRight size={16} /></button></div></section>
  const selectedZone = getDeliveryZone(district, thana)
  const hasDeliveryLocation = Boolean(district && thana)
  const fee = freeDelivery ? 0 : !hasDeliveryLocation ? delivery : selectedZone === 'city' ? delivery : selectedZone === 'sub_dhaka' ? subDhakaDelivery : outsideDelivery
  const districtAreas = bangladeshDistricts.find((item) => item.name === district)?.areas || []
  const zoneLabel = selectedZone === 'city' ? 'Dhaka city' : selectedZone === 'sub_dhaka' ? 'Sub-Dhaka' : 'Outside Dhaka'
  return <section className="checkout-page page-width">
    <div className="checkout-page-heading"><div><span className="section-kicker">AARO / SECURE CHECKOUT</span><h1>Delivery details</h1><p>Enter where you’d like your order delivered.</p></div><button type="button" className="back-to-bag" onClick={onBack}><ChevronLeft size={16} /> Back to your bag</button></div>
    <form className="checkout-page-layout" onSubmit={onPlaceOrder}>
      <div className="checkout-page-form panel">
        <div className="checkout-note"><Phone size={18} /><span><b>Guest checkout</b></span></div>
        <label>Full name<input name="name" autoComplete="name" required placeholder="Name on the order" /></label>
        <label>Phone number<input name="phone" autoComplete="tel" required pattern="[+0-9 ()-]{8,}" placeholder="01XXX XXXXXX" /></label>
        <label>District<select name="district" required value={district} onChange={(event) => { onDistrict(event.target.value); onThana('') }}><option value="">Select a district</option>{bangladeshDistricts.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>Thana / area<select name="thana" required value={thana} disabled={!district} onChange={(event) => onThana(event.target.value)}><option value="">{district ? 'Select a thana or area' : 'Select a district first'}</option>{districtAreas.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        <label>Full delivery address<textarea name="address" rows={3} required autoComplete="street-address" placeholder="House, road, village, or nearby landmark" /></label>
        <label><span className="field-label-title">Comments <em>(optional)</em></span><textarea name="comments" rows={2} placeholder="Any extra delivery instructions" /></label>
        <div className="checkout-delivery-rate"><span><span>Delivery charge · {hasDeliveryLocation ? zoneLabel : 'select your location'}{freeDelivery ? ' · offer applied' : ''}</span><small className="delivery-estimate">{hasDeliveryLocation ? `Estimated delivery · ${selectedZone === 'outside' ? '5–6 days' : '2–3 days'}` : 'Select your area to confirm the delivery charge'}</small></span><b>{money(fee)}</b></div>
        <div className="checkout-payment"><div className="cod-icon"><Truck size={18} /></div><span><b>Cash on delivery</b><small>Pay the courier when your order arrives.</small></span><CheckCircle2 size={18} /></div>
      </div>
      <aside className="checkout-order-summary panel">
        <h2>Order summary</h2>
        <div className="checkout-summary-items">{cartItems.map((line) => { const { product, quantity, size, options } = line; const choices = [size ? `Size ${size}` : '', ...Object.entries(options || {}).map(([name, value]) => `${name}: ${value}`)].filter(Boolean).join(' · '); return <div className="checkout-summary-item" key={cartLineKey(line)}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{choices ? `${choices} · ` : ''}Qty {quantity} · {money(product.price)} each</small></span><strong>{money(product.price * quantity)}</strong></div> })}</div>
        <div className="checkout-totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>Delivery {hasDeliveryLocation ? `(${zoneLabel})` : '(select location)'}</span><b>{money(fee)}</b></div>{offerSavings > 0 && <div className="discount-line"><span>Offer savings</span><b>−{money(offerSavings)}</b></div>}{deliverySavings && <div className="discount-line"><span>Free delivery</span><b>{deliverySavingsText(deliverySavings)}</b></div>}{bundleSavings > 0 && <div className="discount-line"><span>Bundle savings</span><b>{money(bundleSavings)}</b></div>}{couponSavings > 0 && <div className="discount-line"><span>Coupon {coupon ? `(${coupon.code})` : 'saving'}</span><b>−{money(couponSavings)}</b></div>}{(offerSavings + bundleSavings + couponSavings) > 0 && <div className="discounted-subtotal-row"><span>Discounted subtotal</span><b>{money(Math.max(0, subtotal - offerSavings - bundleSavings - couponSavings))}</b></div>}<div className="checkout-total"><span>Total due on delivery</span><b>{money(total)}</b></div></div>
        <button className="dark-button checkout-submit" disabled={cartItems.some(({ product, ...line }) => !hasRequiredProductChoices(product, line))}>Place order <ArrowRight size={17} /></button>
        <details className="checkout-terms"><summary>Delivery and return terms</summary><p>Please check your parcel while the courier is present and report any problem immediately.</p><p>Returns or exchanges requested after the courier has left may require an additional delivery charge.</p><p>Please review the product details and sizing before placing your order.</p></details>
      </aside>
    </form>
  </section>
}

function ProductPage({ product, offers, relatedProducts, wishlist, wished, onClose, onWish, onOpen, onSeeRelated, onAdd }: { product: Product; offers: OfferDeal[]; relatedProducts: Product[]; wishlist: string[]; wished: boolean; onClose: () => void; onWish: (id: string) => void; onOpen: (product: Product) => void; onSeeRelated: () => void; onAdd: (product: Product, quantity: number, size?: string, options?: Record<string, string>) => void }) {
  const [quantity, setQuantity] = useState(1)
  const [size, setSize] = useState('')
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({})
  const [choiceNotice, setChoiceNotice] = useState('')
  const [fullDetails, setFullDetails] = useState<Product | null>(null)
  const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
  useEffect(() => {
    let current = true
    setFullDetails(null)
    if (!apiUrl || (!product.sourceId && product.source !== 'custom')) return () => { current = false }
    fetch(`${apiUrl}/api/products/${encodeURIComponent(product.sourceId || product.id)}`)
      .then((response) => { if (!response.ok) throw new Error('Details unavailable'); return response.json() as Promise<Product> })
      .then((details) => { if (current) setFullDetails({ ...product, ...details, id: product.id }) })
      .catch(() => undefined)
    return () => { current = false }
  }, [apiUrl, product.id, product.source, product.sourceId])
  const detailProduct = fullDetails || product
  const offer = offers.find((item) => item.kind === 'special_price' || item.kind === 'quantity_discount' && item.quantity === 1 || item.kind === 'buy_multiple' && item.tiers?.some((tier) => tier.quantity === 1)) || offers[0]
  const displayProduct = applySingleItemOfferPrice(detailProduct, offers)
  const sizeOption = detailProduct.options?.find((option) => /^size$/i.test(option.name))
  const availableSizes = detailProduct.sizes?.length ? detailProduct.sizes : sizeOption?.values || []
  useEffect(() => { setSelectedOptions({}) }, [detailProduct.id, detailProduct.options])
  const detailImages = detailProduct.images?.length ? detailProduct.images : detailProduct.image ? [detailProduct.image] : []
  const primaryImage = detailImages[0] || detailProduct.image
  const normalizedDescription = (detailProduct.description || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const uniqueAttributes = (detailProduct.attributes || []).filter((attribute) => {
    const normalizedAttribute = attribute.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    return normalizedAttribute && !normalizedDescription.includes(normalizedAttribute)
  })
  const [activeImage, setActiveImage] = useState(product.image)
  useEffect(() => { setActiveImage(primaryImage) }, [detailProduct.id, primaryImage])
  useEffect(() => { setSize('') }, [detailProduct.id, detailProduct.sizes?.join('|')])
  return <section className="product-page page-width">
    <button className="product-back" onClick={onClose}><ChevronLeft size={17} /> Back to shopping</button>
    <div className="product-page-layout">
      <div className="detail-gallery"><div className="detail-image"><ImageView src={activeImage} alt={product.title} loading="eager" /></div>{detailImages.length > 1 && <div className="detail-thumbnails">{detailImages.map((image) => <button type="button" className={activeImage === image ? 'selected' : ''} key={image} onClick={() => setActiveImage(image)} aria-label={`View ${product.title} image`}><ImageView src={image} alt="" /></button>)}</div>}</div>
    <div className="detail-copy"><span className="section-kicker">{detailProduct.category.toUpperCase()} / THE EVERYDAY EDIT</span><h1>{detailProduct.title}</h1><div className="detail-price">{money(displayProduct.price)} {displayProduct.compareAt && displayProduct.compareAt > displayProduct.price && <del>{money(displayProduct.compareAt)}</del>}{displayProduct.compareAt && displayProduct.compareAt > displayProduct.price && <small>YOU SAVE {money(displayProduct.compareAt - displayProduct.price)} ({salePercentOf(displayProduct)}%)</small>}</div><p className="product-description">{detailProduct.description || (detailProduct.source === 'shopbase' ? 'Loading product details…' : '')}</p>{offer && <div className="product-offer-callout"><Tags size={16} /><span><b>{offer.title || 'Special offer'}</b><small>{offer.kind === 'special_price' ? `Offer price: ${money(displayProduct.price)} · Save ${money(Math.max(0, regularProductPrice(displayProduct) - displayProduct.price))}` : offer.kind === 'quantity_discount' ? `Buy ${offer.quantity}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}` : offer.kind === 'buy_multiple' ? offerTierSummary(offer, [detailProduct]) || `Buy ${offer.quantity}${['discount', 'both'].includes(offer.reward || 'discount') ? `, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}` : ''}${['free_delivery', 'both'].includes(offer.reward || '') ? ' + free delivery' : ''}` : `Buy ${offer.quantity}, get ${offer.freeQuantity} free`}</small></span></div>}{Boolean(availableSizes.length) && <div className="size-picker"><div><b>Choose a size</b>{detailProduct.sizeChart && <button type="button" onClick={() => document.getElementById('product-size-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Size guide</button>}</div><div>{availableSizes.map((item) => <button type="button" className={size === item ? 'selected' : ''} key={item} onClick={() => { setSize(item); if (sizeOption) setSelectedOptions((current) => ({ ...current, [sizeOption.name]: item })); setChoiceNotice('') }}>{item}</button>)}</div></div>}{detailProduct.options?.filter((option) => !/^size$/i.test(option.name)).map((option) => <div className="size-picker product-option-picker" key={option.name}><div><b>Choose {option.name.toLowerCase()}</b></div><div>{option.values.map((item) => <button type="button" className={selectedOptions[option.name] === item ? 'selected' : ''} key={item} onClick={() => setSelectedOptions((current) => ({ ...current, [option.name]: item }))}>{item}</button>)}</div></div>)}{uniqueAttributes.length > 0 ? <ul className="product-attributes">{uniqueAttributes.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : null}{detailProduct.sizeChart && <details className="product-size-chart" id="product-size-chart"><summary>Size chart & measurements</summary><pre>{detailProduct.sizeChart}</pre></details>}<div className="detail-actions"><div className="quantity-control"><button onClick={() => setQuantity(Math.max(1, quantity - 1))}><Minus size={13} /></button><span>{quantity}</span><button onClick={() => setQuantity(quantity + 1)}><Plus size={13} /></button></div><button className="dark-button" onClick={() => { if (!hasRequiredProductChoices(detailProduct, { size, options: selectedOptions })) { const missingOption = detailProduct.options?.find((option) => !/^size$/i.test(option.name) && option.values.length && !selectedOptions[option.name]); setChoiceNotice(availableSizes.length && !size ? 'Please select a size first.' : `Please select ${missingOption?.name.toLowerCase() || 'the required option'} first.`); return } const cartOptions = Object.fromEntries(Object.entries(selectedOptions).filter(([name]) => !/^size$/i.test(name))); setChoiceNotice(''); onAdd(detailProduct, quantity, size, cartOptions) }}>Add to bag <ShoppingBag size={17} /></button><IconButton label={wished ? 'Remove from wishlist' : 'Save to wishlist'} className={wished ? 'wished' : ''} onClick={() => onWish(product.id)}><Heart size={18} fill={wished ? 'currentColor' : 'none'} /></IconButton></div>{choiceNotice && <p className="product-choice-notice" role="alert">{choiceNotice}</p>}<div className="detail-policies"><span><Truck size={16} /> Delivery across Bangladesh</span><span><ShieldCheck size={16} /> Easy support if needed</span><span><Truck size={16} /> Estimated delivery · Dhaka city and Sub-Dhaka 2–3 days · Outside Dhaka 5–6 days</span></div></div>
    </div>
    {relatedProducts.length > 0 && <div className="related-products"><ProductSection title="More from this category" kicker={`MORE TO LOVE IN ${product.category.toUpperCase()}`} products={relatedProducts} wishlist={wishlist} onWish={onWish} onOpen={onOpen} onAdd={(item) => onAdd(item, 1)} onSeeAll={onSeeRelated} compact /></div>}
  </section>
}

function AccountDashboard({ apiBase, token, profile, orders, onProfile, onSignOut, notify }: { apiBase: string; token: string; profile: AccountProfile; orders: Order[]; onProfile: (profile: AccountProfile) => void; onSignOut: () => void; notify: (message: string) => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const address = profile.addresses[0]
  const [addressDistrict, setAddressDistrict] = useState(address?.district || '')
  const [addressThana, setAddressThana] = useState(address?.thana || '')
  const [error, setError] = useState('')
  useEffect(() => { setAddressDistrict(address?.district || ''); setAddressThana(address?.thana || '') }, [address?.id, address?.district, address?.thana, profile.defaultAddressId])
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const response = await fetch(`${apiBase}/api/account`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: form.get('name'), email: form.get('email'), phone: form.get('phone') }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); onProfile(result); notify('Account details saved.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save account.') } }
  const saveAddress = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const district = String(form.get('district') || ''); const thana = String(form.get('thana') || ''); const address: Address = { id: profile.addresses[0]?.id || crypto.randomUUID(), recipient: String(form.get('recipient')), phone: String(form.get('phone')), district, thana, area: `${thana}, ${district}`, address: String(form.get('address')), comments: String(form.get('comments') || '').trim() || undefined, isDefault: true }; try { const response = await fetch(`${apiBase}/api/account/addresses`, { method: 'PUT', headers: auth, body: JSON.stringify({ addresses: [address] }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); onProfile({ ...profile, addresses: result.addresses, defaultAddressId: result.defaultAddressId }); notify('Shipping address saved.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save address.') } }
  const changePassword = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const response = await fetch(`${apiBase}/api/account/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ current_password: form.get('current_password'), new_password: form.get('new_password') }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); event.currentTarget.reset(); notify('Password changed.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change password.') } }
  const spent = orders.reduce((sum, order) => sum + order.total, 0)
  const addressDistrictAreas = bangladeshDistricts.find((item) => item.name === addressDistrict)?.areas || []
   return <section className="listing-page page-width account-dashboard"><div className="listing-heading"><div><span className="section-kicker">AARO / YOUR ACCOUNT</span><h1>Hello, {profile.name}</h1><p>Track your orders and manage your account details.</p></div><button className="secondary-button" onClick={onSignOut}>Sign out</button></div><div className="stat-grid"><div className="stat-card"><span>Total orders</span><strong>{orders.length}</strong></div><div className="stat-card"><span>Total spent</span><strong>{money(spent)}</strong></div></div>{error && <p role="alert">{error}</p>}<section className="panel recent-panel" id="account-orders"><div className="panel-heading"><div><h2>Order history</h2><p>Current status for each order</p></div></div>{orders.length ? orders.map((order) => <div className="account-order" key={order.id}><strong>{order.id}</strong><span>{dateLabel(order.createdAt)}</span><StatusPill status={order.status} /><b>{money(order.total)}</b><small>{order.items.map((item) => `${item.title} × ${item.quantity}`).join(', ')}</small></div>) : <p className="empty-row">Your orders will appear here.</p>}</section><div className="content-grid account-settings-grid"><div className="account-settings-left"><form className="panel settings-form" onSubmit={saveProfile}><h2>Account details</h2><label>Full name<input name="name" required defaultValue={profile.name} /></label><label>Email<input name="email" type="email" defaultValue={profile.email} /></label><label>Phone<input name="phone" defaultValue={profile.phone} /></label><button className="primary-button">Save details</button></form><form className="panel settings-form account-password-form" onSubmit={changePassword}><h2>Change password</h2><div className="settings-two"><label>Current password<input name="current_password" type="password" required /></label><label>New password<input name="new_password" type="password" minLength={10} required /></label></div><button className="primary-button">Update password</button></form></div><form className="panel settings-form" onSubmit={saveAddress}><h2>Default shipping address</h2><label>Recipient<input name="recipient" defaultValue={address?.recipient || profile.name} required /></label><label>Phone<input name="phone" autoComplete="tel" pattern="[+0-9 ()-]{8,}" defaultValue={address?.phone || profile.phone} required /></label><label>District<select name="district" required value={addressDistrict} onChange={(event) => { setAddressDistrict(event.target.value); setAddressThana('') }}><option value="">Select a district</option>{bangladeshDistricts.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label><label>Thana / area<select name="thana" required value={addressThana} onChange={(event) => setAddressThana(event.target.value)} disabled={!addressDistrict}><option value="">{addressDistrict ? 'Select a thana or area' : 'Select a district first'}</option>{addressDistrictAreas.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label><label>Full delivery address<textarea name="address" autoComplete="street-address" defaultValue={address?.address || ''} required /></label><label><span className="field-label-title">Comments <em>(optional)</em></span><textarea name="comments" defaultValue={address?.comments || ''} /></label><button className="primary-button">Save default address</button></form></div></section>
}

function OrderEmailSettingsPanel({ apiBase, token, notify }: { apiBase: string; token: string; notify: (message: string) => void }) {
  const [sender, setSender] = useState('')
  const [recipient, setRecipient] = useState('aaro.shop.bd@gmail.com')
  const [provider, setProvider] = useState<'emailjs' | 'gmail' | 'resend'>('emailjs')
  const [credential, setCredential] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [hasCredential, setHasCredential] = useState(false)
  const [authSecretReady, setAuthSecretReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  useEffect(() => { void fetch(`${apiBase}/api/admin/order-email`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.detail); setSender(data.sender || ''); setRecipient(data.recipient || 'aaro.shop.bd@gmail.com'); setProvider(['emailjs', 'gmail', 'resend'].includes(data.provider) ? data.provider : 'emailjs'); setServiceId(data.serviceId || ''); setTemplateId(data.templateId || ''); setPublicKey(data.publicKey || ''); setHasCredential(Boolean(data.hasCredential)); setAuthSecretReady(Boolean(data.authSecretReady)) }).catch(error => setMessage(error instanceof Error ? error.message : 'Could not load settings.')) }, [apiBase, token])
  const save = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); setMessage(''); try { const response = await fetch(`${apiBase}/api/admin/order-email`, { method: 'PUT', headers, body: JSON.stringify({ provider, credential, sender, recipient, serviceId, templateId, publicKey }) }); const data = await response.json(); if (!response.ok) throw new Error(data.detail); setHasCredential(Boolean(data.hasCredential)); setCredential(''); setMessage('Settings saved. Send a test email to verify delivery.'); notify('Email notification settings saved.') } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save settings.') } finally { setBusy(false) } }
  const sendTest = async () => { setBusy(true); setMessage(''); try { const response = await fetch(`${apiBase}/api/admin/order-email/test`, { method: 'POST', headers }); const data = await response.json(); if (!response.ok) throw new Error(data.detail); setMessage(data.message) } catch (error) { setMessage(error instanceof Error ? error.message : 'Test email failed.') } finally { setBusy(false) } }
  const emailjsConfigured = Boolean(serviceId.trim() && templateId.trim() && publicKey.trim() && recipient.trim())
  const notificationReady = provider === 'emailjs' ? emailjsConfigured : hasCredential && Boolean(sender.trim())
  return <section className="panel settings-form"><div className="panel-heading"><div><h2>New order email</h2><p>Get an email as soon as a customer places an order.</p></div><span className={`visibility ${notificationReady ? 'visible' : ''}`}><i />{notificationReady ? 'Configured' : 'Needs setup'}</span></div>{provider !== 'emailjs' && !authSecretReady && <p className="form-error" role="alert"><b>Render setup needed:</b> Add <code>AUTH_SECRET</code> to your Render API service environment to encrypt the provider credential. Keep it private and stable.</p>}<form className="settings-form" onSubmit={save}><label>Email provider<select value={provider} onChange={event => setProvider(event.target.value as 'emailjs' | 'gmail' | 'resend')}><option value="emailjs">EmailJS + Gmail (free, no domain)</option><option value="gmail">Gmail SMTP (blocked on Render free)</option><option value="resend">Resend (requires verified domain)</option></select></label>{provider === 'emailjs' ? <><p className="form-help"><b>Recommended for Render free:</b> EmailJS connects to Gmail and sends over HTTPS, so it works without a domain or Gmail App Password. Leave private key blank; the public key is enough for this server-side integration.</p><div className="settings-two"><label>EmailJS Service ID<input value={serviceId} onChange={event => setServiceId(event.target.value)} placeholder="service_…" required /><small>EmailJS → Email Services → your Gmail service.</small></label><label>EmailJS Template ID<input value={templateId} onChange={event => setTemplateId(event.target.value)} placeholder="template_…" required /><small>EmailJS → Email Templates → your order template.</small></label></div><label>EmailJS Public Key<input value={publicKey} onChange={event => setPublicKey(event.target.value)} placeholder="Your EmailJS public key" required /><small>EmailJS → Account → General. This key is designed to be used by integrations.</small></label><label>Send order alerts to<input type="email" value={recipient} onChange={event => setRecipient(event.target.value)} required /><small>In your EmailJS template, set “To Email” to <code>{'{{to_email}}'}</code>.</small></label></> : <><label>{provider === 'gmail' ? 'Gmail App Password' : 'Resend API key'}<input type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} placeholder={hasCredential ? 'Saved securely · paste a new credential to replace' : provider === 'gmail' ? '16-character Google App Password' : 're_…'} required={!hasCredential} /></label><div className="settings-two"><label>{provider === 'gmail' ? 'Your Gmail address' : 'Verified sender email'}<input type="email" value={sender} onChange={event => setSender(event.target.value)} placeholder={provider === 'gmail' ? 'you@gmail.com' : 'orders@yourdomain.com'} required /><small>{provider === 'gmail' ? 'SMTP is blocked by Render’s free plan. Use EmailJS above instead.' : 'Must be at a domain you own and verified in Resend.'}</small></label><label>Send order alerts to<input type="email" value={recipient} onChange={event => setRecipient(event.target.value)} required /></label></div></>}<p className="form-help">Provider credentials are encrypted before saving and never sent back to this page.</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => void sendTest()} disabled={busy || !notificationReady}>{busy ? 'Working…' : 'Send test email'}</button><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save email settings'}</button></div>{message && <p role="status">{message}</p>}</form>{provider === 'emailjs' ? <div className="form-help"><b>Quick setup:</b> In EmailJS, create an account, add an Email Service using Gmail, create an email template, and set its “To Email” to <code>{'{{to_email}}'}</code>. Use template variables <code>{'{{order_id}}'}</code>, <code>{'{{customer_name}}'}</code>, <code>{'{{customer_phone}}'}</code>, <code>{'{{items}}'}</code>, and <code>{'{{total}}'}</code> to show order details. Copy the Service ID, Template ID, and Public Key into these fields, save, then send a test. <a href="https://www.emailjs.com/docs/user-guide/connecting-email-services/" target="_blank" rel="noreferrer">EmailJS Gmail setup guide</a> · <a href="https://www.emailjs.com/pricing/" target="_blank" rel="noreferrer">Free plan details</a></div> : <div className="form-help">Gmail SMTP is blocked on Render’s free plan. Use EmailJS above for free Gmail delivery without buying a domain.</div>}</section>
}

function AdminLogin({ apiBase, onSuccess }: { apiBase: string; onSuccess: (token: string, rememberMe: boolean) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  return <main className="admin-login-page"><form className="login-modal" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch(`${apiBase}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: form.get('identifier'), password: form.get('password'), remember_me: rememberMe }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Sign in failed.')
      onSuccess(body.accessToken, rememberMe)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reach the admin service.') }
    finally { setBusy(false) }
  }}><span className="section-kicker">AARO / ADMIN</span><label>Admin ID<input name="identifier" autoComplete="username" placeholder="Enter admin ID" required /></label><label>Password<div className="password-input-wrap"><input name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required /><button type="button" className="password-visibility-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label><label className="remember-me-row"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /> Remember me on this browser</label>{error && <p role="alert">{error}</p>}<button className="dark-button" disabled={busy}>{busy ? <><LoaderCircle size={16} /> Signing in…</> : <>Sign in <ArrowRight size={16} /></>}</button></form></main>
}

function AccountAccessPage({ mode, apiBase, darkTheme, onToggleTheme, onModeChange, onBack, onAuth }: { mode: 'login' | 'register'; apiBase: string; darkTheme: boolean; onToggleTheme: () => void; onModeChange: (mode: 'login' | 'register') => void; onBack: () => void; onAuth: (token: string, identifier: string) => void }) {
  const registering = mode === 'register'
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className={`account-access-page ${darkTheme ? 'theme-dark' : ''}`}><div className="account-access-shell"><div className="account-access-top"><button className="wordmark" onClick={onBack} aria-label="AARO home"><img src={darkTheme ? "/images/aaro-logo-lime-transparent.png" : "/images/aaro-logo-orange.png"} alt="AARO" /></button><div className="account-access-actions"><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle" onClick={onToggleTheme}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><button className="account-back-link" onClick={onBack}><ChevronLeft size={16} /> Continue shopping</button></div></div><section className="account-access-panel"><span className="section-kicker">AARO / YOUR ACCOUNT</span><h1>{registering ? 'Create your account' : 'Welcome back'}</h1><p>{registering ? 'Create an account to follow your orders and save your details.' : 'Sign in to view your profile and order history.'}</p><form className="account-access-form" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const body = { identifier: String(form.get('identifier')).trim(), password: String(form.get('password')), ...(registering ? { name: String(form.get('name')).trim() } : {}) }
    try {
      const response = await fetch(`${apiBase}/api/auth/${registering ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not sign in.')
      onAuth(result.accessToken, body.identifier)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Account service unavailable.') }
    finally { setBusy(false) }
  }}>
    {registering && <label>Full name<input name="name" autoComplete="name" required minLength={2} placeholder="Full name" /></label>}
    <label>Email or phone number<input name="identifier" autoComplete="username" required placeholder="Email address or phone number" /></label>
    <label>Password<input name="password" type="password" minLength={10} required autoComplete={registering ? 'new-password' : 'current-password'} placeholder={registering ? 'At least 10 characters' : 'Enter your password'} /></label>
    {error && <p className="account-access-error" role="alert">{error}</p>}
    <button className="dark-button" disabled={busy}>{busy ? <><LoaderCircle size={16} /> Please wait…</> : <>{registering ? 'Create account' : 'Sign in'} <ArrowRight size={17} /></>}</button>
  </form><p className="account-access-switch">{registering ? 'Already have an account?' : 'New to AARO?'} <button onClick={() => onModeChange(registering ? 'login' : 'register')}>{registering ? 'Sign in' : 'Create an account'}</button></p></section></div></main>
}

function AdminOverview({ state, revenue, customerCount, productViews, onTab, updateOrderStatus }: { state: StoreState; revenue: number; customerCount: number; productViews: number; onTab: (tab: AdminTab) => void; updateOrderStatus: (id: string, status: OrderStatus) => void }) {
  const orders = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const liveCatalogCount = state.products.filter((product) => product.source === 'shopbase').length
  const stats = [
    { title: 'Total revenue', value: money(revenue), note: 'From saved orders', icon: CircleDollarSign, trend: 'Live', up: false },
    { title: 'Total orders', value: String(state.orders.length), note: state.orders.filter((order) => order.status === 'Pending confirmation').length + ' awaiting confirmation', icon: ShoppingCart, trend: 'Live', up: false },
    { title: 'Customers', value: String(customerCount), note: 'Customer order records', icon: UsersRound, trend: 'Live', up: false },
    { title: 'Product views', value: productViews.toLocaleString(), note: 'Across all products', icon: Eye, trend: 'Live', up: false }
  ]
  const bucketCount = 10
  const bucketMilliseconds = 3 * 24 * 60 * 60 * 1000
  const rangeStart = new Date()
  rangeStart.setHours(0, 0, 0, 0)
  rangeStart.setDate(rangeStart.getDate() - 29)
  const revenueBuckets = Array.from({ length: bucketCount }, () => 0)
  const revenueOrders = state.orders.filter((order) => ['Confirmed', 'Processing', 'Shipped', 'Delivered'].includes(order.status))
  for (const order of revenueOrders) {
    const timestamp = new Date(order.createdAt).getTime()
    const offset = timestamp - rangeStart.getTime()
    if (!Number.isFinite(timestamp) || offset < 0 || offset >= 30 * 24 * 60 * 60 * 1000) continue
    const bucket = Math.min(bucketCount - 1, Math.floor(offset / bucketMilliseconds))
    revenueBuckets[bucket] += Number(order.total) || 0
  }
  const periodRevenue = revenueBuckets.reduce((sum, amount) => sum + amount, 0)
  const chartMax = periodRevenue > 0 ? Math.ceil(Math.max(...revenueBuckets) / 1000) * 1000 : 0
  const chartTicks = chartMax ? [chartMax, chartMax * .75, chartMax * .5, chartMax * .25, 0] : [0, 0, 0, 0, 0]
  const chartAmount = (amount: number) => amount >= 1000 ? '৳' + (amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1) + 'k' : '৳' + Math.round(amount)
  const chartLabels = revenueBuckets.map((_, index) => {
    const date = new Date(rangeStart.getTime() + index * bucketMilliseconds)
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
  })
  return <><div className="admin-welcome"><div><span className="section-kicker">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }).format(new Date()).toUpperCase()}</span><h2>Your store, at a glance.</h2><p>Here’s what’s happening with AARO today.</p></div><button className="primary-button" onClick={() => onTab('products')}><Plus size={17} /> Add a product</button></div><div className="stat-grid">{stats.map(({ title, value, note, icon: Icon, trend, up }) => <div className="stat-card" key={title}><div className="stat-card-top"><span>{title}</span><i><Icon size={18} /></i></div><strong>{value}</strong><div className="stat-card-bottom"><span>{note}</span><b className={up ? 'trend-up' : 'trend-neutral'}>{up ? <ArrowUpRight size={14} /> : null}{trend}</b></div></div>)}</div><div className="overview-grid"><section className="panel revenue-panel"><div className="panel-heading"><div><h3>Revenue overview</h3><p>Completed and active orders · Last 30 days</p></div></div><div className="revenue-total"><strong>{money(periodRevenue)}</strong><small>Actual order totals for this period</small></div><div className="chart-area">{periodRevenue > 0 ? <><div className="chart-y">{chartTicks.map((amount, index) => <span key={index}>{chartAmount(amount)}</span>)}</div><div className="chart-bars">{revenueBuckets.map((amount, index) => <div className="chart-column" key={index} title={chartLabels[index] + ': ' + money(amount)}><i style={{ height: String(chartMax ? amount / chartMax * 100 : 0) + '%' }} /><span>{chartLabels[index]}</span></div>)}</div></> : <div className="chart-empty">No confirmed sales in the last 30 days.</div>}</div><div className="chart-legend"><span><i /> Sales</span><span>Confirmed, processing, shipped, and delivered orders</span></div></section><section className="panel attention-panel"><div className="panel-heading"><div><h3>Needs your attention</h3><p>Keep orders moving smoothly</p></div></div><div className="attention-item"><span className="attention-icon amber-icon"><Clock3 size={18} /></span><div><b>{state.orders.filter((order) => order.status === 'Pending confirmation').length} orders to confirm</b><small>Call customers before sending to ShopBase</small></div><button onClick={() => onTab('orders')}><ArrowRight size={16} /></button></div><div className="attention-item"><span className="attention-icon teal-icon"><Package size={18} /></span><div><b>{liveCatalogCount.toLocaleString()} live catalog products</b><small>{liveCatalogCount ? 'Imported from your ShopBase catalog' : 'Run the catalog sync to load products'}</small></div><button onClick={() => onTab('products')}><ArrowRight size={16} /></button></div><div className="attention-foot"><ShieldCheck size={15} /> Orders stay in your review queue until confirmed.</div></section></div><section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent orders</h3><p>The latest customer activity</p></div><button className="text-link" onClick={() => onTab('orders')}>View all orders <ArrowRight size={15} /></button></div><OrderTable orders={orders.slice(0, 5)} onStatus={updateOrderStatus} compact /></section></>
}
function AdminProducts({ products: allProducts, categoryGroups, offers, apiBase, token, onBulkApplied, loading, moreLoading, hasMore, total, error, onSearch, onLoadMore, onSortChange, productViewCounts, onCheckAvailability, onAdd, onView, onEdit, onDelete }: { products: Product[]; categoryGroups: CategoryGroup[]; offers: OfferDeal[]; apiBase: string; token: string; onBulkApplied: () => void; loading: boolean; moreLoading: boolean; hasMore: boolean; total: number; error: string; onSearch: (value: string) => void; onLoadMore: (sort: string) => void; onSortChange: (sort: string) => void; productViewCounts: Record<string, number>; onCheckAvailability: (product: Product) => Promise<boolean>; onAdd: () => void; onView: (product: Product) => void; onEdit: (product: Product) => void; onDelete: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [searchPending, setSearchPending] = useState(false)
  const searchTimer = useRef<number | null>(null)
  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch
  const [filter, setFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sort, setSort] = useState<'updated' | 'added' | 'name-asc' | 'name-desc' | 'price-asc' | 'price-desc' | 'views'>('name-asc')
  const [visibleCount, setVisibleCount] = useState(50)
  const [checkingId, setCheckingId] = useState('')
  const [availabilityResults, setAvailabilityResults] = useState<Record<string, boolean>>({})
  const [availabilityError, setAvailabilityError] = useState('')
  const [bulkScope, setBulkScope] = useState<'all' | 'category' | 'subcategory' | 'offer'>('category')
  const [bulkGroupId, setBulkGroupId] = useState('')
  const [bulkChildId, setBulkChildId] = useState('')
  const [bulkCategory, setBulkCategory] = useState('')
  const [bulkOfferId, setBulkOfferId] = useState('')
  const [bulkSearch, setBulkSearch] = useState('')
  const [bulkType, setBulkType] = useState<'amount' | 'percent'>('amount')
  const [bulkDirection, setBulkDirection] = useState<'increase' | 'decrease'>('decrease')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkMessage, setBulkMessage] = useState('')
  const [bulkError, setBulkError] = useState('')
  useEffect(() => () => { if (searchTimer.current !== null) window.clearTimeout(searchTimer.current) }, [])
  useEffect(() => { if (!loading) setSearchPending(false) }, [loading])
  const checkAvailability = async (product: Product) => { setCheckingId(product.id); setAvailabilityError(''); try { const available = await onCheckAvailability(product); setAvailabilityResults((current) => ({ ...current, [product.id]: available })) } catch (error) { setAvailabilityError(error instanceof Error ? error.message : 'Could not start availability check.') } finally { setCheckingId('') } }
  const submitBulkAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (bulkSaving) return
    const adjustmentLabel = bulkType === 'percent' ? `${bulkValue}%` : money(Number(bulkValue))
    if (!window.confirm(`${bulkDirection === 'increase' ? 'Increase' : 'Decrease'} matching product prices by ${adjustmentLabel}? This updates the selected products in the catalog.`)) return
    setBulkSaving(true); setBulkError(''); setBulkMessage('')
    try {
      const group = categoryGroups.find((item) => item.id === bulkGroupId)
      const child = group?.children.find((item) => (item.sourceId || item.name) === bulkChildId)
      const response = await fetch(`${apiBase}/api/admin/products/bulk-price-adjustment`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: bulkScope, parentCategoryId: bulkScope === 'category' ? bulkGroupId : '', category: bulkScope === 'category' ? bulkCategory || group?.name || '' : '', categorySourceId: bulkScope === 'subcategory' ? child?.sourceId || '' : '', ...(bulkScope === 'subcategory' && !child?.sourceId ? { category: child?.name || '' } : {}), offerId: bulkOfferId, search: bulkSearch.trim(), adjustmentType: bulkType, direction: bulkDirection, value: Number(bulkValue) }) })
      const result = await response.json().catch(() => ({})) as { updated?: number; detail?: string }
      if (!response.ok) throw new Error(result.detail || 'Bulk price update failed.')
      setBulkMessage(`Updated prices for ${Number(result.updated || 0).toLocaleString()} products.`)
      setBulkValue(''); onBulkApplied()
    } catch (error) { setBulkError(error instanceof Error ? error.message : 'Bulk price update failed.') }
    finally { setBulkSaving(false) }
  }
  useEffect(() => setVisibleCount(50), [search, filter, categoryFilter, sort])
  const products = allProducts.filter((product) => {
    const matchesSearch = `${product.title} ${product.category} ${product.sourceId || ''} ${product.id}`.toLowerCase().includes(search.toLowerCase())
    const matchesCategory = categoryFilter === 'all' || categoryFilter.startsWith('source:') && product.categorySourceId === categoryFilter.slice(7) || categoryFilter.startsWith('name:') && product.category.toLocaleLowerCase() === categoryFilter.slice(5).toLocaleLowerCase() || categoryFilter.startsWith('group:') && (product.parentCategoryId === categoryFilter.slice(6) || categoryGroups.find((group) => group.id === categoryFilter.slice(6))?.children.some((child) => child.sourceId ? child.sourceId === product.categorySourceId : child.name.toLocaleLowerCase() === product.category.toLocaleLowerCase()))
    const addedTime = Date.parse(product.addedAt || '')
    const recentlyAdded = Number.isFinite(addedTime) && addedTime >= Date.now() - 30 * 24 * 60 * 60 * 1000
    const matchesFilter = filter === 'all' || filter === 'recent' && recentlyAdded || filter === 'active' && product.active || filter === 'hidden' && !product.active || filter === 'available' && product.stock > 0 || filter === 'unavailable' && product.stock <= 0 || filter === 'shopbase' && product.source === 'shopbase' || filter === 'manual' && product.source !== 'shopbase'
    return matchesSearch && matchesFilter && matchesCategory
  }).sort((a, b) => sort === 'added' ? (Date.parse(b.addedAt || '') || 0) - (Date.parse(a.addedAt || '') || 0) : sort === 'name-asc' ? a.title.localeCompare(b.title) : sort === 'name-desc' ? b.title.localeCompare(a.title) : sort === 'price-asc' ? a.price - b.price : sort === 'price-desc' ? b.price - a.price : sort === 'views' ? search.trim() ? allProducts.indexOf(a) - allProducts.indexOf(b) : (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0) : (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  return <section className="panel"><div className="panel-heading panel-heading-wrap"><div><h2>Product catalog</h2><p>Edit product details, pricing, images, availability, and collections.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} /> Add product</button></div><details className="panel bulk-price-panel"><summary>Bulk price adjustment</summary><form className="settings-form" onSubmit={submitBulkAdjustment}><p>Adjust regular and discounted prices for every matching product.</p><div className="settings-two"><label>Apply to<select value={bulkScope} onChange={event => setBulkScope(event.target.value as typeof bulkScope)}><option value="all">All products</option><option value="category">Parent category</option><option value="subcategory">Subcategory</option><option value="offer">Offer products</option></select></label>{bulkScope === "offer" ? <label>Offer<select required value={bulkOfferId} onChange={event => setBulkOfferId(event.target.value)}><option value="">Choose offer</option>{offers.map(offer => <option key={offer.id} value={offer.id}>{offer.title}</option>)}</select></label> : bulkScope === "category" || bulkScope === "subcategory" ? <label>Category<select required value={bulkGroupId} onChange={event => { setBulkGroupId(event.target.value); setBulkChildId(""); setBulkCategory("") }}><option value="">Choose category</option>{categoryGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label> : null}{bulkScope === "subcategory" && <label>Subcategory<select required value={bulkChildId} onChange={event => setBulkChildId(event.target.value)}><option value="">Choose subcategory</option>{(categoryGroups.find(group => group.id === bulkGroupId)?.children || []).map(child => <option key={child.sourceId || child.name} value={child.sourceId || child.name}>{child.name}</option>)}</select></label>}<label>Search matching products (optional)<input value={bulkSearch} onChange={event => setBulkSearch(event.target.value)} placeholder="Product name or keyword" /></label><label>Adjustment<select value={bulkDirection} onChange={event => setBulkDirection(event.target.value as typeof bulkDirection)}><option value="decrease">Decrease</option><option value="increase">Increase</option></select></label><label>By<select value={bulkType} onChange={event => setBulkType(event.target.value as typeof bulkType)}><option value="amount">Fixed amount (৳)</option><option value="percent">Percentage (%)</option></select></label><label>Value<input type="number" min="0.01" step="0.01" required value={bulkValue} onChange={event => setBulkValue(event.target.value)} /></label></div><button className="primary-button" disabled={bulkSaving || !bulkValue}>{bulkSaving ? "Updating prices…" : "Apply price adjustment"}</button>{bulkMessage && <p role="status">{bulkMessage}</p>}{bulkError && <p className="form-error" role="alert">{bulkError}</p>}</form></details><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => { const value = event.target.value; setSearch(value); setSearchPending(true); if (searchTimer.current !== null) window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => onSearchRef.current(value), 250) }} placeholder="Search products..." /></div><select className="select-chip" aria-label="Filter by category or subcategory" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{categoryGroups.map((group) => <optgroup key={group.id} label={group.name}><option value={`group:${group.id}`}>All {group.name}</option>{group.children.map((child) => <option key={`${group.id}-${child.sourceId || child.name}`} value={child.sourceId ? `source:${child.sourceId}` : `name:${child.name}`}>{child.name}</option>)}</optgroup>)}</select><select className="select-chip" aria-label="Filter products" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All products</option><option value="recent">New products · last 30 days</option><option value="active">Active</option><option value="hidden">Hidden</option><option value="available">Available stock</option><option value="unavailable">Out of stock</option><option value="shopbase">ShopBase import</option><option value="manual">Manually added</option></select><label className="product-sort-control">Sort by<select className="select-chip" aria-label="Sort products" value={sort} onChange={(event) => { const value = event.target.value as typeof sort; setSort(value); setVisibleCount(50); onSortChange(value) }}><option value="added">Recently added</option><option value="updated">Recently updated</option><option value="name-asc">Name: A to Z</option><option value="name-desc">Name: Z to A</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option><option value="views">Most viewed</option></select></label><span>{Math.min(products.length, total).toLocaleString()} of {total.toLocaleString()} products{loading ? ' · loading' : ''}</span></div>{searchPending || loading && Boolean(search) || loading && allProducts.length === 0 ? <div className="admin-product-loading" role="status" aria-label="Loading products"><div className="loading-caption"><span className="loading-orbit" />Loading products</div>{[0,1,2,3,4].map((row) => <div className="admin-product-loading-row" key={row}><i /><span /><span /><span /></div>)}</div> : products.length ? <>{availabilityError && <p className="availability-check-notice" role="alert">{availabilityError}</p>}<div className="responsive-table"><table className="data-table product-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Added</th><th>Views</th><th>Stock</th><th>Visibility</th><th>Source</th><th /></tr></thead><tbody>{products.slice(0, visibleCount).map((product) => <tr key={product.id}><td><div className="table-product"><ImageView src={product.image} alt="" /><span><button className="product-admin-view-link" onClick={() => onView(product)}>{product.title}</button><small>SKU / {product.sourceId || product.id.slice(0, 10)}</small></span></div></td><td>{product.category}</td><td><b>{money(product.price)}</b>{product.compareAt && <small className="old-price">{money(product.compareAt)}</small>}</td><td>{product.addedAt ? dateTimeLabel(product.addedAt) : 'Date unavailable'}</td><td><b>{(productViewCounts[product.id] || 0).toLocaleString()}</b></td><td><span className={product.stock < 10 ? 'stock-low' : 'stock-good'}><i /> {product.stock > 0 ? 'Available' : 'Unavailable'}</span></td><td><span className={`visibility ${product.active ? 'visible' : ''}`}><i /> {product.active ? 'Active' : 'Hidden'}</span></td><td><span className="source-tag">{product.source === 'shopbase' ? 'ShopBase import' : 'Manual'}</span></td><td><div className="row-actions">{product.source === 'shopbase' && <button className="availability-check-button" onClick={() => void checkAvailability(product)} disabled={checkingId === product.id} aria-label={`Check availability for ${product.title}`} title={checkingId === product.id ? "Checking ShopBase availability…" : availabilityResults[product.id] === true ? "Available in ShopBase" : availabilityResults[product.id] === false ? "Unavailable in ShopBase" : "Check availability in ShopBase"}>{checkingId === product.id ? <LoaderCircle size={16} className="availability-check-spinner" /> : availabilityResults[product.id] === true ? <Check size={17} /> : availabilityResults[product.id] === false ? <X size={17} /> : <RefreshCw size={16} />}</button>}<button onClick={() => onView(product)} aria-label={`View ${product.title}`}><Eye size={16} /></button><button onClick={() => onEdit(product)} aria-label={`Edit ${product.title}`}><Pencil size={16} /></button><button onClick={() => onDelete(product.id)} aria-label={`Delete ${product.title}`}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>{(products.length > visibleCount || hasMore) && <button className="load-more-button" disabled={moreLoading} onClick={() => { if (products.length > visibleCount) setVisibleCount((count) => count + 50); else { setVisibleCount((count) => count + 50); onLoadMore(sort) } }}>{moreLoading ? 'Loading next 50 products…' : 'Load next 50 products'} <span>Loaded {products.length.toLocaleString()} of {total.toLocaleString()}</span></button>}</> : loading ? <p className="empty-row">Loading more products…</p> : error ? <p className="form-error" role="alert">Products could not be loaded: {error}</p> : <p className="empty-row">No products match this filter.</p>}</section>
}

function AdminOffers({ state, products, apiBase, token, onNewCoupon, onNewOffer, onEditOffer, toggleCoupon, deleteCoupon, toggleOffer, deleteOffer, onEdit, updateState, notify }: { state: StoreState; products: Product[]; apiBase: string; token: string; onNewCoupon: () => void; onNewOffer: () => void; onEditOffer: (offer: OfferDeal) => void; toggleCoupon: (id: string) => void; deleteCoupon: (id: string) => void; toggleOffer: (id: string) => void; deleteOffer: (id: string) => void; onEdit: (product: Product) => void; updateState: (updater: (current: StoreState) => StoreState) => void; notify: (message: string) => void }) {
  const [offerOrderIds, setOfferOrderIds] = useState(() => state.offers.map((offer) => offer.id))
  const [savedOfferOrderIds, setSavedOfferOrderIds] = useState(() => state.offers.map((offer) => offer.id))
  const [savingOfferOrder, setSavingOfferOrder] = useState(false)
  const [offerOrderError, setOfferOrderError] = useState('')
  const offerIdsSignature = state.offers.map((offer) => offer.id).join('|')
  useEffect(() => {
    const liveIds = state.offers.map((offer) => offer.id)
    setOfferOrderIds((current) => [...current.filter((id) => liveIds.includes(id)), ...liveIds.filter((id) => !current.includes(id))])
    setSavedOfferOrderIds((current) => [...current.filter((id) => liveIds.includes(id)), ...liveIds.filter((id) => !current.includes(id))])
  }, [offerIdsSignature])
  const offerOrderDirty = offerOrderIds.length !== savedOfferOrderIds.length || offerOrderIds.some((id, index) => id !== savedOfferOrderIds[index])
  const orderedOffers = [...state.offers].sort((a, b) => {
    const aRank = offerOrderIds.indexOf(a.id)
    const bRank = offerOrderIds.indexOf(b.id)
    return (aRank < 0 ? Number.MAX_SAFE_INTEGER : aRank) - (bRank < 0 ? Number.MAX_SAFE_INTEGER : bRank)
  })
  const offerProducts = state.products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
  const productFor = (id: string) => products.find((product) => product.id === id)
  const moveOffer = (index: number, direction: -1 | 1) => {
    const next = orderedOffers.map((offer) => offer.id); const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setOfferOrderIds(next)
    setOfferOrderError('')
  }
  const saveOfferOrder = async () => {
    if (!offerOrderDirty || savingOfferOrder) return
    const ranked = orderedOffers.map((offer, sortOrder) => ({ ...offer, sortOrder }))
    setSavingOfferOrder(true)
    setOfferOrderError('')
    try {
      if (apiBase && token) {
        for (const offer of ranked) {
          const response = await fetch(`${apiBase}/api/admin/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(offer) })
          if (!response.ok) {
            const result = await response.json().catch(() => ({}))
            throw new Error(result.detail || 'Offer order could not be saved. Please try again.')
          }
        }
      } else throw new Error('Offer order could not be saved because the admin service is unavailable.')
      updateState((current) => ({ ...current, offers: ranked }))
      setSavedOfferOrderIds(ranked.map((offer) => offer.id))
      setOfferOrderIds(ranked.map((offer) => offer.id))
      notify('Offer order saved.')
    } catch (error) {
      setOfferOrderError(error instanceof Error ? error.message : 'Offer order could not be saved. Please try again.')
    } finally {
      setSavingOfferOrder(false)
    }
  }
  const offerLabel = (offer: OfferDeal) => {
    if (offer.kind === 'special_price') return `Special price ${money(offer.value)}`
    if (offer.kind === 'quantity_discount') return offer.quantity === 1 && offer.discountKind === 'percent' ? `${offer.value}% off each selected product` : `Buy ${offer.quantity}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}`
    if (offer.kind === 'buy_multiple') return offerTierSummary(offer, products.filter((product) => (offer.productIds?.length ? offer.productIds : [offer.productId]).includes(product.id))) || `Buy ${offer.quantity}${['discount', 'both'].includes(offer.reward || 'discount') ? `, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}` : ''}${['free_delivery', 'both'].includes(offer.reward || '') ? ' + free delivery' : ''}`
    if (offer.kind === 'buy_x_get_y_free') return `Buy ${offer.quantity}, get ${offer.freeQuantity} free`
    if (offer.kind === 'bundle') return `Bundle of ${(offer.productIds || []).length} products for ${money(offer.value)}`
    return `Free delivery${offer.value ? ` on orders over ${money(offer.value)}` : ''}`
  }
  return <>
    <div className="panel offers-feature"><div className="offers-feature-copy"><span className="section-kicker">CURRENT OFFER EDIT</span><h2>Offers customers can see.</h2><p>Create product deals customers can use automatically in their bag, or manage checkout coupons.</p><div className="offers-actions"><button className="primary-button" onClick={onNewOffer}><Plus size={17} /> Create offer</button><button className="secondary-button" onClick={onNewCoupon}><TicketPercent size={17} /> Create coupon</button></div></div><div className="offer-feature-art"><span>THE GOOD<br />DEAL EDIT</span><b>For a little<br />less.</b></div></div>
    <section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Product offers</h3><p>Deals are applied automatically to eligible items in the bag. Move offers into the order you want, then save.</p></div><div className="offer-order-actions">{offerOrderDirty && <button type="button" className="secondary-button" onClick={() => { setOfferOrderIds(savedOfferOrderIds); setOfferOrderError('') }} disabled={savingOfferOrder}>Discard changes</button>}<button type="button" className="primary-button" onClick={() => void saveOfferOrder()} disabled={!offerOrderDirty || savingOfferOrder}>{savingOfferOrder && <LoaderCircle size={16} />}{savingOfferOrder ? 'Saving order…' : 'Save order'}</button></div></div>
      {offerOrderError && <p className="offer-order-error" role="alert">{offerOrderError}</p>}
      {orderedOffers.length ? <div className="offer-product-list">{orderedOffers.map((offer, index) => { const product = productFor(offer.productId); const targetNames = [...new Set((offer.productIds?.length ? offer.productIds : offer.productId ? [offer.productId] : []).map((id) => productFor(id)?.title).filter((name): name is string => Boolean(name)))]; const productSummary = targetNames.length > 1 ? `${targetNames[0]} + ${targetNames.length - 1} more ${targetNames.length - 1 === 1 ? 'product' : 'products'}` : targetNames[0] || 'Selected products'; const description = offer.kind === 'free_delivery' ? offerLabel(offer) : `${productSummary} · ${offerLabel(offer)}`; return <div className="offer-product-row offer-deal-row" key={offer.id}>{product && <ImageView src={product.image} alt="" />}<span><b>{offer.title || product?.title || (offer.kind === 'free_delivery' ? 'Free delivery offer' : offer.kind === 'bundle' ? 'Product bundle' : 'Product offer')}</b><small>{description}</small></span><button className="offer-order-move" aria-label={`Move ${offer.title} up`} title="Move offer up" disabled={index === 0 || savingOfferOrder} onClick={() => moveOffer(index, -1)}>↑</button><button className="offer-order-move" aria-label={`Move ${offer.title} down`} title="Move offer down" disabled={index === orderedOffers.length - 1 || savingOfferOrder} onClick={() => moveOffer(index, 1)}>↓</button><button onClick={() => onEditOffer(offer)}><Pencil size={14} /> Edit</button><button onClick={() => toggleOffer(offer.id)}>{offer.active ? 'Active' : 'Paused'}</button><button onClick={() => deleteOffer(offer.id)}>Delete</button></div> })}</div> : <p className="empty-row">No offers yet. Create a product deal, bundle, or free-delivery offer.</p>}
    </section>
    <section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Featured offer products</h3><p>Products tagged for the storefront offer section</p></div></div>{offerProducts.length ? <div className="offer-product-list">{offerProducts.map((product) => <div className="offer-product-row" key={product.id}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{product.category} · {money(product.price)}{product.compareAt ? ` / ${money(product.compareAt)}` : ''}</small></span><button onClick={() => onEdit(product)}>Edit price</button><button onClick={() => { updateState((current) => ({ ...current, content: { ...current.content, offerIds: current.content.offerIds.filter((id) => id !== product.id) }, products: current.products.map((item) => item.id === product.id ? { ...item, offer: false } : item) })); notify('Removed from offer edit') }}>Remove</button></div>)}</div> : <p className="empty-row">No featured offers yet. Add a product offer or mark products for the offer section.</p>}</section>
    <section className="panel coupon-admin-panel"><div className="panel-heading"><div><h3>Coupon codes</h3><p>Discounts are checked against the bag subtotal.</p></div><button className="subtle-icon" onClick={onNewCoupon} aria-label="Add coupon"><Plus size={17} /></button></div><div className="coupon-admin-grid">{state.coupons.map((coupon) => <div className={`coupon-card ${coupon.active ? '' : 'inactive'}`} key={coupon.code}><div className="coupon-card-top"><span><TicketPercent size={16} /> DISCOUNT CODE</span><button onClick={() => toggleCoupon(coupon.code)}>{coupon.active ? 'Active' : 'Paused'} <ChevronDown size={13} /></button></div><strong>{coupon.code}</strong><p>{coupon.kind === 'percent' ? `${coupon.value}% off` : `${money(coupon.value)} off`} {coupon.minimum ? `on orders over ${money(coupon.minimum)}` : ''}</p><div className="coupon-card-actions"><button className="copy-code" onClick={() => { navigator.clipboard?.writeText(coupon.code); notify(`${coupon.code} copied`) }}><Copy size={14} /> Copy code</button><button className="delete-coupon" onClick={() => deleteCoupon(coupon.code)} aria-label={`Delete coupon ${coupon.code}`}><Trash2 size={15} /> Delete</button></div></div>)}</div>{!state.coupons.length && <p className="empty-row">Create your first coupon code.</p>}</section>
  </>
}

function AdminOrders({ orders, filter, setFilter, search, setSearch, onStatus }: { orders: Order[]; filter: string; setFilter: (value: string) => void; search: string; setSearch: (value: string) => void; onStatus: (id: string, status: OrderStatus) => void }) {
  const filtered = orders.filter((order) => (filter === 'All orders' || order.status === filter) && `${order.id} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <section className="panel orders-panel"><div className="panel-heading panel-heading-wrap"><div><h2>Orders</h2><p>Review customer details, confirm by phone, then place the supplier order in ShopBase.</p></div><button className="export-button" onClick={() => { const csv = ['Order,Customer,Phone,District,Thana,Address,Comments,Total,Status,Date', ...filtered.map((order) => [order.id, order.customer.name, order.customer.phone, order.customer.district || '', order.customer.thana || order.customer.area, order.customer.address, order.customer.comments || '', order.total, order.status, dateLabel(order.createdAt)].map(csvCell).join(','))].join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'aaro-orders.csv'; link.click(); window.setTimeout(() => URL.revokeObjectURL(link.href), 1000) }}><Download size={16} /> Export</button></div><div className="order-tabs">{['All orders', 'Pending confirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].map((item) => <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}{item === 'Pending confirmation' && <span className="order-count">{orders.filter((order) => order.status === item).length}</span>}</button>)}</div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order number, customer, phone..." /></div><span>{filtered.length} orders</span></div><div className="responsive-table"><OrderTable orders={filtered} onStatus={onStatus} /></div></section>
}

function OrderTable({ orders, onStatus, compact = false }: { orders: Order[]; onStatus: (id: string, status: OrderStatus) => void; compact?: boolean }) {
  return <table className="data-table order-table"><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th><th>{compact ? 'Action' : 'Update status'}</th></tr></thead><tbody>{orders.map((order) => { const selectedOptions = order.items.flatMap((item) => [item.size ? `${item.title}: ${item.size}` : '', ...Object.entries(item.options || {}).map(([name, value]) => `${item.title} · ${name}: ${value}`)]).filter(Boolean); return <tr key={order.id}><td><b className="order-id">{order.id}</b><small>{order.items.reduce((sum, item) => sum + item.quantity, 0)} item{order.items.reduce((sum, item) => sum + item.quantity, 0) === 1 ? '' : 's'}</small>{selectedOptions.length > 0 && <small>{selectedOptions.join(' · ')}</small>}</td><td><div className="customer-cell"><b>{order.customer.name}</b><small>{order.customer.phone} · {order.customer.thana ? `${order.customer.thana}, ${order.customer.district}` : order.customer.area}</small><small>{order.customer.address}</small>{order.customer.comments && <small>Note: {order.customer.comments}</small>}</div></td><td>{shortDate(order.createdAt)}</td><td><b>{money(order.total)}</b></td><td><StatusPill status={order.status} /></td><td>{order.status === 'Pending confirmation' ? <div className="order-action-group"><button className="confirm-button" onClick={() => onStatus(order.id, 'Confirmed')}><Check size={14} /> Confirm</button><button className="cancel-button" onClick={() => onStatus(order.id, 'Cancelled')}><X size={14} /> Cancel</button></div> : order.status === 'Confirmed' ? <button className="small-action" onClick={() => onStatus(order.id, 'Processing')}>Mark processing <ArrowRight size={13} /></button> : order.status === 'Processing' ? <button className="small-action" onClick={() => onStatus(order.id, 'Shipped')}>Mark shipped <ArrowRight size={13} /></button> : !compact && order.status === 'Shipped' ? <button className="small-action" onClick={() => onStatus(order.id, 'Delivered')}>Mark delivered <Check size={13} /></button> : <span className="row-muted">—</span>}</td></tr> })}</tbody></table>
}

function AdminProductViewer({ product, onClose, onEdit }: { product: Product; onClose: () => void; onEdit: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="form-modal product-detail-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / PRODUCT DETAILS</span><h2>{product.title}</h2></div><IconButton label="Close product details" onClick={onClose}><X size={19} /></IconButton></div><div className="admin-product-detail"><ImageView src={product.image} alt={product.title} /><div><div className="admin-product-detail-meta"><span>{product.category}</span><span>{product.source === 'shopbase' ? 'ShopBase import' : 'Manual product'}</span><span>{product.active ? 'Active' : 'Hidden'}</span></div><h3>{money(product.price)}{product.compareAt ? <del>{money(product.compareAt)}</del> : null}</h3><p>{product.description || 'No product description has been added.'}</p><dl><div><dt>Availability</dt><dd>{product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}</dd></div><div><dt>Product ID</dt><dd>{product.sourceId || product.id}</dd></div>{product.retailerPrice != null ? <div><dt>Retailer price</dt><dd>{money(product.retailerPrice)}</dd></div> : null}{product.sizes?.length ? <div><dt>Sizes</dt><dd>{product.sizes.join(', ')}</dd></div> : null}{product.options?.map((option) => <div key={option.name}><dt>{option.name}</dt><dd>{option.values.join(', ')}</dd></div>)}{product.attributes?.map((attribute) => <div key={attribute}><dt>Detail</dt><dd>{attribute}</dd></div>)}</dl><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Close</button><button className="primary-button" onClick={onEdit}><Pencil size={16} /> Edit product</button></div></div></div></section></div>
}

function CategoriesAdmin({ categories, categoryGroups, products, productCounts, content, manualCategoryVisibility, categoryInput, onCategoryInput, onAdd, onRemove, onDeleteChild, onEditGroup, onEditChild, onCategoryImage, onToggleGroup, onToggleChild, onToggleManual }: { categories: string[]; categoryGroups: CategoryGroup[]; products: Product[]; productCounts: Record<string, number>; content: StoreContent; manualCategoryVisibility: Record<string, boolean>; categoryInput: string; onCategoryInput: (value: string) => void; onAdd: (event: FormEvent<HTMLFormElement>) => void; onRemove: (name: string) => void; onDeleteChild: (groupId: string, sourceId: string) => void; onEditGroup: (id: string) => void; onEditChild: (id: string, name: string) => void; onCategoryImage: (name: string) => void; onToggleGroup: (id: string, visible: boolean) => void; onToggleChild: (id: string, name: string, visible: boolean) => void; onToggleManual: (name: string, visible: boolean) => void }) {
  const manualNames = categories.filter((name) => name !== 'All' && !categoryGroups.some((group) => group.children.some((child) => child.name === name)))
  const imageFor = (name: string) => content.categoryImages?.[name] || products.find((product) => product.category === name && product.image)?.image || ''
  const countFor = (child: CategoryGroup['children'][number]) => productCounts[child.sourceId || ''] ?? productCounts[child.name.toLocaleLowerCase()] ?? products.filter((product) => child.sourceId ? product.categorySourceId === child.sourceId : product.category === child.name).length
  return <section className="panel category-management-panel"><div className="panel-heading"><div><h2>Categories</h2><p>Choose images, rename categories, and control what customers see.</p></div><span className="category-total-count">{categoryGroups.reduce((sum, group) => sum + group.children.length, manualNames.length)} categories</span></div><form className="inline-add" onSubmit={onAdd}><input value={categoryInput} onChange={(event) => onCategoryInput(event.target.value)} placeholder="Add a manual category" /><button className="primary-button"><Plus size={17} /> Add category</button></form><div className="category-group-admin-list">{categoryGroups.map((group) => { const groupCount = group.children.reduce((sum, child) => sum + countFor(child), 0); return <section className="category-group-admin" key={group.id}><div className="category-group-admin-heading"><div className="category-group-title"><span className="section-kicker">CATEGORY GROUP</span><button className="category-edit-name" aria-label={`Edit ${group.name}`} onClick={() => onEditGroup(group.id)}><span>{group.name}</span><Pencil size={15} /></button><small>{groupCount.toLocaleString()} products · {group.children.length} subcategories</small></div><CategoryVisibilityToggle checked={group.showInStorefront !== false} onChange={(visible) => onToggleGroup(group.id, visible)} /></div><div className="category-admin-list">{group.children.map((child) => { const count = countFor(child); const image = imageFor(child.name); return <article className="category-admin-card" key={`${group.id}-${child.sourceId || child.name}`}><div className="category-card-image">{image ? <ImageView src={image} alt={`${child.name} category`} /> : <div className="category-image-empty"><ImageIcon size={24} /><span>No image yet</span></div>}<button className="category-image-action" onClick={() => onCategoryImage(child.name)}>{content.categoryImages?.[child.name] ? 'Change image' : 'Choose image'}</button></div><div className="category-card-content"><div className="category-card-title"><button className="category-edit-name" aria-label={`Edit ${child.name}`} onClick={() => onEditChild(group.id, child.name)}><span>{child.name}</span><Pencil size={14} /></button><span className="category-product-count">{count.toLocaleString()} products</span></div><div className="category-card-controls"><CategoryVisibilityToggle checked={child.showInStorefront !== false} onChange={(visible) => onToggleChild(group.id, child.name, visible)} />{child.sourceId && <button type="button" className="subtle-icon danger-hover category-delete-button" aria-label={`Delete ${child.name}`} title="Remove this subcategory from storefront" onClick={() => onDeleteChild(group.id, child.sourceId!)}><Trash2 size={16} /> Delete</button>}</div></div></article> })}</div></section> })}{manualNames.map((name) => { const image = imageFor(name); const count = productCounts[name.toLocaleLowerCase()] ?? products.filter((product) => product.category === name).length; return <article className="category-admin-card manual-category-card" key={name}><div className="category-card-image">{image ? <ImageView src={image} alt={`${name} category`} /> : <div className="category-image-empty"><ImageIcon size={24} /><span>No image yet</span></div>}<button className="category-image-action" onClick={() => onCategoryImage(name)}>{content.categoryImages?.[name] ? 'Change image' : 'Choose image'}</button></div><div className="category-card-content"><div className="category-card-title"><strong>{name}</strong><span className="category-product-count">{count.toLocaleString()} products · manual</span></div><CategoryVisibilityToggle checked={manualCategoryVisibility[name] !== false} onChange={(visible) => onToggleManual(name, visible)} /><button className="subtle-icon danger-hover" aria-label={`Remove ${name}`} onClick={() => onRemove(name)}><Trash2 size={17} /> Remove</button></div></article> })}</div></section>
}

function CategoryVisibilityToggle({ checked, onChange }: { checked: boolean; onChange: (visible: boolean) => void }) {
  return <label className="category-visibility-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>Show in storefront</span></label>
}

function ProductEditor({ product, categories, onClose, onSave }: { product: Product | null; categories: string[]; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const optionText = (product?.options || []).map((option) => `${option.name}: ${option.values.join(', ')}`).join('\n')
  const [images, setImages] = useState<string[]>(() => [...new Set((product?.images?.length ? product.images : product?.image ? [product.image] : []).filter(Boolean))])
  const [newImageUrl, setNewImageUrl] = useState('')
  const [imageUploadBusy, setImageUploadBusy] = useState(false)
  const originalPrice = product ? product.originalPrice ?? (product.compareAt && product.compareAt > product.price ? product.compareAt : product.price) : ''
  const discountedPrice = product?.discountedPrice ?? (product?.compareAt && product.compareAt > product.price ? product.price : '')
  const addImage = () => {
    const value = newImageUrl.trim()
    try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol)) return } catch { return }
    if (images.length >= 20) return
    if (!images.includes(value)) setImages((current) => [...current, value])
    setNewImageUrl('')
  }
  const uploadImage = async (file?: File) => {
    if (!file || images.length >= 20) return
    setImageUploadBusy(true)
    try { const value = await compressImageFile(file, 1400, 1400); setImages((current) => current.length < 20 && !current.includes(value) ? [...current, value] : current) }
    catch (error) { window.alert(error instanceof Error ? error.message : 'Could not prepare this image.') }
    finally { setImageUploadBusy(false) }
  }
  const moveImage = (index: number, direction: -1 | 1) => setImages((current) => { const target = index + direction; if (target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next })
  return <div className="modal-backdrop"><div className="form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CATALOG</span><h2>{product ? 'Edit product' : 'Add product'}</h2></div><IconButton label="Close editor" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form product-editor-form" onSubmit={onSave}>
    <label>Product name<input name="title" required defaultValue={product?.title} placeholder="e.g. Cotton co-ord set" /></label>
    <div className="settings-two"><label>Category<select name="category" defaultValue={product?.category || categories[0]}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><label>Original price (৳)<input name="originalPrice" type="number" min="0" step="0.01" required defaultValue={originalPrice} /><small>{product?.source === 'shopbase' ? 'Editable catalog price. Your saved price stays in place during supplier sync.' : 'Regular selling price before any discount.'}</small></label></div>
    <div className="settings-two"><label>Discounted selling price (৳) <span>(optional)</span><input name="discountedPrice" type="number" min="0" step="0.01" max={originalPrice === '' ? undefined : Math.max(0, Number(originalPrice) - 0.01)} defaultValue={discountedPrice} placeholder="Leave blank for no discount" /></label><label>Retailer price <span>(read only)</span><input type="text" readOnly value={product?.retailerPrice != null ? money(product.retailerPrice) : 'Not provided by supplier'} /><small>For your reference only; never shown to customers.</small></label></div>
    <label>Available quantity (set to 0 to mark unavailable)<input name="stock" type="number" min="0" defaultValue={product?.stock ?? 0} /></label>
    <section className="product-image-manager"><div className="product-image-manager-heading"><b>Product photos</b><span>First photo is the main image. Add, remove, or reorder.</span></div><input type="hidden" name="images" value={JSON.stringify(images)} /><input type="hidden" name="image" value={images[0] || ''} />{images.length ? <div className="product-image-list">{images.map((image, index) => <div className="product-image-row" key={`${image}-${index}`}><ImageView src={image} alt={`Product photo ${index + 1}`} /><span>{index === 0 ? 'Main photo' : `Photo ${index + 1}`}</span><div><button type="button" aria-label={`Move photo ${index + 1} up`} disabled={index === 0} onClick={() => moveImage(index, -1)}>↑</button><button type="button" aria-label={`Move photo ${index + 1} down`} disabled={index === images.length - 1} onClick={() => moveImage(index, 1)}>↓</button><button type="button" aria-label={`Remove photo ${index + 1}`} onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button></div></div>)}</div> : <p className="form-help">Add at least one photo URL or upload an image.</p>}<div className="product-image-add-row"><input type="url" value={newImageUrl} onChange={(event) => setNewImageUrl(event.target.value)} placeholder="Paste a product image URL" /><button type="button" className="secondary-button" onClick={addImage} disabled={!newImageUrl.trim() || images.length >= 20}>Add URL</button><label className="secondary-button product-upload-button">{imageUploadBusy ? 'Preparing…' : 'Upload from device'}<input type="file" accept="image/*" disabled={imageUploadBusy || images.length >= 20} onChange={(event) => { void uploadImage(event.target.files?.[0]); event.currentTarget.value = '' }} /></label></div></section>
    <label>Product details<textarea name="description" rows={4} defaultValue={product?.description} placeholder="What should a customer know?" /></label>
    <div className="settings-two"><label>Available sizes <span>(comma separated; leave empty if not applicable)</span><input name="sizes" defaultValue={product?.sizes?.join(', ')} placeholder="S, M, L, XL" /></label><label>Size guide <span>(optional)</span><textarea name="sizeChart" rows={2} defaultValue={product?.sizeChart || ''} placeholder="Measurements or fit notes" /></label></div>
    <label>Product options <span>(one option per line, format: Color: Black, Blue)</span><textarea name="options" rows={3} defaultValue={optionText} placeholder={'Color: Black, Blue\nMaterial: Cotton, Linen'} /></label><label>Badge (optional)<input name="badge" defaultValue={product?.badge || ''} placeholder="Bestseller, New, Set of 2" /></label>
    <div className="check-options"><label><input type="checkbox" name="active" defaultChecked={product?.active ?? true} /> Show on storefront</label><label><input type="checkbox" name="trending" defaultChecked={product?.trending} /> Trending now</label><label><input type="checkbox" name="offer" defaultChecked={product?.offer} /> Include in offers</label></div>
    <div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!images.length}><Check size={16} /> Save product</button></div>
  </form></div></div>
}
function OfferEditor({ offer, products, apiBase, onClose, onSave }: { offer: OfferDeal | null; products: Product[]; apiBase: string; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const [search, setSearch] = useState('')
  const [searchedProducts, setSearchedProducts] = useState<Product[]>([])
  const [visibleProductCount, setVisibleProductCount] = useState(60)
  const [kind, setKind] = useState<OfferDeal['kind'] | 'percentage_each'>(offer?.kind === 'quantity_discount' && offer.quantity === 1 && offer.discountKind === 'percent' ? 'percentage_each' : offer?.kind || 'special_price')
  const [discountKind, setDiscountKind] = useState<OfferDeal['discountKind']>(offer?.discountKind || 'percent')
  const [tiers, setTiers] = useState<OfferTier[]>(offer?.tiers?.length ? offer.tiers.map((tier) => ({ ...tier })) : [{ quantity: 2, mode: 'discount', value: 10, discountKind: 'percent', freeDelivery: false }])
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(offer?.productIds?.length ? offer.productIds : offer?.productId ? [offer.productId] : [])
  const [thumbnailProductIds, setThumbnailProductIds] = useState<string[]>(offer?.thumbnailProductIds || [])
  const [shareImage, setShareImage] = useState(offer?.shareImage || '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    const needle = search.trim()
    if (!apiBase || needle.length < 2) { setSearchedProducts([]); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ kind: 'search', search: needle, limit: '50' })
      fetch(`${apiBase}/api/catalog-priority?${params.toString()}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ products?: unknown }> : null)
        .then((result) => { if (!result || !Array.isArray(result.products)) return; const found = result.products.filter((item): item is Product => Boolean(item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && 'title' in item && typeof item.title === 'string' && 'category' in item && typeof item.category === 'string' && 'image' in item && typeof item.image === 'string' && 'price' in item && Number.isFinite(Number(item.price)))); setSearchedProducts((current) => [...new Map([...current, ...found].map((product) => [product.id, product])).values()]) })
        .catch(() => { /* Keep local offer products searchable when the catalog API is unavailable. */ })
    }, 220)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [apiBase, search])
  const searchableProducts = [...new Map([...products, ...searchedProducts].map((product) => [product.id, product])).values()]
  const matchingProducts = searchableProducts.filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(search.toLowerCase()))
  const filtered = matchingProducts.slice(0, visibleProductCount)
  const selectedProducts = selectedProductIds.map((id) => searchableProducts.find((product) => product.id === id)).filter((product): product is Product => Boolean(product))
  const selectedProduct = selectedProducts[0]
  const toggleSelectedProduct = (id: string) => setSelectedProductIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const moveThumbnail = (id: string, direction: -1 | 1) => setThumbnailProductIds((current) => {
    const index = current.indexOf(id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= current.length) return current
    const next = [...current]
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  })
  const submitOffer = (event: FormEvent<HTMLFormElement>) => {
    if (saving) { event.preventDefault(); return }
    setSaving(true); setSaveError('')
    void Promise.resolve(onSave(event)).catch((error: unknown) => setSaveError(error instanceof Error ? error.message : 'The offer could not be saved. Please try again.')).finally(() => setSaving(false))
  }
  return <div className="modal-backdrop"><div className="form-modal offer-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / PRODUCT DEAL</span><h2>{offer ? 'Edit offer' : 'Create offer'}</h2></div><IconButton label="Close offer form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={submitOffer} aria-busy={saving}>
    <label>Offer name<input name="title" required maxLength={120} defaultValue={offer?.title || ''} placeholder="e.g. Buy 2, save 10%" /></label><input type="hidden" name="shareImage" value={shareImage} /><div className="social-thumbnail-uploader offer-social-thumbnail"><div className="social-thumbnail-preview">{shareImage ? <ImageView src={shareImage} alt="Offer sharing thumbnail" /> : <div><ImageIcon size={22} /><span>Homepage default</span></div>}</div><div><label className="secondary-button product-upload-button"><Upload size={16} />{shareImage ? "Replace thumbnail" : "Upload thumbnail"}<input type="file" accept="image/*" onChange={async (event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; try { setShareImage(await compressSocialShareImage(file)) } catch (error) { setSaveError(error instanceof Error ? error.message : "Could not prepare this image.") } }} /></label>{shareImage && <button type="button" className="secondary-button" onClick={() => setShareImage("")}>Use homepage thumbnail</button>}<small>Used only when this offer link is shared.</small></div></div>
    {kind !== 'free_delivery' && <section className="offer-product-picker"><label className="offer-search-label">Search and select products<span className="offer-product-search"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleProductCount(60) }} placeholder="Type a product name or category" /></span></label>{selectedProductIds.map((id) => <input type="hidden" name="productIds" value={id} key={id} />)}{selectedProducts.length > 0 && <div className="offer-selected-products"><b>Selected · {selectedProducts.length}</b><div>{selectedProducts.map((product) => <span className="offer-selected-chip" key={product.id}>{product.title}<button type="button" aria-label={`Remove ${product.title}`} onClick={() => toggleSelectedProduct(product.id)}><X size={13} /></button></span>)}</div></div>}<div className="offer-product-results">{filtered.map((product) => { const selected = selectedProductIds.includes(product.id); return <button type="button" className={`offer-product-option ${selected ? 'selected' : ''}`} key={product.id} aria-pressed={selected} onClick={() => toggleSelectedProduct(product.id)}><span className="offer-product-check">{selected ? <Check size={14} /> : <Plus size={14} />}</span><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{product.category} · {money(product.price)}</small></span><strong>{selected ? 'Selected' : 'Add'}</strong></button> })}{!filtered.length && <p className="offer-search-empty">No products match that search.</p>}</div>{matchingProducts.length > filtered.length && <button type="button" className="offer-show-more" onClick={() => setVisibleProductCount((count) => count + 60)}>Show more results · {filtered.length} of {matchingProducts.length.toLocaleString()}</button>}<small className="offer-picker-help">{kind === 'bundle' ? 'Choose at least two products; every selected product must be in the bag for the bundle deal.' : 'All selected products share the offer: mix any of them to reach a quantity tier.'} Select as many products as you need.</small></section>}
    <label>Offer type<select name="kind" value={kind} onChange={(event) => setKind(event.target.value as OfferDeal['kind'] | 'percentage_each')}><option value="special_price">Set a special product price</option><option value="percentage_each">Percentage off each selected product</option><option value="quantity_discount">Buy a quantity and save</option><option value="buy_multiple">Multiple quantity tiers</option><option value="buy_x_get_y_free">Buy X, get Y free</option><option value="bundle">Bundle selected products at one price</option><option value="free_delivery">Free delivery on orders over an amount</option></select></label>
    {kind === 'percentage_each' && <><input type="hidden" name="quantity" value="1" /><input type="hidden" name="discountKind" value="percent" /><label>Discount percentage<input name="value" type="number" min="1" max="100" defaultValue={offer?.value} required /><small>This discount applies to every unit of every selected product.</small></label></>}
    {kind === 'special_price' && <label>Offer price (৳)<input name="value" type="number" min="1" max={selectedProduct?.price} defaultValue={offer?.value} required /></label>}
    {kind === 'quantity_discount' && <><div className="settings-two"><label>Minimum quantity<input name="quantity" type="number" min="1" defaultValue={offer?.quantity ?? 2} required /></label><label>Discount type<select name="discountKind" value={discountKind} onChange={(event) => setDiscountKind(event.target.value as OfferDeal['discountKind'])}><option value="percent">Percentage</option><option value="amount">Fixed ৳ amount</option></select></label></div><label>Discount amount<input name="value" type="number" min="1" max={discountKind === 'percent' ? 100 : undefined} defaultValue={offer?.value} required /></label></>}
    {kind === 'buy_multiple' && <section className="offer-tier-editor"><div className="offer-tier-heading"><div><b>Quantity rewards</b><small>Quantities combine across all selected products. Higher tiers apply first; leftovers can qualify for a smaller set.</small></div><button type="button" className="secondary-button" onClick={() => setTiers((current) => [...current, { quantity: (current.at(-1)?.quantity || 0) + 1, mode: 'discount', value: 10, discountKind: 'percent', freeDelivery: false }])}><Plus size={15} /> Add tier</button>{offer && tiers.some((tier) => tier.mode === 'discount' && tier.discountKind === 'amount') && <button type="button" className="secondary-button" onClick={() => setTiers((current) => current.map((tier) => tier.mode === 'discount' && tier.discountKind === 'amount' ? { ...tier, mode: 'price' } : tier))}>Use amounts as set prices</button>}</div>{tiers.map((tier, index) => <div className="offer-tier-row" key={index}><label>Quantity<input name={`tierQuantity-${index}`} type="number" min="1" required value={tier.quantity} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item))} /></label><label>Reward<select name={`tierMode-${index}`} value={tier.mode} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, mode: event.target.value as OfferTier['mode'] } : item))}><option value="price">Set total price</option><option value="discount">Discount</option><option value="none">Free delivery only</option></select></label>{tier.mode === 'discount' && <label>Discount type<select name={`tierDiscountKind-${index}`} value={tier.discountKind} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, discountKind: event.target.value as OfferTier['discountKind'] } : item))}><option value="percent">Percent</option><option value="amount">Fixed ৳ per set</option></select></label>}{tier.mode !== 'none' && <label>{tier.mode === 'price' ? 'Set price (৳)' : 'Discount value'}<input name={`tierValue-${index}`} type="number" min="0" max={tier.mode === 'discount' && tier.discountKind === 'percent' ? 100 : undefined} required value={tier.value} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: Number(event.target.value) } : item))} /></label>}<label className="offer-tier-free-delivery"><input name={`tierFreeDelivery-${index}`} type="checkbox" checked={tier.freeDelivery || tier.mode === 'none'} disabled={tier.mode === 'none'} onChange={(event) => setTiers((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, freeDelivery: event.target.checked } : item))} /> Free delivery</label><button type="button" className="subtle-icon danger-hover" aria-label={`Remove tier ${index + 1}`} disabled={tiers.length <= 1} onClick={() => setTiers((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button></div>)}<p className="form-help">Example: Buy 1 item at a special price, then get a different price for 2 items. You can set a price, discount, delivery, or combine them.</p></section>}
    {kind === 'buy_x_get_y_free' && <div className="settings-two"><label>Buy quantity<input name="quantity" type="number" min="1" defaultValue={offer?.quantity ?? 3} required /></label><label>Free quantity<input name="freeQuantity" type="number" min="1" defaultValue={offer?.freeQuantity ?? 1} required /></label></div>}
    {kind === 'bundle' && <div className="settings-two"><label>Quantity of each bundle item<input name="quantity" type="number" min="1" defaultValue={offer?.quantity ?? 1} required /></label><label>Bundle price (৳)<input name="value" type="number" min="0" defaultValue={offer?.value} required /></label></div>}
    {kind === 'free_delivery' && <label>Minimum order subtotal (৳)<input name="value" type="number" min="0" defaultValue={offer?.value ?? 0} required /><span>Leave at 0 to offer free delivery on every order.</span></label>}
    {kind !== 'free_delivery' && selectedProducts.length > 0 && <section className="offer-thumbnail-picker"><div className="offer-thumbnail-heading"><b>Offer card thumbnails</b><small>Select up to three products, then arrange their position from left to right. {thumbnailProductIds.length}/3 selected.</small></div>{thumbnailProductIds.length > 0 && <><div className="offer-thumbnail-heading"><b>Thumbnail order · left to right</b></div><div className="offer-thumbnail-order">{thumbnailProductIds.map((id, index) => { const product = selectedProducts.find((item) => item.id === id); return product ? <div className="offer-thumbnail-order-item" key={`order-${id}`}><span className="offer-thumbnail-position">{index + 1}</span><ImageView src={product.image} alt="" /><span title={product.title}>{product.title}</span><button type="button" aria-label={`Move thumbnail ${index + 1} left`} title="Move left" disabled={index === 0} onClick={() => moveThumbnail(id, -1)}>←</button><button type="button" aria-label={`Move thumbnail ${index + 1} right`} title="Move right" disabled={index === thumbnailProductIds.length - 1} onClick={() => moveThumbnail(id, 1)}>→</button></div> : null })}</div>{thumbnailProductIds.map((id) => <input type="hidden" name="thumbnailProductIds" value={id} key={`thumbnail-order-${id}`} />)}</>}<div className="offer-thumbnail-grid">{selectedProducts.map((product) => <label key={`thumb-${product.id}`} className={`offer-thumbnail-choice ${thumbnailProductIds.includes(product.id) ? 'selected' : ''}`}><input type="checkbox" value={product.id} checked={thumbnailProductIds.includes(product.id)} disabled={!thumbnailProductIds.includes(product.id) && thumbnailProductIds.length >= 3} onChange={(event) => setThumbnailProductIds((current) => event.target.checked ? [...current, product.id] : current.filter((id) => id !== product.id))} /><ImageView src={product.image} alt="" /><span>{product.title}</span><i>{thumbnailProductIds.includes(product.id) ? `Position ${thumbnailProductIds.indexOf(product.id) + 1}` : 'Select'}</i></label>)}</div></section>}
    <p className="form-help">Offers are checked again by the server when an order is submitted.</p>
    {saveError && <p className="form-error" role="alert">{saveError}</p>}
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? <><LoaderCircle size={16} className="availability-check-spinner" /> {offer ? 'Updating offer…' : 'Saving offer…'}</> : <><Check size={16} /> {offer ? 'Update offer' : 'Save offer'}</>}</button></div>
  </form></div></div>
}

function CouponEditor({ onClose, onSave }: { onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const [kind, setKind] = useState<Coupon['kind']>('percent')
  return <div className="modal-backdrop"><div className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CHECKOUT</span><h2>Create coupon</h2></div><IconButton label="Close coupon form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={onSave}><label>Coupon code<input name="code" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]+" title="Use letters, numbers, dashes, or underscores only." placeholder="e.g. AARO15" /></label><div className="settings-two"><label>Discount type<select name="kind" value={kind} onChange={(event) => setKind(event.target.value as Coupon['kind'])}><option value="percent">Percentage</option><option value="amount">Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" max={kind === 'percent' ? 100 : undefined} required /></label></div><label>Minimum order (৳), optional<input name="minimum" type="number" min="0" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save coupon</button></div></form></div></div>
}

function SyncPanel({ lastSync, importedCount, onLastSync, onSyncComplete, importNote, fileRef, onImport, products, apiBase, token }: { lastSync: string; importedCount: number | null; onLastSync: (value: string) => void; onSyncComplete: () => void; importNote: string; fileRef: { current: HTMLInputElement | null }; onImport: (file?: File) => void; products: Product[]; apiBase: string; token: string }) {
  const onLastSyncRef = useRef(onLastSync)
  onLastSyncRef.current = onLastSync
  const onSyncCompleteRef = useRef(onSyncComplete)
  onSyncCompleteRef.current = onSyncComplete
  const imported = products.filter((product) => product.source === 'shopbase')
  const stableImportedCount = importedCount ?? imported.length
  type SyncProgress = { status: string; phase?: string; error?: string; startedAt?: string; updatedAt?: string; finishedAt?: string; requestedAt?: string; workflowStartedAt?: string; workflowFinishedAt?: string; categoriesProcessed?: number; totalCategories?: number; productsDiscovered?: number; productsProcessed?: number; totalProducts?: number; created?: number; changed?: number; unchanged?: number; skippedDetails?: number; progressPercent?: number; workflowStatus?: string; workflowRunId?: number; workflowUrl?: string }
  const appliedSyncAtRef = useRef('')
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressError, setProgressError] = useState('')
  const [syncNotice, setSyncNotice] = useState('')
  const [exportingProducts, setExportingProducts] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [intervalHours, setIntervalHours] = useState(24)
  const [startTime, setStartTime] = useState('00:00')
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleMessage, setScheduleMessage] = useState('')
  const [cookieEditorOpen, setCookieEditorOpen] = useState(false)
  const [cookieDraft, setCookieDraft] = useState('')
  const [hostedLoginConfigured, setHostedLoginConfigured] = useState(false)
  const [hostedUsername, setHostedUsername] = useState('')
  const [hostedPassword, setHostedPassword] = useState('')
  const [hostedLoginBusy, setHostedLoginBusy] = useState(false)
  const [hostedLoginMessage, setHostedLoginMessage] = useState('')
  const hostedUsernameRef = useRef<HTMLInputElement>(null)
  const exportAvailableProducts = async () => {
    if (!apiBase || !token) { setExportMessage('Exporting products needs an active admin session.'); return }
    setExportingProducts(true)
    setExportMessage('')
    try {
      const response = await fetch(apiBase + '/api/admin/products', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      const result: unknown = await response.json()
      if (!response.ok) throw new Error(typeof result === 'object' && result !== null && 'detail' in result ? String(result.detail) : 'Could not load the product catalog for export.')
      if (!Array.isArray(result)) throw new Error('The product catalog response was not valid.')
      const available = (result as Product[]).filter((product) => product.active !== false && Number(product.stock) > 0)
      if (!available.length) { setExportMessage('No available products to export.'); return }
      const headings = ['Product ID', 'Supplier ID', 'Product name', 'Category', 'Parent category', 'Selling price (BDT)', 'Original price (BDT)', 'Discounted price (BDT)', 'Retailer price (BDT)', 'Available quantity', 'Availability', 'Visibility', 'Source', 'Sizes', 'Options', 'Main image URL', 'Added at', 'Updated at']
      const rows = available.map((product) => [
        product.id, product.sourceId, product.title, product.category, product.parentCategory,
        product.price, product.originalPrice, product.discountedPrice, product.retailerPrice,
        product.stock, 'Available', product.active === false ? 'Hidden' : 'Active', product.source,
        (product.sizes || []).join(' | '), (product.options || []).map((option) => `${option.name}: ${option.values.join(' | ')}`).join('; '),
        product.image, product.addedAt, product.updatedAt,
      ].map(csvCell).join(','))
      const csv = '\uFEFF' + [headings.map(csvCell).join(','), ...rows].join('\r\n')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `aaro-available-products-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportMessage(`Exported ${available.length.toLocaleString()} available products. Open the CSV in Excel.`)
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : 'Could not export the product catalog.')
    } finally {
      setExportingProducts(false)
    }
  }
  const acceptProgress = (result: SyncProgress) => {
    setSyncProgress(result)
    if ((result.status === 'success' || result.status === 'success_with_skipped_details') && typeof result.finishedAt === 'string') {
      onLastSyncRef.current(result.finishedAt)
      if (appliedSyncAtRef.current !== result.finishedAt) {
        appliedSyncAtRef.current = result.finishedAt
        onSyncCompleteRef.current()
      }
    }
  }
  useEffect(() => {
    if (!apiBase || !token) return
    fetch(apiBase + '/api/admin/sync/schedule', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load the saved sync interval.')
        if ([6, 12, 24, 48].includes(result.intervalHours)) setIntervalHours(result.intervalHours)
        if (typeof result.startTime === 'string' && /^(?:[01]\d|2[0-3]):00$/.test(result.startTime)) setStartTime(result.startTime)
      })
      .catch((error) => setScheduleMessage(error instanceof Error ? error.message : 'Could not load the saved sync interval.'))
  }, [apiBase, token])
  const saveSchedule = async () => {
    if (!apiBase || !token) { setScheduleMessage('Saving the schedule needs an active admin session and catalog API.'); return }
    setScheduleSaving(true)
    setScheduleMessage('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ intervalHours, startTime }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'The sync interval could not be saved.')
      setIntervalHours(result.intervalHours)
      setStartTime(result.startTime)
      setScheduleMessage(`Saved. Automatic sync starts at ${result.startTime} Bangladesh time, then repeats every ${result.intervalHours} hours.`)
    } catch (error) {
      setScheduleMessage(error instanceof Error ? error.message : 'The sync interval could not be saved.')
    } finally { setScheduleSaving(false) }
  }
  const refreshProgress = async () => {
    if (!apiBase || !token) { setProgressError('Sync progress needs an active admin session and catalog API.'); return }
    setProgressLoading(true)
    setProgressError('')
    setSyncNotice('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/progress', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not load sync progress.')
      acceptProgress(result)
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : 'Could not load sync progress.')
    } finally { setProgressLoading(false) }
  }
  useEffect(() => {
    void refreshProgress()
  }, [apiBase, token])
  const loadHostedLogin = async () => {
    if (!apiBase || !token) return
    try {
      const response = await fetch(apiBase + '/api/admin/sync/login', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      const result = await response.json()
      if (response.ok) setHostedLoginConfigured(Boolean(result.configured))
      else setHostedLoginMessage(result.detail || 'Could not check hosted sign-in settings.')
    } catch { setHostedLoginMessage('Could not check hosted sign-in settings.') }
  }
  useEffect(() => { void loadHostedLogin() }, [apiBase, token])
  const saveHostedLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!apiBase || !token) return
    setHostedLoginBusy(true); setHostedLoginMessage('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/login', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ username: hostedUsername, password: hostedPassword }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not save hosted sign-in.')
      setHostedLoginConfigured(true); setHostedUsername(''); setHostedPassword('')
      setHostedLoginMessage('Saved securely. GitHub Actions can now renew the ShopBase session without your PC.')
    } catch (error) { setHostedLoginMessage(error instanceof Error ? error.message : 'Could not save hosted sign-in.') }
    finally { setHostedLoginBusy(false) }
  }
  const removeHostedLogin = async () => {
    if (!apiBase || !token) return
    setHostedLoginBusy(true); setHostedLoginMessage('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/login', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not remove hosted sign-in.')
      setHostedLoginConfigured(false); setHostedLoginMessage('Hosted sign-in credentials removed.')
    } catch (error) { setHostedLoginMessage(error instanceof Error ? error.message : 'Could not remove hosted sign-in.') }
    finally { setHostedLoginBusy(false) }
  }
  const startSyncNow = async () => {
    if (!apiBase || !token) { setProgressError('Sync Now needs an active admin session and catalog API.'); return }
    setProgressLoading(true)
    setProgressError('')
    setSyncNotice('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ refresh_details: true }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not start catalog sync.')
      setSyncProgress({ status: 'running', phase: 'queued', progressPercent: 0, workflowStatus: result.status || 'queued', workflowRunId: result.workflowRunId, workflowUrl: result.workflowUrl, requestedAt: result.requestedAt })
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : 'Could not start catalog sync.')
    } finally { setProgressLoading(false) }
  }
  const startHostedCookieSync = () => {
    if (!hostedLoginConfigured) {
      setHostedLoginMessage('Enter and save your ShopBase credentials here to enable automatic cookie renewal.')
      document.getElementById('hosted-login-setup')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      window.setTimeout(() => hostedUsernameRef.current?.focus(), 450)
      return
    }
    void startSyncNow()
  }
  const saveShopBaseCookie = () => {
    if (!apiBase || !token) { setProgressError('Saving the cookie needs an active admin session and catalog API.'); return }
    setCookieDraft('')
    setCookieEditorOpen(true)
  }
  const submitShopBaseCookie = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cookie = cookieDraft.trim()
    if (!cookie) return
    setProgressLoading(true); setProgressError(''); setSyncNotice('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/cookie', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ cookie }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not save the cookie.')
      setSyncNotice(result.message || 'ShopBase cookie saved securely.')
      setCookieDraft(''); setCookieEditorOpen(false)
    } catch (error) { setProgressError(error instanceof Error ? error.message : 'Could not save the cookie.') }
    finally { setProgressLoading(false) }
  }
  useEffect(() => {
    if (syncProgress?.status !== 'running' || !apiBase || !token) return
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(apiBase + '/api/admin/sync/progress', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
        if (response.ok) { const result = await response.json(); acceptProgress(result) }
      } catch { /* Keep the last reported progress visible during temporary network interruptions. */ }
    }, 5000)
    return () => window.clearInterval(poll)
  }, [syncProgress?.status, apiBase, token])
  useEffect(() => {
    if (syncProgress?.status !== 'running') return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [syncProgress?.status])
  const progress = syncProgress
  const totalProducts = progress?.totalProducts || 0
  const progressPercent = progress?.progressPercent ?? (progress?.status === 'success' || progress?.status === 'success_with_skipped_details' ? 100
    : progress?.phase === 'updating_products' && totalProducts > 0 ? 15 + Math.round(((progress.productsProcessed || 0) / totalProducts) * 85)
    : progress?.totalCategories ? Math.round(((progress.categoriesProcessed || 0) / progress.totalCategories) * 15) : 0)
  const startedAt = progress?.workflowStartedAt || progress?.startedAt || progress?.requestedAt
  const startedMs = startedAt ? new Date(startedAt).getTime() : NaN
  const finishedAt = progress?.workflowFinishedAt || progress?.finishedAt
  const finishedMs = finishedAt ? new Date(finishedAt).getTime() : NaN
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, (progress?.status === 'running' ? clockNow : finishedMs) - startedMs) : NaN
  const remainingMs = progress?.status === 'running' && progress?.phase === 'updating_products' && progressPercent >= 5 && Number.isFinite(elapsedMs)
    ? elapsedMs * (100 - progressPercent) / progressPercent : NaN
  const phaseLabel = progress?.status === 'running' ? ({
    queued: 'Waiting for GitHub Actions to start',
    schedule_check: 'Checking the saved automatic sync schedule',
    starting: 'Starting the catalog importer',
    connecting: 'Connecting to the catalog',
    reading_categories: 'Reading categories',
    refreshing_session: 'Renewing ShopBase session in GitHub Actions',
    scanning_categories: 'Finding products in categories',
    updating_products: 'Updating product details',
  } as Record<string, string>)[progress.phase || ''] || 'Preparing the sync'
    : progress?.status === 'failed' ? 'Sync failed'
    : progress?.status === 'not_started' ? 'No sync run has been recorded yet'
    : progress ? 'Sync finished' : ''
  return <div className="sync-layout">
    <section className="panel sync-hero-panel">
      <div className="sync-symbol"><RotateCcw size={24} /></div>
      <span className="section-kicker">CATALOG / SHOPBASE BD</span>
      <h2>Your catalog, all in one place.</h2>
      <p>Supplier updates belong in your catalog first. The hosted GitHub workflow checks on your saved schedule and runs without your PC being on.</p>
      <div className="sync-schedule-settings"><label htmlFor="catalog-sync-interval">Automatic sync interval<select id="catalog-sync-interval" value={intervalHours} onChange={(event) => { setIntervalHours(Number(event.target.value)); setScheduleMessage('') }}><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Every 24 hours</option><option value={48}>Every 48 hours</option></select></label><label htmlFor="catalog-sync-start">Daily start time (Bangladesh)<input id="catalog-sync-start" type="time" step={3600} value={startTime} onChange={(event) => { setStartTime(event.target.value); setScheduleMessage('') }} /></label><button type="button" className="secondary-button" onClick={saveSchedule} disabled={scheduleSaving}>{scheduleSaving ? 'Saving…' : 'Save changes'}</button>{scheduleMessage && <p className="sync-schedule-message" role="status">{scheduleMessage}</p>}</div>
      <div className="sync-status-box">
        <div className="sync-status-icon"><Clock3 size={19} /></div>
        <span><b>{stableImportedCount ? stableImportedCount.toLocaleString() + ' imported products' : 'ShopBase catalog not synced'}</b><small>{lastSync ? 'Last catalog update ' + dateTimeLabel(lastSync) + ' (Bangladesh time)' : stableImportedCount ? 'Products are available from your connected catalog API.' : 'Save your ShopBase login below to allow the hosted runner to refresh expired sessions.'}</small></span>
        <span className={'status-pill ' + (stableImportedCount ? 'status-green' : 'status-amber')}><i />{stableImportedCount ? 'Connected' : 'Needs sync'}</span>
      </div>
      <div className="sync-actions"><button className="secondary-button" onClick={startHostedCookieSync} disabled={progressLoading || progress?.status === 'running'}><RotateCcw size={16} /> Sync cookie automatically</button><button className="secondary-button" onClick={saveShopBaseCookie} disabled={progressLoading}>{progressLoading && <LoaderCircle size={16} />} Sync cookie manually</button><button className="primary-button sync-now-button" onClick={startSyncNow} disabled={progressLoading || progress?.status === 'running'}>{progressLoading || progress?.status === 'running' ? <LoaderCircle size={17} /> : <RotateCcw size={17} />} {progress?.status === 'running' ? 'Sync running…' : progressLoading ? 'Starting…' : 'Sync Now'}</button><button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload size={17} /> Import supplier CSV</button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => onImport(event.target.files?.[0])} /><button className="secondary-button" onClick={exportAvailableProducts} disabled={exportingProducts}>{exportingProducts ? <LoaderCircle size={17} /> : <Download size={17} />} {exportingProducts ? 'Preparing export…' : 'Export available products (CSV)'}</button><button className="secondary-button" onClick={refreshProgress} disabled={progressLoading}>{progressLoading ? <LoaderCircle size={16} /> : <RotateCcw size={16} />} {progressLoading ? 'Checking progress…' : 'View sync progress'}</button></div>
      {exportMessage && <div className="import-result sync-progress-message" role="status">{exportMessage}</div>}
      <section className="sync-agent-card" id="hosted-login-setup">
        <div className="sync-agent-heading"><b>Hosted automatic sign-in</b><span className={'status-pill ' + (hostedLoginConfigured ? 'status-green' : 'status-amber')}><i />{hostedLoginConfigured ? 'Configured' : 'Setup needed'}</span></div>
        <p>When the saved cookie expires, GitHub Actions signs in to ShopBase, gets a fresh session, and continues the sync. This runs in the cloud; your PC does not need to be on.</p>
        <form className="hosted-login-form" onSubmit={saveHostedLogin}>
          <label>ShopBase phone number or username<input ref={hostedUsernameRef} type="text" autoComplete="username" value={hostedUsername} onChange={(event) => setHostedUsername(event.target.value)} placeholder={hostedLoginConfigured ? 'Enter to replace saved login' : 'ShopBase login phone number'} required /></label>
          <label>ShopBase password<input type="password" autoComplete="new-password" value={hostedPassword} onChange={(event) => setHostedPassword(event.target.value)} placeholder={hostedLoginConfigured ? 'Enter to replace saved password' : 'ShopBase password'} required /></label>
          <div className="sync-actions"><button className="primary-button" disabled={hostedLoginBusy || !hostedUsername || !hostedPassword}>{hostedLoginBusy ? <><LoaderCircle size={16} /> Saving securely…</> : hostedLoginConfigured ? 'Update hosted login' : 'Enable hosted renewal'}</button>{hostedLoginConfigured && <button type="button" className="secondary-button" onClick={removeHostedLogin} disabled={hostedLoginBusy}>Remove</button>}</div>
        </form>
        {hostedLoginMessage && <small role="status">{hostedLoginMessage}</small>}
        <small>Credentials are sent directly to GitHub Actions Secrets using encryption and are not stored in the catalog database. If ShopBase asks for an interactive OTP or CAPTCHA, the run will report that clearly and a fresh cookie will be needed.</small>
      </section>
      {progressError && <div className="import-result sync-progress-error">{progressError}</div>}
      {syncNotice && <div className="import-result sync-progress-message" role="status">{syncNotice}</div>}
      {progress && <div className="sync-progress-card" aria-live="polite">
        <div className="sync-progress-heading"><b>{phaseLabel}</b><span>{progress.status === 'running' ? progressPercent + '% · ' + (progress.workflowStatus || 'Live') : progress.status.replace(/_/g, ' ')}</span></div>
        <div className="sync-progress-track"><i style={{ transform: `scaleX(${Math.max(0, Math.min(100, progressPercent)) / 100})` }} /></div>
        {Number.isFinite(elapsedMs) && <p className="sync-duration">{progress.status === 'running' ? <>Elapsed: <b>{durationLabel(elapsedMs)}</b>{Number.isFinite(remainingMs) && <> · Estimated remaining: <b>{durationLabel(remainingMs)}</b></>}</> : <>Last sync duration: <b>{durationLabel(elapsedMs)}</b></>}</p>}
        {progress.workflowUrl && <p><a href={progress.workflowUrl} target="_blank" rel="noreferrer">Open GitHub Actions run</a></p>}
        {progress.totalCategories ? <p>Categories: {(progress.categoriesProcessed || 0).toLocaleString()} / {progress.totalCategories.toLocaleString()}</p> : null}
        {progress.totalProducts ? <p>Products: {(progress.productsProcessed || 0).toLocaleString()} / {progress.totalProducts.toLocaleString()} processed{progress.productsDiscovered ? ' · ' + progress.productsDiscovered.toLocaleString() + ' found' : ''}</p> : null}
        {(progress.totalProducts || 0) > 0 && <p>New: {progress.created || 0} · Updated: {progress.changed || 0} · Unchanged: {progress.unchanged || 0} · Detail issues: {progress.skippedDetails || 0}</p>}
        {progress.error && <p className="sync-progress-error">{syncErrorLabel(progress.error)}{syncErrorLabel(progress.error) !== progress.error && <small className="sync-error-detail">Details: {progress.error}</small>}</p>}
        {progress.updatedAt && <small>Last update: {dateTimeLabel(progress.updatedAt)} (Bangladesh time)</small>}
      </div>}
      {importNote && <div className="import-result"><CheckCircle2 size={16} />{importNote}</div>}
      <div className="sync-note"><ShieldCheck size={17} /><span><b>Automatic sync every {intervalHours} hours from {startTime} Bangladesh time</b><small>The schedule is saved in the catalog database. GitHub’s hosted runner runs without your PC being on.</small></span></div>
    </section>
    <section className="panel sync-side-panel">
      <div className="panel-heading"><div><h3>How updates work</h3><p>Every {intervalHours} hours · starting at {startTime} Bangladesh time</p></div></div>
      <div className="sync-flow"><div><i>01</i><span><b>Read the reseller catalog</b><small>Use the ShopBase session secret on the server, never in browser code.</small></span></div><div><i>02</i><span><b>Update changed products</b><small>Match by the ShopBase product ID and preserve AARO edits and image overrides.</small></span></div><div><i>03</i><span><b>Recheck at checkout</b><small>Verify the selected product’s latest price and availability before accepting the order.</small></span></div><div><i>04</i><span><b>Review orders</b><small>Confirm with your customer, then submit the order in the ShopBase app until order API access exists.</small></span></div></div>
      <div className="csv-format"><b>CSV columns supported</b><code>id, title, category, price, compare_at, image, description, stock</code></div>
    </section>
    {cookieEditorOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setCookieEditorOpen(false)}><section className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / SHOPBASE SESSION</span><h2>Save a fresh cookie</h2></div><IconButton label="Close cookie form" onClick={() => setCookieEditorOpen(false)}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={submitShopBaseCookie}><label>ShopBase session cookie<input type="password" autoComplete="off" value={cookieDraft} onChange={(event) => setCookieDraft(event.target.value)} placeholder="Paste the cookie copied by your local tool" required /></label><p className="form-help">The cookie is sent to the server and encrypted into the GitHub Actions secret. It is not saved in this browser or repository.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setCookieEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={progressLoading || !cookieDraft.trim()}>{progressLoading ? <LoaderCircle size={16} /> : <Check size={16} />} {progressLoading ? 'Saving…' : 'Save securely'}</button></div></form></section></div>}
  </div>
}








