import copy,hashlib,os,re,sys,time,uuid
from datetime import datetime,timezone
from urllib.parse import urljoin,urlparse
from category_groups import CATEGORY_GROUPS,assignments
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from pymongo import MongoClient,UpdateOne
load_dotenv()
BASE="https://shopbasebd.com"; COOKIE=os.getenv("SHOPBASE_SESSION_COOKIE","").strip()
URI=os.getenv("MONGODB_URI","").strip(); DB=os.getenv("MONGODB_DATABASE","aaro")
DELAY=max(.25,float(os.getenv("SHOPBASE_REQUEST_DELAY_SECONDS","0.35")))
MARKUP=max(0,float(os.getenv("AARO_MARKUP_PERCENT","20")))
CAP=max(0,int(os.getenv("SHOPBASE_MAX_PRODUCTS_PER_RUN","0")))
DETAIL_REFRESH_DAYS=max(1,int(os.getenv("SHOPBASE_DETAIL_REFRESH_DAYS","7")))
DETAILS_VERSION=4
DIGITS=str.maketrans("০১২৩৪৫৬৭৮৯٠١٢٣٤٥٦٧٨٩","01234567890123456789")
class SyncError(RuntimeError): pass
def now(): return datetime.now(timezone.utc).isoformat()
def number(s):
 s=re.sub(r"[^0-9]","",s.translate(DIGITS)); return int(s) if s else None
def digest(*parts): return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()
def details_are_stale(product):
 if os.getenv("SHOPBASE_FORCE_DETAIL_REFRESH","false").strip().lower() in ("1","true","yes","on"): return True
 if int(product.get("detailsVersion",0) or 0)<DETAILS_VERSION: return True
 stored=str(product.get("details") or product.get("description") or "").strip()
 title=str(product.get("title") or "").strip()
 if not stored or re.sub(r"\s+"," ",stored).casefold()==re.sub(r"\s+"," ",title).casefold(): return True
 try:
  updated=datetime.fromisoformat(product.get("detailsFetchedAt",""))
  age=(datetime.now(timezone.utc)-updated).total_seconds()
  if age < DETAIL_REFRESH_DAYS*86400: return False
  item_bucket=int(hashlib.sha256(str(product.get("sourceId","")).encode()).hexdigest()[:8],16)%DETAIL_REFRESH_DAYS
  today_bucket=datetime.now(timezone.utc).timetuple().tm_yday%DETAIL_REFRESH_DAYS
  return item_bucket==today_bucket
 except Exception:
  return True
def session():
 if not COOKIE: raise SyncError("SHOPBASE_SESSION_COOKIE is missing.")
 s=requests.Session(); s.headers.update({"User-Agent":"AARO catalog sync/1.0","Accept":"text/html,application/xhtml+xml","Cookie":COOKIE}); return s
def get(s,path):
 url=urljoin(BASE,path)
 for attempt in range(5):
  try: r=s.get(url,timeout=(10,45))
  except requests.RequestException:
   if attempt==4: raise
   time.sleep(min(30,2**attempt)); continue
  if r.status_code>=500 and attempt<4:
   time.sleep(min(30,2**attempt)); continue
  break
 if r.status_code in (401,403): raise SyncError(f"ShopBase denied {urlparse(r.url).path} (HTTP {r.status_code}).")
 r.raise_for_status()
 if "login" in r.url.lower(): raise SyncError("ShopBase redirected to login; refresh the session secret.")
 time.sleep(DELAY); return BeautifulSoup(r.text,"html.parser")
def categories(soup):
 found={}
 for a in soup.select("a[href]"):
  path=urlparse(a.get("href","")).path.rstrip("/"); m=re.fullmatch(r"/store/products/(\d+)(?:/1)?",path); name=a.get_text(" ",strip=True)
  if m and name: found[m.group(1)]={"sourceId":m.group(1),"name":name,"url":path}
 if not found:
  text=soup.get_text(" ",strip=True).lower()
  if soup.select_one('input[type="password"]') or any(word in text for word in ("sign in", "log in", "login", "লগইন")):
   raise SyncError("ShopBase returned a sign-in page instead of the catalog. The saved session cookie is expired, invalid, or lacks catalog access; existing products are untouched.")
  title=soup.title.get_text(" ",strip=True)[:120] if soup.title else "(no page title)"
  product_links=len(soup.select('a[href*="/store/products/details/"]'))
  raise SyncError(f"ShopBase page loaded, but no category links matched the importer (page: {title}; product links: {product_links}). The cookie was not explicitly rejected; catalog markup or account access may have changed. Existing products are untouched.")
 return list(found.values())
def pages(soup,cid):
 m=re.search(r"Page\s+\d+\s+of\s+(\d+)",soup.get_text(" ",strip=True),re.I)
 if m: return max(1,int(m.group(1)))
 nums=[1]
 for a in soup.select("a[href]"):
  m=re.fullmatch(rf"/store/products/{re.escape(cid)}/(\d+)",urlparse(a.get("href","")).path)
  if m: nums.append(int(m.group(1)))
 return max(nums)
def card_for(a):
 n=a
 for _ in range(8):
  if n is None: break
  if n.name in ("div","article","li") and n.find("img") and "প্রাইস" in n.get_text(" ",strip=True): return n
  n=n.parent
 return a.parent
def cards(soup,cat):
 rows={}
 for a in soup.select('a[href*="/store/products/details/"]'):
  path=urlparse(a.get("href","")).path; m=re.search(r"/store/products/details/(\d+)",path)
  if not m: continue
  box=card_for(a); title_node=box.select_one(".product-name")
  title=title_node.get_text(" ",strip=True) if title_node else a.get_text(" ",strip=True)
  if not title: continue
  text=box.get_text(" ",strip=True); pm=re.search(r"প্রাইস\s*[:：]?\s*(?:৳\s*)?([০-৯0-9,]+)",text)
  if not pm: continue
  price=number(pm.group(1))
  if price is None: continue
  il=box.select_one('a[href*="/public/uploads/shop/products/"]'); image=il.get("href","") if il else ""
  if not image:
   im=box.find("img"); image=(im.get("data-src") or im.get("src") or "") if im else ""
   if not image and im and im.get("srcset"): image=im["srcset"].split(",")[0].strip().split(" ")[0]
  image=urljoin(BASE,image) if image else ""; sid=m.group(1)
  rows[sid]={"sourceId":sid,"title":title,"category":cat["name"],"categorySourceId":cat["sourceId"],"wholesalePrice":price,"sourceImage":image,"detailPath":path,"listFingerprint":digest(title,cat["sourceId"],str(price),image)}
 return list(rows.values())
DESCRIPTION_HEADING=re.compile(r"^(?:📌\s*)?পণ্যের\s+বিবরণ\s*[:：]?$",re.I)
COPY_LABEL=re.compile(r"^(?:কপি\s*করুন|কপি|copy(?:\s+(?:text|details))?)$",re.I)
def clean_detail_text(node,title):
 if node is None: return ""
 if hasattr(node,"select"):
  node=copy.deepcopy(node)
  for junk in node.select("button,input,script,style,svg,nav"):
   junk.decompose()
  raw=node.get_text("\n",strip=True)
 else:
  raw=str(node).strip()
 lines=[]
 for line in raw.splitlines():
  line=re.sub(r"\s+"," ",line).strip()
  if not line or DESCRIPTION_HEADING.fullmatch(line) or COPY_LABEL.fullmatch(line): continue
  lines.append(line)
 result="\n".join(lines).strip()
 normalize=lambda value:re.sub(r"\s+"," ",str(value)).strip().casefold()
 return result if result and normalize(result)!=normalize(title) else ""
def extract_description(soup,title):
 for selector in (".descriptionCopy",".product-description",".product_details","[itemprop='description']"):
  node=soup.select_one(selector)
  text=clean_detail_text(node,title)
  if text: return node,text
 for marker in soup.find_all(string=True):
  if not DESCRIPTION_HEADING.fullmatch(re.sub(r"\s+"," ",str(marker)).strip()): continue
  current=marker.parent
  for _ in range(6):
   if current is None: break
   pieces=[]; sibling=current.next_sibling
   while sibling is not None and sum(map(len,pieces))<12000:
    text=clean_detail_text(sibling,title)
    if text: pieces.append(text)
    sibling=sibling.next_sibling
   candidate=clean_detail_text("\n".join(pieces),title)
   if candidate: return None,candidate
   current=current.parent
 return None,""
def detail(soup,row):
 detail_node,detail_text=extract_description(soup,row["title"])
 if not detail_text:
  raise SyncError(f"Could not find product description for {row['sourceId']}; details were left unchanged.")
 description=detail_text
 text=soup.get_text(" ",strip=True)
 size_chart=""
 for node in soup.select("table, .size-chart, .sizeChart, [class*='size-guide'], [id*='size-chart'], [id*='size-guide']"):
  candidate=node.get_text("\n",strip=True)
  if candidate and re.search(r"size|measurement|মাপ|সাইজ|পরিমাপ",candidate,re.I):
   size_chart=candidate[:12000]
   break
 if not size_chart:
  match=re.search(r"(?:Size\s*Measurement|Size\s*Chart|সাইজ\s*চার্ট|পরিমাপ)[\s\S]{0,4000}",detail_text,re.I)
  if match: size_chart=match.group(0).strip()
 main=soup.select_one('a[href*="/public/uploads/shop/products/"]')
 image=main.get("href","") if main else ""
 if not image:
  node=soup.select_one('img[src*="/public/uploads/shop/products/"],img[data-src*="/public/uploads/shop/products/"]')
  image=(node.get("data-src") or node.get("src") or "") if node else ""
 image=urljoin(BASE,image) if image else row.get("sourceImage","")
 if not image: raise SyncError(f"No main product image found for {row['sourceId']}.")
 imgs=[image]
 available=bool(re.search(r"স্টক\s*[:：]?\s*আছে",text))
 unavailable=bool(re.search(r"স্টক\s*[:：]?\s*(নাই|নেই|out)",text,re.I))
 if not available and not unavailable: raise SyncError(f"Could not read stock state for {row['sourceId']}; stopping safely.")
 stock=1 if available else 0
 sku=re.search(r"SKU\s*[:：]?\s*([A-Za-z0-9_-]+)",text,re.I)
 sm=re.search(r"(?:সর্বোচ্চ|maximum)[^০-৯0-9]{0,24}([০-৯0-9,]+)",text,re.I); suggested=number(sm.group(1)) if sm else None
 if suggested is not None and suggested < row["wholesalePrice"]: suggested=None
 sizes=[]; option_values={}
 for node in soup.select("input[type='radio'], input[type='checkbox'], select"):
  name=(node.get("name") or node.get("id") or "").strip()
  value=(node.get("value") or "").strip()
  context=node.parent.get_text(" ",strip=True) if node.parent else ""
  label=node.find_parent("label") or (soup.find("label",attrs={"for":node.get("id")}) if node.get("id") else None)
  label_text=label.get_text(" ",strip=True) if label else ""
  size_context=bool(re.search(r"size|সাইজ|মাপ",f"{name} {context} {label_text}",re.I))
  if node.name=="select":
   values=[o.get_text(" ",strip=True) or (o.get("value") or "").strip() for o in node.select("option")]
   values=[v for v in values if v and not re.search(r"select|choose|বাছাই",v,re.I)]
  else:
   values=[value] if value else []
   if label_text: values=[re.sub(r"\s+"," ",label_text).strip()]
  values=[v for v in values if v and len(v)<80]
  if values:
   option_name="Size" if size_context else (name or "Option")
   option_values.setdefault(option_name,[]).extend(values)
   if size_context: sizes.extend(values)
 options=[{"name":name,"values":list(dict.fromkeys(values))} for name,values in option_values.items()]
 sizes.extend(re.findall(r"chksuccess_([A-Za-z0-9_-]+)",str(soup)))
 for node in soup.select("label, button, [role='radio']"):
  if re.search(r"size|sizing", " ".join(node.get("class",[])), re.I):
   value=node.get_text(" ",strip=True)
   if value and len(value)<20: sizes.append(value)
 sizes=list(dict.fromkeys(v for v in sizes if v))
 if detail_node is not None and hasattr(detail_node,"select"):
  attributes=[]
  for row_node in detail_node.select("tr, li, p"):
   line=row_node.get_text(" ",strip=True)
   if line and line not in attributes: attributes.append(line[:500])
 else:
  attributes=[line[:500] for line in detail_text.splitlines() if line.strip()]
 cost=row["wholesalePrice"]; retail=max(cost,round(cost*(1+MARKUP/100)/10)*10)
 if suggested: retail=suggested
 parent=row.get("parentCategory",{})
 return {"sourceId":row["sourceId"],"supplierSku":sku.group(1) if sku else row["sourceId"],"title":row["title"],"category":row["category"],"categorySourceId":row["categorySourceId"],"parentCategory":parent.get("parentName"),"parentCategoryId":parent.get("parentId"),"wholesalePrice":cost,"suggestedRetailPrice":suggested,"price":retail,"compareAt":None,"description":description,"details":detail_text,"attributes":attributes,"sizeChart":size_chart,"stock":stock,"sizes":sizes,"options":options,"sourceStatus":"available" if stock else "out_of_stock","sourceImage":imgs[0],"sourceImages":imgs,"listFingerprint":row["listFingerprint"],"source":"shopbase","updatedAt":now()}
def mirror(url,sid):
 cloud,key,secret=(os.getenv(x,"").strip() for x in ("CLOUDINARY_CLOUD_NAME","CLOUDINARY_API_KEY","CLOUDINARY_API_SECRET"))
 if not(cloud and key and secret and os.getenv("CLOUDINARY_MIRROR_IMAGES","false").lower()=="true"): return url
 from requests.auth import HTTPBasicAuth
 img=requests.get(url,timeout=(10,60)); img.raise_for_status()
 r=requests.post(f"https://api.cloudinary.com/v1_1/{cloud}/image/upload",data={"public_id":f"aaro/shopbase/{sid}","overwrite":"true"},files={"file":(f"{sid}.jpg",img.content,img.headers.get("Content-Type","image/jpeg"))},auth=HTTPBasicAuth(key,secret),timeout=(10,120))
 r.raise_for_status(); return r.json()["secure_url"]
def run():
 if not URI: raise SyncError("MONGODB_URI is missing.")
 runid,started=str(uuid.uuid4()),now(); client=MongoClient(URI,serverSelectionTimeoutMS=10000); db=client[DB]
 p,c,runs=db.products,db.categories,db.sync_runs; p.create_index("sourceId",unique=True,partialFilterExpression={"source":"shopbase"}); c.create_index("sourceId",unique=True)
 seen=created=changed=unchanged=0; failed_details=[]; categories_processed=0; products_discovered=0
 runs.update_one({"runId":runid},{"$set":{"runId":runid,"status":"running","phase":"connecting","startedAt":started,"updatedAt":started,"categoriesProcessed":0,"totalCategories":0,"productsProcessed":0,"totalProducts":0,"productsDiscovered":0,"created":0,"changed":0,"unchanged":0,"skippedDetails":0}},upsert=True)
 def report_progress(**values):
  values["updatedAt"]=now()
  runs.update_one({"runId":runid},{"$set":values})
 try:
  report_progress(phase="reading_categories")
  s=session(); cats=categories(get(s,"/store/products/all"))
  if len(cats)<30: raise SyncError(f"Only {len(cats)} categories parsed; refusing a partial catalog scan.")
  report_progress(phase="scanning_categories",totalCategories=len(cats),categoriesProcessed=0)
  category_map,_=assignments(cats)
  unmatched=[cat["name"] for cat in cats if category_map[cat["sourceId"]]["unmatched"]]
  for order,group in enumerate(CATEGORY_GROUPS):
   c.update_one({"sourceId":f"aaro-parent:{group['id']}"},{"$set":{"name":group["name"],"slug":group["id"],"type":"parent","source":"aaro","sortOrder":order,"updatedAt":now()}},upsert=True)
  listing={}
  for source_order,cat in enumerate(cats):
   parent=category_map[cat["sourceId"]]
   c.update_one({"sourceId":cat["sourceId"]},{"$set":{"name":cat["name"],"source":"shopbase","type":"subcategory","parentId":parent["parentId"],"parentName":parent["parentName"],"sortOrder":parent["sortOrder"],"unmatchedCategoryLabel":parent["unmatched"],"sourceOrder":source_order,"updatedAt":now()}},upsert=True)
   first=get(s,cat["url"])
   for page in range(1,pages(first,cat["sourceId"])+1):
    soup=first if page==1 else get(s,f"/store/products/{cat['sourceId']}/{page}")
    for row in cards(soup,cat):
     row["parentCategory"]=parent
     listing[row["sourceId"]]=row
   categories_processed=source_order+1; products_discovered=len(listing)
   report_progress(phase="scanning_categories",categoriesProcessed=categories_processed,totalCategories=len(cats),productsDiscovered=products_discovered)
  if not listing: raise SyncError("Zero product cards found; existing items were not pruned.")
  products_discovered=len(listing)
  report_progress(phase="updating_products",categoriesProcessed=len(cats),totalCategories=len(cats),productsDiscovered=products_discovered,totalProducts=products_discovered,productsProcessed=0,created=0,changed=0,unchanged=0,skippedDetails=0)
  previous_count=p.count_documents({"source":"shopbase"})
  if previous_count and len(listing)<int(previous_count*.7): raise SyncError("Catalog count dropped sharply; refusing a partial scan.")
  old={x["sourceId"]:x for x in p.find({"source":"shopbase"},{"sourceId":1,"listFingerprint":1,"imageOverride":1,"detailsFetchedAt":1,"detailsVersion":1})}; batch=[]
  for sid,row in listing.items():
   prev=old.get(sid)
   if prev and prev.get("listFingerprint")==row["listFingerprint"] and not details_are_stale(prev):
    p.update_one({"sourceId":sid,"source":"shopbase"},{"$set":{"lastSeenRun":runid,"missingRuns":0,"parentCategory":row["parentCategory"]["parentName"],"parentCategoryId":row["parentCategory"]["parentId"]}}); unchanged+=1
   else:
    try: doc=detail(get(s,row["detailPath"]),row)
    except Exception as error:
     failed_details.append({"sourceId":sid,"error":str(error)[:240]})
     print(f"Detail skipped after retries for product {sid}: {error}",file=sys.stderr)
     if prev: p.update_one({"sourceId":sid,"source":"shopbase"},{"$set":{"lastSeenRun":runid,"missingRuns":0,"parentCategory":row["parentCategory"]["parentName"],"parentCategoryId":row["parentCategory"]["parentId"]}})
     seen+=1
     if seen%25==0 or seen==len(listing): report_progress(phase="updating_products",productsProcessed=seen,totalProducts=len(listing),productsDiscovered=len(listing),created=created,changed=changed,unchanged=unchanged,skippedDetails=len(failed_details))
     continue
    hosted=mirror(doc["sourceImage"],sid)
    doc.update({"images":[hosted],"image":(prev.get("imageOverride") or hosted) if prev else hosted,"imageOverride":prev.get("imageOverride") if prev else None,"active":bool(doc["stock"]),"detailsFetchedAt":now(),"detailsVersion":DETAILS_VERSION,"lastSeenRun":runid,"missingRuns":0})
    batch.append(UpdateOne({"sourceId":sid,"source":"shopbase"},{"$set":doc},upsert=True))
    if prev: changed+=1
    else: created+=1
    if len(batch)>=250: p.bulk_write(batch,ordered=False); batch.clear()
   seen+=1
   if seen%25==0 or seen==len(listing): report_progress(phase="updating_products",productsProcessed=seen,totalProducts=len(listing),productsDiscovered=len(listing),created=created,changed=changed,unchanged=unchanged,skippedDetails=len(failed_details))
  if batch: p.bulk_write(batch,ordered=False)
  for missing in p.find({"source":"shopbase","lastSeenRun":{"$ne":runid}},{"sourceId":1,"missingRuns":1}):
   n=int(missing.get("missingRuns",0))+1; p.update_one({"sourceId":missing["sourceId"],"source":"shopbase"},{"$set":{"missingRuns":n,"active":n<2,"stock":0 if n>=2 else None,"sourceStatus":"missing" if n>=2 else "not_seen"}})
  summary={"runId":runid,"status":"success_with_skipped_details" if failed_details else "success","phase":"complete","categories":len(cats),"categoryGroups":len(CATEGORY_GROUPS),"unmatchedCategories":unmatched,"failedDetails":failed_details,"seen":seen,"productsDiscovered":len(listing),"productsProcessed":seen,"totalProducts":len(listing),"categoriesProcessed":len(cats),"totalCategories":len(cats),"created":created,"changed":changed,"unchanged":unchanged,"skippedDetails":len(failed_details),"startedAt":started,"finishedAt":now(),"updatedAt":now()}
  runs.update_one({"runId":runid},{"$set":summary},upsert=True); print({k:v for k,v in summary.items() if k!="runId"})
 except Exception as e:
  runs.update_one({"runId":runid},{"$set":{"status":"failed","phase":"failed","error":str(e)[:500],"startedAt":started,"finishedAt":now(),"updatedAt":now(),"seen":seen,"productsProcessed":seen,"categoriesProcessed":categories_processed,"productsDiscovered":products_discovered,"created":created,"changed":changed,"unchanged":unchanged,"skippedDetails":len(failed_details)}},upsert=True); raise
 finally: client.close()
if __name__=="__main__":
 try: run()
 except Exception as e: print(f"Catalog sync failed: {e}",file=sys.stderr); raise SystemExit(1)

