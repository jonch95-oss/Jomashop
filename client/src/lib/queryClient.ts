import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { authHeaders, requestAdminToken } from "./adminToken";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function isProtectedApi(url: string): boolean {
  return url.startsWith("/api/") && url !== "/api/health";
}

async function throwIfResNotOk(res: Response, url: string) {
  if (!res.ok) {
    if (res.status === 401 && isProtectedApi(url)) {
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
  const headers: Record<string, string> = { ...authHeaders() };
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
      headers: authHeaders(),
    });

    if (res.status === 401 && isProtectedApi(url)) {
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
