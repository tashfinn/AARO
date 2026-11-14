import type { StoreState } from './types'

export const initialState: StoreState = {
  categories: ['All'],
  products: [],
  coupons: [],
  orders: [],
  content: {
    heroTitle: '10,000+ products\nAcross 100+ categories',
    heroSubtitle: 'Thoughtful finds for bright everyday living.',
    heroImage: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1500&q=86',
    heroCta: 'Explore',
    offerTitle: 'A little treat\nfor your cart.',
    offerSubtitle: 'Discover current offers across the AARO collection.',
    offerImage: 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=1200&q=84',
    announcement: 'Thoughtful finds for bright everyday living',
    trendingIds: [],
    offerIds: [],
    combos: [],
    deliveryInDhaka: 60,
    deliveryOutsideDhaka: 120
  },
  views: 0
}
