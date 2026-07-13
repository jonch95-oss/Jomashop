import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { authHeaders, requestAdminToken } from "./adminToken";
import { getEmbeddedAuthHeader, isEmbeddedCandidate } from "./embedded";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function isProtectedApi(url: string): boolean {
  return url.startsWith("/api/") && url !== "/api/health";
}

/**
 * Resolve the Authorization header for an API call.
 *
 * Embedded (Shopify admin iframe): a fresh App Bridge session token, minted
 * per request (they expire after ~60s). Standalone: the manual ADMIN_TOKEN
 * from sessionStorage, exactly as before.
 */
export async function resolveAuthHeaders(): Promise<Record<string, string>> {
  if (isEmbeddedCandidate()) {
    const embedded = await getEmbeddedAuthHeader();
    if (embedded) return embedded;
  }
  return authHeaders();
}

async function throwIfResNotOk(res: Response, url: string) {
  if (!res.ok) {
    if (res.status === 401 && isProtectedApi(url) && !isEmbeddedCandidate()) {
      // Standalone mode only: prompt for the manual ADMIN_TOKEN. Inside the
      // Shopify admin the session token is managed by App Bridge — showing
      // the token modal there would be confusing and useless.
      requestAdminToken();
    }
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = { ...(await resolveAuthHeaders()) };
  if (data) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res, url);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/");
    const res = await fetch(`${API_BASE}${url}`, {
      headers: await resolveAuthHeaders(),
    });

    if (res.status === 401 && isProtectedApi(url) && !isEmbeddedCandidate()) {
      requestAdminToken();
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res, url);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
