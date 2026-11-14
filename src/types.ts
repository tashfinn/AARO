export type Product = {
  id: string
  title: string
  category: string
  price: number
  compareAt?: number
  image: string
  description: string
  rating: number
  reviews: number
  badge?: string
  stock: number
  active: boolean
  trending?: boolean
  offer?: boolean
  source?: 'demo' | 'shopbase'
  images?: string[]
  sourceId?: string
  updatedAt: string
  sizes?: string[]
  sizeChart?: string
  details?: string
  attributes?: string[]
  options?: { name: string; values: string[] }[]
  categorySourceId?: string
  parentCategory?: string
  parentCategoryId?: string
}

export type CategoryGroup = { id: string; name: string; children: { sourceId?: string; name: string; sortOrder?: number }[] }

export type Coupon = { code: string; kind: 'percent' | 'amount'; value: number; active: boolean; minimum?: number }
export type OrderStatus = 'Pending confirmation' | 'Confirmed' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'
export type Order = {
  id: string
  createdAt: string
  customer: { name: string; phone: string; email?: string; address: string; area: string }
  items: { productId: string; title: string; image: string; price: number; quantity: number; size?: string }[]
  subtotal: number
  delivery: number
  discount: number
  total: number
  coupon?: string
  status: OrderStatus
}

export type StoreContent = {
  heroTitle: string
  heroSubtitle: string
  heroImage: string
  heroCta: string
  offerTitle: string
  offerSubtitle: string
  offerImage: string
  announcement: string
  trendingIds: string[]
  offerIds: string[]
  combos: { title: string; subtitle: string; image: string; price: number }[]
  deliveryInDhaka: number
  deliveryOutsideDhaka: number
}

export type StoreState = {
  products: Product[]
  categories: string[]
  categoryGroups?: CategoryGroup[]
  coupons: Coupon[]
  orders: Order[]
  content: StoreContent
  views: number
}
