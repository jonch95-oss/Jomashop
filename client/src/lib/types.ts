export type ConfigStatus = {
  app: { baseUrl: string; env: string };
  shopify: {
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
    appUrlConfigured: boolean;
    scopes: string[];
    callbackUrl: string;
    startUrl: string;
    embeddedAppPlaceholder: boolean;
  };
  jomashop: {
    baseUrl: string;
    emailConfigured: boolean;
    passwordConfigured: boolean;
    sessionActive: boolean;
  };
  credentialStatuses: Array<{
    id: number;
    key: string;
    source: string;
    configured: boolean;
    lastCheckedAt: number | null;
  }>;
};

export type SessionTestResult = {
  configured: boolean;
  ok: boolean;
  status?: number;
  message: string;
};

export type CategorySchema = {
  source: "live" | "fallback";
  name: string;
  schema: {
    name?: string;
    properties: Array<{
      field: string;
      type?: string;
      required?: boolean;
      options?: string[];
      example?: string;
    }>;
  };
};

export type MappedProduct = {
  /** Required category property names that came back null/empty (e.g. ["color", "material"]). */
  missing_required?: string[];
  /** Required top-level field names that are missing (e.g. ["sku", "manufacturer_number"]). */
  missing_top_level?: string[];
  /** Required enum fields whose accepted Jomashop options aren't verified
   *  and no enum override resolved them. Each entry includes the canonical
   *  source value the mapper tried, if any. UI uses this to render
   *  "Fix mapping for Article" with an actionable reason. */
  unverified_required_options?: Array<{ field: string; value?: string }>;
  category: "Shoes" | "Handbags" | "Clothing";
  is_sample?: boolean;
  raw_category?: string | null;
  suggested_category?: string;
  /** True when the Shopify category code is ambiguous (e.g. "WALL"). UI
   *  surfaces "Jomashop category: needs verification" until the operator
   *  picks one. */
  ambiguous_category?: boolean;
  vendor_sku: string;
  sku?: string;
  manufacturer_number?: string | null;
  name: string;
  description: string;
  brand: string;
  price: number | null;
  msrp: number | null;
  commercial_discount: number;
  jomashop_price: number | null;
  images: string[];
  properties: Record<string, string | number | boolean | null>;
  variants: Array<{
    vendor_sku: string;
    price: number | null;
    jomashop_price: number | null;
    quantity: number;
    status: "active" | "out_of_stock" | "inactive";
    options: Record<string, string>;
  }>;
  warnings: string[];
  source: { shopify_product_id?: string | number; shopify_variant_ids: Array<string | number> };
  /** Server-side push state for this Shopify variant SKU. "not_pushed" when
   *  the SKU has never been sent to Jomashop. "pushed" after a successful
   *  POST /v1/products. "rejected" when the last push returned a validation
   *  error like "Brand must exist". "failed" for non-validation errors. */
  push_state?: "not_pushed" | "pushed" | "rejected" | "failed";
  jomashop_sku?: string | null;
  last_push_error?: string | null;
  last_pushed_at?: number | null;
  /** Machine list returned by Jomashop on the last rejection (e.g. ["category", "brand"]). */
  last_invalid_params?: string[] | null;
  /** Exact category string that was rejected on the last push attempt. */
  last_rejected_category?: string | null;
  /** Exact brand string that was rejected on the last push attempt. */
  last_rejected_brand?: string | null;
  /** Stricter readiness signal computed by the server. UI uses this for the
   *  "Ready to push" filter so products with missing fields, unverified
   *  categories, or known-rejected pushes never show as ready. */
  readiness?: "ready" | "missing" | "needs-category-verification" | "rejected" | "sample";
  /** Live /i1 resolution context attached by the server so the UI can show
   *  "Jomashop category: Footwear (id: 12)" or "Brand not found; did you
   *  mean Tod's?" without re-hitting /api/jomashop/resolve-brand per row. */
  jomashop_resolution?: {
    outbound_brand: string;
    outbound_category: string;
    manufacturer: { id: number | string; name: string } | null;
    manufacturer_suggestion: { id: number | string; name: string } | null;
    category_record: { id: number | string; name: string } | null;
    i1_available: boolean;
  };
  /** Where the category property schema for this row came from. "fallback"
   *  means the bundled exact-label schema was used because the live lookup
   *  was unavailable. The UI uses this to label the Category Properties
   *  panel ("Live schema" vs "Fallback schema"). */
  schema_source?: "live-i1" | "live-v1" | "fallback" | "none";
  /** Field names + required flags from the resolved schema. Surfaced so
   *  the UI can render the Category Properties panel even when the Shopify
   *  product lacks values for those fields. */
  schema_fields?: Array<{ field: string; required: boolean }>;
  /** Compact echo of the raw Shopify metafields + options the mapper saw.
   *  Surfaced in the UI as an expandable debug panel for diagnosing
   *  missing-field complaints. */
  debug_raw?: {
    metafields: Array<{
      namespace?: string;
      key?: string;
      name?: string;
      label?: string;
      value: string;
    }>;
    options: Array<{ name: string; values: string[] }>;
    variants: Array<{
      sku?: string;
      options: Record<string, string>;
    }>;
  };
};

export type SyncJob = {
  id: number;
  jobType: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  totalItems: number;
  successItems: number;
  errorItems: number;
  summary: string | null;
};

export type SyncLog = {
  id: number;
  jobId: number | null;
  level: "info" | "warn" | "error";
  message: string;
  detailsJson: string | null;
  createdAt: number;
};

export type Store = {
  id: number;
  shopDomain: string;
  displayName: string;
  oauthStatus: string;
  scopes: string | null;
  installedAt: number | null;
  tokenStorage: string;
};
