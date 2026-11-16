export type Product = {
  id: string
  title: string
  category: string
  price: number
  compareAt?: number
  originalPrice?: number
  discountedPrice?: number
  retailerPrice?: number
  image: string
  description: string
  rating: number
  reviews: number
  badge?: string
  stock: number
  active: boolean
  trending?: boolean
  offer?: boolean
  source?: 'custom' | 'shopbase'
  images?: string[]
  sourceId?: string
  addedAt?: string
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

export type CategoryGroup = { id: string; name: string; showInStorefront?: boolean; children: { sourceId?: string; name: string; sortOrder?: number; showInStorefront?: boolean }[] }

export type OfferDeal = { title: string; id: string; productId: string; productIds?: string[]; kind: 'special_price' | 'quantity_discount' | 'buy_multiple' | 'buy_x_get_y_free' | 'bundle' | 'free_delivery'; value: number; discountKind: 'percent' | 'amount'; quantity: number; freeQuantity: number; reward?: 'discount' | 'free_delivery' | 'both'; active: boolean }
export type Coupon = { code: string; kind: 'percent' | 'amount'; value: number; active: boolean; minimum?: number }
export type OrderStatus = 'Pending confirmation' | 'Confirmed' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'
export type DeliveryZone = 'city' | 'sub_dhaka' | 'outside'
export type Order = {
  id: string
  createdAt: string
  customer: { name: string; phone: string; email?: string; address: string; area: string; district?: string; thana?: string; comments?: string }
  items: { productId: string; title: string; image: string; price: number; quantity: number; size?: string; options?: Record<string, string> }[]
  subtotal: number
  delivery: number
  deliveryZone?: DeliveryZone | 'inside' | 'outside'
  discount: number
  total: number
  coupon?: string
  status: OrderStatus
}

export type StoreContent = {
  heroSlides: { image: string; mobileImage?: string; title: string; description: string; cta: string; link: string }[]
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
  categoryImages?: Record<string, string>
  deliveryInDhaka: number
  deliverySubDhaka: number
  deliveryOutsideDhaka: number
}

export type StoreState = {
  products: Product[]
  categories: string[]
  categoryGroups?: CategoryGroup[]
  coupons: Coupon[]
  offers: OfferDeal[]
  orders: Order[]
  content: StoreContent
  views: number
}
