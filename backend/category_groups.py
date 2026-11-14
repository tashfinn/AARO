"""AARO's curated parent-category taxonomy for ShopBase subcategories.

The child labels mirror the category cards supplied by the store owner. Parent
assignments are intentionally separate from ShopBase's source category IDs so
the daily importer can keep refreshing source categories without losing AARO's
navigation structure.
"""
import re
import unicodedata


CATEGORY_GROUPS = [
    {"id": "mens-winter", "name": "Men's Winter", "children": [
        "সলিড হুডি", "কন্ট্রাস্ট হুডি", "পাফার জ্যাকেট", "ভার্সিটি জ্যাকেট",
        "ভেস্ট জ্যাকেট", "জেন্টস সুইটশার্ট", "জেন্টস সুয়েটার", "ফুল স্লিভ টি-শার্ট",
        "ডেনিম শার্ট", "ডেনিম জ্যাকেট", "জেন্টস শ্যাকেট", "হুডি সেট",
        "ফুল স্লিভ সেট", "ডেনিম প্যান্ট", "জগার্স", "প্যান্ট+ট্রাউজার",
    ]},
    {"id": "womens-winter", "name": "Ladies' Winter", "children": [
        "লেডিস হুডি", "জার্সি জ্যাকেট", "লেডিস জ্যাকেট", "ডেনিম জ্যাকেট",
        "লেডিস ওভারকোট", "লেডিস সোয়েটার", "ভেস্ট জ্যাকেট", "লেডিস শাল",
    ]},
    {"id": "kids-winter", "name": "Kids' Winter", "children": [
        "পাফার জ্যাকেট", "গার্লস হুডি", "হুডি সেট", "হুডি সেট-২", "হুডি সেট-৩",
        "হুডি সেট-৪", "সুইটশার্ট সেট", "ব্ল্যাঙ্কেট", "গার্লস ওভারকোট",
    ]},
    {"id": "boys-clothing", "name": "Boys' Clothing", "children": [
        "পলো শার্ট", "কাতুয়া", "প্রিন্টেড টি-শার্ট", "বেসিক টি-শার্ট", "প্রিন্ট শার্ট",
        "সলিড শার্ট", "চেক শার্ট", "শার্ট কাপড়", "শার্ট কম্বো", "ফুল স্লিভ সেট",
        "এমব্রয়ডারি পাঞ্জাবি", "প্রিন্ট পাঞ্জাবি", "পাঞ্জাবি কম্বো", "ওয়ার্ল্ড কাপ",
    ]},
    {"id": "womens-clothing", "name": "Ladies' Clothing", "children": [
        "রেডিমেড থ্রিপিস", "আনস্টিচড থ্রিপিস", "গাউন & কুর্তি", "লেহেঙ্গা & পার্টি",
        "ওয়েস্টার্ন ড্রেস", "টি-শার্ট & স্কার্ট", "ইনার & নাইটি", "শাড়ি",
        "হ্যান্ডপ্রিন্ট শাড়ি", "ইন্ডিয়ান শাড়ি", "তাঁতের শাড়ি", "বোরকা",
        "হিজাব & নিকাব", "মুসলিম ড্রেস",
    ]},
    {"id": "baby-collection", "name": "Baby Collection", "children": [
        "বয়েজ টি-শার্ট সেট", "বেবি শার্ট", "বেবি পাঞ্জাবি", "গার্লস টি-শার্ট সেট",
        "কিডস প্যান্ট", "বেবি কামিজ", "পরী ড্রেস", "বেবি বোরকা", "খেলনা ও দোলনা",
    ]},
    {"id": "home-decor", "name": "Home & Decor", "children": [
        "রেগুলার বেডশীট", "ওয়াটারপ্রুফ বেডশীট", "রেগুলার ডাইনিং", "ওয়াটারপ্রুফ ডাইনিং",
        "কম্বল", "এসি কাঁথা", "গৃহ সজ্জা",
    ]},
    {"id": "electronics-gadgets", "name": "Electronics & Gadgets", "children": [
        "ফ্যান", "গ্যাজেটস", "ঘড়ি", "হেডফোন", "স্মার্ট-ওয়াচ", "পাওয়ার-ব্যাংক",
        "ক্যামেরা", "স্পিকার",
    ]},
    {"id": "jewelry-accessories", "name": "Jewelry & Accessories", "children": [
        "ক্লিপ & ব্যান্ড", "এক্সেসরিজ", "বিউটি কেয়ার", "ন্যাচারাল কেয়ার",
    ]},
    {"id": "couple-gifts", "name": "Couple & Gift Sets", "children": [
        "কাপল শাড়ি", "কাপল ড্রেস", "শাড়ি কম্বো", "কাপল ঘড়ি", "ঘড়ি কম্বো",
        "গিফট আইটেম", "মিস্ট্রি বক্স",
    ]},
    {"id": "seasonal", "name": "Seasonal Products", "children": [
        "ছাতা", "রেইন কোট", "কাস্টম টি-শার্ট",
    ]},
    {"id": "other-categories", "name": "Other Categories", "children": [
        "হোম কেয়ার", "পার্সোনাল কেয়ার", "টয়স & স্পোর্টস",
    ]},
    {"id": "bags", "name": "Bags", "children": [
        "পার্স ব্যাগ", "মেয়েদের ব্যাগ", "ছেলেদের ব্যাগ", "বেবি ব্যাগ", "ক্যারি ব্যাগ",
    ]},
]


def normalize(value):
    value = unicodedata.normalize("NFKC", str(value or "")).casefold()
    value = value.replace("\u200c", "").replace("\u200d", "")
    return re.sub(r"[\s\u00a0\-–—_.,:;|]+", "", value)


def assignments(categories):
    """Map source category IDs to a parent, preserving all unknown categories.

    If the source has duplicate display names (for example, Denim Jacket in
    men's and ladies' winter), screenshot order is used as a deterministic tie
    breaker. Unmatched categories remain visible under Other Categories.
    """
    choices = {}
    for group in CATEGORY_GROUPS:
        for order, label in enumerate(group["children"]):
            choices.setdefault(normalize(label), []).append((group, order))
    occurrences = {}
    result = {}
    unmatched = []
    for source in categories:
        key = normalize(source.get("name"))
        matches = choices.get(key, [])
        if not matches:
            group = next(item for item in CATEGORY_GROUPS if item["id"] == "other-categories")
            unmatched.append(source.get("name", ""))
            child_order = 1000 + len(unmatched)
        else:
            index = occurrences.get(key, 0)
            group, child_order = matches[min(index, len(matches) - 1)]
            occurrences[key] = index + 1
        result[str(source["sourceId"])] = {
            "parentId": group["id"],
            "parentName": group["name"],
            "sortOrder": child_order,
            "unmatched": not bool(matches),
        }
    return result, unmatched


def category_group_payload(categories):
    """Return API-ready main categories with their source subcategories."""
    assigned, _ = assignments(categories)
    by_id = {str(item.get("sourceId")): item for item in categories}
    # Once the importer has written a manual assignment, trust that stable
    # source-ID mapping. Name-based matching is only the bootstrap path.
    for source_id, item in by_id.items():
        parent_id = item.get("parentId")
        if parent_id and any(group["id"] == parent_id for group in CATEGORY_GROUPS):
            assigned[source_id] = {
                "parentId": parent_id,
                "parentName": item.get("parentName") or next(group["name"] for group in CATEGORY_GROUPS if group["id"] == parent_id),
                "sortOrder": item.get("sortOrder", 1000),
                "unmatched": bool(item.get("unmatchedCategoryLabel", False)),
            }
    groups = []
    for group in CATEGORY_GROUPS:
        children = []
        for source_id, parent in assigned.items():
            if parent["parentId"] != group["id"]:
                continue
            item = by_id.get(source_id, {})
            children.append({
                "sourceId": source_id,
                "name": item.get("name", ""),
                "sortOrder": parent["sortOrder"],
            })
        children.sort(key=lambda item: (item["sortOrder"], normalize(item["name"])))
        groups.append({"id": group["id"], "name": group["name"], "children": children})
    return groups
