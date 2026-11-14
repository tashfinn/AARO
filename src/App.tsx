Warning: truncated output (original token count: 28346)
Total output lines: 770

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Copy, Download, Eye,
  Filter, Heart, House, LayoutDashboard, Camera, Menu, Minus,
  Package, Pencil, Phone, Plus, RotateCcw, Search, ShieldCheck, UserRound,
  ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles, Tags, TicketPercent, Trash2,
  Truck, Upload, UsersRound, X, Moon, Sun, LogOut, Music2, ThumbsUp
} from 'lucide-react'
import { initialState } from './data'
import { manualCategoryGroups } from './data/category-groups'
import type { CategoryGroup, Coupon, Order, OrderStatus, Product, StoreState } from './types'

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
type StorePage = 'shop' | 'trending' | 'offers' | 'combos' | 'category' | 'wishlist' | 'account'
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

function productPath(product: Product) {
  const slug = product.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `/products/${slug}/${encodeURIComponent(product.id)}`
}

function productIdFromPath() {
  const parts = window.location.pathname.split('/').filter(Boolean)
  return parts[0] === 'products' && parts.length > 2 ? decodeURIComponent(parts[parts.length - 1]) : null
}

function readState(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...initialState }
    const saved = JSON.parse(raw) as Partial<StoreState>
    const content = { ...initialState.content, ...saved.content }
    if (content.deliveryInDhaka === 70 && content.deliveryOutsideDhaka === 130) {
      content.deliveryInDhaka = 60
      content.deliveryOutsideDhaka = 120
    }
    return { ...initialState, ...saved, content }
  } catch { return initialState }
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
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>(() => { try { return JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null') || manualCategoryGroups } catch { return manualCategoryGroups } })
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [activeCategoryMenuId, setActiveCategoryMenuId] = useState('')
  const [mobileMenu, setMobileMenu] = useState(false)
  const [cart, setCart] = useState<CartLine[]>(() => { try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]') as CartLine[] } catch { return [] } })
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(() => window.location.pathname === '/checkout')
  const [outsideDhaka, setOutsideDhaka] = useState(false)
  const [productRouteId, setProductRouteId] = useState<string | null>(productIdFromPath)
  const selectedProduct = useMemo(() => state.products.find((product) => product.id === productRouteId) || null, [productRouteId, state.products])
  const [wishlist, setWishlist] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]') as string[] } catch { return [] } })
  const [user, setUser] = useState<string | null>(() => localStorage.getItem(USER_KEY))
  const [accountToken, setAccountToken] = useState(() => localStorage.getItem(AUTH_TOKEN_KEY) || '')
  const [accountProfile, setAccountProfile] = useState<AccountProfile | null>(null)
  const [customerOrders, setCustomerOrders] = useState<Order[]>([])
  const [authRoute, setAuthRoute] = useState<'login' | 'register' | null>(() => window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : null)
  const [adminRoute] = useState(() => window.location.pathname === '/admin')
  const [adminToken, setAdminToken] = useState(readAdminToken)
  const [darkTheme, setDarkTheme] = useState(() => localStorage.getItem(THEME_KEY) === 'dark')
  const [toast, setToast] = useState('')
  const [admin, setAdmin] = useState(false)
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
  const [lastSync, setLastSync] = useState(localStorage.getItem('aaro-last-import') || '')
  const [catalogLoading, setCatalogLoading] = useState(Boolean(import.meta.env.PROD || import.meta.env.VITE_API_URL))
  const [catalogError, setCatalogError] = useState(false)
  const [importNote, setImportNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
  useEffect(() => { localStorage.setItem(THEME_KEY, darkTheme ? 'dark' : 'light') }, [darkTheme])
  useEffect(() => { localStorage.setItem(CATEGORY_GROUPS_KEY, JSON.stringify(categoryGroups)) }, [categoryGroups])
  useEffect(() => {
    const syncRoute = () => {
      setAuthRoute(window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : null)
      setProductRouteId(productIdFromPath())
      setCheckout(window.location.pathname === '/checkout')
      if (window.location.pathname === '/account') setPage('account')
      else if (window.location.pathname !== '/admin' && !productIdFromPath() && window.location.pathname !== '/checkout') setPage('shop')
    }
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])
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
    Promise.all([fetch(`${API_BASE}/api/admin/coupons`, { headers }), fetch(`${API_BASE}/api/admin/orders`, { headers })])
      .then(async ([couponsResponse, ordersResponse]) => { if (!couponsResponse.ok || !ordersResponse.ok) throw new Error('Admin session expired.'); const [coupons, orders] = await Promise.all([couponsResponse.json(), ordersResponse.json()]) as [Coupon[], Order[]]; setState((current) => ({ ...current, coupons, orders })); setAdmin(true) })
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
        return response.json() as Promise<{ products: Product[]; categories: string[]; categoryGroups?: CategoryGroup[]; lastSync?: string }>
      })
      .then((catalog) => {
        if (cancelled) return
        const savedGroups = JSON.parse(localStorage.getItem(CATEGORY_GROUPS_KEY) || 'null') as CategoryGroup[] | null
        setCategoryGroups(mergeCategoryGroups(savedGroups || [], catalog.categoryGroups || []))
        setState((current) => {
          const synced = catalog.products.map((product) => ({ ...product, source: 'shopbase' as const }))
          const manual = current.products.filter((product) => product.source === 'custom')
          const customCategories = current.categories.filter((item) => item !== 'All' && !initialState.categories.includes(item))
          return { ...current, products: [...manual, ...synced], categories: [...new Set(['All', ...catalog.categories, ...customCategories])] }
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
    if (page === 'trending') products = products.filter((product) => state.content.trendingIds.includes(product.id) || product.trending)
    if (page === 'offers') {
      const featured = products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
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
    return products
  }, [activeProducts, category, categoryGroups, maxPrice, minPrice, page, priceSort, selectedCategorySourceId, selectedParentCategoryId, submittedQuery, state.content.offerIds, state.content.trendingIds, wishlist])
  const searchSuggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? activeProducts.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle)).slice(0, 5) : []
  }, [activeProducts, query])
  const cartItems = useMemo(() => cart.map((line) => ({ ...line, product: state.products.find((item) => item.id === line.productId) })).filter((line): line is CartLine & { product: Product } => Boolean(line.product)), [cart, state.products])
  const subtotal = cartItems.reduce((sum, line) => sum + line.product.price * line.quantity, 0)
  const deliveryFee = outsideDhaka ? state.content.deliveryOutsideDhaka : state.content.deliveryInDhaka
  const discount = coupon && coupon.active && subtotal >= (coupon.minimum || 0) ? Math.min(subtotal, coupon.kind === 'percent' ? subtotal * coupon.value / 100 : coupon.value) : 0
  const total = subtotal + deliveryFee - discount
  const revenue = state.orders.filter((order) => !['Cancelled', 'Pending confirmation'].includes(order.status)).reduce((sum, order) => sum + order.total, 0)
  const customerCount = new Set(state.orders.map((order) => order.customer.phone)).size

  function notify(message: string) { setToast(message) }
  function updateState(updater: (current: StoreState) => StoreState) { setState((current) => updater(current)) }
  function showStore(pageToShow: StorePage, nextCategory = 'All', sourceCategoryId = '', parentCategoryId = '') {
    setAdmin(false); setAuthRoute(null); setCheckout(false); setActiveCategoryMenuId(''); setPage(pageToShow); setCategory(nextCategory); setSelectedCategorySourceId(sourceCategoryId); setSelectedParentCategoryId(parentCategoryId); setQuery(''); setSubmittedQuery(''); setProductRouteId(null); setCategoryMenuOpen(false); setMobileMenu(false); history.replaceState({}, '', '/'); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function showAuth(mode: 'login' | 'register') {
    setAuthRoute(mode); setAdmin(false); setMobileMenu(false); setProductRouteId(null); setCheckout(false)
    history.pushState({}, '', `/${mode}`); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function showAccount() {
    setAdmin(false); setAuthRoute(null); setCheckout(false); setProductRouteId(null); setPage('account');
 …18346 tokens truncated…alse },
    { title: 'Customers', value: String(customerCount), note: 'Customer order records', icon: UsersRound, trend: 'Live', up: false },
    { title: 'Store views', value: state.views.toLocaleString(), note: 'Storefront activity', icon: Eye, trend: 'Live', up: false }
  ]
  const bars = [42, 64, 51, 74, 57, 88, 68, 96, 77, 62, 84, 100]
  return <><div className="admin-welcome"><div><span className="section-kicker">SATURDAY, 14 NOVEMBER</span><h2>Your store, at a glance.</h2><p>Here’s what’s happening with AARO today.</p></div><button className="primary-button" onClick={() => onTab('products')}><Plus size={17} /> Add a product</button></div><div className="stat-grid">{stats.map(({ title, value, note, icon: Icon, trend, up }) => <div className="stat-card" key={title}><div className="stat-card-top"><span>{title}</span><i><Icon size={18} /></i></div><strong>{value}</strong><div className="stat-card-bottom"><span>{note}</span><b className={up ? 'trend-up' : 'trend-neutral'}>{up ? <ArrowUpRight size={14} /> : null}{trend}</b></div></div>)}</div><div className="overview-grid"><section className="panel revenue-panel"><div className="panel-heading"><div><h3>Revenue overview</h3><p>Monthly sales performance</p></div><button className="select-chip">Last 30 days <ChevronDown size={14} /></button></div><div className="revenue-total"><strong>{money(revenue)}</strong><span><ArrowUpRight size={14} /> 12.8%</span><small>vs. previous period</small></div><div className="chart-area"><div className="chart-y"><span>৳8k</span><span>৳6k</span><span>৳4k</span><span>৳2k</span><span>৳0</span></div><div className="chart-bars">{bars.map((height, index) => <div className="chart-column" key={index}><i style={{ height: `${height}%` }} /><span>{['Oct 16', 'Oct 20', 'Oct 24', 'Oct 28', 'Nov 01', 'Nov 05', 'Nov 09', 'Nov 14'][Math.floor(index * 8 / bars.length)]}</span></div>)}</div></div><div className="chart-legend"><span><i /> Sales</span><span>Confirmed and delivered orders</span></div></section><section className="panel attention-panel"><div className="panel-heading"><div><h3>Needs your attention</h3><p>Keep orders moving smoothly</p></div></div><div className="attention-item"><span className="attention-icon amber-icon"><Clock3 size={18} /></span><div><b>{state.orders.filter((order) => order.status === 'Pending confirmation').length} orders to confirm</b><small>Call customers before sending to ShopBase</small></div><button onClick={() => onTab('orders')}><ArrowRight size={16} /></button></div><div className="attention-item"><span className="attention-icon teal-icon"><Package size={18} /></span><div><b>{liveCatalogCount.toLocaleString()} live catalog products</b><small>{liveCatalogCount ? 'Imported from your ShopBase catalog' : 'Run the catalog sync to load products'}</small></div><button onClick={() => onTab('products')}><ArrowRight size={16} /></button></div><div className="attention-foot"><ShieldCheck size={15} /> Orders stay in your review queue until confirmed.</div></section></div><section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent orders</h3><p>The latest customer activity</p></div><button className="text-link" onClick={() => onTab('orders')}>View all orders <ArrowRight size={15} /></button></div><OrderTable orders={orders.slice(0, 5)} onStatus={updateOrderStatus} compact /></section></>
}

function AdminProducts({ state, onAdd, onEdit, onDelete }: { state: StoreState; onAdd: () => void; onEdit: (product: Product) => void; onDelete: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(50)
  useEffect(() => setVisibleCount(50), [search])
  const products = state.products.filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(search.toLowerCase()))
  return <section className="panel"><div className="panel-heading panel-heading-wrap"><div><h2>Product catalog</h2><p>Edit product details, pricing, images, availability, and collections.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} /> Add product</button></div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products..." /></div><button className="select-chip"><Filter size={14} /> All products <ChevronDown size={14} /></button><span>{products.length.toLocaleString()} products</span></div><div className="responsive-table"><table className="data-table product-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Visibility</th><th>Source</th><th /></tr></thead><tbody>{products.slice(0, visibleCount).map((product) => <tr key={product.id}><td><div className="table-product"><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>SKU / {product.sourceId || product.id.slice(0, 10)}</small></span></div></td><td>{product.category}</td><td><b>{money(product.price)}</b>{product.compareAt && <small className="old-price">{money(product.compareAt)}</small>}</td><td><span className={product.stock < 10 ? 'stock-low' : 'stock-good'}><i /> {product.stock > 0 ? 'Available' : 'Unavailable'}</span></td><td><span className={`visibility ${product.active ? 'visible' : ''}`}><i /> {product.active ? 'Active' : 'Hidden'}</span></td><td><span className="source-tag">{product.source === 'shopbase' ? 'ShopBase import' : 'Manual'}</span></td><td><div className="row-actions"><button onClick={() => onEdit(product)} aria-label={`Edit ${product.title}`}><Pencil size={16} /></button><button onClick={() => onDelete(product.id)} aria-label={`Delete ${product.title}`}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>{products.length > visibleCount && <button className="load-more-button" onClick={() => setVisibleCount((count) => Math.min(count + 50, products.length))}>Load more products <span>Showing {Math.min(visibleCount, products.length).toLocaleString()} of {products.length.toLocaleString()}</span></button>}</section>
}

function AdminOffers({ state, onNew, toggleCoupon, deleteCoupon, onEdit, updateState, notify }: { state: StoreState; onNew: () => void; toggleCoupon: (code: string) => void; deleteCoupon: (code: string) => void; onEdit: (product: Product) => void; updateState: (updater: (current: StoreState) => StoreState) => void; notify: (message: string) => void }) {
  const offerProducts = state.products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
  return <><div className="panel offers-feature"><div><span className="section-kicker">CURRENT OFFER EDIT</span><h2>Offers customers can see.</h2><p>Choose which products appear in the offer section and create checkout coupon codes.</p><button className="primary-button" onClick={onNew}><Plus size={17} /> Create coupon</button></div><div className="offer-feature-art"><span>THE GOOD<br />DEAL EDIT</span><b>For a little<br />less.</b><i>✳</i></div></div><section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Featured offer products</h3><p>Products tagged for the storefront offer section</p></div></div>{offerProducts.length ? <div className="offer-product-list">{offerProducts.map((product) => <div className="offer-product-row" key={product.id}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{product.category} · {money(product.price)}{product.compareAt ? ` / ${money(product.compareAt)}` : ''}</small></span><button onClick={() => onEdit(product)}>Edit price</button><button onClick={() => { updateState((current) => ({ ...current, content: { ...current.content, offerIds: current.content.offerIds.filter((id) => id !== product.id) }, products: current.products.map((item) => item.id === product.id ? { ...item, offer: false } : item) })); notify('Removed from offer edit') }}>Remove</button></div>)}</div> : <p className="empty-row">No featured offers yet. Edit products and mark them as offers.</p>}</section><section className="panel coupon-admin-panel"><div className="panel-heading"><div><h3>Coupon codes</h3><p>Discounts are checked against the bag subtotal.</p></div><button className="subtle-icon" onClick={onNew} aria-label="Add coupon"><Plus size={17} /></button></div><div className="coupon-admin-grid">{state.coupons.map((coupon) => <div className={`coupon-card ${coupon.active ? '' : 'inactive'}`} key={coupon.code}><div className="coupon-card-top"><span><TicketPercent size={16} /> DISCOUNT CODE</span><button onClick={() => toggleCoupon(coupon.code)}>{coupon.active ? 'Active' : 'Paused'} <ChevronDown size={13} /></button></div><strong>{coupon.code}</strong><p>{coupon.kind === 'percent' ? `${coupon.value}% off` : `${money(coupon.value)} off`} {coupon.minimum ? `on orders over ${money(coupon.minimum)}` : ''}</p><div className="coupon-card-actions"><button className="copy-code" onClick={() => { navigator.clipboard?.writeText(coupon.code); notify(`${coupon.code} copied`) }}><Copy size={14} /> Copy code</button><button className="delete-coupon" onClick={() => deleteCoupon(coupon.code)} aria-label={`Delete coupon ${coupon.code}`}><Trash2 size={15} /> Delete</button></div></div>)}</div>{!state.coupons.length && <p className="empty-row">Create your first coupon code.</p>}</section></>
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

function CouponEditor({ onClose, onSave }: { onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><div className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CHECKOUT</span><h2>Create coupon</h2></div><IconButton label="Close coupon form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={onSave}><label>Coupon code<input name="code" required minLength={3} placeholder="e.g. AARO15" /></label><div className="settings-two"><label>Discount type<select name="kind"><option value="percent">Percentage</option><option value="amount">Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" required /></label></div><label>Minimum order (৳), optional<input name="minimum" type="number" min="0" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save coupon</button></div></form></div></div>
}

function SyncPanel({ lastSync, importNote, fileRef, onImport, products }: { lastSync: string; importNote: string; fileRef: { current: HTMLInputElement | null }; onImport: (file?: File) => void; products: Product[] }) {
  const imported = products.filter((product) => product.source === 'shopbase')
  return <div className="sync-layout">
    <section className="panel sync-hero-panel">
      <div className="sync-symbol"><RotateCcw size={24} /></div>
      <span className="section-kicker">CATALOG / SHOPBASE BD</span>
      <h2>Your catalog, all in one place.</h2>
      <p>Supplier updates belong in your catalog first. A scheduled GitHub Actions workflow refreshes your stored catalog every 24 hours.</p>
      <div className="sync-status-box">
        <div className="sync-status-icon"><Clock3 size={19} /></div>
        <span><b>{imported.length ? `${imported.length.toLocaleString()} imported products` : 'ShopBase catalog not synced'}</b><small>{lastSync ? `Last catalog update ${dateLabel(lastSync)}` : imported.length ? 'Products are available from your connected catalog API.' : 'Add the ShopBase session cookie to GitHub Actions secrets to enable the daily job.'}</small></span>
        <span className={`status-pill ${imported.length ? 'status-green' : 'status-amber'}`}><i />{imported.length ? 'Connected' : 'Needs sync'}</span>
      </div>
      <div className="sync-actions"><button className="primary-button" onClick={() => fileRef.current?.click()}><Upload size={17} /> Import supplier CSV</button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => onImport(event.target.files?.[0])} /><button className="secondary-button" onClick={() => fileRef.current?.click()}><Download size={16} /> Select CSV file</button></div>
      {importNote && <div className="import-result"><CheckCircle2 size={16} />{importNote}</div>}
      <div className="sync-note"><ShieldCheck size={17} /><span><b>Daily catalog sync is configured</b><small>The scheduled workflow reads the ShopBase session cookie from GitHub secrets. Keep it out of storefront code.</small></span></div>
    </section>
    <section className="panel sync-side-panel">
      <div className="panel-heading"><div><h3>How updates work</h3><p>Daily catalog schedule</p></div></div>
      <div className="sync-flow"><div><i>01</i><span><b>Read the reseller catalog</b><small>Use the ShopBase session secret on the server, never in browser code.</small></span></div><div><i>02</i><span><b>Update changed products</b><small>Match by the ShopBase product ID and preserve AARO edits and image overrides.</small></span></div><div><i>03</i><span><b>Recheck at checkout</b><small>Verify the selected product’s latest price and availability before accepting the order.</small></span></div><div><i>04</i><span><b>Review orders</b><small>Confirm with your customer, then submit the order in the ShopBase app until order API access exists.</small></span></div></div>
      <div className="csv-format"><b>CSV columns supported</b><code>id, title, category, price, compare_at, image, description, stock</code></div>
    </section>
  </div>
}

