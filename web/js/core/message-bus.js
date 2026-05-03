/**
 * ComfyDrawer — MessageBus
 * Lightweight EventEmitter with pub/sub and request/response support.
 * Gadgets communicate through this bus instead of direct references.
 */
export class MessageBus {
    #listeners = new Map();
    #responders = new Map();

    /**
     * Subscribe to an event.
     * @param {string} event - Event name (e.g. 'gallery:image-selected')
     * @param {Function} fn - Callback
     * @returns {Function} Unsubscribe function
     */
    on(event, fn) {
        if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
        this.#listeners.get(event).add(fn);
        return () => this.off(event, fn);
    }

    /**
     * Unsubscribe from an event.
     */
    off(event, fn) {
        const s = this.#listeners.get(event);
        if (s) { s.delete(fn); if (s.size === 0) this.#listeners.delete(event); }
    }

    /**
     * Emit an event (fire-and-forget). All listeners receive the data.
     * @param {string} event - Event name
     * @param {*} data - Payload
     */
    emit(event, data) {
        const s = this.#listeners.get(event);
        if (s) for (const fn of [...s]) {
            try { fn(data); } catch (e) { console.error(`[ComfyDrawer:Bus] Error in listener for "${event}":`, e); }
        }
    }

    /**
     * Register a responder for request/response pattern.
     * Only one responder per event.
     * @param {string} event - Request event name
     * @param {Function} fn - Handler that returns a value (can be async)
     */
    respond(event, fn) {
        if (this.#responders.has(event)) {
            console.warn(`[ComfyDrawer:Bus] Responder for "${event}" already registered — rejected`);
            return false;
        }
        this.#responders.set(event, fn);
        return true;
    }

    /**
     * Remove a responder for an event.
     * @param {string} event
     */
    removeResponder(event) {
        return this.#responders.delete(event);
    }

    /**
     * Send a request and await a response.
     * @param {string} event - Request event name
     * @param {*} data - Request payload
     * @returns {Promise<*>} Response from the responder
     */
    async request(event, data) {
        const fn = this.#responders.get(event);
        if (!fn) throw new Error(`[ComfyDrawer:Bus] No responder for "${event}"`);
        return fn(data);
    }

    /**
     * Check if a responder exists for an event.
     */
    hasResponder(event) {
        return this.#responders.has(event);
    }
}
