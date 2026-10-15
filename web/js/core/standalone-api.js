/**
 * ComfyDrawer — StandaloneApi
 * Minimal stand-in for ComfyUI's `api` object, used by standalone.html so
 * Drawer can run without loading the ComfyUI frontend bundle.
 *
 * Mirrors the subset ComfyBridge relies on: apiURL / fetchApi / clientId and
 * the EventTarget interface, fed by the server's /ws socket. ComfyUI sends
 * per-prompt events (executing, executed, …) only to the client that queued
 * the prompt, so these arrive for prompts the standalone page queues itself.
 */
export class StandaloneApi extends EventTarget {
    /** Server base path without trailing slash ('' when served at the root). */
    apiBase;
    clientId = null;
    /** Multi-user id, shared with the ComfyUI frontend through localStorage. */
    user = null;
    #socket = null;
    #retryMs = 1000;

    /**
     * @param {string} [apiBase] - Defaults to the server root derived from
     *   this module's URL (…/extensions/<name>/js/core/standalone-api.js).
     */
    constructor(apiBase) {
        super();
        this.apiBase = apiBase ?? StandaloneApi.#deriveApiBase();
        try {
            this.user = localStorage.getItem('Comfy.userId') || null;
        } catch { /* storage unavailable */ }
    }

    static #deriveApiBase() {
        const root = new URL('../../../../', import.meta.url).pathname;
        return root.replace(/\/+$/, '');
    }

    /** Same shape as ComfyUI's api.apiURL: `${base}/api${route}`. */
    apiURL(route) {
        return `${this.apiBase}/api${route}`;
    }

    /** Same shape as ComfyUI's api.fetchApi: adds the Comfy-User header. */
    fetchApi(route, options = {}) {
        const opts = { ...options };
        if (this.user) {
            const headers = new Headers(opts.headers || {});
            if (!headers.has('Comfy-User')) headers.set('Comfy-User', this.user);
            opts.headers = headers;
        }
        return fetch(this.apiURL(route), opts);
    }

    /**
     * Open the server event socket (idempotent; reconnects with backoff).
     * Messages are re-dispatched as CustomEvent(type, {detail}) shaped like
     * the frontend api's: `status` carries data.status, `executing` the node
     * id, binary previews a Blob on `b_preview`.
     */
    connect() {
        if (this.#socket) return;
        const url = new URL(`${this.apiBase}/ws`, location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (this.clientId) url.searchParams.set('clientId', this.clientId);
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => { this.#retryMs = 1000; });
        socket.addEventListener('message', (e) => this.#onMessage(e.data));
        socket.addEventListener('close', () => {
            if (this.#socket !== socket) return;
            this.#socket = null;
            this.dispatchEvent(new CustomEvent('reconnecting'));
            setTimeout(() => this.connect(), this.#retryMs);
            this.#retryMs = Math.min(this.#retryMs * 2, 15000);
        });
        this.#socket = socket;
    }

    #onMessage(data) {
        const emit = (type, detail) => this.dispatchEvent(new CustomEvent(type, { detail }));
        if (data instanceof ArrayBuffer) {
            const view = new DataView(data);
            const kind = view.getUint32(0);
            if (kind === 1) {
                const format = view.getUint32(4);
                emit('b_preview', new Blob([data.slice(8)], { type: format === 2 ? 'image/png' : 'image/jpeg' }));
            } else if (kind === 4) {
                const metaLength = view.getUint32(4);
                const meta = JSON.parse(new TextDecoder().decode(data.slice(8, 8 + metaLength)));
                emit('b_preview', new Blob([data.slice(8 + metaLength)], { type: meta.image_type }));
            }
            return;
        }
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'status') {
            if (msg.data?.sid) this.clientId = msg.data.sid;
            emit('status', msg.data?.status ?? null);
        } else if (msg.type === 'executing') {
            emit('executing', msg.data?.display_node || msg.data?.node);
        } else {
            emit(msg.type, msg.data);
        }
    }

    /**
     * Read all ComfyUI user settings once and expose them through the
     * app.ui.settings-like interface ComfyBridge expects. Writes stay local
     * to this page; the ComfyUI frontend remains the owner of its settings.
     */
    async loadSettings() {
        let values = {};
        try {
            const resp = await this.fetchApi('/settings', { cache: 'no-store' });
            if (resp.ok) values = (await resp.json()) || {};
        } catch { /* settings are optional */ }
        return {
            getSettingValue: (key, defaultValue) =>
                Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue,
            setSettingValue: (key, value) => { values[key] = value; },
            addSetting: () => {},
        };
    }
}
