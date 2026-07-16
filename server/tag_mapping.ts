// Tag-code → Jomashop category/field mapping.
//
// The Matrixify metafield wipes destroyed custom.category codes, but the
// products' TAGS still carry the operator's garment vocabulary (LOAF, SHIR,
// HOOD, ...). This module maps those codes — as confirmed by the operator in
// the 2026-07-16 tag-mapping review — to the Jomashop category and the
// live-schema enum values (Apparel Type, Article, Shoe Category/Style,
// Accessory Type, Handbag Style, Eyewear Subclass).
//
// The mapper consults this ONLY as a fallback: explicit metafields always
// win; tag defaults fill blanks. Prop keys are normalized label tokens
// (lowercase alphanumerics) so they match live schema labels regardless of
// spacing/casing.

import type { SupportedCategory } from "@shared/schema";

export type TagCategoryDefaults = {
  code: string;
  category: SupportedCategory;
  props: Record<string, string>;
};

type Entry = { category: SupportedCategory; props: Record<string, string> };

const A = (appareltype: string, article: string): Entry => ({
  category: "Apparel",
  props: { appareltype, article },
});
const F = (shoecategory: string, shoestyle: string): Entry => ({
  category: "Footwear",
  props: { shoecategory, shoestyle },
});
const AC = (accessorytype: string): Entry => ({
  category: "Accessories",
  props: { accessorytype },
});
const HB = (handbagstyle: string): Entry => ({
  category: "Handbags",
  props: { handbagstyle },
});

export const TAG_MAPPINGS: Record<string, Entry> = {
  // ---- Apparel ----
  SHIR: A("Tops", "Shirts & Blouses"),
  PANT: A("Bottoms", "Pants & Leggings"),
  JACK: A("Outerwear", "Coats & Jackets"),
  TROU: A("Bottoms", "Pants & Leggings"),
  TOPS: A("Tops", "Shirts & Blouses"),
  TSHR: A("Tops", "T-Shirts & Henleys"),
  UNDW: A("Undergarments", "Underwear & Undershirts"),
  SKRT: A("Bottoms", "Skirts"),
  CARD: A("Tops", "Cardigans & Sweaters"),
  SWTR: A("Tops", "Cardigans & Sweaters"),
  COAT: A("Outerwear", "Coats & Jackets"),
  JEAN: A("Bottoms", "Jeans & Denim"),
  HOOD: A("Tops", "Hoodies & Sweatshirts"),
  SWPA: A("Bottoms", "Active & Lounge"),
  DRSH: A("Tops", "Dress Shirts"),
  POLO: A("Tops", "Polos"),
  SWIM: A("Swim", "Swimsuits"),
  OUTW: A("Outerwear", "Coats & Jackets"),
  BLZR: A("Outerwear", "Blazers"),
  TUXE: A("Sets", "Suits & Tuxedos"),
  CREW: A("Tops", "Hoodies & Sweatshirts"),
  SWSH: A("Tops", "Hoodies & Sweatshirts"),
  BRAS: A("Undergarments", "Lingerie"),
  SUIT: A("Sets", "Suits & Tuxedos"),
  VEST: A("Tops", "Vests"),
  TANK: A("Tops", "T-Shirts & Henleys"),
  JOGG: A("Bottoms", "Active & Lounge"),
  JUMP: A("Sets", "Jumpsuits & Rompers"),
  BLOU: A("Tops", "Shirts & Blouses"),
  PAJA: A("Undergarments", "Sleepwear"),
  ROBE: A("Undergarments", "Robes"),
  SCOAT: A("Outerwear", "Sport Coats"),
  BODY: A("Tops", "Active & Lounge"),
  LEGG: A("Bottoms", "Pants & Leggings"),
  SOCK: A("Undergarments", "Hosiery"),
  CAPE: A("Outerwear", "Coats & Jackets"),
  TIGH: A("Undergarments", "Hosiery"),
  DJAC: A("Outerwear", "Coats & Jackets"),
  LONG: A("Tops", "Shirts & Blouses"),
  // ---- Footwear ----
  LOAF: F("Loafers", "Loafer"),
  SNEK: F("Sneakers", "Fashion"),
  SAND: F("Sandals", "Slides"),
  BOOT: F("Boots", "Ankle boots"),
  DSHO: F("Oxfords & Derbys", "Derby"),
  BALL: F("Flats", "Ballerinas"),
  PUMP: F("Heels", "Pumps"),
  FLAT: F("Flats", "Ballerinas"),
  HEEL: F("Heels", "Heels"),
  DERBY: F("Oxfords & Derbys", "Derby"),
  MULE: F("Sandals", "Mules"),
  WEDG: F("Heels", "Wedges"),
  FLIP: F("Sandals", "Flip Flops"),
  SLPR: F("Slippers", "Fashion"),
  ESPA: F("Espadrilles", "Fashion"),
  // ---- Accessories ----
  PHON: AC("Phone Case"),
  PKSQ: AC("Grooming Kit"),
  MASK: AC("Masks"),
  WALL: AC("Wallets"),
  HAIC: AC("Charm"),
  KCHN: AC("Keychains"),
  BPCK: AC("Backpack"),
  BLAN: AC("Blanket"),
  STRP: AC("Straps"),
  CHOL: AC("Card Case"),
  WALC: AC("Wallets"),
  // Jomashop's Accessory Type list has no "Belts" — the only Belts value
  // lives under Handbag Style, so belts route through Handbags.
  BELT: HB("Belts"),
  // ---- Handbags ----
  BAGS: HB("Top Handle Bag"),
  HAND: HB("Top Handle Bag"),
  TOTE: HB("Tote"),
  SHLD: HB("Shoulder Bag"),
  CRBD: HB("Crossbody"),
  POUC: HB("Pouch"),
  CLTH: HB("Clutch"),
  TOPH: HB("Top Handle Bag"),
  // ---- Eyewear ----
  SUNG: { category: "Eyewear", props: { eyewearsubclass: "Sunglasses", framestyle: "Square" } },
  OPTI: { category: "Eyewear", props: { eyewearsubclass: "Eyeglass Frames", framestyle: "Square" } },
  // Luggage (Ted Baker spinner sets typed "Clothing" by the feed).
  LUGG: { category: "Handbags", props: { handbagstyle: "Luggage", gender: "Unisex" } },
};

/** Codes deliberately unmapped per operator review (jewelry, home goods,
 *  scarves/gloves/headwear/bow ties with no Jomashop category, cummerbunds,
 *  and plain gender tags). Products carrying ONLY these stay unpushed. */
export const IGNORED_TAGS = new Set([
  "MEN", "WOMEN", "UNI", "NECK", "PINS", "CBUND", "HOME", "RING", "BRAC",
  "SCRF", "HEAC", "BOWT", "GLVE",
]);

/** Title keywords → tag code, for products whose tags carry no garment code
 *  (operator: "derive from titles where possible"). Order matters. */
const TITLE_KEYWORDS: Array<[RegExp, string]> = [
  [/sneaker|trainer/i, "SNEK"],
  [/loafer|moccasin/i, "LOAF"],
  [/\bboot/i, "BOOT"],
  [/sandal|slide\b|flip.?flop/i, "SAND"],
  [/\bmule/i, "MULE"],
  [/\bpump/i, "PUMP"],
  [/\bheel/i, "HEEL"],
  [/derby|oxford/i, "DSHO"],
  [/ballerina|ballet/i, "BALL"],
  [/espadrille/i, "ESPA"],
  [/slipper/i, "SLPR"],
  [/hoodie/i, "HOOD"],
  [/sweatshirt|crewneck/i, "SWSH"],
  [/t.?shirt|\btee\b|henley/i, "TSHR"],
  [/polo\b/i, "POLO"],
  [/dress shirt/i, "DRSH"],
  [/blouse/i, "BLOU"],
  [/cardigan|sweater|knit/i, "SWTR"],
  [/blazer/i, "BLZR"],
  [/sport ?coat/i, "SCOAT"],
  [/tuxedo/i, "TUXE"],
  [/\bsuit\b/i, "SUIT"],
  [/jacket/i, "JACK"],
  [/\bcoat\b|parka|puffer/i, "COAT"],
  [/jumpsuit|romper/i, "JUMP"],
  [/legging/i, "LEGG"],
  [/jogger|sweatpant/i, "SWPA"],
  [/jean|denim pant/i, "JEAN"],
  [/trouser|\bpant/i, "PANT"],
  [/skirt/i, "SKRT"],
  [/\bshort/i, "SHRT"],
  [/swim|bikini/i, "SWIM"],
  [/\bdress\b|gown/i, "DRES"],
  [/\bvest\b/i, "VEST"],
  [/\btank\b/i, "TANK"],
  [/pajama|sleepwear/i, "PAJA"],
  [/\brobe\b/i, "ROBE"],
  [/lingerie|\bbra[s]?\b/i, "BRAS"],
  [/underwear|boxer|brief/i, "UNDW"],
  [/hosiery|sock|tight/i, "SOCK"],
  [/\bshirt/i, "SHIR"],
  [/\btop[s]?\b/i, "TOPS"],
  [/backpack/i, "BPCK"],
  [/crossbody/i, "CRBD"],
  [/\btote\b/i, "TOTE"],
  [/clutch/i, "CLTH"],
  [/shoulder bag/i, "SHLD"],
  [/pouch/i, "POUC"],
  [/top handle/i, "TOPH"],
  [/luggage|spinner|suitcase|pc set \(\d{2}/i, "LUGG"],
  [/handbag|\bbag\b/i, "BAGS"],
  [/wallet/i, "WALL"],
  [/keychain/i, "KCHN"],
  [/phone case|iphone case/i, "PHON"],
  [/sunglass/i, "SUNG"],
  [/eyeglass|optical/i, "OPTI"],
  [/\bbelt\b/i, "BELT"],
];

/** True when a size token looks like a numeric waist size (26–46). */
function isWaistSize(tok: string | null | undefined): boolean {
  const m = String(tok ?? "").trim().match(/^(\d{2}(?:\.\d)?)$/);
  if (!m) return false;
  const n = parseFloat(m[1]);
  return n >= 24 && n <= 46;
}

/**
 * Resolve tag-based category + required-enum defaults for a product.
 * Returns null when no confirmed garment code (or title keyword) applies.
 *
 * Special cases from the operator review:
 *  - SHRT splits by size: numeric waist sizes → Shorts; letter sizes → Shirts.
 *  - DRES splits by title: gown/evening → Evening & Formal Gowns;
 *    cocktail/party/mini → Cocktail & Party Dresses; else Summer Dresses.
 */
export function resolveTagCategoryDefaults(input: {
  tags?: string[] | string | null;
  title?: string | null;
  sizeToken?: string | null;
}): TagCategoryDefaults | null {
  const tags = (Array.isArray(input.tags)
    ? input.tags
    : String(input.tags ?? "").split(",")
  ).map((t) => String(t).trim().toUpperCase());
  const title = String(input.title ?? "");

  let code: string | null = null;
  for (const t of tags) {
    if (TAG_MAPPINGS[t] || t === "SHRT" || t === "DRES") {
      code = t;
      break;
    }
  }
  if (!code) {
    // No garment tag — try title keywords (operator-approved fallback).
    for (const [re, c] of TITLE_KEYWORDS) {
      if (re.test(title)) {
        code = c;
        break;
      }
    }
  }
  if (!code) return null;

  if (code === "SHRT") {
    return isWaistSize(input.sizeToken)
      ? { code: "SHRT", category: "Apparel", props: { appareltype: "Bottoms", article: "Shorts" } }
      : { code: "SHRT", category: "Apparel", props: { appareltype: "Tops", article: "Shirts & Blouses" } };
  }
  if (code === "DRES") {
    const article = /gown|evening/i.test(title)
      ? "Evening & Formal Gowns"
      : /cocktail|party|mini/i.test(title)
        ? "Cocktail & Party Dresses"
        : "Summer Dresses";
    return { code: "DRES", category: "Apparel", props: { appareltype: "Dresses", article } };
  }
  const entry = TAG_MAPPINGS[code];
  return entry ? { code, category: entry.category, props: entry.props } : null;
}
