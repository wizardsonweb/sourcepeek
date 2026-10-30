// "Randomise" in Network: fake data with the same shape as a real response (or the expected type, or the payload).
// Keys and types are kept; values are replaced with plausible random ones picked from the key name and the
// sample value — an `email` gets an e-mail, `createdAt` a date in the same format, `price` a price, `avatar` an
// image URL. Fields that look like enums (status, type, role…) keep values seen in the sample, and pagination
// fields (page, limit…) are left alone. Arrays get a new random length, modelled on their sample items.
// An empty array ([] in the sample) is filled from other known shapes of the same response (the response type, an
// earlier real answer…), or, with nothing to go on, from an item guessed from the key (`items` next to `total` →
// cart lines). A `total` next to a list of priced items is the sum of price × qty.

const FIRST = ['Ana', 'Luka', 'Mia', 'Ivan', 'Sara', 'Noah', 'Emma', 'Leo', 'Olivia', 'Marko', 'Nina', 'Liam', 'Zoe', 'Petra', 'Jakob', 'Ema', 'Mateo', 'Lucia', 'Omar', 'Hana', 'Felix', 'Iris', 'Diego', 'Yuki'];
const LAST = ['Horvat', 'Smith', 'Kovač', 'Garcia', 'Novak', 'Müller', 'Rossi', 'Jensen', 'Babić', 'Silva', 'Tanaka', 'Nguyen', 'Martin', 'Dubois', 'Kowalski', 'Andersen', 'Petrović', 'Okafor'];
const CITIES = ['Zagreb', 'Split', 'Vienna', 'Berlin', 'Lisbon', 'Austin', 'Toronto', 'Osaka', 'Melbourne', 'Oslo', 'Prague', 'Seville', 'Dublin', 'Ljubljana'];
const COUNTRIES = ['Croatia', 'Austria', 'Germany', 'Portugal', 'United States', 'Canada', 'Japan', 'Australia', 'Norway', 'Czechia', 'Spain', 'Ireland', 'Slovenia'];
const STREETS = ['Ilica', 'Main Street', 'Oak Avenue', 'Maple Road', 'Savska cesta', 'Hauptstraße', 'Rua Augusta', 'Elm Street', 'Park Lane'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella Labs', 'Stark & Co', 'Hooli', 'Vandelay', 'Northwind', 'Contoso', 'Blue Harbor', 'Pixel Forge'];
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim minim veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat proident sunt culpa officia deserunt mollit anim'.split(' ');
const TITLE_WORDS = ['Quick', 'Bright', 'Silent', 'Golden', 'Hidden', 'Modern', 'Simple', 'Urban', 'Wild', 'Little', 'Smart', 'Classic', 'Fresh', 'Bold', 'Daily', 'Garden', 'River', 'Studio', 'Market', 'Journey', 'Guide', 'Project', 'Notes', 'Story', 'Plan', 'Coffee', 'Light', 'Ocean', 'Forest', 'Report'];
const DOMAINS = ['example.com', 'mail.test', 'demo.dev', 'acme.io'];
const PRODUCT_ADJ = ['Paper', 'Oak', 'Clay', 'Linen', 'Brass', 'Walnut', 'Ceramic', 'Wool', 'Glass', 'Cotton', 'Leather', 'Bamboo', 'Marble', 'Copper', 'Rattan', 'Velvet', 'Stone', 'Birch'];
const PRODUCT_NOUN = ['lamp', 'stool', 'vase', 'chair', 'mug', 'rug', 'basket', 'candle', 'bowl', 'shelf', 'mirror', 'blanket', 'tray', 'clock', 'planter', 'cushion', 'table', 'bench'];
const productName = () => `${pick(PRODUCT_ADJ)} ${pick(PRODUCT_NOUN)}`;

const int = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const norm = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const sentence = (n = int(6, 14)) => cap(words(n)) + '.';
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const alnum = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[int(0, 35)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[int(0, 3)]}${hex(3)}-${hex(12)}`;
const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const RX = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  objectId: /^[0-9a-f]{24}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^https?:\/\//i,
  isoDateTime: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  isoDate: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2})?$/,
  hexColor: /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,
  numeric: /^-?\d+(\.\d+)?$/,
  currency: /^[A-Z]{3}$/,
  // placeholders the code scan writes for unknown values
  placeholder: /^(string|text|value|\.\.\.|…|\{[^}]*\}|lorem.*|example|foo|bar|test)$/i,
};

// Keys whose values come from a fixed set: keep values from the sample instead of inventing new ones.
const ENUM_KEY = /^(status|state|type|kind|role|roles|category|variant|level|priority|gender|lang|language|locale|method|mode|plan|tier|size|unit|visibility|severity|stage|phase|platform|provider|channel|format|direction|sort|order|currency|country(code)?|timezone|tz)$/;
// Pagination / request echo: keep as-is so paging logic keeps working.
const DATE_AT = /(created|updated|deleted|modified|published|started|ended|finished|expires|expired|sent|read|seen|last|joined|scheduled|completed|paid|archived|closed|opened|starts|ends)at$/;
const KEEP_KEY = /^(page|pages|pagesize|perpage|limit|offset|skip|take|cursor|nextcursor|prevcursor|version|apiversion|v)$/;

function personName() {
  return `${pick(FIRST)} ${pick(LAST)}`;
}

function randomDate(sample, k = '') {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const t = /^(birthday|birthdate|dob|dateofbirth|born)$/.test(k)
    ? new Date(now - int(18 * 365, 70 * 365) * DAY)
    : new Date(now - int(0, 365 * DAY) + (Math.random() < 0.15 ? int(0, 60 * DAY) : 0));
  if (typeof sample === 'string') {
    if (RX.isoDate.test(sample)) return t.toISOString().slice(0, 10);
    if (RX.time.test(sample)) return t.toISOString().slice(11, sample.length > 5 ? 19 : 16);
    if (RX.isoDateTime.test(sample)) {
      let s = t.toISOString();
      if (!/\.\d+/.test(sample)) s = s.replace(/\.\d+/, '');
      if (!/Z$/i.test(sample)) {
        const off = sample.match(/[+-]\d{2}:?\d{2}$/);
        s = s.replace(/Z$/, off ? off[0] : '');
      }
      if (sample.charAt(10) === ' ') s = s.replace('T', ' ');
      return s;
    }
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(sample)) return `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`;
    if (/^\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\.?$/.test(sample)) return `${t.getDate()}. ${t.getMonth() + 1}. ${t.getFullYear()}.`;
    return t.toISOString();
  }
  return t;
}

function imageUrl(k) {
  const seed = alnum(6);
  if (/avatar|profile|face|userimage|photo$/.test(k)) return `https://i.pravatar.cc/150?u=${seed}`;
  if (/icon|logo/.test(k)) return `https://picsum.photos/seed/${seed}/64/64`;
  if (/thumb/.test(k)) return `https://picsum.photos/seed/${seed}/160/120`;
  return `https://picsum.photos/seed/${seed}/640/400`;
}

function randomString(sample, k, ctx) {
  const s = String(sample);
  const placeholder = !s || RX.placeholder.test(s);
  // value formats first: they are certain
  if (!placeholder) {
    if (RX.uuid.test(s)) return uuid();
    if (RX.objectId.test(s)) return hex(24);
    if (RX.email.test(s)) return email(ctx);
    if (RX.isoDateTime.test(s) || RX.isoDate.test(s) || (RX.time.test(s) && (/time$/.test(k) || DATE_AT.test(k)))) return randomDate(s, k);
    if (RX.hexColor.test(s)) return '#' + hex(s.length === 4 ? 3 : 6);
    if (RX.url.test(s)) {
      if (/\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(s) || /image|img|photo|avatar|picture|thumb|logo|icon|cover|banner/.test(k)) return imageUrl(k);
      return `https://${pick(DOMAINS)}/${slugify(words(int(1, 3)))}`;
    }
    if (RX.numeric.test(s) && !/zip|postal|phone|tel/.test(k)) {
      const n = randomNumber(Number(s), k);
      return s.includes('.') ? n.toFixed((s.split('.')[1] || '').length) : String(Math.round(n));
    }
  }
  // then the key name
  if (/^(id|uuid|guid|_id|key|uid)$/.test(k) || /(id|uuid|guid)$/.test(k)) return s && /^\d+$/.test(s) ? String(int(1, 99999)) : s.length === 24 && /^[0-9a-f]+$/i.test(s) ? hex(24) : uuid();
  if (/email|mail$/.test(k)) return email(ctx);
  if (/(avatar|image|img|photo|picture|thumbnail|thumb|logo|icon|cover|banner|poster)(url|src)?$/.test(k)) return imageUrl(k);
  if (/(url|uri|link|href|website|homepage|site)$/.test(k)) return `https://${pick(DOMAINS)}/${slugify(words(int(1, 3)))}`;
  if (/(phone|mobile|tel|telephone|fax)/.test(k)) return `+385 9${int(1, 9)} ${int(100, 999)} ${int(1000, 9999)}`;
  if (/^(firstname|givenname|first|fname|forename)$/.test(k)) return (ctx.first = ctx.first || pick(FIRST));
  if (/^(lastname|surname|familyname|last|lname)$/.test(k)) return (ctx.last = ctx.last || pick(LAST));
  if (/^(username|login|handle|nickname|nick|screenname)$/.test(k)) return `${(ctx.first || pick(FIRST)).toLowerCase()}${int(1, 999)}`;
  if (/^(name|fullname|displayname|author|owner|user|customer|contact|assignee|createdby|sender|recipient)$/.test(k)) {
    if (ctx.objectHint === 'product' && k === 'name') return productName();
    const n = personName();
    [ctx.first, ctx.last] = n.split(' ');
    return n;
  }
  if (/(company|organization|organisation|org|brand|employer|vendor|publisher)/.test(k)) return pick(COMPANIES);
  if (/^(city|town)$/.test(k)) return pick(CITIES);
  if (/^country(name)?$/.test(k)) return pick(COUNTRIES);
  if (/(address|street|addressline\d?|line\d)$/.test(k)) return `${pick(STREETS)} ${int(1, 199)}`;
  if (/(zip|zipcode|postal|postalcode|postcode)/.test(k)) return String(int(10000, 99999));
  if (/(color|colour)$/.test(k)) return '#' + hex(6);
  if (/(date|time|timestamp|birthday|dob|since|until|expires|deadline)$/.test(k) || DATE_AT.test(k)) return randomDate(placeholder ? new Date().toISOString() : s, k);
  if (/slug$/.test(k)) return slugify(words(int(2, 4)));
  if (/(token|secret|hash|signature|apikey|sessionid)/.test(k)) return alnum(Math.max(16, Math.min(64, s.length || 32)));
  if (/(sku|code|ref|reference|number|ordernumber|invoiceno)$/.test(k)) return s && !placeholder ? s.replace(/[A-Z]/g, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[int(0, 23)]).replace(/\d/g, () => String(int(0, 9))) : `${alnum(3).toUpperCase()}-${int(1000, 9999)}`;
  if (/^(productname|itemname|producttitle)$/.test(k) || (ctx.objectHint === 'product' && /^(title|label)$/.test(k))) return productName();
  if (/(title|headline|subject|heading|label|caption|productname|itemname)$/.test(k)) return Array.from({ length: int(2, 4) }, () => pick(TITLE_WORDS)).join(' ');
  if (/(description|summary|bio|body|content|text|message|comment|excerpt|about|note|notes|details|review|reason|answer|question)$/.test(k)) return int(0, 2) ? sentence() : `${sentence()} ${sentence()}`;
  if (/(lat|latitude)$/.test(k)) return (Math.random() * 180 - 90).toFixed(6);
  if (/(lng|lon|long|longitude)$/.test(k)) return (Math.random() * 360 - 180).toFixed(6);
  // fall back: text of about the same length, same capitalisation
  const n = placeholder ? int(1, 3) : Math.max(1, Math.min(12, s.trim().split(/\s+/).length + int(-1, 1)));
  let out = words(n);
  if (!placeholder && /^[A-Z]/.test(s)) out = cap(out);
  if (!placeholder && /[.!?]$/.test(s)) out += s.slice(-1);
  if (!placeholder && s === s.toUpperCase() && /[A-Z]/.test(s)) out = out.toUpperCase();
  if (!placeholder && !/\s/.test(s) && /^[a-z][a-z0-9]*([_-][a-z0-9]+)+$/.test(s)) out = words(s.split(/[_-]/).length).replace(/ /g, s.includes('_') ? '_' : '-');
  return out;
}

function email(ctx) {
  const f = (ctx.first || pick(FIRST)).toLowerCase();
  const l = (ctx.last || pick(LAST)).toLowerCase();
  return slugify(`${f}.${l}`).replace(/-/g, '.') + (int(0, 3) ? '' : int(1, 99)) + '@' + pick(DOMAINS);
}

function randomNumber(sample, k) {
  const isInt = Number.isInteger(sample);
  const dec = isInt ? 0 : Math.min(6, (String(sample).split('.')[1] || '').length || 2);
  const round = (n) => (isInt ? Math.round(n) : Number(n.toFixed(dec)));
  if (/^(id|uid|_id)$/.test(k) || /id$/.test(k)) return Math.abs(sample) < 1000 ? int(1, 999) : int(1, 99999);
  if (sample > 1e12 && sample < 1e14) return Date.now() - int(0, 365 * 24 * 3600 * 1000); // ms timestamp
  if (sample > 1e9 && sample < 1e10 && (/(time|date|timestamp|exp|iat|nbf|since|until|expires)$/.test(k) || DATE_AT.test(k))) return Math.floor(Date.now() / 1000) - int(0, 365 * 24 * 3600);
  if (/^(qty|quantity)$/.test(k)) return int(1, 5);
  if (/(price|cost)/.test(k) && !/total/.test(k)) return isInt ? int(5, 250) : Number((Math.random() * 245 + 5).toFixed(2));
  if (/(price|amount|cost|total|subtotal|balance|salary|fee|tax|discount|revenue|value|paid|due)/.test(k)) return isInt ? int(1, 999) : Number((Math.random() * 999 + 1).toFixed(2));
  if (/^age$/.test(k)) return int(18, 80);
  if (/year$/.test(k)) return int(1990, new Date().getFullYear());
  if (/month$/.test(k)) return int(1, 12);
  if (/(day|dayofmonth)$/.test(k)) return int(1, 28);
  if (/(rating|stars|score)$/.test(k) && sample <= 5) return isInt ? int(1, 5) : Number((Math.random() * 4 + 1).toFixed(1));
  if (/(rating|score)$/.test(k) && sample <= 10) return round(Math.random() * 10);
  if (/(percent|percentage|pct|progress|ratio|rate)$/.test(k)) return sample <= 1 && !isInt ? Number(Math.random().toFixed(2)) : int(0, 100);
  if (/(lat|latitude)$/.test(k)) return Number((Math.random() * 180 - 90).toFixed(6));
  if (/(lng|lon|long|longitude)$/.test(k)) return Number((Math.random() * 360 - 180).toFixed(6));
  if (/(count|quantity|qty|stock|views|likes|followers|following|comments|votes|downloads|items|members|size|length|duration|minutes|seconds|hours)$/.test(k)) return int(0, isInt && sample > 500 ? sample * 2 : 500);
  if (sample === 0 || !Number.isFinite(sample)) return isInt ? int(0, 100) : Number((Math.random() * 100).toFixed(dec));
  const mag = Math.abs(sample);
  const n = mag * (0.3 + Math.random() * 1.7) * Math.sign(sample);
  return round(n);
}

/** Values of each key across the items of an array: a field with few distinct values is an enum. */
function poolsOf(items) {
  const pools = new Map();
  for (const it of items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    for (const [k, v] of Object.entries(it)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      if (!pools.has(k)) pools.set(k, []);
      pools.get(k).push(v);
    }
  }
  return pools;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PRICE_KEY = /^(price|unitprice|priceeach|cost|unitcost|amount)$/;
const QTY_KEY = /^(qty|quantity|count|units)$/;
const TOTAL_KEY = /^(total|subtotal|grandtotal|totalprice|totalamount|totalcost|sum)$/;

/** Sum of price × qty over a list of objects, or null when the items have no price. */
function lineSum(list) {
  let sum = 0;
  let found = false;
  for (const it of list) {
    if (!isObj(it)) continue;
    let p = null;
    let q = 1;
    for (const [k, v] of Object.entries(it)) {
      const nk = norm(k);
      if (p === null && PRICE_KEY.test(nk) && typeof v === 'number') p = v;
      else if (QTY_KEY.test(nk) && typeof v === 'number') q = v;
    }
    if (p === null) continue;
    found = true;
    sum += p * q;
  }
  return found ? sum : null;
}

/**
 * A sample item for an empty list nothing else describes, guessed from its key and the keys next to it.
 * Values are placeholders; gen() turns them into random ones.
 */
function guessItem(key, siblings = []) {
  const k = norm(key);
  const hasTotal = siblings.some((x) => TOTAL_KEY.test(x));
  if (/^(cart|cartitems|basket|lineitems|lines|orderitems|orderlines)$/.test(k) || (/^(items|entries|products)$/.test(k) && hasTotal)) return { productId: 0, name: 'string', price: 0, qty: 0 };
  if (/^(products|catalog|catalogue|goods|wishlist|favorites|favourites)$/.test(k)) return { id: 0, name: 'string', price: 0, stock: 0 };
  if (/^(users|members|customers|people|persons|employees|contacts|authors|participants|followers|friends|team)$/.test(k)) return { id: 0, name: 'string', email: 'string' };
  if (/^(orders|purchases|invoices|transactions|payments)$/.test(k)) return { id: 0, total: 0, createdAt: 'string' };
  if (/^(comments|reviews|messages|replies|notes)$/.test(k)) return { id: 0, author: 'string', text: 'string', createdAt: 'string' };
  if (/^(posts|articles|stories|news|blogs|entries)$/.test(k)) return { id: 0, title: 'string', excerpt: 'string', createdAt: 'string' };
  if (/^(images|photos|pictures|gallery|media)$/.test(k)) return { id: 0, url: 'https://example.com/a.jpg', alt: 'string' };
  if (/^(tags|keywords|labels|names|words)$/.test(k)) return 'string';
  if (/^(ids|.*ids)$/.test(k)) return 0;
  if (/(scores|ratings|values|amounts|prices|counts|numbers|totals|points|datapoints|series|weights|sizes)$/.test(k)) return 0;
  if (/^(emails)$/.test(k)) return 'a@example.com';
  if (/^(urls|links)$/.test(k)) return 'https://example.com/';
  if (/^(dates|timestamps)$/.test(k)) return '2026-01-01T00:00:00.000Z';
  if (/^(events|tasks|todos|projects|notifications)$/.test(k)) return { id: 0, title: 'string', createdAt: 'string' };
  return { id: 0, name: 'string' };
}

const singular = (k) => String(k || '').replace(/(ies)$/, 'y').replace(/(ses|xes)$/, (m) => m.slice(0, -2)).replace(/s$/, '');

function gen(sample, key, pools, depth, ctx, tpls = []) {
  const k = norm(key);
  if (depth > 12) return sample;
  if (sample === null || sample === undefined) return sample === undefined ? null : null;
  if (typeof sample === 'boolean') return Math.random() < 0.5;
  if (KEEP_KEY.test(k) && typeof sample !== 'object') return sample;
  if (ENUM_KEY.test(k) && typeof sample !== 'object') {
    const pool = pools && pools.get(key);
    if (pool && pool.length) return pick(pool);
    if (k === 'currency' && RX.currency.test(String(sample))) return sample;
    return sample;
  }
  if (typeof sample === 'number') return randomNumber(sample, k);
  if (typeof sample === 'string') return randomString(sample, k, ctx);
  if (Array.isArray(sample)) {
    // items of the same list in other known shapes (the response type, an earlier answer…)
    const tplItems = [];
    for (const t of tpls) if (Array.isArray(t)) tplItems.push(...t.filter((x) => x !== undefined));
    let items = sample;
    if (!items.length) items = tplItems.length ? tplItems : [guessItem(key, ctx.siblings)];
    const len = items.length;
    const n = Math.min(24, !sample.length ? int(2, 5) : len <= 1 ? int(2, 6) : int(Math.max(1, len - 2), len + 3));
    const itemPools = poolsOf(sample.length ? sample : tplItems);
    const childKey = singular(key);
    const out = [];
    const ids = new Set();
    for (let i = 0; i < n; i++) {
      let v = gen(items[i % len], childKey, itemPools, depth + 1, { objectHint: ctx.objectHint }, tplItems);
      // ids in a list must not repeat (React keys, lookups)
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const idKeys = Object.keys(v).filter((x) => /^(id|_id|uuid|key|slug)$/.test(x) || /^[a-z]+(Id|_id|ID)$/.test(x));
        for (const idKey of idKeys) {
          if (!(idKey in v)) continue;
          let guard = 0;
          while (ids.has(idKey + ':' + v[idKey]) && guard++ < 20) v[idKey] = typeof v[idKey] === 'number' ? int(1, 99999) : gen(v[idKey], idKey, null, depth + 1, {});
          ids.add(idKey + ':' + v[idKey]);
        }
      } else if (/^(id|uuid)s?$/.test(norm(key))) {
        let guard = 0;
        while (ids.has(String(v)) && guard++ < 20) v = gen(sample[i % len], childKey, null, depth + 1, {});
        ids.add(String(v));
      }
      out.push(v);
    }
    return out;
  }
  if (typeof sample === 'object') {
    const out = {};
    const keys = Object.keys(sample).map(norm);
    const child = {
      objectHint: keys.some((x) => /^(email|firstname|lastname|username|avatar)$/.test(x)) ? 'person' : keys.some((x) => /^(price|unitprice|sku|stock|brand|productid|qty|quantity)$/.test(x)) ? 'product' : null,
      siblings: keys,
    };
    const objTpls = tpls.filter(isObj);
    // name-ish fields first, so email / username can follow the same person
    const order = Object.keys(sample).sort((a, b) => Number(/name/i.test(b)) - Number(/name/i.test(a)));
    // enum pools (values seen across sibling items) apply to this object's own primitive fields only
    for (const k of order) {
      const sub = objTpls.map((t) => t[k]).filter((x) => x !== undefined);
      out[k] = gen(sample[k], k, sample[k] && typeof sample[k] === 'object' ? null : pools, depth + 1, child, sub);
    }
    const summed = new Set();
    // `total` next to a list of priced items: the sum of price × qty (when the sample agreed, or had an empty list)
    for (const [k, v] of Object.entries(sample)) {
      if (typeof v !== 'number' || !TOTAL_KEY.test(norm(k))) continue;
      for (const list of Object.keys(sample)) {
        if (!Array.isArray(sample[list]) || !Array.isArray(out[list])) continue;
        const now = lineSum(out[list]);
        if (now === null) continue;
        const before = lineSum(sample[list]);
        const agreed = sample[list].length === 0 || (before !== null && Math.abs(before - v) <= Math.max(0.01, Math.abs(v) * 0.001));
        if (!agreed) continue;
        const intPrices = out[list].every((it) => !isObj(it) || Object.values(it).every((x) => typeof x !== 'number' || Number.isInteger(x)));
        out[k] = intPrices && Number.isInteger(v) ? Math.round(now) : Number(now.toFixed(2));
        summed.add(k);
        break;
      }
    }
    // keep `total` / `count` in step with the list next to it, when the sample had them equal
    for (const [k, v] of Object.entries(sample)) {
      if (summed.has(k)) continue;
      if (typeof v !== 'number' || !/^(total|count|totalcount|totalitems|length|size|numresults|results)$/.test(norm(k))) continue;
      const list = Object.keys(sample).find((x) => Array.isArray(sample[x]) && sample[x].length === v);
      if (list) out[k] = out[list].length;
    }
    return Object.fromEntries(Object.keys(sample).map((k) => [k, out[k]]));
  }
  return sample;
}

/**
 * Random data with the same shape as `sample` (parsed JSON). `templates` are other known shapes of the same data
 * (the response type, earlier answers…): empty lists in `sample` take their items from there.
 */
export function randomLike(sample, ...templates) {
  return gen(sample, '', null, 0, {}, templates.filter((t) => t !== undefined && t !== null && typeof t === 'object'));
}

/** Parse JSON text, or undefined when it isn't JSON. */
export function parseJson(text) {
  if (text == null) return undefined;
  if (typeof text !== 'string') return text;
  const t = text.trim();
  if (!t || !/^[[{"\d\-tfn]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}
