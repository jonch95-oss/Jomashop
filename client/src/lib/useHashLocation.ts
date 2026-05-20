import { useSyncExternalStore } from "react";
import type { BaseLocationHook, BaseSearchHook } from "wouter";

const listeners: Array<() => void> = [];

function onHashChange() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void) {
  if (listeners.push(cb) === 1) {
    window.addEventListener("hashchange", onHashChange);
  }
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
    if (listeners.length === 0) {
      window.removeEventListener("hashchange", onHashChange);
    }
  };
}

function rawHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, "");
}

function splitHash(hash: string): { path: string; search: string } {
  const normalized = hash.replace(/^\/?/, "/");
  const qIdx = normalized.indexOf("?");
  if (qIdx === -1) return { path: normalized || "/", search: "" };
  return {
    path: normalized.slice(0, qIdx) || "/",
    search: normalized.slice(qIdx + 1),
  };
}

function currentPath() {
  return splitHash(rawHash()).path;
}

function currentSearch() {
  return splitHash(rawHash()).search;
}

function navigate(to: string) {
  if (typeof window === "undefined") return;
  const target = to.startsWith("#") ? to.slice(1) : to;
  const next = target.startsWith("/") ? target : `/${target}`;
  if (window.location.hash === `#${next}`) return;
  window.location.hash = next;
}

export const useHashLocation: BaseLocationHook = () => {
  const path = useSyncExternalStore(subscribe, currentPath, () => "/");
  return [path, navigate];
};

export const useHashSearch: BaseSearchHook = () =>
  useSyncExternalStore(subscribe, currentSearch, () => "");
