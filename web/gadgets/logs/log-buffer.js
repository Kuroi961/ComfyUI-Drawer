/**
 * ComfyDrawer — server log line buffer
 *
 * ComfyUI's log entries are raw stdout/stderr writes ({t, m}): a print
 * arrives as the text and its "\n" separately, and progress bars (tqdm)
 * rewrite the current line with "\r". LogBuffer joins the writes into
 * lines the way a terminal would and tags each line with a level.
 *
 * DOM-free so it can be unit tested under node.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const ERROR_RE = /\b(ERROR|CRITICAL|FATAL)\b|Traceback \(most recent call last\)|!!! Exception|Failed to validate prompt|^\s*\w+(\.\w+)*(Error|Exception)\b/;
const WARN_RE = /\bWARN(ING)?\b|\bWarning\b|Warning:/;
// A Python traceback ends with the "SomeError: message" line.
const TRACEBACK_END_RE = /^\w+(\.\w+)*(Error|Exception|Interrupt|Exit)\b/;

export const LEVEL = { INFO: 0, WARNING: 1, ERROR: 2 };

export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

export class LogBuffer {
    /** @param {{limit?: number}} [opts] - lines kept (oldest dropped first) */
    constructor({ limit = 5000 } = {}) {
        this.limit = limit;
        /** @type {Array<{id: number, t: string, text: string, level: number}>} */
        this.lines = [];
        /** The unterminated last line (a progress bar), or null. */
        this.current = null;
        this.nextId = 1;
        this.inTraceback = false;
        this.tracebackLines = 0;
        this.pendingCR = false;
    }

    clear() {
        this.lines = [];
        this.current = null;
        this.inTraceback = false;
        this.pendingCR = false;
    }

    /**
     * Append raw entries. Returns what changed so a view can update
     * incrementally: `added` committed lines, `dropped` how many old lines
     * fell off the front, `current` the open line after the update.
     */
    append(entries) {
        const added = [];
        let dropped = 0;
        for (const entry of entries ?? []) {
            const m = stripAnsi(entry?.m ?? '');
            const t = String(entry?.t ?? '');
            const parts = m.split('\n');
            parts.forEach((part, i) => {
                if (i > 0) {
                    const line = this.#open(t);
                    this.current = null;
                    this.pendingCR = false;
                    line.level = this.#classify(line.text);
                    this.lines.push(line);
                    added.push(line);
                }
                this.#write(part, t);
            });
        }
        if (this.lines.length > this.limit) {
            dropped = this.lines.length - this.limit;
            this.lines.splice(0, dropped);
        }
        if (this.current) this.current.level = this.#peekLevel(this.current.text);
        return { added, dropped, current: this.current };
    }

    #open(t) {
        if (!this.current) this.current = { id: this.nextId++, t, text: '', level: LEVEL.INFO };
        return this.current;
    }

    #write(part, t) {
        const segments = part.split('\r');
        segments.forEach((seg, i) => {
            if (i > 0) this.pendingCR = true;
            if (!seg) return;
            const line = this.#open(t);
            if (this.pendingCR) {
                line.text = seg;
                line.t = t;
                this.pendingCR = false;
            } else {
                line.text += seg;
            }
        });
    }

    #classify(text) {
        if (this.inTraceback) {
            // The cap keeps an unrecognised ending from colouring the rest red.
            if (TRACEBACK_END_RE.test(text) || ++this.tracebackLines > 300) this.inTraceback = false;
            return LEVEL.ERROR;
        }
        if (/Traceback \(most recent call last\)/.test(text)) {
            this.inTraceback = true;
            this.tracebackLines = 0;
            return LEVEL.ERROR;
        }
        return this.#peekLevel(text);
    }

    #peekLevel(text) {
        if (this.inTraceback || ERROR_RE.test(text)) return LEVEL.ERROR;
        if (WARN_RE.test(text)) return LEVEL.WARNING;
        return LEVEL.INFO;
    }
}

/**
 * Whether a line passes the view's filters.
 * @param {{text: string, level: number}} line
 * @param {number} minLevel
 * @param {string} query - lower-cased search text ('' = all)
 */
export const lineMatches = (line, minLevel, query) =>
    line.level >= minLevel && (!query || line.text.toLowerCase().includes(query));
