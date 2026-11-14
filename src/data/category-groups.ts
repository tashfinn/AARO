import type { CategoryGroup } from '../types'

// Manual storefront taxonomy based on the category screenshots. The API's
// supplier category IDs replace these name-only children when it is available.
export const manualCategoryGroups: CategoryGroup[] = [
  { id: 'mens-winter', name: "Men's Winter", children: ['সলিড হুডি', 'কন্ট্রাস্ট হুডি', 'পাফার জ্যাকেট', 'ভার্সিটি জ্যাকেট', 'ভেস্ট জ্যাকেট', 'জেন্টস সুইটশার্ট', 'জেন্টস সুয়েটার', 'ফুল স্লিভ টি-শার্ট', 'ডেনিম শার্ট', 'ডেনিম জ্যাকেট', 'জেন্টস শ্যাকেট', 'হুডি সেট', 'ফুল স্লিভ সেট', 'ডেনিম প্যান্ট', 'জগার্স', 'প্যান্ট+ট্রাউজার'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'womens-winter', name: "Ladies' Winter", children: ['লেডিস হুডি', 'জার্সি জ্যাকেট', 'লেডিস জ্যাকেট', 'ডেনিম জ্যাকেট', 'লেডিস ওভারকোট', 'লেডিস সোয়েটার', 'ভেস্ট জ্যাকেট', 'লেডিস শাল'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'kids-winter', name: "Kids' Winter", children: ['পাফার জ্যাকেট', 'গার্লস হুডি', 'হুডি সেট', 'হুডি সেট-২', 'হুডি সেট-৩', 'হুডি সেট-৪', 'সুইটশার্ট সেট', 'ব্ল্যাঙ্কেট', 'গার্লস ওভারকোট'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'boys-clothing', name: "Boys' Clothing", children: ['পলো শার্ট', 'কাতুয়া', 'প্রিন্টেড টি-শার্ট', 'বেসিক টি-শার্ট', 'প্রিন্ট শার্ট', 'সলিড শার্ট', 'চেক শার্ট', 'শার্ট কাপড়', 'শার্ট কম্বো', 'ফুল স্লিভ সেট', 'এমব্রয়ডারি পাঞ্জাবি', 'প্রিন্ট পাঞ্জাবি', 'পাঞ্জাবি কম্বো', 'ওয়ার্ল্ড কাপ'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'womens-clothing', name: "Ladies' Clothing", children: ['রেডিমেড থ্রিপিস', 'আনস্টিচড থ্রিপিস', 'গাউন & কুর্তি', 'লেহেঙ্গা & পার্টি', 'ওয়েস্টার্ন ড্রেস', 'টি-শার্ট & স্কার্ট', 'ইনার & নাইটি', 'শাড়ি', 'হ্যান্ডপ্রিন্ট শাড়ি', 'ইন্ডিয়ান শাড়ি', 'তাঁতের শাড়ি', 'বোরকা', 'হিজাব & নিকাব', 'মুসলিম ড্রেস'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'baby-collection', name: 'Baby Collection', children: ['বয়েজ টি-শার্ট সেট', 'বেবি শার্ট', 'বেবি পাঞ্জাবি', 'গার্লস টি-শার্ট সেট', 'কিডস প্যান্ট', 'বেবি কামিজ', 'পরী ড্রেস', 'বেবি বোরকা', 'খেলনা ও দোলনা'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'home-decor', name: 'Home & Decor', children: ['রেগুলার বেডশীট', 'ওয়াটারপ্রুফ বেডশীট', 'রেগুলার ডাইনিং', 'ওয়াটারপ্রুফ ডাইনিং', 'কম্বল', 'এসি কাঁথা', 'গৃহ সজ্জা'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'electronics-gadgets', name: 'Electronics & Gadgets', children: ['ফ্যান', 'গ্যাজেটস', 'ঘড়ি', 'হেডফোন', 'স্মার্ট-ওয়াচ', 'পাওয়ার-ব্যাংক', 'ক্যামেরা', 'স্পিকার'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'jewelry-accessories', name: 'Jewelry & Accessories', children: ['ক্লিপ & ব্যান্ড', 'এক্সেসরিজ', 'বিউটি কেয়ার', 'ন্যাচারাল কেয়ার'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'couple-gifts', name: 'Couple & Gift Sets', children: ['কাপল শাড়ি', 'কাপল ড্রেস', 'শাড়ি কম্বো', 'কাপল ঘড়ি', 'ঘড়ি কম্বো', 'গিফট আইটেম', 'মিস্ট্রি বক্স'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'seasonal', name: 'Seasonal Products', children: ['ছাতা', 'রেইন কোট', 'কাস্টম টি-শার্ট'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'other-categories', name: 'Other Categories', children: ['হোম কেয়ার', 'পার্সোনাল কেয়ার', 'টয়স & স্পোর্টস'].map((name, sortOrder) => ({ name, sortOrder })) },
  { id: 'bags', name: 'Bags', children: ['পার্স ব্যাগ', 'মেয়েদের ব্যাগ', 'ছেলেদের ব্যাগ', 'বেবি ব্যাগ', 'ক্যারি ব্যাগ'].map((name, sortOrder) => ({ name, sortOrder })) },
]
