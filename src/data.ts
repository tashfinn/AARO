import type { StoreState } from './types'

export const initialState: StoreState = {
  categories: ['All'],
  products: [],
  coupons: [],
  offers: [],
  orders: [],
  content: {
    heroSlides: [
      { image: '/images/premium-earth-tone-apparel-display.jpg', title: '10,000+ products across 100+ categories', description: 'Thoughtful finds for bright everyday living.', cta: 'Explore', link: '/trending' },
      { image: '/images/warm-boutique-clothing-display.jpg', title: 'Warm layers for everyday living.', description: 'Earth-tone pieces and easy layers, thoughtfully picked for your day.', cta: 'Explore', link: '/offers' },
      { image: '/images/warm-earth-tone-fashion-portrait.jpg', title: 'Find your kind of good.', description: 'Explore clothing and everyday finds selected for comfort and personal style.', cta: 'Explore', link: '/offers' },
    ],
    heroTitle: '10,000+ products\nAcross 100+ categories',
    heroSubtitle: 'Thoughtful finds for bright everyday living.',
    heroImage: '/images/warm-boutique-clothing-display-v2.png',
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
