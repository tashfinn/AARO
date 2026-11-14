import type { StoreState } from './types'

const now = new Date().toISOString()

export const initialState: StoreState = {
  categories: ['All', 'Women', 'Men', 'Home & Living', 'Beauty', 'Gadgets', 'Accessories', 'Kids'],
  products: [
    { id: 'p-001', title: 'Everyday Cotton Co-ord Set', category: 'Women', price: 1890, compareAt: 2290, image: 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=900&q=82', description: 'An easy, breathable two-piece for busy days and slow weekends. Relaxed fit with a soft cotton feel.', rating: 4.8, reviews: 42, badge: 'Bestseller', stock: 24, active: true, trending: true, offer: true, source: 'demo', updatedAt: now, sizes: ['S', 'M', 'L', 'XL'] },
    { id: 'p-002', title: 'Sculpted Minimal Watch', category: 'Accessories', price: 2450, compareAt: 2990, image: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=82', description: 'A clean everyday watch with a quiet, timeless profile and a comfortable strap.', rating: 4.7, reviews: 28, badge: 'Popular', stock: 18, active: true, trending: true, offer: true, source: 'demo', updatedAt: now },
    { id: 'p-003', title: 'Soft Knit Layered Sweater', category: 'Women', price: 1590, compareAt: 1890, image: 'https://images.unsplash.com/photo-1576566588028-4147f3842f27?auto=format&fit=crop&w=900&q=82', description: 'A light, cozy knit layer designed to style effortlessly from day to evening.', rating: 4.9, reviews: 63, badge: 'Just in', stock: 31, active: true, trending: true, offer: false, source: 'demo', updatedAt: now, sizes: ['S', 'M', 'L', 'XL'] },
    { id: 'p-004', title: 'Classic Everyday Sneakers', category: 'Men', price: 2190, compareAt: 2590, image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=82', description: 'Lightweight comfort with a versatile shape that goes with everything.', rating: 4.6, reviews: 35, stock: 16, active: true, offer: true, source: 'demo', updatedAt: now, sizes: ['39', '40', '41', '42', '43'] },
    { id: 'p-005', title: 'The Daily Carry Tote', category: 'Accessories', price: 1290, compareAt: 1590, image: 'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=900&q=82', description: 'Room for the essentials, finished with sturdy handles and an understated look.', rating: 4.8, reviews: 51, badge: 'Bestseller', stock: 42, active: true, trending: true, offer: false, source: 'demo', updatedAt: now },
    { id: 'p-006', title: 'Ceramic Table Lamp', category: 'Home & Living', price: 2850, compareAt: 3290, image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=900&q=82', description: 'Warm ambient light and a sculptural ceramic base for a calmer corner at home.', rating: 4.9, reviews: 19, stock: 12, active: true, trending: true, offer: true, source: 'demo', updatedAt: now },
    { id: 'p-007', title: 'Glow Ritual Skincare Duo', category: 'Beauty', price: 1490, compareAt: 1750, image: 'https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=900&q=82', description: 'A simple daily-care pair selected for a fresh, comfortable skin routine.', rating: 4.7, reviews: 38, badge: 'Set of 2', stock: 28, active: true, offer: true, source: 'demo', updatedAt: now },
    { id: 'p-008', title: 'Wireless Studio Headphones', category: 'Gadgets', price: 3190, compareAt: 3790, image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=82', description: 'Comfortable over-ear listening with a clean silhouette for work, travel, and downtime.', rating: 4.6, reviews: 24, stock: 14, active: true, trending: true, offer: false, source: 'demo', updatedAt: now },
    { id: 'p-009', title: 'Relaxed Linen Shirt', category: 'Men', price: 1690, compareAt: 1990, image: 'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?auto=format&fit=crop&w=900&q=82', description: 'A versatile, relaxed shirt with an airy feel and easy everyday styling.', rating: 4.8, reviews: 32, stock: 21, active: true, offer: false, source: 'demo', updatedAt: now, sizes: ['M', 'L', 'XL', 'XXL'] },
    { id: 'p-010', title: 'Textured Cushion Cover Set', category: 'Home & Living', price: 990, compareAt: 1250, image: 'https://images.unsplash.com/photo-1584100936595-c0654b55a2e2?auto=format&fit=crop&w=900&q=82', description: 'Two tactile cushion covers that add an easy, considered finishing touch to a room.', rating: 4.5, reviews: 17, badge: 'Set of 2', stock: 36, active: true, offer: true, source: 'demo', updatedAt: now },
    { id: 'p-011', title: 'Mini Weekend Crossbody', category: 'Accessories', price: 1780, compareAt: 2090, image: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=900&q=82', description: 'A compact crossbody to keep your everyday essentials close and organized.', rating: 4.7, reviews: 26, stock: 19, active: true, trending: true, source: 'demo', updatedAt: now },
    { id: 'p-012', title: 'Little Explorer Play Set', category: 'Kids', price: 1190, compareAt: 1450, image: 'https://images.unsplash.com/photo-1599623560574-39d485900c95?auto=format&fit=crop&w=900&q=82', description: 'A thoughtful activity set for curious hands and screen-free play.', rating: 4.9, reviews: 14, stock: 15, active: true, offer: true, source: 'demo', updatedAt: now }
  ],
  coupons: [
    { code: 'AARO10', kind: 'percent', value: 10, active: true, minimum: 1000 },
    { code: 'WELCOME150', kind: 'amount', value: 150, active: true, minimum: 1200 }
  ],
  orders: [
    { id: 'AR-2418', createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), customer: { name: 'Nusrat Jahan', phone: '01712 345 678', area: 'Dhanmondi', address: 'Road 8, Dhanmondi, Dhaka' }, items: [{ productId: 'p-001', title: 'Everyday Cotton Co-ord Set', image: 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=160&q=75', price: 1890, quantity: 1 }], subtotal: 1890, delivery: 60, discount: 0, total: 1950, status: 'Confirmed' },
    { id: 'AR-2417', createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(), customer: { name: 'Tanvir Ahmed', phone: '01819 876 543', area: 'Uttara', address: 'Sector 7, Uttara, Dhaka' }, items: [{ productId: 'p-008', title: 'Wireless Studio Headphones', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=160&q=75', price: 3190, quantity: 1 }], subtotal: 3190, delivery: 60, discount: 0, total: 3250, status: 'Processing' },
    { id: 'AR-2416', createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), customer: { name: 'Maliha Rahman', phone: '01911 234 567', area: 'Chattogram', address: 'GEC Circle, Chattogram' }, items: [{ productId: 'p-006', title: 'Ceramic Table Lamp', image: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=160&q=75', price: 2850, quantity: 1 }], subtotal: 2850, delivery: 120, discount: 0, total: 2970, status: 'Delivered' },
    { id: 'AR-2415', createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(), customer: { name: 'Farhan Kabir', phone: '01610 987 654', area: 'Mirpur', address: 'Mirpur 10, Dhaka' }, items: [{ productId: 'p-005', title: 'The Daily Carry Tote', image: 'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=160&q=75', price: 1290, quantity: 2 }], subtotal: 2580, delivery: 60, discount: 0, total: 2640, status: 'Pending confirmation' }
  ],
  content: {
    heroTitle: 'Good finds for\nbright everyday living.',
    heroSubtitle: 'Thoughtful picks across style, home, and all the little things that make a day.',
    heroImage: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=1500&q=86',
    heroCta: 'Explore the edit',
    offerTitle: 'A little treat\nfor your cart.',
    offerSubtitle: 'Explore our current offer edit. Thoughtfully chosen pieces, with a little more value built in.',
    offerImage: 'https://images.unsplash.com/photo-1594633312681-425c7b97ccd1?auto=format&fit=crop&w=1200&q=84',
    announcement: 'Thoughtful finds for bright everyday living',
    trendingIds: ['p-001', 'p-002', 'p-003', 'p-005', 'p-006', 'p-008'],
    offerIds: ['p-001', 'p-002', 'p-004', 'p-006', 'p-007', 'p-010'],
    combos: [
      { title: 'The Everyday Edit', subtitle: 'A little refresh, all together', image: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=900&q=82', price: 2990 },
      { title: 'Slow Morning Set', subtitle: 'Make home feel like a pause', image: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=900&q=82', price: 1890 },
      { title: 'Everyday Tech Pair', subtitle: 'The useful things, together', image: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=900&q=82', price: 3490 }
    ],
    deliveryInDhaka: 60,
    deliveryOutsideDhaka: 120
  },
  views: 0
}
