import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, Copy, Download, Eye,
  Filter, Heart, House, LayoutDashboard, LogIn, Mail, Menu, Minus,
  MoreHorizontal, Package, Pencil, Phone, Plus, RotateCcw, Search, ShieldCheck,
  ShoppingBag, ShoppingCart, SlidersHorizontal, Sparkles, Tags, TicketPercent, Trash2,
  Truck, Upload, UsersRound, X
} from 'lucide-react'
import { initialState } from './data'
import type { Coupon, Order, OrderStatus, Product, StoreState } from './types'

const STORAGE_KEY = 'aaro-demo-store-v1'
const WISHLIST_KEY = 'aaro-demo-wishlist-v1'
const USER_KEY = 'aaro-demo-user-v1'
type StorePage = 'shop' | 'trending' | 'offers' | 'combos' | 'category' | 'wishlist'
type AdminTab = 'overview' | 'products' | 'categories' | 'offers' | 'orders' | 'content' | 'sync'
type CartLine = { productId: string; quantity: number }

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
    if (!raw) return {
      ...initialState,
      orders: initialState.orders.map((order, index) => ({
        ...order,
        id: `DEMO-${index + 1}`,
        customer: { ...order.customer, name: `Demo customer ${index + 1}`, phone: 'Demo only', area: 'Sample area', address: 'Sample address' }
      }))
    }
    const saved = JSON.parse(raw) as Partial<StoreState>
    return { ...initialState, ...saved, content: { ...initialState.content, ...saved.content } }
  } catch { return initialState }
}

function money(amount: number) { return `৳${Math.max(0, Math.round(amount)).toLocaleString('en-BD')}` }
function dateLabel(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) }
function shortDate(value: string) { return new Intl.DateTimeFormat('en-BD', { day: 'numeric', month: 'short' }).format(new Date(value)) }

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
  const [state, setState] = useState<StoreState>(readState)
  const [page, setPage] = useState<StorePage>('shop')
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [cart, setCart] = useState<CartLine[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [productRouteId, setProductRouteId] = useState<string | null>(productIdFromPath)
  const selectedProduct = useMemo(() => state.products.find((product) => product.id === productRouteId) || null, [productRouteId, state.products])
  const [wishlist, setWishlist] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(WISHLIST_KEY) || '[]') as string[] } catch { return [] } })
  const [user, setUser] = useState<string | null>(() => localStorage.getItem(USER_KEY))
  const [loginOpen, setLoginOpen] = useState(false)
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
  const [importNote, setImportNote] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const localState = { ...state, products: state.products.filter((product) => product.source !== 'shopbase') }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localState))
  }, [state])
  useEffect(() => { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)) }, [wishlist])
  useEffect(() => {
    const syncRoute = () => setProductRouteId(productIdFromPath())
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])
  useEffect(() => {
    const next = readState()
    next.views += 1
    setState(next)
  }, [])
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL?.replace(/\/$/, '')
    if (!apiUrl) return
    let cancelled = false
    fetch(`${apiUrl}/api/catalog`)
      .then((response) => {
        if (!response.ok) throw new Error(`Catalog API returned ${response.status}`)
        return response.json() as Promise<{ products: Product[]; categories: string[]; lastSync?: string }>
      })
      .then((catalog) => {
        if (cancelled) return
        setState((current) => {
          const synced = catalog.products.map((product) => ({ ...product, source: 'shopbase' as const }))
          const manual = current.products.filter((product) => product.source !== 'shopbase' && product.source !== 'demo')
          const customCategories = current.categories.filter((item) => item !== 'All' && !initialState.categories.includes(item))
          return { ...current, products: [...manual, ...synced], categories: [...new Set(['All', ...catalog.categories, ...customCategories])] }
        })
        if (catalog.lastSync) setLastSync(catalog.lastSync)
      })
      .catch((error) => console.warn('AARO catalog API unavailable; showing the saved preview catalog.', error))
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
    let products = activeProducts
    if (page === 'trending') products = products.filter((product) => state.content.trendingIds.includes(product.id) || product.trending)
    if (page === 'offers') products = products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
    if (page === 'wishlist') products = products.filter((product) => wishlist.includes(product.id))
    if (page === 'category' && category !== 'All') products = products.filter((product) => product.category === category)
    if (needle) products = products.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle))
    if (page === 'category') {
      products = products.filter((product) => product.price >= minPrice && product.price <= maxPrice)
      if (priceSort === 'low-high') products = [...products].sort((a, b) => a.price - b.price)
      if (priceSort === 'high-low') products = [...products].sort((a, b) => b.price - a.price)
    }
    return products
  }, [activeProducts, category, maxPrice, minPrice, page, priceSort, submittedQuery, state.content.offerIds, state.content.trendingIds, wishlist])
  const searchSuggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? activeProducts.filter((product) => `${product.title} ${product.category} ${product.description}`.toLowerCase().includes(needle)).slice(0, 5) : []
  }, [activeProducts, query])
  const cartItems = useMemo(() => cart.map((line) => ({ ...line, product: state.products.find((item) => item.id === line.productId) })).filter((line): line is CartLine & { product: Product } => Boolean(line.product)), [cart, state.products])
  const subtotal = cartItems.reduce((sum, line) => sum + line.product.price * line.quantity, 0)
  const deliveryFee = state.content.deliveryInDhaka
  const discount = coupon && coupon.active && subtotal >= (coupon.minimum || 0) ? Math.min(subtotal, coupon.kind === 'percent' ? subtotal * coupon.value / 100 : coupon.value) : 0
  const total = subtotal + deliveryFee - discount
  const revenue = state.orders.filter((order) => !['Cancelled', 'Pending confirmation'].includes(order.status)).reduce((sum, order) => sum + order.total, 0)
  const customerCount = new Set(state.orders.map((order) => order.customer.phone)).size

  function notify(message: string) { setToast(message) }
  function updateState(updater: (current: StoreState) => StoreState) { setState((current) => updater(current)) }
  function showStore(pageToShow: StorePage, nextCategory = 'All') {
    setAdmin(false); setPage(pageToShow); setCategory(nextCategory); setQuery(''); setSubmittedQuery(''); setProductRouteId(null); setCategoryMenuOpen(false); setMobileMenu(false); history.replaceState({}, '', '/'); window.scrollTo({ top: 0, behavior: 'smooth' })
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
  function addToCart(product: Product, quantity = 1) {
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id)
      return existing ? current.map((line) => line.productId === product.id ? { ...line, quantity: line.quantity + quantity } : line) : [...current, { productId: product.id, quantity }]
    })
    setCartOpen(true); setCheckout(false); notify(`${product.title} added to your bag`)
  }
  function setQuantity(productId: string, quantity: number) {
    setCart((current) => quantity <= 0 ? current.filter((line) => line.productId !== productId) : current.map((line) => line.productId === productId ? { ...line, quantity } : line))
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
  function placeOrder(event: FormEvent<HTMLFormElement>) {
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
      items: cartItems.map((line) => ({ productId: line.productId, title: line.product.title, image: line.product.image, price: line.product.price, quantity: line.quantity })),
      subtotal, delivery: fee, discount, total: Math.max(0, subtotal + fee - discount), coupon: coupon?.code, status: 'Pending confirmation'
    }
    updateState((current) => ({ ...current, orders: [newOrder, ...current.orders] }))
    setCart([]); setCoupon(null); setCouponInput(''); setCheckout(false); setCartOpen(false); notify(`Preview order ${newOrder.id} saved in this browser.`)
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
      source: editingProduct?.source || 'demo', sourceId: editingProduct?.sourceId, updatedAt: new Date().toISOString()
    }
    updateState((current) => ({ ...current, products: editingProduct ? current.products.map((item) => item.id === product.id ? product : item) : [product, ...current.products] }))
    setProductFormOpen(false); setEditingProduct(null); notify(editingProduct ? 'Product updated' : 'Product added')
  }
  function deleteProduct(productId: string) {
    updateState((current) => ({ ...current, products: current.products.filter((item) => item.id !== productId), content: { ...current.content, trendingIds: current.content.trendingIds.filter((id) => id !== productId), offerIds: current.content.offerIds.filter((id) => id !== productId) } }))
    notify('Product removed from your catalog')
  }
  function updateOrderStatus(orderId: string, status: OrderStatus) {
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
  function saveCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    const nextCoupon: Coupon = { code: String(form.get('code')).trim().toUpperCase(), kind: form.get('kind') === 'amount' ? 'amount' : 'percent', value: Number(form.get('value')), minimum: Number(form.get('minimum')) || undefined, active: true }
    updateState((current) => ({ ...current, coupons: [...current.coupons.filter((item) => item.code !== nextCoupon.code), nextCoupon] })); setCouponFormOpen(false); notify('Coupon saved')
  }
  function toggleCoupon(code: string) { updateState((current) => ({ ...current, coupons: current.coupons.map((item) => item.code === code ? { ...item, active: !item.active } : item) })) }
  function saveContent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const combos = state.content.combos.map((combo, index) => ({ ...combo, title: String(form.get(`comboTitle${index}`) || combo.title), subtitle: String(form.get(`comboSubtitle${index}`) || combo.subtitle), image: String(form.get(`comboImage${index}`) || combo.image), price: Number(form.get(`comboPrice${index}`) || combo.price) }))
    updateState((current) => ({ ...current, content: { ...current.content, heroTitle: String(form.get('heroTitle')), heroSubtitle: String(form.get('heroSubtitle')), heroImage: String(form.get('heroImage')), heroCta: String(form.get('heroCta')), offerTitle: String(form.get('offerTitle')), offerSubtitle: String(form.get('offerSubtitle')), offerImage: String(form.get('offerImage')), announcement: String(form.get('announcement')), combos, deliveryInDhaka: Number(form.get('deliveryInDhaka')), deliveryOutsideDhaka: Number(form.get('deliveryOutsideDhaka')) } }))
    notify('Storefront content saved')
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
  const formatPageTitle = page === 'trending' ? 'Trending now' : page === 'offers' ? 'Offers for you' : page === 'category' ? category === 'All' ? 'All products' : category : page === 'wishlist' ? 'Your wishlist' : 'The AARO edit'

  return <>
    {admin ? <div className="admin-shell">
      <aside className={`admin-sidebar ${mobileMenu ? 'admin-sidebar-open' : ''}`}>
        <div className="admin-brand"><span className="brand-mark">A</span><span>AARO <small>STUDIO</small></span><IconButton label="Close menu" className="mobile-only" onClick={() => setMobileMenu(false)}><X size={18} /></IconButton></div>
        <div className="admin-store-pill"><span className="store-live-dot" />Preview mode <ChevronDown size={15} /></div>
        <p className="sidebar-caption">WORKSPACE</p>
        <nav className="admin-nav">{navItems.map(({ label, icon: Icon, tab }) => <button key={tab} className={adminTab === tab ? 'active' : ''} onClick={() => { setAdminTab(tab); setMobileMenu(false) }}><Icon size={18} /><span>{label}</span>{tab === 'orders' && state.orders.filter((order) => order.status === 'Pending confirmation').length > 0 && <b>{state.orders.filter((order) => order.status === 'Pending confirmation').length}</b>}</button>)}</nav>
        <div className="sidebar-bottom"><div className="admin-profile"><div className="avatar">A</div><div><strong>Store admin</strong><small>AARO Bangladesh</small></div><MoreHorizontal size={18} /></div><button className="back-store" onClick={() => { setAdmin(false); window.scrollTo(0, 0) }}><House size={17} /> View storefront <ArrowUpRight size={15} /></button></div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar"><button className="mobile-menu-trigger" onClick={() => setMobileMenu(true)}><Menu size={20} /></button><div><p className="eyebrow">AARO STUDIO <span>/</span> {navItems.find((item) => item.tab === adminTab)?.label.toUpperCase()}</p><h1>{adminTab === 'overview' ? 'Good morning, Admin' : navItems.find((item) => item.tab === adminTab)?.label}</h1></div><div className="admin-top-actions"><span className="date-chip"><CalendarDays size={15} /> {dateLabel(new Date().toISOString())}</span><button className="admin-view-store" onClick={() => setAdmin(false)}>View store <ArrowUpRight size={15} /></button><div className="avatar avatar-small">A</div></div></header>
        <div className="admin-content">
          {adminTab === 'overview' && <AdminOverview state={state} revenue={revenue} customerCount={customerCount} onTab={setAdminTab} updateOrderStatus={updateOrderStatus} />}
          {adminTab === 'products' && <AdminProducts state={state} onAdd={() => startEditProduct()} onEdit={startEditProduct} onDelete={deleteProduct} />}
          {adminTab === 'categories' && <section className="panel"><div className="panel-heading"><div><h2>Categories</h2><p>Organize your catalog so customers can find their next favorite.</p></div></div><form className="inline-add" onSubmit={addCategory}><input value={categoryInput} onChange={(event) => setCategoryInput(event.target.value)} placeholder="Add a category, e.g. Travel" /><button className="primary-button"><Plus size={17} /> Add category</button></form><div className="category-admin-list">{state.categories.filter((item) => item !== 'All').map((item) => <div className="category-admin-card" key={item}><div className="category-initial">{item.charAt(0)}</div><div><strong>{item}</strong><small>{state.products.filter((product) => product.category === item).length} products</small></div><button className="subtle-icon danger-hover" aria-label={`Remove ${item}`} onClick={() => removeCategory(item)}><Trash2 size={17} /></button></div>)}</div></section>}
          {adminTab === 'offers' && <AdminOffers state={state} onNew={() => setCouponFormOpen(true)} toggleCoupon={toggleCoupon} updateState={updateState} notify={notify} />}
          {adminTab === 'orders' && <AdminOrders orders={state.orders} filter={orderFilter} setFilter={setOrderFilter} search={orderSearch} setSearch={setOrderSearch} onStatus={updateOrderStatus} />}
          {adminTab === 'content' && <section className="content-grid"><div className="panel content-editor"><div className="panel-heading"><div><h2>Storefront & campaigns</h2><p>Manage the homepage, promo banner, combos, and delivery estimates.</p></div><span className="saved-badge"><CheckCircle2 size={15} /> Saved to this browser</span></div><form className="settings-form" onSubmit={saveContent}><label>Announcement bar<input name="announcement" defaultValue={state.content.announcement} /></label><label>Hero headline<textarea name="heroTitle" rows={2} defaultValue={state.content.heroTitle} /></label><label>Hero supporting line<textarea name="heroSubtitle" rows={3} defaultValue={state.content.heroSubtitle} /></label><div className="settings-two"><label>Hero call to action<input name="heroCta" defaultValue={state.content.heroCta} /></label><label>Hero image URL<input name="heroImage" defaultValue={state.content.heroImage} /></label></div><h3 className="settings-subhead">Promotional banner</h3><label>Banner headline<textarea name="offerTitle" rows={2} defaultValue={state.content.offerTitle} /></label><label>Banner supporting line<textarea name="offerSubtitle" rows={2} defaultValue={state.content.offerSubtitle} /></label><label>Banner image URL<input name="offerImage" defaultValue={state.content.offerImage} /></label><h3 className="settings-subhead">Homepage combo cards</h3>{state.content.combos.map((combo, index) => <div className="combo-editor" key={`${combo.title}-${index}`}><b>Combo 0{index + 1}</b><label>Title<input name={`comboTitle${index}`} defaultValue={combo.title} /></label><div className="settings-two"><label>Subtitle<input name={`comboSubtitle${index}`} defaultValue={combo.subtitle} /></label><label>Price from (৳)<input name={`comboPrice${index}`} type="number" defaultValue={combo.price} /></label></div><label>Image URL<input name={`comboImage${index}`} defaultValue={combo.image} /></label></div>)}<h3 className="settings-subhead">Delivery estimates</h3><div className="settings-two"><label>Dhaka delivery (৳)<input name="deliveryInDhaka" type="number" defaultValue={state.content.deliveryInDhaka} /></label><label>Outside Dhaka (৳)<input name="deliveryOutsideDhaka" type="number" defaultValue={state.content.deliveryOutsideDhaka} /></label></div><p className="form-help">Demo amounts only. Confirm ShopBase’s current zone charges before publishing these rates.</p><button className="primary-button"><Check size={17} /> Save storefront</button></form></div><div className="panel preview-panel"><div className="panel-heading"><div><h3>Homepage preview</h3><p>How the edit appears to customers</p></div><button className="subtle-icon" onClick={() => setAdmin(false)} aria-label="Open storefront"><ArrowUpRight size={17} /></button></div><div className="mini-hero" style={{ backgroundImage: `linear-gradient(90deg,rgba(26,44,43,.24),rgba(26,44,43,0)),url("${state.content.heroImage}")` }}><span>AARO / THE EVERYDAY EDIT</span><b>{state.content.heroTitle.replace('\n', ' ')}</b><button onClick={() => setAdmin(false)}>{state.content.heroCta} <ArrowRight size={13} /></button></div><div className="preview-note"><ShieldCheck size={17} /> Updates become visible on the storefront in this browser.</div></div></section>}
          {adminTab === 'sync' && <SyncPanel lastSync={lastSync} importNote={importNote} fileRef={fileRef} onImport={importCsv} products={state.products} />}
        </div>
      </main>
      {mobileMenu && <button className="admin-backdrop" onClick={() => setMobileMenu(false)} aria-label="Close menu" />}
      {productFormOpen && <ProductEditor product={editingProduct} categories={state.categories.filter((item) => item !== 'All')} onClose={() => setProductFormOpen(false)} onSave={saveProduct} />}
      {couponFormOpen && <CouponEditor onClose={() => setCouponFormOpen(false)} onSave={saveCoupon} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div> : <div className="storefront">
      <div className="announcement"><Sparkles size={14} /><span>{state.content.announcement}</span><button onClick={() => showStore('offers')}>Shop offers <ArrowRight size={13} /></button></div>
      <header className="site-header">
        <div className="header-main page-width"><button className="mobile-menu-trigger storefront-menu" onClick={() => setMobileMenu(!mobileMenu)} aria-label="Open navigation"><Menu size={22} /></button><button className="wordmark" onClick={() => showStore('shop')} aria-label="AARO home">AARO<span>.</span></button>
          <div className={`desktop-nav ${mobileMenu ? 'desktop-nav-open' : ''}`}><button className={page === 'shop' ? 'nav-current' : ''} onClick={() => showStore('shop')}>Discover</button><div className={`category-nav ${categoryMenuOpen ? 'category-nav-open' : ''}`} onMouseEnter={() => setCategoryMenuOpen(true)} onMouseLeave={() => setCategoryMenuOpen(false)}><button aria-expanded={categoryMenuOpen} onClick={() => setCategoryMenuOpen((open) => !open)}>Categories <ChevronDown size={14} /></button><div className="category-dropdown">{state.categories.filter((item) => item !== 'All').map((item) => <button key={item} onClick={() => showStore('category', item)}>{item}<ArrowRight size={13} /></button>)}</div></div><button className={page === 'trending' ? 'nav-current' : ''} onClick={() => showStore('trending')}>Trending now</button><button className={page === 'offers' ? 'nav-current' : ''} onClick={() => showStore('offers')}>Offers</button><button className={page === 'combos' ? 'nav-current' : ''} onClick={() => showStore('combos')}>Combos</button></div>
          <div className="header-actions"><form className={`search-wrap ${showSearch ? 'search-focused' : ''}`} onSubmit={(event) => { event.preventDefault(); submitSearch() }}><Search size={18} /><input ref={searchRef} value={query} onFocus={() => setShowSearch(true)} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { setShowSearch(false); setQuery('') } }} placeholder="Search products, styles..." aria-label="Search products" />{query && <button type="button" onClick={() => { setQuery(''); setSubmittedQuery(''); searchRef.current?.focus() }} aria-label="Clear search"><X size={15} /></button>}</form><IconButton label="Account login" onClick={() => setLoginOpen(true)}><LogIn size={19} /></IconButton><IconButton label={`Wishlist, ${wishlist.length} saved`} onClick={() => { setPage('wishlist'); setCategory('All'); setQuery(''); setSubmittedQuery(''); setShowSearch(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Heart size={19} /><i className="action-count">{wishlist.length}</i></IconButton><IconButton label={`Shopping bag, ${cart.reduce((sum, line) => sum + line.quantity, 0)} items`} onClick={() => { setCartOpen(true); setCheckout(false) }}><ShoppingBag size={19} /><i className="action-count">{cart.reduce((sum, line) => sum + line.quantity, 0)}</i></IconButton></div>
        </div>
        {showSearch && query && <div className="search-suggestions page-width"><div><span>QUICK RESULTS</span><button onClick={submitSearch}>View all results <ArrowRight size={13} /></button></div>{searchSuggestions.map((product) => <button key={product.id} className="suggestion-item" onClick={() => openProduct(product)}><ImageView src={product.image} alt="" /><span>{product.title}<small>{product.category}</small></span><b>{money(product.price)}</b></button>)}{!searchSuggestions.length && <p className="empty-search">No products found. Try another search.</p>}</div>}
      </header>
      <main onClick={(event) => { if (showSearch && !(event.target as HTMLElement).closest('.search-wrap,.search-suggestions')) setShowSearch(false) }}>
        {selectedProduct ? <ProductPage product={selectedProduct} relatedProducts={activeProducts.filter((item) => item.category === selectedProduct.category && item.id !== selectedProduct.id).slice(0, 4)} wishlist={wishlist} wished={wishlist.includes(selectedProduct.id)} onClose={closeProduct} onWish={toggleWish} onOpen={openProduct} onSeeRelated={() => showStore('category', selectedProduct.category)} onAdd={(product, quantity) => { addToCart(product, quantity); closeProduct() }} /> : <>
        {page === 'shop' && !submittedQuery && <><section className="hero page-width"><div className="hero-copy"><span className="kicker"><i /> THE AARO EDIT <span>·</span> NO. 01</span><h1>{state.content.heroTitle.split('\n').map((line, index) => <span key={index}>{line}{index === 0 && <br />}</span>)}</h1><p>{state.content.heroSubtitle}</p><div className="hero-actions"><button className="dark-button" onClick={() => showStore('trending')}>{state.content.heroCta} <ArrowRight size={17} /></button><span><ShieldCheck size={15} /> Guest checkout · order confirmation by phone</span></div><div className="hero-points"><span><ShieldCheck size={16} /> Curated finds</span><span><Truck size={16} /> Nationwide delivery</span></div></div><div className="hero-art"><ImageView src={state.content.heroImage} alt="A curated neutral-toned fashion edit" loading="eager" /><div className="hero-label"><span>THE NEW EVERYDAY</span><b>Made for your kind of day.</b><button onClick={() => showStore('category', 'Women')}>Explore the edit <ArrowUpRight size={14} /></button></div><div className="hero-stamp"><span>MADE TO</span><b>feel like<br />you.</b><i>✳</i></div></div><div className="hero-count"><span>01</span><i /> 03</div></section>
          <section className="service-strip page-width"><div><span className="service-icon"><Truck size={19} /></span><span><b>Delivery across Bangladesh</b><small>Dhaka & beyond</small></span></div><div><span className="service-icon"><ShieldCheck size={19} /></span><span><b>Thoughtful, trusted picks</b><small>Picked with care</small></span></div><div><span className="service-icon"><RotateCcw size={19} /></span><span><b>Easy order support</b><small>We’re here to help</small></span></div><div><span className="service-icon"><CheckCircle2 size={19} /></span><span><b>Order without an account</b><small>We’ll call to confirm</small></span></div></section>
          <section className="category-section page-width"><div className="section-heading"><div><span className="section-kicker">A LITTLE BIT OF EVERYTHING</span><h2>Find your kind of good.</h2></div><button className="text-link" onClick={() => showStore('category', 'All')}>Browse all categories <ArrowRight size={16} /></button></div><div className="category-tiles">{[
            { title: 'Style, your way', cat: 'Women', image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?auto=format&fit=crop&w=900&q=82', label: 'WOMEN & MEN' },
            { title: 'Little home joys', cat: 'Home & Living', image: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=900&q=82', label: 'HOME & LIVING' },
            { title: 'Everyday extras', cat: 'Gadgets', image: 'https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85?auto=format&fit=crop&w=900&q=82', label: 'BEAUTY & MORE' }
          ].map((tile, index) => <button className={`category-tile tile-${index + 1}`} key={tile.cat} onClick={() => showStore('category', tile.cat)}><ImageView src={tile.image} alt={tile.title} /><span className="tile-overlay" /><span className="tile-copy"><small>{tile.label}</small><b>{tile.title}</b><i>Explore <ArrowRight size={15} /></i></span></button>)}</div></section>
          <ProductSection title="Trending now" kicker="THE PIECES EVERYONE'S LOVING" products={activeProducts.filter((product) => state.content.trendingIds.includes(product.id) || product.trending).slice(0, 4)} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('trending')} />
          <OfferBanner state={state} onShop={() => showStore('offers')} />
          <ProductSection title="A good deal, indeed." kicker="A LITTLE SOMETHING EXTRA" products={activeProducts.filter((product) => state.content.offerIds.includes(product.id) || product.offer).slice(0, 4)} wishlist={wishlist} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} onSeeAll={() => showStore('offers')} compact />
          <section className="combo-section page-width"><div className="section-heading"><div><span className="section-kicker">AARO, ALL TOGETHER</span><h2>Good things come in sets.</h2></div><button className="text-link" onClick={() => showStore('combos')}>See all combos <ArrowRight size={16} /></button></div><div className="combo-grid">{state.content.combos.slice(0, 3).map((combo, index) => <button className="combo-card" key={combo.title} onClick={() => showStore('combos')}><div className={`combo-photo combo-photo-${index + 1}`}><ImageView src={combo.image} alt="" /><span>THE SET EDIT</span><b>0{index + 1}</b></div><div><span>{combo.subtitle}</span><strong>{combo.title}</strong><small>From {money(combo.price)} <ArrowRight size={14} /></small></div></button>)}</div></section>
          <section className="newsletter page-width"><div className="newsletter-mark">A</div><div><span className="section-kicker">A NOTE FROM AARO</span><h2>Good things, occasionally.</h2><p>New finds, thoughtful edits, and a little something for your inbox.</p></div><form onSubmit={(event) => { event.preventDefault(); notify('You’re on the list. Watch your inbox!'); (event.currentTarget as HTMLFormElement).reset() }}><Mail size={17} /><input type="email" placeholder="Your email address" required /><button type="submit">Count me in <ArrowRight size={15} /></button></form></section></>}
        {(page !== 'shop' && page !== 'combos') || submittedQuery ? <section className="listing-page page-width">
          <div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>{submittedQuery ? 'Search results' : page === 'category' ? category : formatPageTitle}</span></div>
          <div className="listing-heading"><div><span className="section-kicker">THE AARO EDIT / {visibleProducts.length} FINDS</span><h1>{submittedQuery ? `Results for “${submittedQuery}”` : formatPageTitle}</h1><p>{page === 'offers' ? 'Little extras to make a good find feel even better.' : page === 'trending' ? 'The pieces customers keep coming back for.' : page === 'wishlist' ? 'All the things you have saved for later.' : 'Good things, picked with your everyday in mind.'}</p></div>{page === 'category' && <button className="filter-button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={16} /> Filters <ChevronDown size={14} /></button>}</div>
          <div className="filter-chips">{state.categories.filter((item) => item !== 'All').map((item) => <button className={category === item ? 'selected' : ''} key={item} onClick={() => { setPage('category'); setCategory(item); setSubmittedQuery('') }}>{item}</button>)}</div>
          {page === 'category' && filtersOpen && <div className="catalog-filters"><label className="sort-control">Sort by<select value={priceSort} onChange={(event) => setPriceSort(event.target.value as typeof priceSort)}><option value="recommended">Recommended</option><option value="low-high">Price: low to high</option><option value="high-low">Price: high to low</option></select></label><div className="price-range"><div className="price-range-heading"><b>Price range</b><span>{money(minPrice)} – {money(Math.min(maxPrice, catalogMaxPrice))}</span></div><label>Minimum price<input aria-label="Minimum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(minPrice, catalogMaxPrice)} onChange={(event) => setMinPrice(Math.min(Number(event.target.value), maxPrice))} /></label><label>Maximum price<input aria-label="Maximum price" type="range" min="0" max={catalogMaxPrice} step="100" value={Math.min(maxPrice, catalogMaxPrice)} onChange={(event) => setMaxPrice(Math.max(Number(event.target.value), minPrice))} /></label></div><button className="reset-filters" onClick={() => { setMinPrice(0); setMaxPrice(catalogMaxPrice); setPriceSort('recommended') }}>Reset filters</button></div>}
          {visibleProducts.length ? <><div className="product-grid listing-grid">{visibleProducts.slice(0, productsToShow).map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={toggleWish} onOpen={openProduct} onAdd={addToCart} />)}</div>{visibleProducts.length > productsToShow && <button className="load-more-button" onClick={() => setProductsToShow((count) => Math.min(count + 48, visibleProducts.length))}>Load more products <span>{Math.min(48, visibleProducts.length - productsToShow)} more</span></button>}</> : <div className="empty-state"><Search size={27} /><h3>{page === 'wishlist' ? 'Nothing saved just yet' : 'No finds in this range'}</h3><p>{page === 'wishlist' ? 'Tap the heart on anything you love and it will show up here.' : 'Adjust the price range or browse another category.'}</p><button className="dark-button" onClick={() => { setQuery(''); showStore('shop') }}>Explore all products <ArrowRight size={16} /></button></div>}
        </section> : null}
        {page === 'combos' && !submittedQuery && <section className="listing-page page-width combo-list-page"><div className="breadcrumb"><button onClick={() => showStore('shop')}>Home</button><ChevronRight size={14} /><span>Combos</span></div><div className="listing-heading"><div><span className="section-kicker">AARO, ALL TOGETHER</span><h1>The good things set.</h1><p>Considered combinations for gifting, keeping, or making your day.</p></div></div><div className="combo-grid">{state.content.combos.map((combo, index) => <div className="combo-card combo-card-static" key={combo.title}><div className={`combo-photo combo-photo-${index + 1}`}><ImageView src={combo.image} alt={combo.title} /><span>THE SET EDIT</span><b>0{index + 1}</b></div><div><span>{combo.subtitle}</span><strong>{combo.title}</strong><small>From {money(combo.price)} <ArrowRight size={14} /></small></div><button className="dark-button" onClick={() => notify('Combo ordering will be enabled after product bundles are connected.')}>Explore this set <ArrowRight size={15} /></button></div>)}</div></section>}
        <section className="bottom-promo page-width"><span><Sparkles size={17} /> EASY DOES IT</span><p>A good find should feel good from the first click to the doorstep.</p><button onClick={() => setLoginOpen(true)}>Need a hand? <ArrowRight size={15} /></button></section>
        </>}
      </main>
      <footer className="site-footer"><div className="footer-main page-width"><div className="footer-brand"><button className="wordmark" onClick={() => showStore('shop')}>AARO<span>.</span></button><p>Good finds for bright everyday living.</p><div className="social-dots"><a href="#instagram" aria-label="Instagram">ig</a><a href="#facebook" aria-label="Facebook">f</a><a href="#tiktok" aria-label="TikTok">tk</a></div></div><div className="footer-column"><b>Discover</b><button onClick={() => showStore('trending')}>Trending now</button><button onClick={() => showStore('offers')}>Offers</button><button onClick={() => showStore('combos')}>Combos</button></div><div className="footer-column"><b>Helpful things</b><button onClick={() => notify('Delivery details will be shown here after ShopBase rates are confirmed.')}>Delivery & returns</button><button onClick={() => notify('Contact AARO customer care from your social page.')}>Contact us</button><button onClick={() => setLoginOpen(true)}>Your account</button></div><div className="footer-contact"><span className="section-kicker">A LITTLE HELP?</span><p>Questions, ideas, or a product request?</p><button onClick={() => notify('Customer support: add your contact details before launch.')}>Say hello <ArrowRight size={15} /></button></div></div><div className="footer-bottom page-width"><span>© 2026 AARO Bangladesh. Demo storefront.</span><span>Designed for the everyday, with a little extra.</span><button onClick={() => { setAdmin(true); setAdminTab('overview'); window.scrollTo(0, 0) }}>Moderator preview</button></div></footer>
      {cartOpen && <CartDrawer cartItems={cartItems} subtotal={subtotal} delivery={deliveryFee} outsideDelivery={state.content.deliveryOutsideDhaka} discount={discount} total={total} coupon={coupon} couponInput={couponInput} setCouponInput={setCouponInput} applyCoupon={applyCoupon} clearCoupon={() => setCoupon(null)} onQuantity={setQuantity} onClose={() => setCartOpen(false)} checkout={checkout} setCheckout={setCheckout} onPlaceOrder={placeOrder} onShop={() => { setCartOpen(false); showStore('shop') }} />}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} user={user} setUser={(nextUser) => { setUser(nextUser); if (nextUser) localStorage.setItem(USER_KEY, nextUser); else localStorage.removeItem(USER_KEY) }} notify={notify} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>}
  </>
}

function ProductCard({ product, wished, onWish, onOpen, onAdd }: { product: Product; wished: boolean; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void }) {
  const salePercent = product.compareAt ? Math.round((1 - product.price / product.compareAt) * 100) : 0
  return <article className="product-card"><div className="product-image" onClick={() => onOpen(product)} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen(product)}><ImageView src={product.image} alt={product.title} /><span className="image-wash" />{(product.badge || salePercent > 0) && <span className="product-badge">{product.badge || `${salePercent}% OFF`}</span>}<IconButton label={wished ? 'Remove from wishlist' : 'Add to wishlist'} className={`wishlist-button ${wished ? 'wished' : ''}`} onClick={() => onWish(product.id)}><Heart size={17} fill={wished ? 'currentColor' : 'none'} /></IconButton><button className="quick-add" onClick={(event) => { event.stopPropagation(); onAdd(product) }}>Quick add <Plus size={15} /></button></div><div className="product-info"><button className="product-category" onClick={() => onOpen(product)}>{product.category}</button><button className="product-name" onClick={() => onOpen(product)}>{product.title}</button><div className="product-meta"><span className="price">{money(product.price)}{product.compareAt && <del>{money(product.compareAt)}</del>}</span></div></div></article>
}

function ProductSection({ title, kicker, products, wishlist, onWish, onOpen, onAdd, onSeeAll, compact = false }: { title: string; kicker: string; products: Product[]; wishlist: string[]; onWish: (id: string) => void; onOpen: (product: Product) => void; onAdd: (product: Product) => void; onSeeAll: () => void; compact?: boolean }) {
  return <section className={`product-section page-width ${compact ? 'compact-section' : ''}`}><div className="section-heading"><div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div><button className="text-link" onClick={onSeeAll}>View all <ArrowRight size={16} /></button></div>{products.length ? <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} wished={wishlist.includes(product.id)} onWish={onWish} onOpen={onOpen} onAdd={onAdd} />)}</div> : <p className="empty-row">Add products to this collection from the moderator panel.</p>}</section>
}

function OfferBanner({ state, onShop }: { state: StoreState; onShop: () => void }) {
  return <section className="offer-banner page-width"><div className="offer-visual"><ImageView src={state.content.offerImage} alt="A featured AARO offer edit" /><span className="offer-seal"><b>JUST A</b><strong>little<br />extra</strong><i>✳</i></span><span className="offer-count">THE OFFER EDIT&nbsp; / &nbsp;01—06</span></div><div className="offer-copy"><span className="section-kicker">GOOD FINDS, GOOD TIMING</span><h2>{state.content.offerTitle.split('\n').map((line, index) => <span key={index}>{line}{index === 0 && <br />}</span>)}</h2><p>{state.content.offerSubtitle}</p><button className="dark-button" onClick={onShop}>Shop the offers <ArrowRight size={16} /></button><small>Offers can change as availability updates.</small></div></section>
}

function CartDrawer({ cartItems, subtotal, delivery, outsideDelivery, discount, total, coupon, couponInput, setCouponInput, applyCoupon, clearCoupon, onQuantity, onClose, checkout, setCheckout, onPlaceOrder, onShop }: { cartItems: (CartLine & { product: Product })[]; subtotal: number; delivery: number; outsideDelivery: number; discount: number; total: number; coupon: Coupon | null; couponInput: string; setCouponInput: (value: string) => void; applyCoupon: () => void; clearCoupon: () => void; onQuantity: (id: string, qty: number) => void; onClose: () => void; checkout: boolean; setCheckout: (value: boolean) => void; onPlaceOrder: (event: FormEvent<HTMLFormElement>) => void; onShop: () => void }) {
  const [outsideDhaka, setOutsideDhaka] = useState(false)
  const checkoutDelivery = outsideDhaka ? outsideDelivery : delivery
  const checkoutTotal = Math.max(0, subtotal + checkoutDelivery - discount)
  return <div className="modal-backdrop drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="cart-drawer">
      <div className="drawer-head"><div><span className="section-kicker">AARO / YOUR BAG</span><h2>{checkout ? 'A few details.' : `Your bag (${cartItems.reduce((sum, line) => sum + line.quantity, 0)})`}</h2></div><IconButton label="Close bag" onClick={onClose}><X size={20} /></IconButton></div>
      {checkout ? <form className="checkout-form" onSubmit={onPlaceOrder}>
        <div className="checkout-note"><Phone size={17} /><span><b>Guest checkout preview.</b><small>This demo saves the order in this browser only. It does not check live supplier stock or send an order to ShopBase.</small></span></div>
        <label>Full name<input name="name" autoComplete="name" required placeholder="Name on the order" /></label>
        <label>Phone number<input name="phone" autoComplete="tel" required pattern="[+0-9 ()-]{8,}" placeholder="01XXX XXXXXX" /></label>
        <label>Email <span>(optional)</span><input type="email" name="email" autoComplete="email" placeholder="you@example.com" /></label>
        <label>Delivery area<input name="area" required placeholder="e.g. Dhanmondi, Dhaka" /></label>
        <label>Full delivery address<textarea name="address" rows={3} required placeholder="House, road, area, city" /></label>
        <label>Delivery zone<select name="zone" value={outsideDhaka ? 'outside' : 'dhaka'} onChange={(event) => setOutsideDhaka(event.target.value === 'outside')}><option value="dhaka">Inside Dhaka — {money(delivery)} estimate</option><option value="outside">Outside Dhaka — {money(outsideDelivery)} estimate</option></select></label>
        <div className="checkout-payment"><div className="cod-icon"><Truck size={17} /></div><span><b>Cash on delivery</b><small>Pay the courier when your order arrives.</small></span><CheckCircle2 size={17} /></div>
        <div className="summary-row"><span>Order total</span><b>{money(checkoutTotal)}</b></div>
        <button className="dark-button checkout-submit">Place order <ArrowRight size={17} /></button>
        <button type="button" className="back-to-bag" onClick={() => setCheckout(false)}><ChevronLeft size={15} /> Back to your bag</button>
        <p className="checkout-terms">Demo only: no payment, SMS, supplier check, or fulfillment request is made.</p>
      </form> : cartItems.length ? <>
        <div className="free-delivery"><span><Truck size={16} /> Delivery estimate for inside Dhaka: {money(delivery)}</span><small>Final courier charge depends on the address and supplier rate.</small></div>
        <div className="cart-lines">{cartItems.map(({ product, quantity }) => <div className="cart-line" key={product.id}><ImageView src={product.image} alt={product.title} /><div className="cart-line-copy"><span>{product.category}</span><b>{product.title}</b><strong>{money(product.price)}</strong><div className="quantity-control"><button aria-label="Decrease quantity" onClick={() => onQuantity(product.id, quantity - 1)}><Minus size={13} /></button><span>{quantity}</span><button aria-label="Increase quantity" onClick={() => onQuantity(product.id, quantity + 1)}><Plus size={13} /></button></div></div><button className="remove-line" onClick={() => onQuantity(product.id, 0)} aria-label={`Remove ${product.title}`}><X size={16} /></button></div>)}</div>
        <div className="coupon-row"><TicketPercent size={17} /><input value={couponInput} onChange={(event) => setCouponInput(event.target.value.toUpperCase())} placeholder="Coupon code" /><button onClick={applyCoupon}>{coupon ? 'Applied' : 'Apply'}</button></div>
        {coupon && <div className="coupon-applied"><CheckCircle2 size={14} /> {coupon.code} is on this order <button onClick={() => { setCouponInput(''); clearCoupon() }}>Remove</button></div>}
        <div className="drawer-summary"><div><span>Subtotal</span><b>{money(subtotal)}</b></div><div><span>Delivery estimate</span><b>{delivery ? money(delivery) : 'Complimentary'}</b></div>{discount > 0 && <div className="discount-line"><span>Coupon saving</span><b>−{money(discount)}</b></div>}<div className="summary-total"><span>Estimated total</span><b>{money(total)}</b></div><button className="dark-button checkout-submit" onClick={() => setCheckout(true)}>Continue to checkout <ArrowRight size={17} /></button><p><ShieldCheck size={14} /> Order placed as guest · Cash on delivery</p></div>
      </> : <div className="empty-cart"><div><ShoppingBag size={28} /></div><h3>Your bag has room to grow.</h3><p>Find something lovely for your everyday.</p><button className="dark-button" onClick={onShop}>Explore the edit <ArrowRight size={16} /></button></div>}
    </aside>
  </div>
}

function ProductPage({ product, relatedProducts, wishlist, wished, onClose, onWish, onOpen, onSeeRelated, onAdd }: { product: Product; relatedProducts: Product[]; wishlist: string[]; wished: boolean; onClose: () => void; onWish: (id: string) => void; onOpen: (product: Product) => void; onSeeRelated: () => void; onAdd: (product: Product, quantity: number) => void }) {
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
  const detailImages = [...new Set([detailProduct.image, ...(detailProduct.images || [])].filter(Boolean))]
  const [activeImage, setActiveImage] = useState(product.image)
  useEffect(() => { setActiveImage(detailProduct.image) }, [detailProduct.id, detailProduct.image])
  useEffect(() => { setSize(detailProduct.sizes?.[0] || '') }, [detailProduct.id, detailProduct.sizes?.join('|')])
  return <section className="product-page page-width">
    <button className="product-back" onClick={onClose}><ChevronLeft size={17} /> Back to shopping</button>
    <div className="product-page-layout">
      <div className="detail-gallery"><div className="detail-image"><ImageView src={activeImage} alt={product.title} loading="eager" /><span className="detail-image-tag">AARO / SELECTED</span></div>{detailImages.length > 1 && <div className="detail-thumbnails">{detailImages.map((image) => <button type="button" className={activeImage === image ? 'selected' : ''} key={image} onClick={() => setActiveImage(image)} aria-label={`View ${product.title} image`}><ImageView src={image} alt="" /></button>)}</div>}</div>
      <div className="detail-copy"><span className="section-kicker">{detailProduct.category.toUpperCase()} / THE EVERYDAY EDIT</span><h1>{detailProduct.title}</h1><div className="detail-price">{money(detailProduct.price)} {detailProduct.compareAt && <del>{money(detailProduct.compareAt)}</del>}{detailProduct.compareAt && <small>YOU SAVE {money(detailProduct.compareAt - detailProduct.price)}</small>}</div><p>{detailProduct.description || (detailProduct.source === 'shopbase' ? 'Loading product details…' : '')}</p>{detailProduct.sizes && <div className="size-picker"><div><b>Choose a size</b><button onClick={() => setSize(detailProduct.sizes?.[0] || '')}>Size guide</button></div><div>{detailProduct.sizes.map((item) => <button className={size === item ? 'selected' : ''} key={item} onClick={() => setSize(item)}>{item}</button>)}</div></div>}<div className="detail-stock"><i /> Catalog availability is a snapshot; we’ll confirm stock before fulfillment.</div><div className="detail-actions"><div className="quantity-control"><button onClick={() => setQuantity(Math.max(1, quantity - 1))}><Minus size={13} /></button><span>{quantity}</span><button onClick={() => setQuantity(quantity + 1)}><Plus size={13} /></button></div><button className="dark-button" onClick={() => onAdd(product, quantity)}>Add to bag <ShoppingBag size={17} /></button><IconButton label={wished ? 'Remove from wishlist' : 'Save to wishlist'} className={wished ? 'wished' : ''} onClick={() => onWish(product.id)}><Heart size={18} fill={wished ? 'currentColor' : 'none'} /></IconButton></div><div className="detail-policies"><span><Truck size={16} /> Delivery across Bangladesh</span><span><ShieldCheck size={16} /> Easy support if needed</span></div></div>
    </div>
    {relatedProducts.length > 0 && <div className="related-products"><ProductSection title="More from this category" kicker={`MORE TO LOVE IN ${product.category.toUpperCase()}`} products={relatedProducts} wishlist={wishlist} onWish={onWish} onOpen={onOpen} onAdd={(item) => onAdd(item, 1)} onSeeAll={onSeeRelated} compact /></div>}
  </section>
}

function LoginModal({ onClose, user, setUser, notify }: { onClose: () => void; user: string | null; setUser: (value: string | null) => void; notify: (message: string) => void }) {
  const [complete, setComplete] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="login-modal"><button className="modal-close" aria-label="Close account" onClick={onClose}><X size={20} /></button><span className="section-kicker">AARO / YOUR ACCOUNT</span><h2>{user ? 'Welcome back.' : complete ? 'You’re all set.' : mode === 'register' ? 'Create your account.' : 'Good to see you.'}</h2><p>{user ? `Signed in as ${user}. Your orders and saved things can live here.` : complete ? 'Your demo account is ready in this browser.' : 'Sign in or create an account. You can still place an order as a guest.'}</p>{user ? <button className="dark-button" onClick={() => { setUser(null); notify('Signed out'); onClose() }}>Sign out <ArrowRight size={16} /></button> : complete ? <button className="dark-button" onClick={onClose}>Continue shopping <ArrowRight size={16} /></button> : <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const identifier = String(form.get('identifier')); setUser(identifier); setComplete(true); notify(mode === 'register' ? 'Demo account created' : 'Demo account session started') }}>
    {mode === 'register' && <label>Your name<input name="name" autoComplete="name" required placeholder="Full name" /></label>}
    <label>Email or phone number<input name="identifier" required placeholder="you@example.com or 01XXX XXXXXX" /></label>
    <label>Password<input name="password" type="password" minLength={6} required placeholder="At least 6 characters" /></label>
    <button className="dark-button">{mode === 'register' ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
    <button type="button" className="account-mode-toggle" onClick={() => setMode((current) => current === 'login' ? 'register' : 'login')}>{mode === 'register' ? 'Already have an account? Sign in' : 'New to AARO? Create an account'}</button>
    <small className="demo-only">Preview mode: accounts are saved only in this browser. Secure registration will be connected to the backend before launch.</small>
  </form>}</div></div>
}

function AdminOverview({ state, revenue, customerCount, onTab, updateOrderStatus }: { state: StoreState; revenue: number; customerCount: number; onTab: (tab: AdminTab) => void; updateOrderStatus: (id: string, status: OrderStatus) => void }) {
  const orders = [...state.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const stats = [
    { title: 'Total revenue', value: money(revenue), note: 'Sample order records', icon: CircleDollarSign, trend: 'Demo', up: false },
    { title: 'Total orders', value: String(state.orders.length), note: `${state.orders.filter((order) => order.status === 'Pending confirmation').length} awaiting confirmation`, icon: ShoppingCart, trend: 'Demo', up: false },
    { title: 'Customers', value: String(customerCount), note: 'Sample phone records', icon: UsersRound, trend: 'Demo', up: false },
    { title: 'Store views', value: state.views.toLocaleString(), note: 'This browser demo', icon: Eye, trend: 'Live', up: false }
  ]
  const bars = [42, 64, 51, 74, 57, 88, 68, 96, 77, 62, 84, 100]
  return <><div className="admin-welcome"><div><span className="section-kicker">SATURDAY, 14 NOVEMBER</span><h2>Your store, at a glance.</h2><p>Here’s what’s happening with AARO today.</p></div><button className="primary-button" onClick={() => onTab('products')}><Plus size={17} /> Add a product</button></div><div className="stat-grid">{stats.map(({ title, value, note, icon: Icon, trend, up }) => <div className="stat-card" key={title}><div className="stat-card-top"><span>{title}</span><i><Icon size={18} /></i></div><strong>{value}</strong><div className="stat-card-bottom"><span>{note}</span><b className={up ? 'trend-up' : 'trend-neutral'}>{up ? <ArrowUpRight size={14} /> : null}{trend}</b></div></div>)}</div><div className="overview-grid"><section className="panel revenue-panel"><div className="panel-heading"><div><h3>Revenue overview</h3><p>Monthly sales performance</p></div><button className="select-chip">Last 30 days <ChevronDown size={14} /></button></div><div className="revenue-total"><strong>{money(revenue)}</strong><span><ArrowUpRight size={14} /> 12.8%</span><small>vs. previous period</small></div><div className="chart-area"><div className="chart-y"><span>৳8k</span><span>৳6k</span><span>৳4k</span><span>৳2k</span><span>৳0</span></div><div className="chart-bars">{bars.map((height, index) => <div className="chart-column" key={index}><i style={{ height: `${height}%` }} /><span>{['Oct 16', 'Oct 20', 'Oct 24', 'Oct 28', 'Nov 01', 'Nov 05', 'Nov 09', 'Nov 14'][Math.floor(index * 8 / bars.length)]}</span></div>)}</div></div><div className="chart-legend"><span><i /> Sales</span><span>Sample visualization · confirmed orders</span></div></section><section className="panel attention-panel"><div className="panel-heading"><div><h3>Needs your attention</h3><p>Keep orders moving smoothly</p></div></div><div className="attention-item"><span className="attention-icon amber-icon"><Clock3 size={18} /></span><div><b>{state.orders.filter((order) => order.status === 'Pending confirmation').length} orders to confirm</b><small>Call customers before sending to ShopBase</small></div><button onClick={() => onTab('orders')}><ArrowRight size={16} /></button></div><div className="attention-item"><span className="attention-icon teal-icon"><RotateCcw size={18} /></span><div><b>Catalog sync is not connected</b><small>Import a supplier CSV to update products</small></div><button onClick={() => onTab('sync')}><ArrowRight size={16} /></button></div><div className="attention-foot"><ShieldCheck size={15} /> Orders stay in your review queue until confirmed.</div></section></div><section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent orders</h3><p>The latest customer activity</p></div><button className="text-link" onClick={() => onTab('orders')}>View all orders <ArrowRight size={15} /></button></div><OrderTable orders={orders.slice(0, 5)} onStatus={updateOrderStatus} compact /></section><div className="admin-demo-footer"><span><Sparkles size={14} /> Demo workspace — changes save in this browser.</span><span>Connect a secured backend to launch for customers.</span></div></>
}

function AdminProducts({ state, onAdd, onEdit, onDelete }: { state: StoreState; onAdd: () => void; onEdit: (product: Product) => void; onDelete: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const products = state.products.filter((product) => `${product.title} ${product.category}`.toLowerCase().includes(search.toLowerCase()))
  return <section className="panel"><div className="panel-heading panel-heading-wrap"><div><h2>Product catalog</h2><p>Edit product details, pricing, images, availability, and collections.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} /> Add product</button></div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search products..." /></div><button className="select-chip"><Filter size={14} /> All products <ChevronDown size={14} /></button><span>{products.length} products</span></div><div className="responsive-table"><table className="data-table product-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Visibility</th><th>Source</th><th /></tr></thead><tbody>{products.map((product) => <tr key={product.id}><td><div className="table-product"><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>SKU / {product.sourceId || product.id.slice(0, 10)}</small></span></div></td><td>{product.category}</td><td><b>{money(product.price)}</b>{product.compareAt && <small className="old-price">{money(product.compareAt)}</small>}</td><td><span className={product.stock < 10 ? 'stock-low' : 'stock-good'}><i /> {product.stock} in stock</span></td><td><span className={`visibility ${product.active ? 'visible' : ''}`}><i /> {product.active ? 'Active' : 'Hidden'}</span></td><td><span className="source-tag">{product.source === 'shopbase' ? 'ShopBase import' : 'Manual'}</span></td><td><div className="row-actions"><button onClick={() => onEdit(product)} aria-label={`Edit ${product.title}`}><Pencil size={16} /></button><button onClick={() => onDelete(product.id)} aria-label={`Delete ${product.title}`}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div></section>
}

function AdminOffers({ state, onNew, toggleCoupon, updateState, notify }: { state: StoreState; onNew: () => void; toggleCoupon: (code: string) => void; updateState: (updater: (current: StoreState) => StoreState) => void; notify: (message: string) => void }) {
  const offerProducts = state.products.filter((product) => state.content.offerIds.includes(product.id) || product.offer)
  return <><div className="panel offers-feature"><div><span className="section-kicker">CURRENT OFFER EDIT</span><h2>Offers customers can see.</h2><p>Choose which products appear in the offer section and create checkout coupon codes.</p><button className="primary-button" onClick={onNew}><Plus size={17} /> Create coupon</button></div><div className="offer-feature-art"><span>THE GOOD<br />DEAL EDIT</span><b>For a little<br />less.</b><i>✳</i></div></div><section className="panel offer-list-panel"><div className="panel-heading"><div><h3>Featured offer products</h3><p>Products tagged for the storefront offer section</p></div></div>{offerProducts.length ? <div className="offer-product-list">{offerProducts.map((product) => <div className="offer-product-row" key={product.id}><ImageView src={product.image} alt="" /><span><b>{product.title}</b><small>{product.category} · {money(product.price)}{product.compareAt ? ` / ${money(product.compareAt)}` : ''}</small></span><button onClick={() => { updateState((current) => ({ ...current, content: { ...current.content, offerIds: current.content.offerIds.filter((id) => id !== product.id) }, products: current.products.map((item) => item.id === product.id ? { ...item, offer: false } : item) })); notify('Removed from offer edit') }}>Remove</button></div>)}</div> : <p className="empty-row">No featured offers yet. Edit products and mark them as offers.</p>}</section><section className="panel coupon-admin-panel"><div className="panel-heading"><div><h3>Coupon codes</h3><p>Discounts are checked against the bag subtotal.</p></div><button className="subtle-icon" onClick={onNew} aria-label="Add coupon"><Plus size={17} /></button></div><div className="coupon-admin-grid">{state.coupons.map((coupon) => <div className={`coupon-card ${coupon.active ? '' : 'inactive'}`} key={coupon.code}><div className="coupon-card-top"><span><TicketPercent size={16} /> DISCOUNT CODE</span><button onClick={() => toggleCoupon(coupon.code)}>{coupon.active ? 'Active' : 'Paused'} <ChevronDown size={13} /></button></div><strong>{coupon.code}</strong><p>{coupon.kind === 'percent' ? `${coupon.value}% off` : `${money(coupon.value)} off`} {coupon.minimum ? `on orders over ${money(coupon.minimum)}` : ''}</p><button className="copy-code" onClick={() => { navigator.clipboard?.writeText(coupon.code); notify(`${coupon.code} copied`) }}><Copy size={14} /> Copy code</button></div>)}</div>{!state.coupons.length && <p className="empty-row">Create your first coupon code.</p>}</section></>
}

function AdminOrders({ orders, filter, setFilter, search, setSearch, onStatus }: { orders: Order[]; filter: string; setFilter: (value: string) => void; search: string; setSearch: (value: string) => void; onStatus: (id: string, status: OrderStatus) => void }) {
  const filtered = orders.filter((order) => (filter === 'All orders' || order.status === filter) && `${order.id} ${order.customer.name} ${order.customer.phone}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return <section className="panel orders-panel"><div className="panel-heading panel-heading-wrap"><div><h2>Orders</h2><p>Review customer details, confirm by phone, then submit to ShopBase.</p></div><button className="export-button" onClick={() => { const csv = ['Order,Customer,Phone,Area,Total,Status,Date', ...filtered.map((order) => [order.id, order.customer.name, order.customer.phone, order.customer.area, order.total, order.status, dateLabel(order.createdAt)].join(','))].join('\n'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'aaro-orders.csv'; link.click(); URL.revokeObjectURL(link.href) }}><Download size={16} /> Export</button></div><div className="order-tabs">{['All orders', 'Pending confirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'].map((item) => <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}{item === 'Pending confirmation' && <i>{orders.filter((order) => order.status === item).length}</i>}</button>)}</div><div className="table-toolbar"><div className="admin-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Order number, customer, phone..." /></div><span>{filtered.length} orders</span></div><div className="responsive-table"><OrderTable orders={filtered} onStatus={onStatus} /></div></section>
}

function OrderTable({ orders, onStatus, compact = false }: { orders: Order[]; onStatus: (id: string, status: OrderStatus) => void; compact?: boolean }) {
  return <table className="data-table order-table"><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th><th>{compact ? 'Action' : 'Update status'}</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td><b className="order-id">{order.id}</b><small>{order.items.reduce((sum, item) => sum + item.quantity, 0)} item{order.items.reduce((sum, item) => sum + item.quantity, 0) === 1 ? '' : 's'}</small></td><td><div className="customer-cell"><b>{order.customer.name}</b><small>{order.customer.phone} · {order.customer.area}</small></div></td><td>{shortDate(order.createdAt)}</td><td><b>{money(order.total)}</b></td><td><StatusPill status={order.status} /></td><td>{order.status === 'Pending confirmation' ? <button className="confirm-button" onClick={() => onStatus(order.id, 'Confirmed')}><Check size={14} /> Confirm</button> : order.status === 'Confirmed' ? <button className="small-action" onClick={() => onStatus(order.id, 'Processing')}>Mark processing <ArrowRight size={13} /></button> : order.status === 'Processing' ? <button className="small-action" onClick={() => onStatus(order.id, 'Shipped')}>Mark shipped <ArrowRight size={13} /></button> : !compact && order.status === 'Shipped' ? <button className="small-action" onClick={() => onStatus(order.id, 'Delivered')}>Mark delivered <Check size={13} /></button> : <span className="row-muted">—</span>}</td></tr>)}</tbody></table>
}

function ProductEditor({ product, categories, onClose, onSave }: { product: Product | null; categories: string[]; onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><div className="form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CATALOG</span><h2>{product ? 'Edit product' : 'Add product'}</h2></div><IconButton label="Close editor" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form product-editor-form" onSubmit={onSave}><label>Product name<input name="title" required defaultValue={product?.title} placeholder="e.g. Cotton co-ord set" /></label><div className="settings-two"><label>Category<select name="category" defaultValue={product?.category || categories[0]}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><label>Price (৳)<input name="price" type="number" min="0" required defaultValue={product?.price} /></label></div><div className="settings-two"><label>Compare at / suggested (৳)<input name="compareAt" type="number" min="0" defaultValue={product?.compareAt || ''} /></label><label>Available quantity<input name="stock" type="number" min="0" defaultValue={product?.stock ?? 0} /></label></div><label>Image URL<input name="image" required defaultValue={product?.image} placeholder="Cloudinary URL or approved product image URL" /></label><label>Product details<textarea name="description" rows={4} defaultValue={product?.description} placeholder="What should a customer know?" /></label><label>Badge (optional)<input name="badge" defaultValue={product?.badge || ''} placeholder="Bestseller, New, Set of 2" /></label><div className="check-options"><label><input type="checkbox" name="active" defaultChecked={product?.active ?? true} /> Show on storefront</label><label><input type="checkbox" name="trending" defaultChecked={product?.trending} /> Trending now</label><label><input type="checkbox" name="offer" defaultChecked={product?.offer} /> Include in offers</label></div><p className="form-help">Images use a URL for now. Connect Cloudinary upload in the production backend for secure media management.</p><div className="modal-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save product</button></div></form></div></div>
}

function CouponEditor({ onClose, onSave }: { onClose: () => void; onSave: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop"><div className="form-modal small-form-modal"><div className="modal-heading"><div><span className="section-kicker">AARO / CHECKOUT</span><h2>Create coupon</h2></div><IconButton label="Close coupon form" onClick={onClose}><X size={19} /></IconButton></div><form className="settings-form" onSubmit={onSave}><label>Coupon code<input name="code" required minLength={3} placeholder="e.g. AARO15" /></label><div className="settings-two"><label>Discount type<select name="kind"><option value="percent">Percentage</option><option value="amount">Fixed amount</option></select></label><label>Value<input name="value" type="number" min="1" required /></label></div><label>Minimum order (৳), optional<input name="minimum" type="number" min="0" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button"><Check size={16} /> Save coupon</button></div></form></div></div>
}

function SyncPanel({ lastSync, importNote, fileRef, onImport, products }: { lastSync: string; importNote: string; fileRef: { current: HTMLInputElement | null }; onImport: (file?: File) => void; products: Product[] }) {
  const imported = products.filter((product) => product.source === 'shopbase')
  return <div className="sync-layout"><section className="panel sync-hero-panel"><div className="sync-symbol"><RotateCcw size={24} /></div><span className="section-kicker">CATALOG / SHOPBASE BD</span><h2>Your catalog, all in one place.</h2><p>Supplier updates belong in your catalog first. A scheduled backend job refreshes your stored catalog every 24 hours.</p><div className="sync-status-box"><div className="sync-status-icon"><Clock3 size={19} /></div><span><b>{imported.length ? `${imported.length} imported products` : 'ShopBase catalog not synced'}</b><small>{lastSync ? `Last catalog update ${dateLabel(lastSync)}` : 'Add the ShopBase session cookie to Render to enable the daily job.'}</small></span><span className="status-pill status-amber"><i /> Needs setup</span></div><div className="sync-actions"><button className="primary-button" onClick={() => fileRef.current?.click()}><Upload size={17} /> Import supplier CSV</button><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => onImport(event.target.files?.[0])} /><button className="secondary-button" onClick={() => fileRef.current?.click()}><Download size={16} /> Select CSV file</button></div>{importNote && <div className="import-result"><CheckCircle2 size={16} />{importNote}</div>}<div className="sync-note"><ShieldCheck size={17} /><span><b>Backend connection required for automation</b><small>The importer reads the authenticated reseller portal. Keep its session cookie in Render secrets, never in the storefront.</small></span></div></section><section className="panel sync-side-panel"><div className="panel-heading"><div><h3>How updates will work</h3><p>Daily catalog schedule</p></div></div><div className="sync-flow"><div><i>01</i><span><b>Read the reseller catalog</b><small>Use the ShopBase session secret on the server, never in browser code.</small></span></div><div><i>02</i><span><b>Update changed products</b><small>Match by the ShopBase product ID and preserve AARO edits and image overrides.</small></span></div><div><i>03</i><span><b>Recheck at checkout</b><small>Verify the selected product’s latest price and availability before accepting the order.</small></span></div><div><i>04</i><span><b>Review orders</b><small>Confirm with your customer, then submit the order in the ShopBase app until order API access exists.</small></span></div></div><div className="csv-format"><b>CSV columns supported</b><code>id, title, category, price, compare_at, image, description, stock</code></div></section></div>
}
