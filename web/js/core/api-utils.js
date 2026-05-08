/**
 * Internal ComfyUI API helpers for modules that do not receive ComfyBridge.
 */
import { api } from "../../../../scripts/api.js";

/** Build a ComfyUI API URL that respects the configured base path. */
export function apiURL(path) {
    return api?.apiURL?.(path) ?? path;
}

/** Fetch through ComfyUI's API helper so auth and base path handling stay intact. */
export function apiFetch(path, options) {
    if (api?.fetchApi) return api.fetchApi(path, options);
    return fetch(apiURL(path), options);
}
