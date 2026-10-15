/**
 * ComfyDrawer — Logs Gadget
 * The ComfyUI server console: what the terminal window shows, readable
 * from the phone. Live while mounted, with a level filter, search, follow
 * (auto-scroll to the newest line), copy and clear. Tap a line to select it;
 * long-press (or Shift+click) selects the range from the last tapped line;
 * copy then takes only the selected lines.
 *
 * Source: ComfyUI's own log API, the same one its bottom-panel terminal uses —
 * GET /internal/logs/raw for the recent buffer, PATCH /internal/logs/subscribe
 * to receive `logs` events on this client's socket. Server log writes are
 * joined into lines by LogBuffer.
 */
import { GadgetBase } from '../../js/core/gadget-base.js';
import { showToast } from '../../js/services/toast.js';
import { copyText } from '../../js/utils.js';
import { LogBuffer, LEVEL, lineMatches } from './log-buffer.js';

/** @private Locale helper */
const _t = (key, params) => (window.ComfyDrawer?.t?.(key, params)) ?? key;

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const LOGS_ICON = svg('<path d="M13 12h8"/><path d="M13 18h8"/><path d="M13 6h8"/><path d="M3 12h1"/><path d="M3 18h1"/><path d="M3 6h1"/><path d="M8 12h1"/><path d="M8 18h1"/><path d="M8 6h1"/>');
const ICONS = {
    follow: svg('<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'),
    copy: svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
    clear: svg('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
    deselect: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
};
// Re-send the subscription now and then: ComfyUI's own terminal panel shares
// this client id and unsubscribes it when the panel closes.
const RESUBSCRIBE_MS = 30000;
const FOLLOW_SLACK_PX = 24;
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 8;

export class LogsGadget extends GadgetBase {
    #buffer = new LogBuffer();
    #minLevel = LEVEL.INFO;
    #query = '';
    #follow = true;
    /** Entries at or before this server timestamp were cleared by the user. */
    #clearedAt = '';
    #lastT = '';
    /** While the recent buffer loads, live entries wait here. */
    #queued = null;
    #failed = false;
    #subscribedId = null;
    #reloadSeq = 0;
    #el = {};
    #currentEl = null;
    #searchTimer = 0;
    /** Selected line ids, and the last tapped line (start of a range). */
    #selected = new Set();
    #anchorId = null;
    #suppressClick = false;

    constructor() {
        super('logs', {
            label: 'Logs',
            icon: LOGS_ICON,
            order: 5,
            cssUrl: new URL('./logs.css', import.meta.url).href,
        });
    }

    onMount(container, bus, bridge) {
        container.classList.add('gadget-logs');
        container.innerHTML = `
            <div class="lg-view" tabindex="0">
                <div class="lg-lines" role="log" aria-live="off"></div>
                <div class="lg-empty"></div>
            </div>
            <div class="lg-toolbar">
                <div class="lg-levels" role="group"></div>
                <label class="lg-search">
                    ${ICONS.search}
                    <input type="search" class="lg-search-input" enterkeyhint="search" autocomplete="off" spellcheck="false">
                </label>
                <span class="lg-count"></span>
                <span class="lg-selection" hidden>
                    <span class="lg-selection-text"></span>
                    <button type="button" class="lg-deselect">${ICONS.deselect}</button>
                </span>
                <span class="lg-break"></span>
                <button type="button" class="lg-btn lg-follow">${ICONS.follow}</button>
                <button type="button" class="lg-btn lg-copy">${ICONS.copy}</button>
                <button type="button" class="lg-btn lg-clear">${ICONS.clear}</button>
            </div>`;
        const q = (s) => container.querySelector(s);
        this.#el = {
            view: q('.lg-view'), lines: q('.lg-lines'), empty: q('.lg-empty'),
            levels: q('.lg-levels'), search: q('.lg-search-input'), count: q('.lg-count'),
            follow: q('.lg-follow'), copy: q('.lg-copy'), clear: q('.lg-clear'),
            selection: q('.lg-selection'), selectionText: q('.lg-selection-text'), deselect: q('.lg-deselect'),
        };
        const el = this.#el;
        el.search.placeholder = _t('logs.search');
        el.follow.title = _t('logs.follow');
        el.copy.title = _t('logs.copy');
        el.clear.title = _t('logs.clear');
        el.deselect.title = _t('logs.clearSelection');
        for (const [level, key] of [[LEVEL.INFO, 'logs.levelAll'], [LEVEL.WARNING, 'logs.levelWarning'], [LEVEL.ERROR, 'logs.levelError']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lg-level';
            b.dataset.level = String(level);
            b.textContent = _t(key);
            b.addEventListener('click', () => {
                this.#minLevel = level;
                this.#renderAll();
            });
            el.levels.appendChild(b);
        }

        el.search.addEventListener('input', () => {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = setTimeout(() => {
                this.#query = el.search.value.trim().toLowerCase();
                this.#renderAll();
            }, 150);
        });
        el.view.addEventListener('scroll', () => {
            const atBottom = el.view.scrollHeight - el.view.scrollTop - el.view.clientHeight < FOLLOW_SLACK_PX;
            if (atBottom !== this.#follow) {
                this.#follow = atBottom;
                this.#updateToolbar();
            }
        }, { passive: true });
        el.follow.addEventListener('click', () => {
            this.#follow = !this.#follow;
            this.#updateToolbar();
            if (this.#follow) this.#scrollToEnd();
        });
        el.copy.addEventListener('click', () => this.#copy());
        el.clear.addEventListener('click', () => this.#clear());
        el.deselect.addEventListener('click', () => this.#setSelection([]));
        this.#bindSelection(el.lines);

        const onLogs = (e) => this.#onLive(e.detail?.entries);
        bridge.onApiEvent('logs', onLogs);
        this.addDisposable(() => bridge.offApiEvent('logs', onLogs));
        // A reconnect gets a new client id: subscribe it and fill the gap.
        const onStatus = () => {
            const id = this.#clientId();
            if (id && id !== this.#subscribedId) this.#reload();
        };
        bridge.onApiEvent('status', onStatus);
        this.addDisposable(() => bridge.offApiEvent('status', onStatus));
        const timer = setInterval(() => this.#subscribe(), RESUBSCRIBE_MS);
        this.addDisposable(() => clearInterval(timer));
        this.addDisposable(() => clearTimeout(this.#searchTimer));

        this.#renderAll();
        this.#reload();
    }

    onActivate() {
        if (this.#failed) this.#reload();
        else if (this.#follow) this.#scrollToEnd();
        if (!this.#subscribedId) this.#subscribe();
    }

    onDestroy() {
        const id = this.#subscribedId;
        this.#subscribedId = null;
        if (id) this.#patchSubscription(id, false);
    }

    /* ── Server ── */

    get #api() { return this.bridge?.api; }

    #clientId() { return this.#api?.clientId || null; }

    #internalURL(route) {
        const api = this.#api;
        const base = api?.api_base ?? api?.apiBase ?? '';
        return `${base}/internal${route}`;
    }

    #patchSubscription(clientId, enabled) {
        return fetch(this.#internalURL('/logs/subscribe'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, enabled }),
        });
    }

    async #subscribe() {
        const id = this.#clientId();
        if (!id) return false;
        try {
            const resp = await this.#patchSubscription(id, true);
            if (!resp.ok) return false;
            this.#subscribedId = id;
            return true;
        } catch {
            return false;
        }
    }

    /** Subscribe, then rebuild from the server's recent buffer. */
    async #reload() {
        const seq = ++this.#reloadSeq;
        this.#queued = [];
        await this.#subscribe();
        let entries = null;
        try {
            const resp = await fetch(this.#internalURL('/logs/raw'));
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            entries = (await resp.json())?.entries;
        } catch (e) {
            console.warn('[ComfyDrawer:logs] could not read the server log:', e);
        }
        if (seq !== this.#reloadSeq || !this.container) return;
        const queued = this.#queued ?? [];
        this.#queued = null;
        this.#failed = !Array.isArray(entries);
        if (this.#failed) {
            this.#renderAll();
            return;
        }
        const recent = entries.filter(e => String(e?.t ?? '') > this.#clearedAt);
        const last = recent.length ? String(recent.at(-1).t) : this.#clearedAt;
        this.#buffer.clear();
        this.#buffer.append(recent);
        this.#buffer.append(queued.filter(e => String(e?.t ?? '') > last));
        this.#noteLast(recent);
        this.#noteLast(queued);
        this.#renderAll();
    }

    #noteLast(entries) {
        for (const e of entries) {
            const t = String(e?.t ?? '');
            if (t > this.#lastT) this.#lastT = t;
        }
    }

    #onLive(entries) {
        if (!Array.isArray(entries) || !entries.length || !this.container) return;
        if (this.#queued) {
            this.#queued.push(...entries);
            return;
        }
        const fresh = entries.filter(e => String(e?.t ?? '') > this.#clearedAt);
        if (!fresh.length) return;
        this.#noteLast(fresh);
        this.#applyChange(this.#buffer.append(fresh));
    }

    /* ── View ── */

    #lineEl(line) {
        const row = document.createElement('div');
        row.className = `lg-line lg-lvl-${line.level}`;
        if (this.#selected.has(line.id)) row.classList.add('selected');
        row.dataset.id = String(line.id);
        const time = document.createElement('span');
        time.className = 'lg-time';
        time.textContent = line.t.slice(11, 19);
        const text = document.createElement('span');
        text.className = 'lg-text';
        this.#fillText(text, line.text);
        row.append(time, text);
        return row;
    }

    /** Text with the search matches wrapped in <mark>. */
    #fillText(el, text) {
        el.textContent = '';
        const q = this.#query;
        if (!q) { el.textContent = text || ' '; return; }
        const lower = text.toLowerCase();
        let at = 0;
        for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
            if (i > at) el.append(text.slice(at, i));
            const mark = document.createElement('mark');
            mark.textContent = text.slice(i, i + q.length);
            el.append(mark);
            at = i + q.length;
        }
        if (at < text.length) el.append(text.slice(at));
    }

    #matches(line) {
        return lineMatches(line, this.#minLevel, this.#query);
    }

    #renderAll() {
        const { lines } = this.#el;
        if (!lines) return;
        const frag = document.createDocumentFragment();
        for (const line of this.#buffer.lines) {
            if (this.#matches(line)) frag.appendChild(this.#lineEl(line));
        }
        lines.replaceChildren(frag);
        this.#currentEl = null;
        this.#syncCurrent(this.#buffer.current);
        this.#afterRender();
    }

    #applyChange({ added, dropped, current }) {
        const { lines } = this.#el;
        if (!lines) return;
        this.#currentEl?.remove();
        this.#currentEl = null;
        if (dropped) {
            const firstId = this.#buffer.lines[0]?.id ?? Infinity;
            while (lines.firstChild && Number(lines.firstChild.dataset.id) < firstId) lines.firstChild.remove();
        }
        for (const line of added) {
            if (this.#matches(line)) lines.appendChild(this.#lineEl(line));
        }
        this.#syncCurrent(current);
        this.#afterRender();
    }

    /** The open line (a progress bar being redrawn) shows below the rest. */
    #syncCurrent(current) {
        if (!current || !current.text || !this.#matches(current)) return;
        this.#currentEl = this.#lineEl(current);
        this.#currentEl.classList.add('lg-current');
        this.#el.lines.appendChild(this.#currentEl);
    }

    #afterRender() {
        this.#updateToolbar();
        if (this.#follow) this.#scrollToEnd();
    }

    #scrollToEnd() {
        const view = this.#el.view;
        if (view) view.scrollTop = view.scrollHeight;
    }

    #visibleLines() {
        const out = this.#buffer.lines.filter(l => this.#matches(l));
        const cur = this.#buffer.current;
        if (cur?.text && this.#matches(cur)) out.push(cur);
        return out;
    }

    #updateToolbar() {
        const el = this.#el;
        if (!el.count) return;
        for (const b of el.levels.children) {
            b.classList.toggle('active', Number(b.dataset.level) === this.#minLevel);
        }
        el.follow.classList.toggle('active', this.#follow);
        el.follow.setAttribute('aria-pressed', String(this.#follow));
        const total = this.#buffer.lines.length;
        const shown = el.lines.childElementCount;
        const filtered = this.#minLevel !== LEVEL.INFO || !!this.#query;
        el.count.textContent = filtered
            ? _t('logs.countFiltered', { shown, total })
            : _t('logs.count', { count: total });
        const picked = this.#selectedLines().length;
        el.selection.hidden = !picked;
        el.count.hidden = !!picked;
        el.selectionText.textContent = _t('logs.selected', { count: picked });
        el.copy.classList.toggle('active', !!picked);
        el.copy.title = picked ? _t('logs.copySelected') : _t('logs.copy');
        let empty = '';
        if (this.#failed) empty = _t('logs.loadFailed');
        else if (this.#queued && !total) empty = _t('common.loading');
        else if (!shown) empty = total ? _t('logs.noMatch') : _t('logs.empty');
        el.empty.textContent = empty;
        el.empty.hidden = !empty;
    }

    /* ── Selection ── */

    #bindSelection(linesEl) {
        let timer = 0;
        let start = null;
        const cancel = () => { clearTimeout(timer); timer = 0; };
        linesEl.addEventListener('pointerdown', (e) => {
            const row = e.target.closest('.lg-line');
            if (!row || e.button > 0) return;
            this.#suppressClick = false;
            start = { x: e.clientX, y: e.clientY };
            cancel();
            timer = setTimeout(() => {
                timer = 0;
                this.#suppressClick = true;
                this.#selectRangeTo(Number(row.dataset.id));
                navigator.vibrate?.(15);
            }, LONG_PRESS_MS);
        });
        linesEl.addEventListener('pointermove', (e) => {
            if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_MOVE_PX) cancel();
        }, { passive: true });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave']) linesEl.addEventListener(type, cancel);
        this.addDisposable(cancel);
        linesEl.addEventListener('click', (e) => {
            const row = e.target.closest('.lg-line');
            if (!row) return;
            if (this.#suppressClick) { this.#suppressClick = false; return; }
            // Leave a mouse text selection alone.
            if (!(window.getSelection?.()?.isCollapsed ?? true)) return;
            const id = Number(row.dataset.id);
            if (e.shiftKey && this.#anchorId != null) this.#selectRangeTo(id);
            else this.#toggleLine(id);
        });
    }

    #toggleLine(id) {
        if (this.#selected.has(id)) this.#selected.delete(id);
        else this.#selected.add(id);
        this.#anchorId = id;
        this.#paintSelection();
    }

    /** Select the shown lines from the last tapped line to `id` (inclusive). */
    #selectRangeTo(id) {
        const ids = [...this.#el.lines.querySelectorAll('.lg-line')].map(r => Number(r.dataset.id));
        const to = ids.indexOf(id);
        let from = ids.indexOf(this.#anchorId);
        if (to < 0) return;
        if (from < 0) from = to;
        const [a, b] = from <= to ? [from, to] : [to, from];
        for (const lineId of ids.slice(a, b + 1)) this.#selected.add(lineId);
        this.#anchorId = id;
        this.#paintSelection();
    }

    #setSelection(ids) {
        this.#selected = new Set(ids);
        if (!this.#selected.size) this.#anchorId = null;
        this.#paintSelection();
    }

    #paintSelection() {
        for (const row of this.#el.lines.querySelectorAll('.lg-line')) {
            row.classList.toggle('selected', this.#selected.has(Number(row.dataset.id)));
        }
        this.#updateToolbar();
    }

    /** Selected lines still in the buffer, in log order. */
    #selectedLines() {
        if (!this.#selected.size) return [];
        const out = this.#buffer.lines.filter(l => this.#selected.has(l.id));
        const cur = this.#buffer.current;
        if (cur && this.#selected.has(cur.id)) out.push(cur);
        return out;
    }

    async #copy() {
        const selected = this.#selectedLines();
        const lines = selected.length ? selected : this.#visibleLines();
        if (!lines.length) return;
        const ok = await copyText(lines.map(l => l.text).join('\n'));
        showToast(ok ? _t('logs.copied', { count: lines.length }) : _t('logs.copyFailed'),
            { variant: ok ? 'success' : 'danger' });
    }

    #clear() {
        this.#clearedAt = this.#lastT;
        this.#buffer.clear();
        this.#selected.clear();
        this.#anchorId = null;
        this.#renderAll();
    }
}
