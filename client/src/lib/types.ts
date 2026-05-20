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
  category: "Shoes" | "Handbags" | "Clothing";
  vendor_sku: string;
  name: string;
  description: string;
  brand: string;
  price: number | null;
  msrp: number | null;
  images: string[];
  properties: Record<string, string | number | boolean | null>;
  variants: Array<{
    vendor_sku: string;
    price: number | null;
    quantity: number;
    status: "active" | "out_of_stock" | "inactive";
    options: Record<string, string>;
  }>;
  warnings: string[];
  source: { shopify_product_id?: string | number; shopify_variant_ids: Array<string | number> };
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
