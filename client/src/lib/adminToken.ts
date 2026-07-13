import { getCachedEmbeddedToken } from "./embedded";

const STORAGE_KEY = "admin_token";
const EVENT_NAME = "admin-token-required";

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(STORAGE_KEY, token);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore (private mode, etc.)
  }
  window.dispatchEvent(new CustomEvent("admin-token-changed"));
}

export function clearAdminToken(): void {
  setAdminToken("");
}

export function requestAdminToken(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function onAdminTokenRequired(handler: () => void): () => void {
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

export function onAdminTokenChanged(handler: () => void): () => void {
  window.addEventListener("admin-token-changed", handler);
  return () => window.removeEventListener("admin-token-changed", handler);
}

export function authHeaders(): Record<string, string> {
  // Embedded Shopify admin: prefer the App Bridge session token (kept fresh
  // by a 30s refresh loop in lib/embedded.ts). Standalone: manual ADMIN_TOKEN.
  const embedded = getCachedEmbeddedToken();
  if (embedded) return { Authorization: `Bearer ${embedded}` };
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
