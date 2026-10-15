/**
 * Internal API helpers for modules that do not receive ComfyBridge.
 *
 * No static import of ComfyUI's scripts/api.js: that shim reads
 * window.comfyAPI and throws outside the ComfyUI frontend, which would break
 * the standalone page. The host entry point installs its api object instead
 * (comfy-drawer.js → ComfyUI api, standalone.html → StandaloneApi).
 */
let _api = null;

/** Install the host api object ({ apiURL, fetchApi }). */
export function setApiProvider(api) {
    _api = api ?? null;
}

/** Build an API URL that respects the configured base path. */
export function apiURL(path) {
    return _api?.apiURL?.(path) ?? path;
}

/** Fetch through the host API helper so auth and base path handling stay intact. */
export function apiFetch(path, options) {
    if (_api?.fetchApi) return _api.fetchApi(path, options);
    return fetch(apiURL(path), options);
}
