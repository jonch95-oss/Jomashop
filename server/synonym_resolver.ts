// Global, data-driven category-code → live enum option resolver.
//
// Live Jomashop categories expose enum properties whose accepted values are
// only known at runtime (per `data.values` from `GET /v1/categories/:name`).
// Shopify products carry short category codes (OUTW, HEEL, CRBD, ...) that
// don't line up 1:1 with those accepted values. This module collapses the
// gap with a fixed table of "candidate Jomashop labels" per (field-token,
// code) pair and resolves to whichever candidate the live `acceptedOptions`
// list actually contains.
//
// Resolution is option-aware:
//   - Caller passes the LIVE accepted options for the field. The resolver
//     only emits a value that appears in that list (case-insensitive). When
//     no candidate is accepted, it returns null and the caller blocks
//     (preflight) or omits (optional field).
//   - When the field is not an enum (no acceptedOptions), the resolver
//     returns null — there's nothing to match against.
//
// The synonym table is intentionally lookup-only: it lists Jomashop-side
// labels that we've seen in production category schemas. The accepted-options
// gate keeps us honest — adding a candidate that's not in the live list
// quietly does nothing rather than poisoning a payload.

type FieldGroup =
  | "article"
  | "apparel_type"
  | "shoe_type"
  | "handbag_type"
  | "accessory_type"
  | "eyewear_type"
  | "jewelry_type";

/**
 * Collapse a schema field label to a stable token so "Article", "article",
 * and "ARTICLE" all map to the same canonical group.
 */
function fieldToken(field: string): string {
  return String(field || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Map a live schema field label to the synonym group it belongs to. Returns
 * null when the field isn't one of the enum groups this resolver handles
 * (e.g. "Color", "Material" — those don't benefit from code-based
 * synonyms).
 */
function fieldGroupFor(field: string): FieldGroup | null {
  const t = fieldToken(field);
  if (!t) return null;
  if (t.includes("article")) return "article";
  if (t.includes("appareltype") || t === "type" || t === "apparelttype") return "apparel_type";
  if (t.includes("shoetype") || t.includes("footweartype") || t.includes("shoecategory")) return "shoe_type";
  if (
    t.includes("handbagtype") ||
    t.includes("bagtype") ||
    t.includes("bagstyle") ||
    t === "style" ||
    t.includes("handbagstyle")
  )
    return "handbag_type";
  if (t.includes("accessorytype") || t.includes("accessorycategory")) return "accessory_type";
  if (t.includes("eyeweartype") || t.includes("frameshape") || t.includes("sunglasstype")) return "eyewear_type";
  if (t.includes("jewelrytype") || t.includes("jewellerytype") || t.includes("jewelrycategory"))
    return "jewelry_type";
  return null;
}

/**
 * Collapse a category code (e.g. "OUTW", "outw", "Outerwear") into a stable
 * lookup key. Strips non-alphanumerics and lowercases — matches
 * normalizeCategoryCode() in mapping.ts.
 */
function codeKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

/**
 * For each (field group, normalized code), the set of Jomashop labels we've
 * seen used in live category schemas — in priority order. The resolver
 * emits the first candidate that appears in the live accepted-options list.
 *
 * Adding a Jomashop label here is safe: the accepted-options gate guards
 * against emitting an option Jomashop didn't actually publish.
 */
const SYNONYMS: Record<FieldGroup, Record<string, string[]>> = {
  // Apparel Article — the enum that surfaces specific item categories like
  // "Coats & Jackets", "Dress Shirts", "Tuxedos". OUTW/SCOAT/COAT all map
  // to Coats & Jackets first (the live Apparel option), with looser
  // candidates as fallbacks.
  article: {
    outw: ["Coats & Jackets", "Jackets", "Coats", "Outerwear"],
    scoat: ["Coats & Jackets", "Coats", "Sport Coats", "Outerwear"],
    coat: ["Coats & Jackets", "Coats", "Outerwear"],
    jack: ["Coats & Jackets", "Jackets", "Outerwear"],
    vest: ["Vests"],
    blzr: ["Blazers", "Coats & Jackets"],
    suit: ["Suits"],
    tuxe: ["Tuxedos", "Suits"],
    pant: ["Pants", "Trousers", "Casual Pants", "Dress Pants"],
    trou: ["Pants", "Trousers", "Dress Pants"],
    jean: ["Jeans"],
    swpa: ["Sweatpants"],
    jogg: ["Joggers", "Sweatpants"],
    shor: ["Shorts"],
    legg: ["Leggings"],
    shir: ["Casual Button-Downs", "Dress Shirts", "Shirts"],
    shrt: ["Casual Button-Downs", "Dress Shirts", "Shirts"],
    drsh: ["Dress Shirts", "Shirts"],
    polo: ["Polo Shirts", "Polos", "Shirts"],
    tshr: ["T-Shirts", "Tees", "Shirts"],
    tank: ["Tank Tops", "Tanks"],
    tops: ["Tops"],
    blou: ["Blouses", "Tops"],
    swtr: ["Cardigans & Sweaters", "Sweaters"],
    hood: ["Hoodies & Sweatshirts", "Hoodies", "Sweatshirts"],
    crew: ["Hoodies & Sweatshirts", "Sweatshirts"],
    swsh: ["Hoodies & Sweatshirts", "Sweatshirts"],
    pull: ["Pullovers", "Cardigans & Sweaters", "Sweaters"],
    dres: ["Cocktail & Party Dresses", "Casual Dresses", "Dresses"],
    drco: ["Cocktail & Party Dresses", "Dresses"],
    drev: ["Evening Dresses", "Dresses"],
    skrt: ["Skirts"],
    swim: ["Swimwear", "Swimsuits", "Cover-Ups"],
    cvup: ["Cover-Ups", "Swimwear"],
    actv: ["Active & Lounge", "Activewear"],
    loun: ["Active & Lounge", "Loungewear"],
    sock: ["Socks", "Hosiery"],
    undw: ["Underwear"],
    paja: ["Pajamas & Robes", "Pajamas", "Sleepwear"],
    robe: ["Pajamas & Robes", "Robes"],
    body: ["Bodysuits"],
    jump: ["Jumpsuits & Rompers", "Jumpsuits", "Rompers"],
    rome: ["Jumpsuits & Rompers", "Rompers"],
    bras: ["Bras", "Intimates"],
    cape: ["Capes & Ponchos", "Capes"],
    scrf: ["Scarves", "Scarves & Wraps"],
    beanie: ["Hats", "Beanies"],
    hat1: ["Hats"],
    cbund: ["Cummerbunds"],
    heac: ["Headwear", "Hats"],
    mask: ["Masks"],
    clth: ["Casual Button-Downs"],
  },
  // Apparel Type — the higher-level grouping shown next to Article on the
  // live Apparel schema. Keeps the legacy mapping (OUTW → Outerwear) but
  // gated on acceptedOptions like every other group.
  apparel_type: {
    outw: ["Outerwear"],
    scoat: ["Outerwear"],
    coat: ["Outerwear"],
    blzr: ["Outerwear"],
    jack: ["Jackets", "Outerwear"],
    vest: ["Vests"],
    pant: ["Pants"],
    trou: ["Pants"],
    jean: ["Jeans"],
    swpa: ["Sweatpants"],
    jogg: ["Joggers"],
    shor: ["Shorts"],
    shrt: ["Shirts"],
    shir: ["Shirts"],
    drsh: ["Dress Shirts"],
    polo: ["Polo Shirts"],
    tshr: ["T-Shirts"],
    tank: ["Tank Tops"],
    tops: ["Tops"],
    blou: ["Blouses"],
    swtr: ["Sweaters"],
    hood: ["Hoodies"],
    crew: ["Sweatshirts"],
    swsh: ["Sweatshirts"],
    pull: ["Pullovers"],
    dres: ["Dresses"],
    skrt: ["Skirts"],
    suit: ["Suits"],
    tuxe: ["Tuxedos"],
    swim: ["Swimwear"],
    legg: ["Leggings"],
    sock: ["Socks"],
    undw: ["Underwear"],
    paja: ["Pajamas"],
    robe: ["Robes"],
    body: ["Bodysuits"],
    jump: ["Jumpsuits"],
    actv: ["Activewear"],
    bras: ["Bras"],
    cape: ["Capes"],
    scrf: ["Scarves"],
    beanie: ["Hats"],
    hat1: ["Hats"],
    cbund: ["Cummerbunds"],
    heac: ["Headwear"],
    mask: ["Masks"],
  },
  // Footwear Shoe Type / Type / Footwear Type
  shoe_type: {
    snek: ["Sneakers", "Athletic Shoes"],
    heel: ["Heels", "Pumps", "High Heels"],
    pump: ["Pumps", "Heels"],
    sand: ["Sandals"],
    loaf: ["Loafers", "Loafers & Slip-Ons", "Slip-Ons"],
    boot: ["Boots", "Ankle Boots"],
    ankb: ["Ankle Boots", "Boots"],
    knee: ["Knee-High Boots", "Boots"],
    bool: ["Boots"],
    flip: ["Flip-Flops", "Sandals"],
    derby: ["Derbys", "Oxfords"],
    oxfo: ["Oxfords", "Dress Shoes"],
    mule: ["Mules", "Slides"],
    slid: ["Slides"],
    slpr: ["Slippers"],
    dsho: ["Dress Shoes"],
    flat: ["Flats", "Ballet Flats"],
    ball: ["Ballet Flats", "Flats"],
    espa: ["Espadrilles"],
    wedg: ["Wedges"],
    moca: ["Moccasins"],
    moc: ["Moccasins"],
  },
  // Handbags Type / Style / Bag Type
  handbag_type: {
    tote: ["Tote", "Totes"],
    hand: ["Top Handle", "Top-Handle", "Satchel", "Handbag"],
    shld: ["Shoulder", "Shoulder Bag"],
    crbd: ["Crossbody", "Cross-Body", "Crossbody Bag"],
    bpck: ["Backpack", "Backpacks"],
    pouc: ["Pouch", "Pouches", "Clutch"],
    clut: ["Clutch", "Clutches"],
    bktb: ["Bucket Bag", "Bucket"],
    hobo: ["Hobo", "Hobo Bag"],
    satc: ["Satchel"],
    toph: ["Top Handle", "Top-Handle"],
    bltb: ["Belt Bag", "Belt Bags", "Waist Bag"],
    minib: ["Mini Bag", "Mini"],
    week: ["Weekender", "Duffel"],
    duff: ["Duffel", "Weekender"],
    even: ["Evening Bag", "Clutch"],
  },
  // Accessories Type (belts, wallets, hats, ties — for live "Type" /
  // "Accessory Type" / "Category" enums where present).
  accessory_type: {
    belt: ["Belts", "Belt"],
    wall: ["Wallets", "Wallet"],
    card: ["Card Holders", "Card Holder"],
    kchn: ["Keychains", "Keychain", "Key Holders"],
    chol: ["Card Holders", "Card Holder"],
    pksq: ["Pocket Squares", "Pocket Square"],
    tie1: ["Ties", "Neckties", "Tie"],
    bowt: ["Bow Ties", "Bow Tie"],
    glve: ["Gloves"],
    scrf: ["Scarves"],
    hat1: ["Hats"],
    phon: ["Phone Cases", "Phone Case"],
    luggage: ["Luggage"],
    strp: ["Straps", "Bag Straps"],
  },
  // Eyewear Type
  eyewear_type: {
    sung: ["Sunglasses"],
    opti: ["Optical", "Eyeglasses", "Optical Frames"],
    read: ["Readers", "Reading Glasses"],
  },
  // Jewelry Type
  jewelry_type: {
    neck: ["Necklaces", "Necklace"],
    ring: ["Rings", "Ring"],
    eari: ["Earrings", "Earring"],
    brac: ["Bracelets", "Bracelet"],
    pins: ["Pins & Brooches", "Pins", "Brooches"],
    cufl: ["Cufflinks", "Cuff Links"],
    pend: ["Pendants", "Pendant"],
    char: ["Charms", "Charm"],
    anke: ["Anklets", "Anklet"],
  },
};

/**
 * Pick the first candidate Jomashop option whose lowercased form appears in
 * `acceptedLower`. Returns the verbatim accepted-option spelling (Title
 * Case preserved) so the outgoing payload uses Jomashop's exact casing.
 */
function pickAcceptedCandidate(
  candidates: string[],
  acceptedOptions: string[],
): string | null {
  const acceptedLower = acceptedOptions.map((o) => String(o).toLowerCase().trim());
  for (const cand of candidates) {
    const idx = acceptedLower.indexOf(cand.toLowerCase().trim());
    if (idx !== -1) return acceptedOptions[idx];
  }
  return null;
}

/**
 * Resolve a Shopify category code (e.g. "OUTW") to the first matching
 * Jomashop accepted option for the given live schema field. Returns null
 * when the field doesn't belong to one of the synonym groups, or when no
 * candidate is in the live accepted-options list.
 *
 * Designed to be invoked AFTER the operator override resolver and BEFORE
 * the "drop unmappable enum" fallback — it's a safe, additive layer.
 */
export function resolveCategorySynonym(
  field: string,
  code: string | null | undefined,
  acceptedOptions: string[] | null | undefined,
): string | null {
  if (!Array.isArray(acceptedOptions) || acceptedOptions.length === 0) return null;
  const group = fieldGroupFor(field);
  if (!group) return null;
  const key = codeKey(code);
  if (!key) return null;
  const candidates = SYNONYMS[group][key];
  if (!candidates || candidates.length === 0) return null;
  return pickAcceptedCandidate(candidates, acceptedOptions);
}

/**
 * Variant of resolveCategorySynonym that tries multiple source codes in
 * order (e.g. raw_category_code first, then apparel_type, then category_type).
 * Returns the first hit, or null if none of the codes map to an accepted
 * option.
 */
export function resolveCategorySynonymFromAny(
  field: string,
  codes: Array<string | null | undefined>,
  acceptedOptions: string[] | null | undefined,
): string | null {
  for (const c of codes) {
    const hit = resolveCategorySynonym(field, c, acceptedOptions);
    if (hit) return hit;
  }
  return null;
}

/**
 * Read-only snapshot of the synonym table for debug endpoints and tests.
 */
export function listSynonymsForField(field: string): Record<string, string[]> | null {
  const group = fieldGroupFor(field);
  if (!group) return null;
  return { ...SYNONYMS[group] };
}

export function _fieldGroupForTest(field: string): FieldGroup | null {
  return fieldGroupFor(field);
}
