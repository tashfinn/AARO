import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Copy, Download, Eye,
  Filter, Heart, House, LayoutDashboard, Menu, Minus,
  Package, Pencil, Phone, Plus, RotateCcw, Search, ShieldCheck, UserRound,
  ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles, Tags, TicketPercent, Trash2,
  Truck, Upload, UsersRound, X, Moon, Sun, LogOut, Mail
} from 'lucide-react'
import { initialState } from './data'
import { manualCategoryGroups } from './data/category-groups'
import type { CategoryGroup, Coupon, OfferDeal, Order, OrderStatus, Product, StoreState } from './types'

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
type Address = { id: string; label?: string; recipient: string; phone: string; area: string; address: string; isDefault?: boolean }
type AccountProfile = { id: string; name: string; email: string; phone: string; addresses: Address[]; defaultAddressId?: string }
type StorePage = 'shop' | 'trending' | 'offers' | 'combos' | 'category' | 'wishlist' | 'account' | 'terms' | 'delivery' | 'contact'
type AdminTab = 'overview' | 'products' | 'categories' | 'offers' | 'orders' | 'content' | 'sync'
type CartLine = { productId: string; quantity: number; size?: string }

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
function storePath(page: StorePage, category = 'All', groups: CategoryGroup[] = [], sourceId = '', parentId = '') {
  if (page === 'delivery') return '/delivery-returns'
  if (page === 'contact') return '/contact-us'
  if (page === 'terms') return '/terms'
  if (page === 'trending' || page === 'offers' || page === 'combos' || page === 'wishlist') return `/${page}`
  if (page !== 'category' || category === 'All') return '/'
  const parent = groups.find((group) => group.id === parentId)
  const child = parent?.children.find((item) => item.sourceId === sourceId || item.name === category)
  return parent ? `/category/${slugify(parent.name)}${child ? `/${slugify(child.name)}` : ''}` : `/category/${slugify(category)}`
}
function productPath(product: Product) {
  const parent = slugify(product.parentCategory || 'catalog')
  const subcategory = slugify(product.category || 'products')
  return `/category/${parent}/${subcategory}/${slugify(product.title)}/${encodeURIComponent(product.id)}`
}

function productIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  if (parts[0] === 'category' && parts.length >= 5) return decodeURIComponent(parts[4])
  return parts[0] === 'products' && parts.length > 2 ? decodeURIComponent(parts[parts.length - 1]) : null
}

function readState(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...initialState }
    const saved = JSON.parse(raw) as Partial<StoreState>
    const savedContent = saved.content && typeof saved.content === 'object' ? saved.content : {}
    const content = { ...initialState.content, ...savedContent }
    for (const key of ['heroTitle', 'heroSubtitle', 'heroImage', 'heroCta', 'offerTitle', 'offerSubtitle', 'offerImage', 'announcement'] as const) {
      if (typeof content[key] !== 'string') content[key] = initialState.content[key]
    }
    content.trendingIds = Array.isArray(content.trendingIds) ? content.trendingIds.filter((id): id is string => typeof id === 'string') : []
    content.offerIds = Array.isArray(content.offerIds) ? content.offerIds.filter((id): id is string => typeof id === 'string') : []
    content.combos = Array.isArray(content.combos) ? content.combos.filter((combo) => combo && typeof combo.title === 'string' && typeof combo.subtitle === 'string' && typeof combo.image === 'string' && Number.isFinite(combo.price)) : []
    content.deliveryInDhaka = Number.isFinite(content.deliveryInDhaka) ? content.deliveryInDhaka : initialState.content.deliveryInDhaka
    content.deliveryOutsideDhaka = Number.isFinite(content.deliveryOutsideDhaka) ? content.deliveryOutsideDhaka : initialState.content.deliveryOutsideDhaka
    if (content.heroImage.startsWith('https://images.unsplash.com/photo-1490481651871-ab68de25d43d')) content.heroImage = '/images/warm-boutique-clothing-display-v2.png'
    if (content.deliveryInDhaka === 70 && content.deliveryOutsideDhaka === 130) {
      content.deliveryInDhaka = 60
      content.deliveryOutsideDhaka = 120
    }
    const products = Array.isArray(saved.products) ? saved.products.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && typeof item.description === 'string' && Number.isFinite(item.price)) : []
    const categories = Array.isArray(saved.categories) ? saved.categories.filter((item): item is string => typeof item === 'string') : [...initialState.categories]
    const coupons = Array.isArray(saved.coupons) ? saved.coupons.filter((item): item is Coupon => Boolean(item && typeof item.code === 'string' && (item.kind === 'percent' || item.kind === 'amount') && Number.isFinite(item.value) && typeof item.active === 'boolean')) : []
    const offers = Array.isArray(saved.offers) ? saved.offers.filter((item): item is OfferDeal => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.productId === 'string' && ['special_price', 'quantity_discount', 'buy_x_get_y_free'].includes(item.kind) && Number.isFinite(item.value) && typeof item.active === 'boolean')) : []
    const orders = Array.isArray(saved.orders) ? saved.orders.filter((item): item is Order => Boolean(item && typeof item.id === 'string' && item.customer && typeof item.customer.phone === 'string' && Array.isArray(item.items) && Number.isFinite(item.total))) : []
    return { ...initialState, ...saved, products, categories: categories.length ? categories : [...initialState.categories], coupons, offers, orders, views: Number.isFinite(saved.views) ? Number(saved.views) : 0, content }
  } catch { return { ...initialState, content: { ...initialState.content }, products: [], categories: [...initialState.categories], coupons: [], offers: [], orders: [], views: 0 } }
}

function money(amount: number) { return `৳${Math.max(0, Math.round(amount)).toLocaleString('en-BD')}` }
function dateLabel(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) }
function shortDate(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short' }).format(new Date(value)) }
function readAdminToken() { return localStorage.getItem(ADMIN_TOKEN_KEY) || sessionStorage.getItem(ADMIN_SESSION_TOKEN_KEY) || '' }
function ImageView({ src, alt, className = '', loading = 'lazy' }: { src: string; alt: string; className?: string; loading?: 'lazy' | 'eager' }) {
  return <img src={src} alt={alt} loading={loading} className={className} onError={(event) => { event.currentTarget.style.opacity = '0' }} />
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
  const [page, setPage] = useState<StorePage>(() => window.location.pathname === '/account' ? 'account' : 'shop')
  const [category, setCategory] = useState('All')
  const [selectedCategorySourceId, setSelectedCategorySourceId] = useState('')
  const [selectedParentCategoryId, setSelectedParentCategoryId] = useState('')
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null'); if (!Array.isArray(value)) return manualCategoryGroups; const valid = value.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))).map((group) => ({ ...group, children: group.children.filter((child) => child && typeof child.name === 'string' && (child.sourceId === undefined || typeof child.sourceId === 'string')) })); return valid.length ? valid : manualCategoryGroups } catch { return manualCategoryGroups } })
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [activeCategoryMenuId, setActiveCategoryMenuId] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [cart, setCart] = useState<CartLine[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(value) ? value.filter((line): line is CartLine => Boolean(line && typeof line.productId === 'string' && Number.isFinite(line.quantity) && line.quantity > 0 && (line.size === undefined || typeof line.size === 'string'))) : [] } catch { return [] } })
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(() => window.location.pathname === '/checkout')
  const [outsideDhaka, setOutsideDhaka] = useState(false)
  const [productRouteId, setProductRouteId] = useState<string | null>(productIdFromPath)
  const selectedProduct = useMemo(() => state.products.find((product) => product.id === productRouteId) || null, [productRouteId, state.products])
  const [wishlist, setWishlist] = useState<string[]>(() => { try { const value: unknown = JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]'); return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [] } catch { return [] } })
  const [user, setUser] = useState<string | null>(() => localStorage.getItem(USER_KEY))
  const [accountToken, setAccountToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY) || '')
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null)
  const [customerOrders, setCustomerOrders] = useState<Order[]>([])
  const [authRoute, setAuthRoute] = useState<'login' | 'register' | null>(() => !localStorage.getItem(AUTH_TOKEN_KEY) ? window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : null : null)
  const [adminRoute] = useState(() => window.location.pathname === '/admin')
  const [adminToken, setAdminToken] = useState(readAdminToken)
  const [darkTheme, setDarkTheme] = useState(() => localStorage.getItem(THEME_KEY) === 'dark')
  const [toast, setToast] = useState('')
  const [admin, setAdmin] = useState(false)
  const [storeIsLive, setStoreIsLive] = useState(true)
  const [storeStatusBusy, setStoreStatusBusy] = useState(false)
  const [storeMenuOpen, setStoreMenuOpen] = useState(false)
  const [adminTab, setAdminTab] = useState<AdminTab>('overview')
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [productFormOpen, setProductFormOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [minPrice, setMinPrice] = useState(0)
  const [maxPrice, setMaxPrice] = useState(10000)
  const [priceSort, setPriceSort] = useState<'recommended' | 'low-high' | 'high-low'>('recommended')
  const [productsToShow, setProductsToShow] = useState(48)

  const [couponInput, setCouponInput] = useState('')
  const [coupon, setCoupon] = useState<Coupon | null>(null)
  const [orderFilter, setOrderFilter] = useState('All orders')
  const [orderSearch, setOrderSearch] = useState('')
  const [categoryInput, setCategoryInput] = useState('')
  const [couponFormOpen, setCouponFormOpen] = useState(false)
  const [offerFormOpen, setOfferFormOpen] = useState(false)
  const [lastSync, setLastSync] = useState(localStorage.getItem('aaro-last-import') || '')
  const [catalogLoading, setCatalogLoading] = useState(Boolean(import.meta.env.PROD || import.meta.env.VITE_API_URL))
  const [catalogError, setCatalogError] = useState(false)
  const [productViewCounts, setProductViewCounts] = useState<Record<string, number>>({})
  const [importNote, setImportNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!API_BASE) return
    fetch(`${API_BASE}/api/store-status`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<{ isLive?: unknown }> : null)
      .then((status) => { if (typeof status?.isLive === 'boolean') setStoreIsLive(status.isLive) })
      .catch(() => { /* Keep the storefront available if the status API is temporarily unreachable. */ })
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localState))
  }, [state])
  useEffect(() => { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)) }, [wishlist])
  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(cart)) }, [cart])
  useEffect(() => {
    localStorage.setItem(THEME_KEY, darkTheme ? 'dark' : 'light')
    document.documentElement.classList.toggle('theme-dark', darkTheme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', darkTheme ? '#111915' : '#f4f6f1')
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
      if (parts[0] === 'account') setPage('account')
      else if (parts[0] === 'delivery-returns') setPage('delivery')
      else if (parts[0] === 'contact-us') setPage('contact')
      else if (['trending', 'offers', 'combos', 'wishlist', 'terms'].includes(parts[0] || '')) setPage(parts[0] as StorePage)
      else if (parts[0] === 'category') {
        const parent = categoryGroups.find((group) => slugify(group.name) === parts[1])
        const child = parent?.children.find((item) => slugify(item.name) === parts[2])
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
        if (!profileResponse.ok || !ordersResponse.ok) throw new Error('Account session expired.')
        setAccountProfile(await profileResponse.json())
        setCustomerOrders(await ordersResponse.json())
      })
      .catch(() => { setAccountToken(''); setUser(null); setAccountProfile(null); localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(USER_KEY) })
  }, [accountToken])
  useEffect(() => {
    if (!adminRoute || !adminToken || !API_BASE) return
    const headers = { Authorization: `Bearer ${adminToken}` }
    Promise.all([fetch(`${API_BASE}/api/admin/coupons`, { headers }), fetch(`${API_BASE}/api/admin/orders`, { headers }), fetch(`${API_BASE}/api/admin/offers`, { headers })])
      .then(async ([couponsResponse, ordersResponse, offersResponse]) => { if (!couponsResponse.ok || !ordersResponse.ok || !offersResponse.ok) throw new Error('Admin session expired.'); const [coupons, orders, offers] = await Promise.all([couponsResponse.json(), ordersResponse.json(), offersResponse.json()]) as [unknown, unknown, unknown]; setState((current) => ({ ...current, coupons: Array.isArray(coupons) ? coupons as Coupon[] : [], orders: Array.isArray(orders) ? orders as Order[] : [], offers: Array.isArray(offers) ? offers as OfferDeal[] : [] })); setAdmin(true) })
      .catch(() => { localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY); setAdminToken('') })
  }, [adminRoute, adminToken])
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
    if (!apiUrl) {
      if (import.meta.env.PROD) {
        setCatalogError(true)
        setState((current) => ({ ...current, products: current.products.filter((product) => product.source === 'shopbase') }))
        setCatalogLoading(false)
      }
      return
    }
    let cancelled = false
    fetch(`${apiUrl}/api/catalog`)
      .then((response) => {
        if (!response.ok) throw new Error(`Catalog API returned ${response.status}`)
        return response.json() as Promise<{ products?: unknown; categories?: unknown; categoryGroups?: unknown; lastSync?: string; productViewCounts?: unknown }>
      })
      .then((catalog) => {
        if (cancelled) return
        const catalogProducts = Array.isArray(catalog.products) ? catalog.products.filter((item): item is Product => Boolean(item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.category === 'string' && typeof item.image === 'string' && typeof item.description === 'string' && Number.isFinite(item.price))) : []
        const catalogCategories = Array.isArray(catalog.categories) ? catalog.categories.filter((item): item is string => typeof item === 'string') : []
        const catalogGroups = Array.isArray(catalog.categoryGroups) ? catalog.categoryGroups.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))).map((group) => ({ ...group, children: group.children.filter((child) => child && typeof child.name === 'string') })) : []
        if (catalog.productViewCounts && typeof catalog.productViewCounts === 'object' && !Array.isArray(catalog.productViewCounts)) {
          setProductViewCounts(Object.fromEntries(Object.entries(catalog.productViewCounts as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0)))
        }
        const rawSavedGroups: unknown = JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null')
        const savedGroups = Array.isArray(rawSavedGroups) ? rawSavedGroups.filter((group): group is CategoryGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.children))) : []
        setCategoryGroups(mergeCategoryGroups(savedGroups, catalogGroups))
        setState((current) => {
          const synced = catalogProducts.map((product) => ({ ...product, source: 'shopbase' as const }))
          const manual = current.products.filter((product) => product.source === 'custom')
          const customCategories = current.categories.filter((item) => item !== 'All' && !initialState.categories.includes(item))
          return { ...current, products: [...manual, ...synced], categories: [...new Set(['All', ...catalogCategories, ...customCategories])] }
        })
        if (catalog.lastSync) setLastSync(catalog.lastSync)
      })
      .catch((error) => {
        console.warn('AARO live catalog API unavailable.', error)
        if (!cancelled) {
          setCatalogError(true)
          setState((current) => ({ ...current, products: current.products.filter((product) => product.source === 'shopbase') }))
        }
      })
      .finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!productRouteId || !API_BASE) return
    let current = true
    fetch(`${API_BASE}/api/products/${encodeURIComponent(productRouteId)}/view`, { method: 'POST', keepalive: true })
      .then((response) => response.ok ? response.json() as Promise<{ productId: string; views: number }> : null)
      .then((result) => { if (current && result && Number.isFinite(result.views)) setProductViewCounts((counts) => ({ ...counts, [result.productId]: result.views })) })
      .catch(() => { /* Product browsing remains available if view counting is temporarily offline. */ })
    return () => { current = false }
  }, [productRouteId])
  useEffect(() => {
    if (!API_BASE) return
    let current = true
    const refreshCounts = () => fetch(`${API_BASE}/api/product-views`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<Record<string, unknown>> : null)
      .then((result) => { if (current && result) setProductViewCounts(Object.fromEntries(Object.entries(result).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0))) })
      .catch(() => { /* Keep the last shared counts during brief network issues. */ })
    void refreshCounts()
    const timer = window.setInterval(refreshCounts, 30000)
    return () => { current = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => {
    if (!API_BASE) return
    fetch(`${API_BASE}/api/offers`, { cache: 'no-store' }).then((response) => response.ok ? response.json() as Promise<unknown> : []).then((offers) => setState((current) => ({ ...current, offers: Array.isArray(offers) ? offers as OfferDeal[] : [] }))).catch(() => setState((current) => ({ ...current, offers: [] })))
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])
  const activeProducts = useMemo(() => state.products.filter((product) => product.active), [state.products])
  const catalogMaxPrice = Math.max(1000, ...activeProducts.map((product) => product.price))
  useEffect(() => { setProductsToShow(48) }, [category, submittedQuery, page, minPrice, maxPrice, priceSort])
  const visibleProducts = useMemo(() => {
    const needle = submittedQuery.trim().toLowerCase()
    const parentChildren = selectedParentCategoryId ? categoryGroups.find((group) => group.id === selectedParentCategoryId)?.children || [] : []
    const parentChildIds = parentChildren.flatMap((child) => child.sourceId ? [child.sourceId] : [])
    let products = activeProducts
    if (page === 'trending') products = [...products].sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0)).slice(0, 20)
    if (page === 'offers') {
      const dealProductIds = new Set(state.offers.filter((offer) => offer.active).map((offer) => offer.productId))
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
    if (needle) products = products.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle))
    if (page === 'category') {
      products = products.filter((product) => product.price >= minPrice && product.price <= maxPrice)
      if (priceSort === 'low-high') products = [...products].sort((a, b) => a.price - b.price)
      if (priceSort === 'high-low') products = [...products].sort((a, b) => b.price - a.price)
    }
    products = [...products].sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0))
    return products
  }, [activeProducts, category, categoryGroups, maxPrice, minPrice, page, priceSort, productViewCounts, selectedCategorySourceId, selectedParentCategoryId, submittedQuery, state.content.offerIds, state.content.trendingIds, state.offers, wishlist])
  const searchSuggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? activeProducts.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle)).slice(0, 5) : []
  }, [activeProducts, query])
  const cartItems = useMemo(() => cart.map((line) => ({ ...line, product: state.products.find((item) => item.id === line.productId) })).filter((line): line is CartLine & { product: Product } => Boolean(line.product)), [cart, state.products])
  const subtotal = cartItems.reduce((sum, line) => sum + line.product.price * line.quantity, 0)
  const offerSavings = cartItems.reduce((sum, line) => {
    const offer = state.offers.find((item) => item.active && item.productId === line.product.id)
    if (!offer) return sum
    const unitPrice = line.product.price
    if (offer.kind === 'special_price') return sum + Math.max(0, unitPrice - Math.min(unitPrice, offer.value)) * line.quantity
    if (offer.kind === 'quantity_discount') {
      const groups = Math.floor(line.quantity / Math.max(1, offer.quantity))
      const eligibleQuantity = groups * Math.max(1, offer.quantity)
      const saving = offer.discountKind === 'percent' ? eligibleQuantity * unitPrice * offer.value / 100 : groups * offer.value
      return sum + Math.min(eligibleQuantity * unitPrice, saving)
    }
    const freeCount = Math.floor(line.quantity / (Math.max(1, offer.quantity) + Math.max(1, offer.freeQuantity))) * Math.max(1, offer.freeQuantity)
    return sum + freeCount * unitPrice
  }, 0)
  const couponDiscount = coupon && coupon.active && subtotal >= (coupon.minimum || 0) ? Math.min(subtotal, coupon.kind === 'percent' ? subtotal * coupon.value / 100 : coupon.value) : 0
  const discount = Math.min(subtotal, offerSavings + couponDiscount)
  const deliveryFee = outsideDhaka ? state.content.deliveryOutsideDhaka : state.content.deliveryInDhaka
  const total = subtotal + deliveryFee - discount
  const revenue = state.orders.filter((order) => !['Cancelled', 'Pending confirmation'].includes(order.status)).reduce((sum, order) => sum + order.total, 0)
  const customerCount = new Set(state.orders.map((order) => order.customer.phone)).size

  function notify(message: string) { setToast(message) }
  function updateState(updater: (current: StoreState) => StoreState) { setState((current) => updater(current)) }
  function showStore(pageToShow: StorePage, nextCategory = 'All', sourceCategoryId = '', parentCategoryId = '') {
    setAdmin(false); setAuthRoute(null); setCheckout(false); setActiveCategoryMenuId(''); setPage(pageToShow); setCategory(nextCategory); setSelectedCategorySourceId(sourceCategoryId); setSelectedParentCategoryId(parentCategoryId); setQuery(''); setSubmittedQuery(''); setProductRouteId(null); setCategoryMenuOpen(false); setMobileMenu(false); history.pushState({ aaroRoute: true }, '', storePath(pageToShow, nextCategory, categoryGroups, sourceCategoryId, parentCategoryId)); window.scrollTo({ top: 0, behavior: 'smooth' })
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
    setCartOpen(false)
    setCheckout(true)
    history.pushState({ aaroCheckout: true }, '', '/checkout')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function returnToBag() {
    setCheckout(false)
    setOutsideDhaka(false)
    history.replaceState({}, '', '/')
    setCartOpen(true)
  }
  function openProduct(product: Product) {
    setAdmin(false); setProductRouteId(product.id); setShowSearch(false); setQuery(''); setSubmittedQuery(''); setCategoryMenuOpen(false)
    history.pushState({ productId: product.id, aaroProduct: true }, '', productPath(product)); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function closeProduct() {
    if (history.state?.aaroProduct) history.back()
    else { history.replaceState({}, '', '/'); setProductRouteId(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  }
  function submitSearch() {
    setSubmittedQuery(query.trim()); setPage('shop'); setCategory('All'); setShowSearch(false); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function addToCart(product: Product, quantity = 1, size = '') {
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id && (line.size || '') === size)
      return existing ? current.map((line) => line.productId === product.id && (line.size || '') === size ? { ...line, quantity: line.quantity + quantity } : line) : [...current, { productId: product.id, quantity, ...(size ? { size } : {}) }]
    })
    setCartOpen(true); setCheckout(false); notify(`${product.title} added to your bag`)
  }
  function setQuantity(productId: string, quantity: number, size = '') {
    setCart((current) => quantity <= 0 ? current.filter((line) => line.productId !== productId || (line.size || '') !== size) : current.map((line) => line.productId === productId && (line.size || '') === size ? { ...line, quantity } : line))
  }
  function toggleWish(productId: string) {
    const already = wishlist.includes(productId)
    setWishlist((current) => already ? current.filter((id) => id !== productId) : [...current, productId])
    notify(already ? 'Removed from your wishlist' : 'Saved to your wishlist')
  }
  function applyCoupon() {
    const found = state.coupons.find((item) => item.code.toLowerCase() === couponInput.trim().toLowerCase() && item.active)
    if (!found) { setCoupon(null); notify('That code is not active. Try AARO10 or WELCOME150.'); return }
    if (subtotal < (found.minimum || 0)) { notify(`Minimum order for this code is ${money(found.minimum || 0)}`); return }
    setCoupon(found); notify(`${found.code} applied`)
  }
  async function placeOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!cartItems.length) return
    const form = new FormData(event.currentTarget)
    const area = String(form.get('area') || '')
    const outsideDhaka = form.get('zone') === 'outside'
    const fee = outsideDhaka ? state.content.deliveryOutsideDhaka : state.content.deliveryInDhaka
    const newOrder: Order = {
      id: `AR-${Math.floor(1000 + Math.random() * 9000)}`,
      createdAt: new Date().toISOString(),
      customer: { name: String(form.get('name')), phone: String(form.get('phone')), email: String(form.get('email') || '') || undefined, area, address: String(form.get('address')) },
      items: cartItems.map((line) => ({ productId: line.productId, title: line.product.title, image: line.product.image, price: line.product.price, quantity: line.quantity, ...(line.size ? { size: line.size } : {}) })),
      subtotal, delivery: fee, discount, total: Math.max(0, subtotal + fee - discount), coupon: coupon?.code, status: 'Pending confirmation'
    }
    try {
      const response = await fetch(`${API_BASE}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(accountToken ? { Authorization: `Bearer ${accountToken}` } : {}) }, body: JSON.stringify(newOrder) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Order could not be saved.')
      updateState((current) => ({ ...current, orders: [result as Order, ...current.orders] }))
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Could not save your order. Please try again.'); return }
    history.replaceState({}, '', '/')
    setCart([]); setCoupon(null); setCouponInput(''); setCheckout(false); setCartOpen(false); setOutsideDhaka(false); notify(`Order ${newOrder.id} received.`)
  }
  function startEditProduct(product?: Product) {
    setEditingProduct(product || null); setProductFormOpen(true)
  }
  function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const product: Product = {
      id: editingProduct?.id || `custom-${Date.now()}`,
      title: String(form.get('title')).trim(), category: String(form.get('category')),
      price: Number(form.get('price')), compareAt: Number(form.get('compareAt')) || undefined,
      image: String(form.get('image')).trim(), description: String(form.get('description')).trim(),
      rating: editingProduct?.rating || 5, reviews: editingProduct?.reviews || 0,
      badge: String(form.get('badge') || '') || undefined, stock: Number(form.get('stock') || 0),
      active: form.get('active') === 'on', trending: form.get('trending') === 'on', offer: form.get('offer') === 'on',
      source: editingProduct?.source || 'custom', sourceId: editingProduct?.sourceId, updatedAt: new Date().toISOString()
    }
    updateState((current) => ({ ...current, products: editingProduct ? current.products.map((item) => item.id === product.id ? product : item) : [product, ...current.products] }))
    setProductFormOpen(false); setEditingProduct(null); notify(editingProduct ? 'Product updated' : 'Product added')
  }
  function deleteProduct(productId: string) {
    updateState((current) => ({ ...current, products: current.products.filter((item) => item.id !== productId), content: { ...current.content, trendingIds: current.content.trendingIds.filter((id) => id !== productId), offerIds: current.content.offerIds.filter((id) => id !== productId) } }))
    notify('Product removed from your catalog')
  }
  async function updateOrderStatus(orderId: string, status: OrderStatus) {
    if (adminToken && API_BASE) { const response = await fetch(`${API_BASE}/api/admin/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ status }) }); if (!response.ok) { notify('Order status could not be saved.'); return } }
    updateState((current) => ({ ...current, orders: current.orders.map((order) => order.id === orderId ? { ...order, status } : order) }))
    notify(`Order marked ${status.toLowerCase()}`)
  }
  function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = categoryInput.trim()
    if (!value || state.categories.some((item) => item.toLowerCase() === value.toLowerCase())) return
    updateState((current) => ({ ...current, categories: [...current.categories, value] })); setCategoryInput(''); notify('Category added')
  }
  function removeCategory(value: string) {
    if (value === 'All') return
    updateState((current) => ({ ...current, categories: current.categories.filter((item) => item !== value) })); notify('Category removed')
  }
  function editCategoryGroup(groupId: string) {
    const group = categoryGroups.find((item) => item.id === groupId)
    if (!group) return
    const name = window.prompt('Edit parent category name', group.name)?.trim()
    if (!name || name === group.name) return
    setCategoryGroups((current) => current.map((item) => item.id === groupId ? { ...item, name } : item))
    notify('Parent category updated')
  }
  function editSubcategory(groupId: string, childName: string) {
    const group = categoryGroups.find((item) => item.id === groupId)
    const child = group?.children.find((item) => item.name === childName)
    if (!group || !child) return
    const name = window.prompt('Edit subcategory name', child.name)?.trim()
    if (!name || name === child.name) return
    setCategoryGroups((current) => current.map((item) => item.id === groupId ? { ...item, children: item.children.map((entry) => entry === child ? { ...entry, name } : entry) } : item))
    notify('Subcategory updated')
  }
  async function saveCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const nextCoupon: Coupon = { code: String(form.get('code')).trim().toUpperCase(), kind: form.get('kind') === 'amount' ? 'amount' : 'percent', value: Number(form.get('value')), minimum: Number(form.get('minimum')) || undefined, active: true }
    if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(nextCoupon) }); if (!response.ok) { notify('Coupon could not be saved to the server.'); return } }
    updateState((current) => ({ ...current, coupons: [...current.coupons.filter((item) => item.code !== nextCoupon.code), nextCoupon] })); setCouponFormOpen(false); notify('Coupon saved')
  }
  async function saveOffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const nextOffer: OfferDeal = { title: String(form.get('title') || '').trim(), id: `offer-${Date.now()}`, productId: String(form.get('productId')), kind: String(form.get('kind')) as OfferDeal['kind'], value: Number(form.get('value')) || 0, discountKind: String(form.get('discountKind') || 'percent') as OfferDeal['discountKind'], quantity: Number(form.get('quantity')) || 1, freeQuantity: Number(form.get('freeQuantity')) || 1, active: true }
    if (!nextOffer.productId) { notify('Choose a product for this offer.'); return }
    if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(nextOffer) }); if (!response.ok) { notify('Offer could not be saved.'); return } }
    updateState((current) => ({ ...current, offers: [...current.offers, nextOffer] }))
    setOfferFormOpen(false); notify('Offer saved')
  }
  async function toggleOffer(id: string) { const offer = state.offers.find((item) => item.id === id); if (!offer) return; const updated = { ...offer, active: !offer.active }; if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/offers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(updated) }); if (!response.ok) { notify('Offer could not be updated.'); return } }; updateState((current) => ({ ...current, offers: current.offers.map((item) => item.id === id ? updated : item) })) }
  async function deleteOffer(id: string) { if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/offers/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } }); if (!response.ok) { notify('Offer could not be deleted.'); return } }; updateState((current) => ({ ...current, offers: current.offers.filter((item) => item.id !== id) })); notify('Offer deleted') }
  async function toggleCoupon(code: string) { const item = state.coupons.find((entry) => entry.code === code); if (!item) return; const updated = { ...item, active: !item.active }; if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(updated) }); if (!response.ok) { notify('Coupon could not be updated on the server.'); return } }; updateState((current) => ({ ...current, coupons: current.coupons.map((entry) => entry.code === code ? updated : entry) })) }
  async function deleteCoupon(code: string) { if (API_BASE && adminToken) { const response = await fetch(`${API_BASE}/api/admin/coupons/${encodeURIComponent(code)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } }); if (!response.ok) { notify('Coupon could not be deleted from the server.'); return } }; updateState((current) => ({ ...current, coupons: current.coupons.filter((item) => item.code !== code) })); if (coupon?.code === code) { setCoupon(null); setCouponInput('') }; notify(`Coupon ${code} deleted`) }
  function saveContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const combos = state.content.combos.map((combo, index) => ({ ...combo, title: String(form.get(`comboTitle${index}`) || combo.title), subtitle: String(form.get(`comboSubtitle${index}`) || combo.subtitle), image: String(form.get(`comboImage${index}`) || combo.image), price: Number(form.get(`comboPrice${index}`) || combo.price) }))
    updateState((current) => ({ ...current, content: { ...current.content, heroTitle: String(form.get('heroTitle')), heroSubtitle: String(form.get('heroSubtitle')), heroImage: String(form.get('heroImage')), heroCta: String(form.get('heroCta')), offerTitle: String(form.get('offerTitle')), offerSubtitle: String(form.get('offerSubtitle')), offerImage: String(form.get('offerImage')), announcement: String(form.get('announcement')), combos, deliveryInDhaka: Number(form.get('deliveryInDhaka')), deliveryOutsideDhaka: Number(form.get('deliveryOutsideDhaka')) } }))
    notify('Storefront content saved')
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
    const reader = new FileReader()
    reader.onload = () => {
      const rows = String(reader.result || '').split(/\r?\n/).filter(Boolean)
      if (rows.length < 2) { setImportNote('The file looks empty. Upload a CSV with a header row and product rows.'); return }
      const headers = rows[0].split(',').map((item) => item.trim().toLowerCase().replaceAll(' ', '_'))
      const value = (cells: string[], ...keys: string[]) => { const index = headers.findIndex((header) => keys.includes(header)); return index >= 0 ? (cells[index] || '').trim().replace(/^"|"$/g, '') : '' }
      const parsed: Product[] = rows.slice(1).flatMap((row, index) => {
        const cells = row.match(/("[^"]*(?:""[^"]*)*"|[^,]*)(,|$)/g)?.map((part) => part.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"')) || row.split(',')
        const title = value(cells, 'title', 'name', 'product_name')
        if (!title) return []
        return {
          id: value(cells, 'source_id', 'sku', 'id') || `import-${Date.now()}-${index}`,
          title, category: value(cells, 'category') || 'Imported', price: Number(value(cells, 'price', 'wholesale_price')) || 0,
          compareAt: Number(value(cells, 'compare_at', 'suggested_price')) || undefined,
          image: value(cells, 'image', 'image_url', 'images') || 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=900&q=80',
          description: value(cells, 'description', 'details') || 'Imported supplier product. Add details before publishing.',
          rating: 0, reviews: 0, stock: Number(value(cells, 'stock', 'availability')) || 0,
          active: true, source: 'shopbase' as const, sourceId: value(cells, 'source_id', 'sku', 'id') || undefined, updatedAt: new Date().toISOString()
        } satisfies Product
      })
      if (!parsed.length) { setImportNote('No products were found. Expected a title/name column.'); return }
      updateState((current) => {
        const existing = new Map(current.products.map((product) => [product.sourceId || product.id, product]))
        for (const product of parsed) existing.set(product.sourceId || product.id, { ...existing.get(product.sourceId || product.id), ...product })
        const categories = [...new Set([...current.categories, ...parsed.map((product) => product.category)])]
        return { ...current, products: [...existing.values()], categories }
      })
      const when = new Date().toISOString(); setLastSync(when); localStorage.setItem('aaro-last-import', when)
      setImportNote(`${parsed.length} products imported from ${file.name}. This is a manual CSV import. The scheduled portal sync runs from the backend.`)
    }
    reader.readAsText(file)
  }

  const navItems: { label: string; icon: typeof LayoutDashboard; tab: AdminTab }[] = [
    { label: 'Overview', icon: LayoutDashboard, tab: 'overview' }, { label: 'Products', icon: Package, tab: 'products' },
    { label: 'Categories', icon: Tags, tab: 'categories' }, { label: 'Offers & coupons', icon: TicketPercent, tab: 'offers' },
    { label: 'Orders', icon: ShoppingCart, tab: 'orders' }, { label: 'Storefront', icon: Sparkles, tab: 'content' }, { label: 'Product sync', icon: RotateCcw, tab: 'sync' }
  ]
  const formatPageTitle = page === 'trending' ? 'Trending now' : page === 'offers' ? 'Offers for you' : page === 'category' ? category === 'All' ? 'All products' : category : page === 'wishlist' ? 'Your wishlist' : page === 'terms' ? 'Terms & Conditions' : page === 'delivery' ? 'Delivery & Returns' : page === 'contact' ? 'Contact us' : 'The AARO edit'
  const selectedTrendingProducts = [...activeProducts].sort((a, b) => (productViewCounts[b.id] || 0) - (productViewCounts[a.id] || 0)).slice(0, 20)
  const homeTrendingProducts = selectedTrendingProducts.slice(0, 12)
  const dealProductIds = new Set(state.offers.filter((offer) => offer.active).map((offer) => offer.productId))
  const selectedOfferProducts = activeProducts.filter((product) => state.content.offerIds.includes(product.id) || product.offer || dealProductIds.has(product.id))
  const discountedProducts = activeProducts.filter((product) => product.compareAt && product.compareAt > product.price)
  const homeOfferProducts = (selectedOfferProducts.length ? selectedOfferProducts : discountedProducts).slice(0, 4)
  const homeCategories = useMemo(() => state.categories.filter((item) => item !== 'All').map((category) => ({ category, products: activeProducts.filter((product) => product.category === category) })).filter((item) => item.products.length > 0).sort(() => Math.random() - 0.5).slice(0, 3), [activeProducts, state.categories])

  return <>
    {admin ? <div className={`admin-shell ${darkTheme ? 'theme-dark' : ''}`}>
      <aside className={`admin-sidebar ${mobileMenu ? 'admin-sidebar-open' : ''}`}>
        <div className="admin-brand"><button className="admin-brand-home" onClick={() => window.location.assign('/')} aria-label="Go to AARO storefront"><span className="brand-mark">A</span><span>AARO</span></button><IconButton label="Close menu" className="mobile-only" onClick={() => setMobileMenu(false)}><X size={18} /></IconButton></div>
        <div className={`admin-store-control ${storeMenuOpen ? 'is-open' : ''}`}>
          <button type="button" className={`admin-store-pill ${storeIsLive ? 'is-live' : 'is-closed'}`} onClick={() => setStoreMenuOpen((open) => !open)} aria-expanded={storeMenuOpen} aria-haspopup="menu"><span className="store-live-dot" />{storeIsLive ? 'Live store' : 'Store closed'}<ChevronDown size={15} /></button>
          {storeMenuOpen && <div className="store-status-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setStoreMenuOpen(false); void toggleStoreStatus() }} disabled={storeStatusBusy}>{storeStatusBusy ? 'Saving…' : storeIsLive ? 'Close store' : 'Open store'}</button></div>}
        </div>
        <p className="sidebar-caption">WORKSPACE</p>
        <nav className="admin-nav">{navItems.map(({ label, icon: Icon, tab }) => <button key={tab} className={adminTab === tab ? 'active' : ''} onClick={() => { setAdminTab(tab); setMobileMenu(false) }}><Icon size={18} /><span>{label}</span>{tab === 'orders' && state.orders.filter((order) => order.status === 'Pending confirmation').length > 0 && <b>{state.orders.filter((order) => order.status === 'Pending confirmation').length}</b>}</button>)}</nav>
        <div className="sidebar-bottom"><div className="admin-profile"><div className="avatar">A</div><div><strong>Store admin</strong><small>AARO</small></div></div><button className="back-store" onClick={() => window.location.assign('/')}><House size={17} /> View storefront <ArrowUpRight size={15} /></button><button className="admin-logout-button" onClick={logoutAdmin}><LogOut size={17} /> Log out</button></div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><button className="mobile-menu-trigger" onClick={() => setMobileMenu(true)}><Menu size={20} /></button><div><p className="eyebrow">AARO <span>/</span> {navItems.find((item) => item.tab === adminTab)?.label.toUpperCase()}</p><h1>{adminTab === 'overview' ? 'Good morning, Admin' : navItems.find((item) => item.tab === adminTab)?.label}</h1></div><div className="admin-top-actions"><span className="date-chip"><CalendarDays size={15} /> {dateLabel(new Date().toISOString())}</span><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle admin-theme-toggle" onClick={() => setDarkTheme((current) => !current)}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><button className="admin-view-store" onClick={() => window.location.assign('/')}>View store <ArrowUpRight size={15} /></button><button className="admin-logout-button admin-logout-top" onClick={logoutAdmin}><LogOut size={16} /> Log out</button><div className="avatar avatar-small">A</div></div></header>
        <div className="admin-content">
          {adminTab === 'overview' && <AdminOverview state={state} revenue={revenue} customerCount={customerCount} onTab={setAdminTab} updateOrderStatus={updateOrderStatus} />}
          {adminTab === 'products' && <AdminProducts state={state} productViewCounts={productViewCounts} onAdd={() => startEditProduct()} onEdit={startEditProduct} onDelete={deleteProduct} />}
          {adminTab === 'categories' && <section className="panel"><div className="panel-heading"><div><h2>Categories</h2><p>ShopBase subcategories are grouped into your curated storefront sections.</p></div></div><form className="inline-add" onSubmit={addCategory}><input value={categoryInput} onChange={(event) => setCategoryInput(event.target.value)} placeholder="Add a manual category" /><button className="primary-button"><Plus size={17} /> Add category</button></form><div className="category-group-admin-list">{categoryGroups.map((group) => <section className="category-group-admin" key={group.id}><div className="category-group-admin-heading"><button className="category-edit-name" aria-label={"Edit " + group.name} onClick={() => editCategoryGroup(group.id)}><span>{group.name}</span><Pencil size={15} /></button><span>{group.children.reduce((count, child) => count + state.products.filter((product) => child.sourceId ? product.categorySourceId === child.sourceId : product.category === child.name).length, 0).toLocaleString()} products</span></div><div className="category-admin-list">{group.children.map((child) => <div className="category-admin-card" key={`${group.id}-${child.sourceId || child.name}`}><div className="category-initial">{child.name.charAt(0)}</div><div><button className="category-edit-name" aria-label={"Edit " + child.name} onClick={() => editSubcategory(group.id, child.name)}><span>{child.name}</span><Pencil size={15} /></button><small>{state.products.filter((product) => child.sourceId ? product.categorySourceId === child.sourceId : product.category === child.name).length.toLocaleString()} products</small></div></div>)}</div></section>)}{state.categories.filter((item) => item !== 'All' && !categoryGroups.some((group) => group.children.some((child) => child.name === item))).map((item) => <div className="category-admin-card" key={item}><div className="category-initial">{item.charAt(0)}</div><div><strong>{item}</strong><small>{state.products.filter((product) => product.category === item).length} products · manual</small></div><button className="subtle-icon danger-hover" aria-label={`Remove ${item}`} onClick={() => removeCategory(item)}><Trash2 size={17} /></button></div>)}</div></section>}
          {adminTab === 'offers' && <AdminOffers state={state} products={activeProducts} onNewCoupon={() => setCouponFormOpen(true)} onNewOffer={() => setOfferFormOpen(true)} toggleCoupon={toggleCoupon} deleteCoupon={deleteCoupon} toggleOffer={toggleOffer} deleteOffer={deleteOffer} onEdit={startEditProduct} updateState={updateState} notify={notify} />}
          {adminTab === 'orders' && <AdminOrders orders={state.orders} filter={orderFilter} setFilter={setOrderFilter} search={orderSearch} setSearch={setOrderSearch} onStatus={updateOrderStatus} />}
          {adminTab === 'content' && <section className="content-grid"><div className="panel content-editor"><div className="panel-heading"><div><h2>Storefront & campaigns</h2><p>Manage the homepage, promo banner, combos, and delivery estimates.</p></div><span className="saved-badge"><CheckCircle2 size={15} /> Saved to this browser</span></div><form className="settings-form" onSubmit={saveContent}><label>Announcement bar<input name="announcement" defaultValue={state.content.announcement} /></label><label>Hero headline<textarea name="heroTitle" rows={2} defaultValue={state.content.heroTitle} /></label><label>Hero supporting line<textarea name="heroSubtitle" rows={3} defaultValue={state.content.heroSubtitle} /></label><div className="settings-two"><label>Hero call to action<input name="heroCta" defaultValue={state.content.heroCta} /></label><label>Hero image URL<input name="heroImage" defaultValue={state.content.heroImage} /></label></div><h3 className="settings-subhead">Promotional banner</h3><label>Banner headline<textarea name="offerTitle" rows={2} defaultValue={state.content.offerTitle} /></label><label>Banner supporting line<textarea name="offerSubtitle" rows={2} defaultValue={state.content.offerSubtitle} /></label><label>Banner image URL<input name="offerImage" defaultValue={state.content.offerImage} /></label><h3 className="settings-subhead">Homepage combo cards</h3>{state.content.combos.map((combo, index) => <div className="combo-editor" key={`${combo.title}-${index}`}><b>Combo 0{index + 1}</b><label>Title<input name={`comboTitle${index}`} defaultValue={combo.title} /></label><div className="settings-two"><label>Subtitle<input name={`comboSubtitle${index}`} defaultValue={combo.subtitle} /></label><label>Price from (৳)<input name={`comboPrice${index}`} type="number" defaultValue={combo.price} /></label></div><label>Image URL<input name={`comboImage${index}`} defaultValue={combo.image} /></label></div>)}<h3 className="settings-subhead">Delivery charges</h3><div className="settings-two"><label>Inside Dhaka (৳)<input name="deliveryInDhaka" type="number" defaultValue={state.content.deliveryInDhaka} /></label><label>Outside Dhaka (৳)<input name="deliveryOutsideDhaka" type="number" defaultValue={state.content.deliveryOutsideDhaka} /></label></div><p className="form-help">Current delivery charges are ৳60 inside Dhaka and ৳120 outside Dhaka. You can update them here.</p><button className="primary-button"><Check size={17} /> Save storefront</button></form></div><div className="panel preview-panel"><div className="panel-heading"><div><h3>Homepage preview</h3><p>How the edit appears to customers</p></div><button className="subtle-icon" onClick={() => setAdmin(false)} aria-label="Open storefront"><ArrowUpRight size={17} /></button></div><div className="mini-hero" style={{ backgroundImage: `linear-gradient(90deg,rgba(26,44,43,.24),rgba(26,44,43,0)),url("${state.content.heroImage}")` }}><span>AARO / THE EVERYDAY EDIT</span><b>{state.content.heroTitle.replace('\n', ' ')}</b><button onClick={() => setAdmin(false)}>{state.content.heroCta} <ArrowRight size={13} /></button></div><div className="preview-note"><ShieldCheck size={17} /> Updates become visible on the storefront in this browser.</div></div></section>}
          {adminTab === 'sync' && <SyncPanel lastSync={lastSync} importNote={importNote} fileRef={fileRef} onImport={importCsv} products={state.products} apiBase={API_BASE} token={adminToken} />}
        </div>
      </main>
      {mobileMenu && <button className="admin-backdrop" onClick={() => setMobileMenu(false)} aria-label="Close menu" />}
      {productFormOpen && <ProductEditor product={editingProduct} categories={state.categories.filter((item) => item !== 'All')} onClose={() => setProductFormOpen(false)} onSave={saveProduct} />}
      {couponFormOpen && <CouponEditor onClose={() => setCouponFormOpen(false)} onSave={saveCoupon} />}
      {offerFormOpen && <OfferEditor products={activeProducts} onClose={() => setOfferFormOpen(false)} onSave={saveOffer} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div> : adminRoute ? <AdminLogin apiBase={API_BASE} onSuccess={(token, rememberMe) => { localStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_SESSION_TOKEN_KEY); (rememberMe ? localStorage : sessionStorage).setItem(rememberMe ? ADMIN_TOKEN_KEY : ADMIN_SESSION_TOKEN_KEY, token); setAdminToken(token); setAdmin(true) }} /> : !storeIsLive ? <main className={`store-closed-page ${darkTheme ? 'theme-dark' : ''}`}><span className="wordmark">AARO<span>.</span></span><h1>We’ll be back soon</h1><p>Our store is temporarily closed while we make a few updates. Please check back shortly.</p></main> : (authRoute || (page === 'account' && !accountToken)) ? <AccountAccessPage key={authRoute || 'login'} mode={authRoute || 'login'} apiBase={API_BASE} darkTheme={darkTheme} onToggleTheme={() => setDarkTheme((current) => !current)} onModeChange={showAuth} onBack={() => showStore('shop')} onAuth={(token, identifier) => { setAccountToken(token); localStorage.setItem(AUTH_TOKEN_KEY, token); setUser(identifier); localStorage.setItem(USER_KEY, identifier); showAccount() }} /> : <div className={`storefront ${darkTheme ? 'theme-dark' : ''} ${mobileMenu ? 'storefront-menu-open' : ''}`}>
      <div className="announcement"><Sparkles size={14} /><span>{state.content.announcement}</span><button onClick={() => showStore('offers')}>Shop offers <ArrowRight size={13} /></button></div>
      <header className={`site-header ${mobileMenu ? 'mobile-menu-active' : ''}`}>
        <div className="header-main page-width"><button className="mobile-menu-trigger storefront-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Open navigation"><Menu size={22} /></button><button className="wordmark" onClick={() => showStore('shop')} aria-label="AARO home">AARO<span>.</span></button>
          {mobileMenu && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
          <div className={`desktop-nav ${mobileMenu ? 'desktop-nav-open' : ''}`}><div className="mobile-nav-heading"><strong>Browse AARO</strong><button type="button" onClick={() => { setMobileMenu(false); setCategoryMenuOpen(false); setActiveCategoryMenuId('') }} aria-label="Close navigation"><X size={20} /></button></div><button className={page === 'shop' ? 'nav-current' : ''} onClick={() => showStore('shop')}>Discover</button><div className={`category-nav ${categoryMenuOpen ? 'category-nav-open' : ''}`} onMouseEnter={() => { if (!window.matchMedia('(max-width: 780px)').matches) setCategoryMenuOpen(true) }} onMouseLeave={() => { if (!window.matchMedia('(max-width: 780px)').matches) { setCategoryMenuOpen(false); setActiveCategoryMenuId('') } }}><button aria-expanded={categoryMenuOpen} onClick={() => setCategoryMenuOpen((open) => !open)}>Categories <ChevronDown size={14} /></button><div className={`category-dropdown ${activeCategoryMenuId ? 'category-dropdown-expanded' : ''}`}><div className="category-menu-list">{categoryGroups.map((group) => <section className={`category-menu-group ${activeCategoryMenuId === group.id ? 'category-menu-group-active' : ''}`} key={group.id} onMouseEnter={() => { if (!window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId(group.id) }} onFocus={() => { if (!window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId(group.id) }}><button className="category-menu-parent" aria-expanded={activeCategoryMenuId === group.id} onClick={() => { if (window.matchMedia('(max-width: 780px)').matches) setActiveCategoryMenuId((active) => active === group.id ? '' : group.id); else showStore('category', group.name, '', group.id) }}>{group.name}<ArrowRight size={13} /></button><div className="category-menu-inline-children">{group.children.map((child) => <button className="category-menu-child" key={`${group.id}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', group.id)}>{child.name}</button>)}</div></section>)}</div>{activeCategoryMenuId && (() => { const group = categoryGroups.find((item) => item.id === activeCategoryMenuId); return group ? <div className="category-menu-subcategories"><button className="category-menu-view-all" onClick={() => showStore('category', group.name, '', group.id)}>Shop all {group.name}<ArrowRight size={13} /></button>{group.children.map((child) => <button className="category-menu-child" key={`${group.id}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', group.id)}>{child.name}</button>)}</div> : null })()}</div></div><button className={page === 'trending' ? 'nav-current' : ''} onClick={() => showStore('trending')}>Trending now</button><button className={page === 'offers' ? 'nav-current' : ''} onClick={() => showStore('offers')}>Offers</button></div>
          <div className="header-actions"><form className={`search-wrap ${showSearch ? 'search-focused' : ''}`} onSubmit={(event) => { event.preventDefault(); submitSearch() }}><Search size={18} /><input ref={searchRef} value={query} onFocus={() => setShowSearch(true)} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setShowSearch(false); setQuery('') } }} placeholder="Search products, styles..." aria-label="Search products" />{query && <button type="button" onClick={() => { setQuery(''); setSubmittedQuery(''); searchRef.current?.focus() }} aria-label="Clear search"><X size={15} /></button>}</form><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle" onClick={() => setDarkTheme((current) => !current)}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><IconButton label={user ? 'Your profile' : 'Account login'} onClick={() => user ? showAccount() : showAuth('login')}><UserRound size={20} /></IconButton><IconButton label={`Wishlist, ${wishlist.length} saved`} onClick={() => { setPage('wishlist'); setCategory('All'); setQuery(''); setSubmittedQuery(''); setShowSearch(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Heart size={19} /><i className="action-count">{wishlist.length}</i></IconButton><IconButton label={`Shopping bag, ${cart.reduce((sum, line) => sum + line.quantity, 0)} items`} onClick={() => { setCartOpen(true); setCheckout(false); if (window.location.pathname === '/checkout') history.replaceState({}, '', '/') }}><ShoppingBag size={19} /><i className="action-count">{cart.reduce((sum, line) => sum + line.quantity, 0)}</i></IconButton></div>
        </div>
        {showSearch && query && <div className="search-suggestions page-width"><div><span>QUICK RESULTS</span><button onClick={submitSearch}>View all results <ArrowRight size={13} /></button></div>{searchSuggestions.map((product) => <button key={product.id} className="suggestion-item" onClick={() => openProduct(product)}><ImageView src={product.image} alt="" /><span>{product.title}<small>{product.category}</small></span><b>{money(product.price)}</b></button>)}{!searchSuggestions.length && <p className="empty-search">No products found. Try another search.</p>}</div>}
      </header>
      <main onClick={(event) => { if (showSearch && !(event.target as HTMLElement).closest('.search-wrap,.search-suggestions')) setShowSearch(false) }}>
        {catalogLoading ? <div className="catalog-message" role="status"><span className="catalog-spinner" />Loading the AARO product catalog…</div> : <>
        {catalogError && <div className="catalog-warning" role="status">The live catalog could not be reached. Showing any saved products available in this browser.</div>}
        {checkout ? <CheckoutPage cartItems={cartItems} subtotal={subtotal} delivery={state.content.deliveryInDhaka} outsideDelivery={state.content.deliveryOutsideDhaka} outsideDhaka={outsideDhaka} setOutsideDhaka={setOutsideDhaka} discount={discount} total={subtotal + deliveryFee - discount} coupon={coupon} onPlaceOrder={placeOrder} onBack={returnToBag} /> : selectedProduct ? <ProductPage product={selectedProduct} offer={state.offers.find((item) => item.active && item.productId === selectedProduct.id)} relatedProducts={activeProducts.filter((item) => item.categorySourceId === selectedProduct.categorySourceId && item.id !== selectedProduct.id).slice(0, 4)} wishlist={wishlist} wished={wishlist.includes(selectedProduct.id)} onClose={closeProduct} onWish={toggleWish} onOpen={openProduct} onSeeRelated={() => showStore('category', selectedProduct.category, selectedProduct.categorySourceId || '', selectedProduct.parentCategoryId || '')} onAdd={(product, quantity, size) => { addToCart(product, quantity, size); closeProduct() }} /> : <>
        {page === 'shop' && !submittedQuery && <><section className="hero page-width"><div className="hero-copy"><span className="kicker"><i /> SHOP AARO <span>·</span> EVERYDAY FINDS</span><h1>{state.content.heroTitle.split('\n').map((line, index) => <span key={index}>{line}{index === 0 && <br />}</span>)}</h1><p>{state.content.heroSubtitle}</p><div className="hero-actions"><button className="dark-button" onClick={() => showStore('trending')}>{state.content.heroCta} <ArrowRight size={17} /></button><span><ShieldCheck size={15} /> Guest checkout available</span></div><div className="hero-points"><span><ShieldCheck size={16} /> Curated finds</span><span><Truck size={16} /> Nationwide delivery</span></div></div><div className="hero-art"><ImageView src={state.content.heroImage} alt="A curated neutral-toned fashion edit" loading="eager" /><div className="hero-label"><span>THE NEW EVERYDAY</span><b>Made for your kind of day.</b><button onClick={() => showStore('category', homeCategories[0]?.category || 'All')}>Explore <ArrowUpRight size={14} /></button></div><div className="hero-stamp"><span>MADE TO</span><b>feel like<br />you.</b><i>✳</i></div></div><div className="hero-count"><span>01</span><i /> 03</div></section>
          <section className="service-strip page-width"><div><span className="service-icon"><Truck size={19} /></span><span><b>Delivery across Bangladesh</b><small>Dhaka & beyond</small></span></div><div><span className="service-icon"><ShieldCheck size={19} /></span><span><b>Thoughtful, trusted picks</b><small>Picked with care</small></span></div><div><span className="service-icon"><RotateCcw size={19} /></span><span><b>Easy order support</b><small>We’re here to help</small></span></div><div><span className="service-icon"><Package size={19} /></span><span><b>10,000+ products</b><small>Across 100+ categories</small></span></div></section>
          <section className="category-section page-width"><div className="section-heading"><div><span className="section-kicker">A LITTLE BIT OF EVERYTHING</span><h2>Find your kind of good.</h2></div><button className="text-link" onClick={() => showStore('category', 'All')}>Browse all categories <ArrowRight size={16} /></button></div><div className="category-tiles">{homeCategories.map(({ category: categoryName, products }, index) => <button className={`category-tile tile-${index + 1}`} key={categoryName} onClick={() => showStore('category', categoryName)}><ImageView src={products[0].image} alt={categoryName} /><span className="tile-overlay" /><span className="tile-copy"><b>{categoryName}</b><i>Explore <ArrowRight size={15} /></i></span></button>)}</div></section>
          {homeTrendingProducts.length > 0 && <ProductSection title="Trending now" kicker="POPULAR RIGHT NOW" products={homeTrendingProducts} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('trending')} />}
          {homeOfferProducts.length > 0 && <><OfferBanner state={state} onShop={() => showStore('offers')} /><ProductSection title="A good deal, indeed." kicker="CURRENT OFFERS" products={homeOfferProducts} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('offers')} compact /></>}
          </>}
        {page === 'terms' && !submittedQuery && <section className="terms-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Terms & Conditions</span></div><article className="terms-card"><span className="legal-kicker">AARO / CUSTOMER TERMS</span><h1>Terms &amp; Conditions</h1><p className="terms-lead">These simple terms explain what to expect when placing an order with AARO.</p><h2>Products and prices</h2><p>We do our best to show accurate product photos, descriptions, prices, and availability. Colors may look slightly different on different screens, and availability can change before an order is confirmed.</p><h2>Placing an order</h2><p>Please provide accurate delivery details and contact information. We may contact you to confirm your order or clarify its details. An order is confirmed once AARO has reviewed and accepted it.</p><h2>Payment and delivery</h2><p>Product prices are shown in Bangladeshi taka. Any delivery charge will be shown before you submit your order. Available payment methods and delivery details are provided during checkout.</p><h2>Order changes</h2><p>If you need to correct or cancel an order, contact us as soon as possible. We may be unable to change an order after it has been prepared or handed to the courier.</p><p>For parcel inspection, returns, and exchanges, please read our <button className="terms-inline-link" onClick={() => showStore('delivery')}>Delivery &amp; Returns policy</button>.</p><button className="dark-button" onClick={() => showStore('shop')}>Continue shopping <ArrowRight size={16} /></button></article></section>}
        {page === 'delivery' && !submittedQuery && <section className="legal-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Delivery & Returns</span></div><article className="legal-card"><span className="legal-kicker">AARO / DELIVERY CARE</span><h1>Delivery & Returns</h1><p className="legal-intro">We deliver across Bangladesh. Here are the delivery charges and what to do if there is a problem with your order.</p><section><h2>Delivery charges</h2><ul><li><b>Inside Dhaka:</b> ৳60</li><li><b>Outside Dhaka:</b> ৳120</li></ul><p>Any applicable delivery charge will be shown during checkout before you place your order.</p></section><section><h2>Order confirmation</h2><p>We may call the phone number on your order to confirm it. Please provide an active number and stay reachable. We cannot confirm an order if we are unable to reach you.</p></section><section><h2>Check your parcel at delivery</h2><p>Please check your product while the courier is present. If it is damaged, incorrect, or has another issue, tell the courier immediately and contact us at once.</p></section><section><h2>Returns and exchanges</h2><p>If you ask to return or exchange an item after the courier has left, an additional delivery charge will apply. Products that have been used or damaged after delivery cannot be returned. We will review the issue with you before arranging a return or exchange.</p></section><p className="legal-contact-note">For help with a delivery or return, contact us with your order number and the phone number used for the order.</p><button className="dark-button" onClick={() => showStore('contact')}>Contact us <ArrowRight size={16} /></button></article></section>}
        {page === 'contact' && !submittedQuery && <section className="legal-page page-width"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Contact us</span></div><article className="legal-card contact-card"><span className="legal-kicker">AARO / HERE TO HELP</span><h1>Contact us</h1><p className="legal-intro">Questions about a product, delivery, or an order? Contact AARO using either option below.</p><div className="contact-options"><a href="https://wa.me/8801731955291" target="_blank" rel="noopener noreferrer"><span className="contact-option-icon"><Phone size={20} /></span><span><small>WHATSAPP</small><b>+880 1731 955 291</b><i>Chat with us on WhatsApp <ArrowUpRight size={15} /></i></span></a><a href="mailto:aaro.shop.bd@gmail.com"><span className="contact-option-icon"><Mail size={20} /></span><span><small>EMAIL</small><b>aaro.shop.bd@gmail.com</b><i>Send us an email <ArrowUpRight size={15} /></i></span></a></div><p className="contact-help-note">For order support, include your order number and the phone number used when placing it.</p></article></section>}
        {page === 'account' && (accountProfile ? <AccountDashboard apiBase={API_BASE} token={accountToken} profile={accountProfile} orders={customerOrders} onProfile={setAccountProfile} onSignOut={signOutCustomer} notify={notify} /> : <div className="catalog-message">Loading your account…</div>)}
        {(page !== 'shop' && page !== 'combos' && page !== 'account' && page !== 'terms' && page !== 'delivery' && page !== 'contact') || submittedQuery ? <section className="listing-page page-width">
          <div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>{submittedQuery ? 'Search results' : page === 'category' ? category : formatPageTitle}</span></div>
          <div className="listing-heading"><div><span className="section-kicker">THE AARO EDIT / {visibleProducts.length} FINDS</span><h1>{submittedQuery ? `Results for “${submittedQuery}”` : formatPageTitle}</h1><p>{page === 'offers' ? 'Little extras to make a good find feel even better.' : page === 'trending' ? 'The pieces customers keep coming back for.' : page === 'wishlist' ? 'All the things you have saved for later.' : 'Good things, picked with your everyday in mind.'}</p></div>{page === 'category' && <button className="filter-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={16} /> Filters <ChevronDown size={14} /></button>}</div>
          {page === 'category' && <>
            <div className="filter-chips">{categoryGroups.map((group) => <button className={selectedParentCategoryId === group.id ? 'selected' : ''} key={group.id} onClick={() => showStore('category', group.name, '', group.id)}>{group.name}</button>)}</div>
            {selectedParentCategoryId && <div className="filter-chips subcategory-chips">{(categoryGroups.find((group) => group.id === selectedParentCategoryId)?.children || []).map((child) => <button className={category === child.name ? 'selected' : ''} key={`${selectedParentCategoryId}-${child.sourceId || child.name}`} onClick={() => showStore('category', child.name, child.sourceId || '', selectedParentCategoryId)}>{child.name}</button>)}</div>}
          </>}
          {page === 'category' && filtersOpen && <div className="catalog-filters"><label className="sort-control">Sort by<select value={priceSort} onChange={(event) => setPriceSort(event.target.value as typeof priceSort)}><option value="recommended">Recommended</option><option value="low-high">Price: low to high</option><option value="high-low">Price: high to low</option></select></label><div className="price-range"><div className="price-range-heading"><b>Price range</b><span>{money(minPrice)} – {money(Math.min(maxPrice, catalogMaxPrice))}</span></div><label>Minimum price<input aria-label="Minimum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(minPrice, catalogMaxPrice)} onChange={(event) => setMinPrice(Math.min(Number(event.target.value), maxPrice))} /></label><label>Maximum price<input aria-label="Maximum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(maxPrice, catalogMaxPrice)} onChange={(event) => setMaxPrice(Math.max(Number(event.target.value), minPrice))} /></label></div><button className="reset-filters" onClick={() => { setMinPrice(0); setMaxPrice(catalogMaxPrice); setPriceSort('recommended') }}>Reset filters</button></div>}
          {visibleProducts.length ? <><div className="product-grid listing-grid">{visibleProducts.slice(0, productsToShow).map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} />)}</div>{visibleProducts.length > productsToShow && <button className="load-more-button" onClick={() => setProductsToShow((count) => Math.min(count + 48, visibleProducts.length))}>Load more products <span>{Math.min(48, visibleProducts.length - productsToShow)} more</span></button>}</> : <div className="empty-state"><Search size={27} /><h3>{page === 'wishlist' ? 'Nothing saved just yet' : 'No finds in this range'}</h3><p>{page === 'wishlist' ? 'Tap the heart on anything you love and it will show up here.' : 'Adjust the price range or browse another category.'}</p><button className="dark-button" onClick={() => { setQuery(''); showStore('shop') }}>Explore all products <ArrowRight size={16} /></button></div>}
        </section> : null}
        {page === 'combos' && !submittedQuery && <section className="listing-page page-width combo-list-page"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Combos</span></div><div className="listing-heading"><div><span className="section-kicker">AARO, ALL TOGETHER</span><h1>The good things set.</h1><p>Considered combinations for gifting, keeping, or making your day.</p></div></div><div className="combo-grid">{state.content.combos.map((combo, index) => <div className="combo-card combo-card-static" key={combo.title}><div className={`combo-photo combo-photo-${index + 1}`}><ImageView src={combo.image} alt={combo.title} /><span>THE SET EDIT</span><b>0{index + 1}</b></div><div><span>{combo.subtitle}</span><strong>{combo.title}</strong><small>From {money(combo.price)} <ArrowRight size={14} /></small></div><button className="dark-button" onClick={() => notify('Combo ordering will be enabled after product bundles are connected.')}>Explore this set <ArrowRight size={15} /></button></div>)}</div></section>}
        
        </>}
        </>}
      </main>
      <footer className="site-footer"><div className="footer-main page-width"><div className="footer-brand"><button className="wordmark" onClick={() => showStore('shop')}>AARO<span>.</span></button><p>Good finds for bright everyday living.</p><div className="social-dots"><a href="/" aria-label="Instagram"><img src="/images/instagram.svg" alt="" /></a><a href="/" aria-label="Facebook"><img src="/images/facebook.svg" alt="" /></a><a href="/" aria-label="TikTok"><img src="/images/tiktok.svg" alt="" /></a></div></div><div className="footer-column"><b>Discover</b><button onClick={() => showStore('trending')}>Trending now</button><button onClick={() => showStore('offers')}>Offers</button></div><div className="footer-column"><b>Helpful things</b><button onClick={() => showStore('terms')}>Terms & Conditions</button><button onClick={() => showStore('delivery')}>Delivery & returns</button><button onClick={() => showStore('contact')}>Contact us</button><button onClick={() => user ? showAccount() : showAuth('login')}>Your account</button></div><div className="footer-contact"><span className="section-kicker">A LITTLE HELP?</span><p>Questions, ideas, or a product request?</p><button onClick={() => showStore('contact')}>Say hello <ArrowRight size={15} /></button></div></div><div className="footer-bottom page-width"><span>© 2026 AARO. All rights reserved.</span><span>Designed for the everyday, with a little extra.</span></div></footer>
      {cartOpen && <CartDrawer cartItems={cartItems} subtotal={subtotal} delivery={deliveryFee} outsideDelivery={state.content.deliveryOutsideDhaka} discount={discount} total={total} coupon={coupon} couponInput={couponInput} setCouponInput={setCouponInput} applyCoupon={applyCoupon} clearCoupon={() => setCoupon(null)} onQuantity={setQuantity} onClose={() => setCartOpen(false)} onCheckout={beginCheckout} onShop={() => { setCartOpen(false); showStore('shop') }} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>}
  </>
}

function ProductCard({ product, wished, onWish, onOpen, onAdd }: { product: Product; wished: boolean; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void }) {
  const salePercent = product.compareAt ? Math.round((1 - product.price / product.compareAt) * 100) : 0
  return <article className="product-card"><div className="product-image" onClick={() => onOpen(product)} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen(product)}><ImageView src={product.image} alt={product.title} />{(product.badge || salePercent > 0) && <span className="product-badge">{product.badge || `${salePercent}% OFF`}</span>}<IconButton label={wished ? 'Remove from wishlist' : 'Add to wishlist'} className={`wishlist-button ${wished ? 'wished' : ''}`} onClick={() => onWish(product.id)}><Heart size={17} fill={wished ? 'currentColor' : 'none'} /></IconButton><button className="quick-add" onClick={(event) => { event.stopPropagation(); if (product.source === 'shopbase') onOpen(product); else onAdd(product) }}>{product.source === 'shopbase' ? 'View options' : 'Quick add'} <Plus size={15} /></button></div><div className="product-info"><button className="product-category" onClick={() => onOpen(product)}>{product.category}</button><button className="product-name" onClick={() => onOpen(product)}>{product.title}</button><div className="product-meta"><span className="price">{money(product.price)}{product.compareAt && <del>{money(product.compareAt)}</del>}</span></div></div></article>
}

function ProductSection({ title, kicker, products, wishlist, onWish, onOpen, onAdd, onSeeAll, compact = false }: { title: string; kicker: string; products: Product[]; wishlist: string[]; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void; onSeeAll: () => void; compact?: boolean }) {
  return <section className={`product-section page-width ${compact ? 'compact-section' : ''}`}><div className="section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><button className="text-link" onClick={onSeeAll}>View all <ArrowRight size={16} /></button></div>{products.length ? <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={onWish} onOpen={onOpen} onAdd={onAdd} />)}</div> : <p className="empty-row">Add products to this collection from the moderator panel.</p>}</section>
}

function OfferBanner({ state, onShop }: { state: StoreState; onShop: () => void }) {
  return <section className="offer-banner page-width"><div className="offer-visual"><ImageView src={state.content.offerImage} alt="A featured AARO offer edit" /><span className="offer-seal"><b>JUST A</b><strong>little<br />extra</strong><i>✳</i></span><span className="offer-count">THE OFFER EDIT&nbsp; / &nbsp;01—06</span></div><div className="offer-copy"><span className="section-kicker">GOOD FINDS, GOOD TIMING</span><h2>{state.content.offerTitle.split('\n').map((line, index) => <span key={index}>{line}{index === 0 && <br />}</span>)}</h2><p>{state.content.offerSubtitle}</p><button className="dark-button" onClick={onShop}>Shop the offers <ArrowRight size={16} /></button><small>Offers can change as availability updates.</small></div></section>
}

function CartDrawer({ cartItems, subtotal, delivery, outsideDelivery, discount, total, coupon, couponInput, setCouponInput, applyCoupon, clearCoupon, onQuantity, onClose, onCheckout, onShop }: { cartItems: (CartLine & { product: Product })[]; subtotal: number; delivery: number; outsideDelivery: number; discount: number; total: number; coupon: Coupon | null; couponInput: string; setCouponInput: (value: string) => void; applyCoupon: () => void; clearCoupon: () => void; onQuantity: (id: string, qty: number, size?: string) => void; onClose: () => void; onCheckout: () => void; onShop: () => void }) {
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="cart-drawer">
      <div className="drawer-head"><div><span className="section-kicker">AARO / YOUR BAG</span><h2>Your bag ({cartItems.reduce((sum, line) => sum + line.quantity, 0)})</h2></div><IconButton label="Close bag" onClick={onClose}><X size={20} /></IconButton></div>
      {cartItems.length ? <>
        <div className="free-delivery"><span><Truck size={16} /> Delivery: {money(delivery)} inside Dhaka · {money(outsideDelivery)} outside Dhaka</span><small>Choose the correct delivery zone at checkout.</small></div>
        <div className="cart-lines">{cartItems.map(({ product, quantity, size }) => <div className="cart-line" key={`${product.id}-${size || 'default'}`}><ImageView src={product.image} alt={product.title} /><div className="cart-line-copy"><span>{product.category}</span><b>{product.title}</b>{size && <small>Size: {size}</small>}<strong>{money(product.price)}</strong><div className="quantity-control"><button aria-label="Decrease quantity" onClick={() => onQuantity(product.id, quantity - 1, size)}><Minus size={13} /></button><span>{quantity}</span><button aria-label="Increase quantity" onClick={() => onQuantity(product.id, quantity + 1, size)}><Plus size={13} /></button></div></div><button className="remove-line" onClick={() => onQuantity(product.id, 0, size)} aria-label={`Remove ${product.title}`}><X size={16} /></button></div>)}</div>
        <div className="coupon-row"><TicketPercent size={17} /><input value={couponInput} onChange={(event) => setCouponInput(event.target.value.toUpperCase())} placeholder="Coupon code" /><button onClick={applyCoupon}>{coupon ? 'Applied' : 'Apply'}</button></div>
        {coupon && <div className="coupon-applied"><CheckCircle2 size={14} /> {coupon.code} is on this order <button onClick={() => { setCouponInput(''); clearCoupon() }}>Remove</button></div>}
        <div className="drawer-summary"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>Delivery (inside / outside)</span><b>{money(delivery)} / {money(outsideDelivery)}</b></div>{discount > 0 && <div className="discount-line"><span>Offer & coupon savings</span><b>−{money(discount)}</b></div>}<div className="summary-total"><span>Estimated total · inside Dhaka</span><b>{money(total)}</b></div><button className="dark-button checkout-submit" onClick={onCheckout}>Continue to checkout <ArrowRight size={17} /></button><p><ShieldCheck size={14} /> Cash on delivery · Guest checkout available</p></div>
      </> : <div className="empty-cart"><div><ShoppingBag size={28} /></div><h3>Your bag has room to grow.</h3><p>Find something lovely for your everyday.</p><button className="dark-button" onClick={onShop}>Explore the edit <ArrowRight size={16} /></button></div>}
    </aside>
  </div>
}

function CheckoutPage({ cartItems, subtotal, delivery, outsideDelivery, outsideDhaka, setOutsideDhaka, discount, total, coupon, onPlaceOrder, onBack }: { cartItems: (CartLine & { product: Product })[]; subtotal: number; delivery: number; outsideDelivery: number; outsideDhaka: boolean; setOutsideDhaka: (outside: boolean) => void; discount: number; total: number; coupon: Coupon | null; onPlaceOrder: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) {
  if (!cartItems.length) return <section className="checkout-page page-width"><div className="empty-state"><ShoppingBag size={27} /><h1>Your bag is empty</h1><p>Add products to your bag before checking out.</p><button className="dark-button" onClick={onBack}>Return to bag <ArrowRight size={16} /></button></div></section>
  return <section className="checkout-page page-width">
    <div className="checkout-page-heading"><div><span className="section-kicker">AARO / SECURE CHECKOUT</span><h1>Delivery details</h1><p>Enter where you’d like your order delivered.</p></div><button type="button" className="back-to-bag" onClick={onBack}><ChevronLeft size={16} /> Back to your bag</button></div>
    <form className="checkout-page-layout" onSubmit={onPlaceOrder}>
      <div className="checkout-page-form panel">
        <div className="checkout-note"><Phone size={18} /><span><b>Guest checkout</b></span></div>
        <label>Full name<input name="name" autoComplete="name" required placeholder="Name on the order" /></label>
        <label>Phone number<input name="phone" autoComplete="tel" required pattern="[+0-9 ()-]{8,}" placeholder="01XXX XXXXXX" /></label>
        <label>Email <span>(optional)</span><input type="email" name="email" autoComplete="email" placeholder="you@example.com" /></label>
        <label>Delivery area<input name="area" required placeholder="e.g. Dhanmondi, Dhaka" /></label>
        <label>Full delivery address<textarea name="address" rows={3} required placeholder="House, road, area, city" /></label>
        <label>Delivery zone<select name="zone" value={outsideDhaka ? 'outside' : 'dhaka'} onChange={(event) => setOutsideDhaka(event.target.value === 'outside')}><option value="dhaka">Inside Dhaka — {money(delivery)}</option><option value="outside">Outside Dhaka — {money(outsideDelivery)}</option></select></label>
        <div className="checkout-payment"><div className="cod-icon"><Truck size={18} /></div><span><b>Cash on delivery</b><small>Pay the courier when your order arrives.</small></span><CheckCircle2 size={18} /></div>
      </div>
      <aside className="checkout-order-summary panel">
        <h2>Order summary</h2>
        <div className="checkout-summary-items">{cartItems.map(({ product, quantity, size }) => <div className="checkout-summary-item" key={`${product.id}-${size || 'default'}`}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{size ? `Size ${size} · ` : ''}Qty ${quantity} · {money(product.price)} each</small></span><strong>{money(product.price * quantity)}</strong></div>)}</div>
        <div className="checkout-totals"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>Delivery {outsideDhaka ? '(outside Dhaka)' : '(inside Dhaka)'}</span><b>{money(outsideDhaka ? outsideDelivery : delivery)}</b></div>{discount > 0 && <div className="discount-line"><span>Coupon {coupon ? `(${coupon.code})` : 'saving'}</span><b>−{money(discount)}</b></div>}<div className="checkout-total"><span>Total due on delivery</span><b>{money(total)}</b></div></div>
        <button className="dark-button checkout-submit">Place order <ArrowRight size={17} /></button>
        <details className="checkout-terms"><summary>ডেলিভারি ও রিটার্নের শর্ত</summary><p>কুরিয়ার কর্মী থাকা অবস্থায় পণ্য পরীক্ষা করুন। ত্রুটি থাকলে সঙ্গে সঙ্গে রিটার্নের কথা জানান।</p><p>কুরিয়ার চলে যাওয়ার পরে পণ্য ফেরত বা পরিবর্তন করতে অতিরিক্ত ডেলিভারি চার্জ প্রযোজ্য হবে।</p><p>ফেরত পণ্য পুনরায় বিক্রির উপযোগী নাও থাকতে পারে—অর্ডার দেওয়ার আগে পণ্যের বিবরণ ও মাপ দেখে নিন।</p></details>
      </aside>
    </form>
  </section>
}

function ProductPage({ product, offer, relatedProducts, wishlist, wished, onClose, onWish, onOpen, onSeeRelated, onAdd }: { product: Product; offer?: OfferDeal; relatedProducts: Product[]; wishlist: string[]; wished: boolean; onClose: () => void; onWish: (id: string) => void; onOpen: (product: Product) => void; onSeeRelated: () => void; onAdd: (product: Product, quantity: number, size?: string) => void }) {
  const [quantity, setQuantity] = useState(1)
  const [size, setSize] = useState(product.sizes?.[0] || '')
  const [fullDetails, setFullDetails] = useState<Product | null>(null)
  const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
  useEffect(() => {
    let current = true
    setFullDetails(null)
    if (!apiUrl || !product.sourceId) return () => { current = false }
    fetch(`${apiUrl}/api/products/${encodeURIComponent(product.sourceId)}`)
      .then((response) => { if (!response.ok) throw new Error('Details unavailable'); return response.json() as Promise<Product> })
      .then((details) => { if (current) setFullDetails({ ...product, ...details, id: product.id }) })
      .catch(() => undefined)
    return () => { current = false }
  }, [apiUrl, product.id, product.sourceId])
  const detailProduct = fullDetails || product
  const primaryImage = detailProduct.images?.[0] || detailProduct.image
  const detailImages = primaryImage ? [primaryImage] : []
  const normalizedDescription = (detailProduct.description || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const uniqueAttributes = (detailProduct.attributes || []).filter((attribute) => {
    const normalizedAttribute = attribute.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    return normalizedAttribute && !normalizedDescription.includes(normalizedAttribute)
  })
  const [activeImage, setActiveImage] = useState(product.image)
  useEffect(() => { setActiveImage(primaryImage) }, [detailProduct.id, primaryImage])
  useEffect(() => { setSize(detailProduct.sizes?.[0] || '') }, [detailProduct.id, detailProduct.sizes?.join('|')])
  return <section className="product-page page-width">
    <button className="product-back" onClick={onClose}><ChevronLeft size={17} /> Back to shopping</button>
    <div className="product-page-layout">
      <div className="detail-gallery"><div className="detail-image"><ImageView src={activeImage} alt={product.title} loading="eager" /></div>{detailImages.length > 1 && <div className="detail-thumbnails">{detailImages.map((image) => <button type="button" className={activeImage === image ? 'selected' : ''} key={image} onClick={() => setActiveImage(image)} aria-label={`View ${product.title} image`}><ImageView src={image} alt="" /></button>)}</div>}</div>
      <div className="detail-copy"><span className="section-kicker">{detailProduct.category.toUpperCase()} / THE EVERYDAY EDIT</span><h1>{detailProduct.title}</h1><div className="detail-price">{money(detailProduct.price)} {detailProduct.compareAt && <del>{money(detailProduct.compareAt)}</del>}{detailProduct.compareAt && <small>YOU SAVE {money(detailProduct.compareAt - detailProduct.price)}</small>}</div><p className="product-description">{detailProduct.description || (detailProduct.source === 'shopbase' ? 'Loading product details…' : '')}</p>{offer && <div className="product-offer-callout"><Tags size={16} /><span><b>{offer.title || 'Special offer'}</b><small>{offer.kind === 'special_price' ? `Offer price: ${money(offer.value)}` : offer.kind === 'quantity_discount' ? `Buy ${offer.quantity}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}` : `Buy ${offer.quantity}, get ${offer.freeQuantity} free`}</small></span></div>}{Boolean(detailProduct.sizes?.length) && <div className="size-picker"><div><b>Choose a size</b>{detailProduct.sizeChart && <button type="button" onClick={() => document.getElementById('product-size-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Size guide</button>}</div><div>{detailProduct.sizes?.map((item) => <button type="button" className={size === item ? 'selected' : ''} key={item} onClick={() => setSize(item)}>{item}</button>)}</div></div>}{uniqueAttributes.length > 0 ? <ul className="product-attributes">{uniqueAttributes.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : null}{detailProduct.sizeChart && <details className="product-size-chart" id="product-size-chart"><summary>Size chart & measurements</summary><pre>{detailProduct.sizeChart}</pre></details>}<div className="detail-actions"><div className="quantity-control"><button onClick={() => setQuantity(Math.max(1, quantity - 1))}><Minus size={13} /></button><span>{quantity}</span><button onClick={() => setQuantity(quantity + 1)}><Plus size={13} /></button></div><button className="dark-button" disabled={Boolean(detailProduct.sizes?.length && !size)} onClick={() => onAdd(detailProduct, quantity, size)}>Add to bag <ShoppingBag size={17} /></button><IconButton label={wished ? 'Remove from wishlist' : 'Save to wishlist'} className={wished ? 'wished' : ''} onClick={() => onWish(product.id)}><Heart size={18} fill={wished ? 'currentColor' : 'none'} /></IconButton></div><div className="detail-policies"><span><Truck size={16} /> Delivery across Bangladesh</span><span><ShieldCheck size={16} /> Easy support if needed</span></div></div>
    </div>
    {relatedProducts.length > 0 && <div className="related-products"><ProductSection title="More from this category" kicker={`MORE TO LOVE IN ${product.category.toUpperCase()}`} products={relatedProducts} wishlist={wishlist} onWish={onWish} onOpen={onOpen} onAdd={(item) => onAdd(item, 1)} onSeeAll={onSeeRelated} compact /></div>}
  </section>
}

function AccountDashboard({ apiBase, token, profile, orders, onProfile, onSignOut, notify }: { apiBase: string; token: string; profile: AccountProfile; orders: Order[]; onProfile: (profile: AccountProfile) => void; onSignOut: () => void; notify: (message: string) => void }) {
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const [error, setError] = useState('')
  const saveProfile = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const response = await fetch(`${apiBase}/api/account`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: form.get('name'), email: form.get('email'), phone: form.get('phone') }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); onProfile(result); notify('Account details saved.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save account.') } }
  const saveAddress = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const address: Address = { id: profile.addresses[0]?.id || crypto.randomUUID(), recipient: String(form.get('recipient')), phone: String(form.get('phone')), area: String(form.get('area')), address: String(form.get('address')), isDefault: true }; try { const response = await fetch(`${apiBase}/api/account/addresses`, { method: 'PUT', headers: auth, body: JSON.stringify({ addresses: [address] }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); onProfile({ ...profile, addresses: result.addresses, defaultAddressId: result.defaultAddressId }); notify('Shipping address saved.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save address.') } }
  const changePassword = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const response = await fetch(`${apiBase}/api/account/password`, { method: 'PUT', headers: auth, body: JSON.stringify({ current_password: form.get('current_password'), new_password: form.get('new_password') }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail); event.currentTarget.reset(); notify('Password changed.') } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change password.') } }
  const spent = orders.reduce((sum, order) => sum + order.total, 0)
  const address = profile.addresses[0]
  return <section className="listing-page page-width account-dashboard"><div className="listing-heading"><div><span className="section-kicker">AARO / YOUR ACCOUNT</span><h1>Hello, {profile.name}</h1><p>Track your orders and manage your account details.</p></div><button className="secondary-button" onClick={onSignOut}>Sign out</button></div><div className="stat-grid"><div className="stat-card"><span>Total orders</span><strong>{orders.length}</strong></div><div className="stat-card"><span>Total spent</span><strong>{money(spent)}</strong></div></div>{error && <p role="alert">{error}</p>}<section className="panel recent-panel" id="account-orders"><div className="panel-heading"><div><h2>Order history</h2><p>Current status for each order</p></div></div>{orders.length ? orders.map((order) => <div className="account-order" key={order.id}><strong>{order.id}</strong><span>{dateLabel(order.createdAt)}</span><StatusPill status={order.status} /><b>{money(order.total)}</b><small>{order.items.map((item) => `${item.title} × ${item.quantity}`).join(', ')}</small></div>) : <p className="empty-row">Your orders will appear here.</p>}</section><div className="content-grid"><form className="panel settings-form" onSubmit={saveProfile}><h2>Account details</h2><label>Full name<input name="name" required defaultValue={profile.name} /></label><label>Email<input name="email" type="email" defaultValue={profile.email} /></label><label>Phone<input name="phone" defaultValue={profile.phone} /></label><button className="primary-button">Save details</button></form><form className="panel settings-form" onSubmit={saveAddress}><h2>Default shipping address</h2><label>Recipient<input name="recipient" defaultValue={address?.recipient || profile.name} required /></label><label>Phone<input name="phone" defaultValue={address?.phone || profile.phone} required /></label><label>Area<input name="area" defaultValue={address?.area || ''} required /></label><label>Address<textarea name="address" defaultValue={address?.address || ''} required /></label><button className="primary-button">Save default address</button></form></div><form className="panel settings-form" onSubmit={changePassword}><h2>Change password</h2><div className="settings-two"><label>Current password<input name="current_password" type="password" required /></label><label>New password<input name="new_password" type="password" minLength={10} required /></label></div><button className="primary-button">Update password</button></form></section>
}

function AdminLogin({ apiBase, onSuccess }: { apiBase: string; onSuccess: (token: string, rememberMe: boolean) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)
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
  }}><span className="section-kicker">AARO / ADMIN</span><label>Admin ID<input name="identifier" autoComplete="username" placeholder="Finn" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><label className="remember-me-row"><input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} /> Remember me on this browser</label>{error && <p role="alert">{error}</p>}<button className="dark-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={16} /></button></form></main>
}

function AccountAccessPage({ mode, apiBase, darkTheme, onToggleTheme, onModeChange, onBack, onAuth }: { mode: 'login' | 'register'; apiBase: string; darkTheme: boolean; onToggleTheme: () => void; onModeChange: (mode: 'login' | 'register') => void; onBack: () => void; onAuth: (token: string, identifier: string) => void }) {
  const registering = mode === 'register'
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return <main className={`account-access-page ${darkTheme ? 'theme-dark' : ''}`}><div className="account-access-shell"><div className="account-access-top"><button className="wordmark" onClick={onBack} aria-label="AARO home">AARO<span>.</span></button><div className="account-access-actions"><IconButton label={darkTheme ? 'Switch to light theme' : 'Switch to dark theme'} className="theme-toggle" onClick={onToggleTheme}>{darkTheme ? <Sun size={19} /> : <Moon size={19} />}</IconButton><button className="account-back-link" onClick={onBack}><ChevronLeft size={16} /> Continue shopping</button></div></div><section className="account-access-panel"><span className="section-kicker">AARO / YOUR ACCOUNT</span><h1>{registering ? 'Create your account' : 'Welcome back'}</h1><p>{registering ? 'Create an account to follow your orders and save your details.' : 'Sign in to view your profile and order history.'}</p><form className="account-access-form" onSubmit={async (event) => {
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
    <button className="dark-button" disabled={busy}>{busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'} <ArrowRight size={17} /></button>
  </form><p className="account-access-switch">{registering ? 'Already have an account?' : 'New to AARO?'} <button onClick={() => onModeChange(registering ? 'login' : 'register')}>{registering ? 'Sign in' : 'Create an account'}</button></p></section></div></main>
}

function AdminOverview({ state, revenue, customerCount, onTab, updateOrderStatus }: { state: StoreState; revenue: number; customerCount: number; onTab: (tab: AdminTab) => void; updateOrderStatus: (id: string, status: OrderStatus) => void }) {
  const orders = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const liveCatalogCount = state.products.filter((product) => product.source === 'shopbase').length
  const stats = [
    { title: 'Total revenue', value: money(revenue), note: 'From saved orders', icon: CircleDollarSign, trend: 'Live', up: false },
    { title: 'Total orders', value: String(state.orders.length), note: state.orders.filter((order) => order.status === 'Pending confirmation').length + ' awaiting confirmation', icon: ShoppingCart, trend: 'Live', up: false },
    { title: 'Customers', value: String(customerCount), note: 'Customer order records', icon: UsersRound, trend: 'Live', up: false },
    { title: 'Store views', value: state.views.toLocaleString(), note: 'Storefront activity', icon: Eye, trend: 'Live', up: false }
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
function AdminProducts({ state, productViewCounts, onAdd, onEdit, onDelete }: { state: StoreState; productViewCounts: Record<string, number>; onAdd: () => void; onEdit: (product: Product) => void; onDelete: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => setVisibleCount(50), [search])
  const products = state.products.filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(search.toLowerCase()))
  return <section className="panel"><div className="panel-heading panel-heading-wrap"><div><h2>Product catalog</h2><p>Edit product details, pricing, images, availability, and collections.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} /> Add product</button></div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products..." /></div><button className="select-chip"><Filter size={14} /> All products <ChevronDown size={14} /></button><span>{products.length.toLocaleString()} products</span></div><div className="responsive-table"><table className="data-table product-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Views</th><th>Stock</th><th>Visibility</th><th>Source</th><th /></tr></thead><tbody>{products.slice(0, visibleCount).map((product) => <tr key={product.id}><td><div className="table-product"><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>SKU / {product.sourceId || product.id.slice(0, 10)}</small></span></div></td><td>{product.category}</td><td><b>{money(product.price)}</b>{product.compareAt && <small className="old-price">{money(product.compareAt)}</small>}</td><td><b>{(productViewCounts[product.id] || 0).toLocaleString()}</b></td><td><span className={product.stock < 10 ? 'stock-low' : 'stock-good'}><i /> {product.stock > 0 ? 'Available' : 'Unavailable'}</span></td><td><span className={`visibility ${product.active ? 'visible' : ''}`}><i /> {product.active ? 'Active' : 'Hidden'}</span></td><td><span className="source-tag">{product.source === 'shopbase' ? 'ShopBase import' : 'Manual'}</span></td><td><div className="row-actions"><button onClick={() => onEdit(product)} aria-label={`Edit ${product.title}`}><Pencil size={16} /></button><button onClick={() => onDelete(product.id)} aria-label={`Delete ${product.title}`}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>{products.length > visibleCount && <button className="load-more-button" onClick={() => setVisibleCount((count) => Math.min(count + 50, products.length))}>Load more products <span>Showing {Math.min(visibleCount, products.length).toLocaleString()} of {products.length.toLocaleString()}</span></button>}</section>
}

function AdminOffers({ state, products, onNewCoupon, onNewOffer, toggleCoupon, deleteCoupon, toggleOffer, deleteOffer, onEdit, updateState, notify }: { state: StoreState; products: Product[]; onNewCoupon: () => void; onNewOffer: () => void; toggleCoupon: (code: string) => void; deleteCoupon: (code: string) => void; toggleOffer: (id: string) => void; deleteOffer: (id: string) => void; onEdit: (product: Product) => void; updateState: (updater: (current: StoreState) => StoreState) => void; notify: (message: string) => void }) {
  const offerProducts = state.products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
  const productFor = (id: string) => products.find((product) => product.id === id)
  const offerLabel = (offer: OfferDeal) => {
    if (offer.kind === 'special_price') return `Special price ${money(offer.value)}`
    if (offer.kind === 'quantity_discount') return `Buy ${offer.quantity}, save ${offer.discountKind === 'percent' ? `${offer.value}%` : money(offer.value)}`
    return `Buy ${offer.quantity}, get ${offer.freeQuantity} free`
  }
  return <>
    <div className="panel offers-feature"><div className="offers-feature-copy"><span className="section-kicker">CURRENT OFFER EDIT</span><h2>Offers customers can see.</h2><p>Create product deals customers can use automatically in their bag, or manage checkout coupons.</p><div className="offers-actions"><button className="primary-button" onClick={onNewOffer}><Plus size={17} /> Create offer</button><button className="secondary-button" onClick={onNewCoupon}><TicketPercent size={17} /> Create coupon</button></div></div><div className="offer-feature-art"><span>THE GOOD<br />DEAL EDIT</span><b>For a little<br />less.</b><i>✳</i></div></div>
    <section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Product offers</h3><p>Deals are applied automatically to eligible items in the bag.</p></div></div>
      {state.offers.length ? <div className="offer-product-list">{state.offers.map((offer) => { const product = productFor(offer.productId); return <div className="offer-product-row offer-deal-row" key={offer.id}>{product && <ImageView src={product.image} alt="" />}<span><b>{offer.title || product?.title || 'Product offer'}</b><small>{product ? `${product.title} · ${offerLabel(offer)}` : 'The selected product is no longer in the active catalog.'}</small></span><button onClick={() => toggleOffer(offer.id)}>{offer.active ? 'Active' : 'Paused'}</button><button onClick={() => deleteOffer(offer.id)}>Delete</button></div> })}</div> : <p className="empty-row">No product offers yet. Create an offer to feature a deal.</p>}
    </section>
    <section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Featured offer products</h3><p>Products tagged for the storefront offer section</p></div></div>{offerProducts.length ? <div className="offer-product-list">{offerProducts.map((product) => <div className="offer-product-row" key={product.id}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{product.category} · {money(product.price)}{product.compareAt ? ` / ${money(product.compareAt)}` : ''}</small></span><button onClick={() => onEdit(product)}>Edit price</button><button onClick={() => { updateState((current) => ({ ...current, content: { ...current.content, offerIds: current.content.offerIds.filter((id) => id !== product.id) }, products: current.products.map((item) => item.id === product.id ? { ...item, offer: false } : item) })); notify('Removed from offer edit') }}>Remove</button></div>)}</div> : <p className="empty-row">No featured offers yet. Add a product offer or mark products for the offer section.</p>}</section>
    <section className="panel coupon-admin-panel"><div className="panel-heading"><div><h3>Coupon codes</h3><p>Discounts are checked against the bag subtotal.</p></div><button className="subtle-icon" onClick={onNewCoupon} aria-label="Add coupon"><Plus size={17} /></button></div><div className="coupon-admin-grid">{state.coupons.map((coupon) => <div className={`coupon-card ${coupon.active ? '' : 'inactive'}`} key={coupon.code}><div className="coupon-card-top"><span><TicketPercent size={16} /> DISCOUNT CODE</span><button onClick={() => toggleCoupon(coupon.code)}>{coupon.active ? 'Active' : 'Paused'} <ChevronDown size={13} /></button></div><strong>{coupon.code}</strong><p>{coupon.kind === 'percent' ? `${coupon.value}% off` : `${money(coupon.value)} off`} {coupon.minimum ? `on orders over ${money(coupon.minimum)}` : ''}</p><div className="coupon-card-actions"><button className="copy-code" onClick={() => { navigator.clipboard?.writeText(coupon.code); notify(`${coupon.code} copied`) }}><Copy size={14} /> Copy code</button><button className="delete-coupon" onClick={() => deleteCoupon(coupon.code)} aria-label={`Delete coupon ${coupon.code}`}><Trash2 size={15} /> Delete</button></div></div>)}</div>{!state.coupons.length && <p className="empty-row">Create your first coupon code.</p>}</section>
  </>
}

function AdminOrders({ orders, filter, setFilter, search, setSearch, onStatus }: { orders: Order[]; filter: string; setFilter: (value: string) => void; search: string; setSearch: (value: string) => void; onStatus: (id: string, status: OrderStatus) => void }) {
  const filtered = orders.filter((order) => (filter === 'All orders' || order.status === filter) && `${order.id} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <section className="panel orders-panel"><div className="panel-heading panel-heading-wrap"><div><h2>Orders</h2><p>Review customer details, confirm by phone, then submit to ShopBase.</p></div><button className="export-button" onClick={() => { const csv = ['Order,Customer,Phone,Area,Total,Status,Date', ...filtered.map((order) => [order.id, order.customer.name, order.customer.phone, order.customer.area, order.total, order.status, dateLabel(order.createdAt)].join(','))].join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'aaro-orders.csv'; link.click(); URL.revokeObjectURL(link.href) }}><Download size={16} /> Export</button></div><div className="order-tabs">{['All orders', 'Pending confirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].map((item) => <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}{item === 'Pending confirmation' && <i>{orders.filter((order) => order.status === item).length}</i>}</button>)}</div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order number, customer, phone..." /></div><span>{filtered.length} orders</span></div><div className="responsive-table"><OrderTable orders={filtered} onStatus={onStatus} /></div></section>
}

function OrderTable({ orders, onStatus, compact = false }: { orders: Order[]; onStatus: (id: string, status: OrderStatus) => void; compact?: boolean }) {
  return <table className="data-table order-table"><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th><th>{compact ? 'Action' : 'Update status'}</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><b className="order-id">{order.id}</b><small>{order.items.reduce((sum, item) => sum + item.quantity, 0)} item{order.items.reduce((sum, item) => sum + item.quantity, 0) === 1 ? '' : 's'}</small>{order.items.some((item) => item.size) && <small>{order.items.filter((item) => item.size).map((item) => `${item.title}: ${item.size}`).join(' · ')}</small>}</td><td><div className="customer-cell"><b>{order.customer.name}</b><small>{order.customer.phone} · {order.customer.area}</small></div></td><td>{shortDate(order.createdAt)}</td><td><b>{money(order.total)}</b></td><td><StatusPill status={order.status} /></td><td>{order.status === 'Pending confirmation' ? <div className="order-action-group"><button className="confirm-button" onClick={() => onStatus(order.id, 'Confirmed')}><Check size={14} /> Confirm</button><button className="cancel-button" onClick={() => onStatus(order.id, 'Cancelled')}><X size={14} /> Cancel</button></div> : order.status === 'Confirmed' ? <button className="small-action" onClick={() => onStatus(order.id, 'Processing')}>Mark processing <ArrowRight size={13} /></button> : order.status === 'Processing' ? <button className="small-action" onClick={() => onStatus(order.id, 'Shipped')}>Mark shipped <ArrowRight size={13} /></button> : !compact && order.status === 'Shipped' ? <button className="small-action" onClick={() => onStatus(order.id, 'Delivered')}>Mark delivered <Check size={13} /></button> : <span className="row-muted">—</span>}</td></tr>)}</tbody></table>
}

function ProductEditor({ product, categories, onClose, onSave }: { product: Product | null; categories: string[]; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><div className="form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CATALOG</span><h2>{product ? 'Edit product' : 'Add product'}</h2></div><IconButton label="Close editor" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form product-editor-form" onSubmit={onSave}><label>Product name<input name="title" required defaultValue={product?.title} placeholder="e.g. Cotton co-ord set" /></label><div className="settings-two"><label>Category<select name="category" defaultValue={product?.category || categories[0]}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><label>Discounted selling price (৳)<input name="price" type="number" min="0" required defaultValue={product?.price} /></label></div><div className="settings-two"><label>Original / suggested price (৳)<input name="compareAt" type="number" min="0" defaultValue={product?.compareAt || ''} /></label><label>Available quantity (set to 0 to mark unavailable)<input name="stock" type="number" min="0" defaultValue={product?.stock ?? 0} /></label></div><label>Image URL<input name="image" required defaultValue={product?.image} placeholder="Cloudinary URL or approved product image URL" /></label><label>Product details<textarea name="description" rows={4} defaultValue={product?.description} placeholder="What should a customer know?" /></label><label>Badge (optional)<input name="badge" defaultValue={product?.badge || ''} placeholder="Bestseller, New, Set of 2" /></label><div className="check-options"><label><input type="checkbox" name="active" defaultChecked={product?.active ?? true} /> Show on storefront</label><label><input type="checkbox" name="trending" defaultChecked={product?.trending} /> Trending now</label><label><input type="checkbox" name="offer" defaultChecked={product?.offer} /> Include in offers</label></div><p className="form-help">Images use a URL for now. Connect Cloudinary upload in the production backend for secure media management.</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save product</button></div></form></div></div>
}

function OfferEditor({ products, onClose, onSave }: { products: Product[]; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<OfferDeal['kind']>('special_price')
  const filtered = products.filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(search.toLowerCase())).slice(0, 60)
  return <div className="modal-backdrop"><div className="form-modal offer-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / PRODUCT DEAL</span><h2>Create offer</h2></div><IconButton label="Close offer form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={onSave}>
    <label>Offer name<input name="title" required maxLength={120} placeholder="e.g. Buy 2, save 10%" /></label>
    <label>Find a product<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search product name or category" /></label>
    <label>Select product<select name="productId" required defaultValue=""><option value="" disabled>Choose a product</option>{filtered.map((product) => <option value={product.id} key={product.id}>{product.title} · {money(product.price)}</option>)}</select></label>
    <label>Offer type<select name="kind" value={kind} onChange={(event) => setKind(event.target.value as OfferDeal['kind'])}><option value="special_price">Set a special product price</option><option value="quantity_discount">Buy a quantity and save</option><option value="buy_x_get_y_free">Buy X, get Y free</option></select></label>
    {kind === 'special_price' && <label>Offer price (৳)<input name="value" type="number" min="1" required /></label>}
    {kind === 'quantity_discount' && <><div className="settings-two"><label>Minimum quantity<input name="quantity" type="number" min="1" defaultValue="2" required /></label><label>Discount type<select name="discountKind"><option value="percent">Percentage</option><option value="amount">Fixed ৳ amount</option></select></label></div><label>Discount amount<input name="value" type="number" min="1" required /></label></>}
    {kind === 'buy_x_get_y_free' && <div className="settings-two"><label>Buy quantity<input name="quantity" type="number" min="1" defaultValue="3" required /></label><label>Free quantity<input name="freeQuantity" type="number" min="1" defaultValue="1" required /></label></div>}
    <p className="form-help">The deal is saved to the catalog server and applied automatically when the selected product qualifies in the customer’s bag.</p>
    <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save offer</button></div>
  </form></div></div>
}

function CouponEditor({ onClose, onSave }: { onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><div className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CHECKOUT</span><h2>Create coupon</h2></div><IconButton label="Close coupon form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={onSave}><label>Coupon code<input name="code" required minLength={3} placeholder="e.g. AARO15" /></label><div className="settings-two"><label>Discount type<select name="kind"><option value="percent">Percentage</option><option value="amount">Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" required /></label></div><label>Minimum order (৳), optional<input name="minimum" type="number" min="0" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save coupon</button></div></form></div></div>
}

function SyncPanel({ lastSync, importNote, fileRef, onImport, products, apiBase, token }: { lastSync: string; importNote: string; fileRef: { current: HTMLInputElement | null }; onImport: (file?: File) => void; products: Product[]; apiBase: string; token: string }) {
  const imported = products.filter((product) => product.source === 'shopbase')
  type SyncProgress = { status: string; phase?: string; error?: string; startedAt?: string; updatedAt?: string; finishedAt?: string; requestedAt?: string; categoriesProcessed?: number; totalCategories?: number; productsDiscovered?: number; productsProcessed?: number; totalProducts?: number; created?: number; changed?: number; unchanged?: number; skippedDetails?: number; progressPercent?: number; workflowStatus?: string; workflowRunId?: number; workflowUrl?: string }
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressError, setProgressError] = useState('')
  const [intervalHours, setIntervalHours] = useState(24)
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleMessage, setScheduleMessage] = useState('')
  useEffect(() => {
    if (!apiBase || !token) return
    fetch(apiBase + '/api/admin/sync/schedule', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail || 'Could not load the saved sync interval.')
        if ([6, 12, 24, 48].includes(result.intervalHours)) setIntervalHours(result.intervalHours)
      })
      .catch((error) => setScheduleMessage(error instanceof Error ? error.message : 'Could not load the saved sync interval.'))
  }, [apiBase, token])
  const saveSchedule = async () => {
    if (!apiBase || !token) { setScheduleMessage('Saving the schedule needs an active admin session and catalog API.'); return }
    setScheduleSaving(true)
    setScheduleMessage('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ intervalHours }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'The sync interval could not be saved.')
      setIntervalHours(result.intervalHours)
      setScheduleMessage('Saved. Automatic sync checks use this interval from 12:00 a.m. Bangladesh time.')
    } catch (error) {
      setScheduleMessage(error instanceof Error ? error.message : 'The sync interval could not be saved.')
    } finally { setScheduleSaving(false) }
  }
  const refreshProgress = async () => {
    if (!apiBase || !token) { setProgressError('Sync progress needs an active admin session and catalog API.'); return }
    setProgressLoading(true)
    setProgressError('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/progress', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not load sync progress.')
      setSyncProgress(result)
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : 'Could not load sync progress.')
    } finally { setProgressLoading(false) }
  }
  const startSyncNow = async () => {
    if (!apiBase || !token) { setProgressError('Sync Now needs an active admin session and catalog API.'); return }
    setProgressLoading(true)
    setProgressError('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ refresh_details: true }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not start catalog sync.')
      setSyncProgress({ status: 'running', phase: 'queued', progressPercent: 0, workflowStatus: result.status || 'queued', workflowRunId: result.workflowRunId, workflowUrl: result.workflowUrl, requestedAt: result.requestedAt })
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : 'Could not start catalog sync.')
    } finally { setProgressLoading(false) }
  }
  const saveShopBaseCookie = async () => {
    if (!apiBase || !token) { setProgressError('Saving the cookie needs an active admin session and catalog API.'); return }
    const cookie = window.prompt('Paste the cookie copied by the local ShopBase cookie tool. It will be encrypted and saved to GitHub Actions.')
    if (!cookie) return
    setProgressLoading(true); setProgressError('')
    try {
      const response = await fetch(apiBase + '/api/admin/sync/cookie', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ cookie }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not save the cookie.')
      setProgressError(result.message || 'ShopBase cookie saved securely.')
    } catch (error) { setProgressError(error instanceof Error ? error.message : 'Could not save the cookie.') }
    finally { setProgressLoading(false) }
  }
  useEffect(() => {
    if (syncProgress?.status !== 'running' || !apiBase || !token) return
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(apiBase + '/api/admin/sync/progress', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
        if (response.ok) setSyncProgress(await response.json())
      } catch { /* Keep the last reported progress visible during temporary network interruptions. */ }
    }, 5000)
    return () => window.clearInterval(poll)
  }, [syncProgress?.status, apiBase, token])
  const progress = syncProgress
  const totalProducts = progress?.totalProducts || 0
  const progressPercent = progress?.progressPercent ?? (progress?.status === 'success' || progress?.status === 'success_with_skipped_details' ? 100
    : progress?.phase === 'updating_products' && totalProducts > 0 ? 15 + Math.round(((progress.productsProcessed || 0) / totalProducts) * 85)
    : progress?.totalCategories ? Math.round(((progress.categoriesProcessed || 0) / progress.totalCategories) * 15) : 0)
  const phaseLabel = progress?.status === 'running' ? ({
    queued: 'Waiting for GitHub Actions to start',
    starting: 'Starting the catalog importer',
    connecting: 'Connecting to the catalog',
    reading_categories: 'Reading categories',
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
      <div className="sync-schedule-settings"><label htmlFor="catalog-sync-interval">Automatic sync interval<select id="catalog-sync-interval" value={intervalHours} onChange={(event) => { setIntervalHours(Number(event.target.value)); setScheduleMessage('') }}><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Every 24 hours</option><option value={48}>Every 48 hours</option></select></label><button type="button" className="secondary-button" onClick={saveSchedule} disabled={scheduleSaving}>{scheduleSaving ? 'Saving…' : 'Save changes'}</button>{scheduleMessage && <p className="sync-schedule-message" role="status">{scheduleMessage}</p>}</div>
      <div className="sync-status-box">
        <div className="sync-status-icon"><Clock3 size={19} /></div>
        <span><b>{imported.length ? imported.length.toLocaleString() + ' imported products' : 'ShopBase catalog not synced'}</b><small>{lastSync ? 'Last catalog update ' + dateLabel(lastSync) : imported.length ? 'Products are available from your connected catalog API.' : 'Add the ShopBase session cookie to GitHub Actions secrets to enable the scheduled job.'}</small></span>
        <span className={'status-pill ' + (imported.length ? 'status-green' : 'status-amber')}><i />{imported.length ? 'Connected' : 'Needs sync'}</span>
      </div>
      <div className="sync-actions"><button className="secondary-button" onClick={saveShopBaseCookie} disabled={progressLoading}>Sync cookie</button><button className="primary-button sync-now-button" onClick={startSyncNow} disabled={progressLoading || progress?.status === 'running'}><RotateCcw size={17} /> {progress?.status === 'running' ? 'Sync running…' : progressLoading ? 'Starting…' : 'Sync Now'}</button><button className="secondary-button" onClick={() => fileRef.current?.click()}><Upload size={17} /> Import supplier CSV</button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => onImport(event.target.files?.[0])} /><button className="secondary-button" onClick={() => fileRef.current?.click()}><Download size={16} /> Select CSV file</button><button className="secondary-button" onClick={refreshProgress} disabled={progressLoading}><RotateCcw size={16} /> {progressLoading ? 'Checking progress…' : 'View sync progress'}</button></div>
      {progressError && <div className="import-result sync-progress-error">{progressError}</div>}
      {progress && <div className="sync-progress-card" aria-live="polite">
        <div className="sync-progress-heading"><b>{phaseLabel}</b><span>{progress.status === 'running' ? progressPercent + '% · ' + (progress.workflowStatus || 'Live') : progress.status.replace(/_/g, ' ')}</span></div>
        <div className="sync-progress-track"><i style={{ transform: `scaleX(${Math.max(0, Math.min(100, progressPercent)) / 100})` }} /></div>
        {progress.workflowUrl && <p><a href={progress.workflowUrl} target="_blank" rel="noreferrer">Open GitHub Actions run</a></p>}
        {progress.totalCategories ? <p>Categories: {(progress.categoriesProcessed || 0).toLocaleString()} / {progress.totalCategories.toLocaleString()}</p> : null}
        {progress.totalProducts ? <p>Products: {(progress.productsProcessed || 0).toLocaleString()} / {progress.totalProducts.toLocaleString()} processed{progress.productsDiscovered ? ' · ' + progress.productsDiscovered.toLocaleString() + ' found' : ''}</p> : null}
        {(progress.totalProducts || 0) > 0 && <p>New: {progress.created || 0} · Updated: {progress.changed || 0} · Unchanged: {progress.unchanged || 0} · Detail issues: {progress.skippedDetails || 0}</p>}
        {progress.error && <p className="sync-progress-error">{progress.error}</p>}
        {progress.updatedAt && <small>Last update: {new Date(progress.updatedAt).toLocaleString()}</small>}
      </div>}
      {importNote && <div className="import-result"><CheckCircle2 size={16} />{importNote}</div>}
      <div className="sync-note"><ShieldCheck size={17} /><span><b>Automatic sync every {intervalHours} hours</b><small>The schedule is saved in the catalog database. GitHub’s hosted runner runs without your PC being on.</small></span></div>
    </section>
    <section className="panel sync-side-panel">
      <div className="panel-heading"><div><h3>How updates work</h3><p>Every {intervalHours} hours · from midnight Bangladesh time</p></div></div>
      <div className="sync-flow"><div><i>01</i><span><b>Read the reseller catalog</b><small>Use the ShopBase session secret on the server, never in browser code.</small></span></div><div><i>02</i><span><b>Update changed products</b><small>Match by the ShopBase product ID and preserve AARO edits and image overrides.</small></span></div><div><i>03</i><span><b>Recheck at checkout</b><small>Verify the selected product’s latest price and availability before accepting the order.</small></span></div><div><i>04</i><span><b>Review orders</b><small>Confirm with your customer, then submit the order in the ShopBase app until order API access exists.</small></span></div></div>
      <div className="csv-format"><b>CSV columns supported</b><code>id, title, category, price, compare_at, image, description, stock</code></div>
    </section>
  </div>
}
