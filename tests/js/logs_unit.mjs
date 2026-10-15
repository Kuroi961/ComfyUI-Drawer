// Unit checks for web/gadgets/logs/log-buffer.js: joining ComfyUI's raw log
// writes into lines and tagging levels.
// Usage: node tests/js/logs_unit.mjs
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '..', '..');
const { LogBuffer, LEVEL, lineMatches, stripAnsi } = await import(pathToFileURL(join(repo, 'web/gadgets/logs/log-buffer.js')));

const e = (m, t = '2026-10-15T12:00:00.000000') => ({ t, m });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a print arrives as text and newline: one line', () => {
    const b = new LogBuffer();
    const r = b.append([e('got prompt'), e('\n')]);
    assert.deepEqual(b.lines.map(l => l.text), ['got prompt']);
    assert.equal(r.added.length, 1);
    assert.equal(b.current, null);
});

test('several lines in one write, the tail stays open', () => {
    const b = new LogBuffer();
    b.append([e('a\nb\nc')]);
    assert.deepEqual(b.lines.map(l => l.text), ['a', 'b']);
    assert.equal(b.current.text, 'c');
    b.append([e('d\n')]);
    assert.deepEqual(b.lines.map(l => l.text), ['a', 'b', 'cd']);
});

test('carriage return redraws the open line (tqdm)', () => {
    const b = new LogBuffer();
    b.append([e('\r  5%|#    | 1/20'), e('\r 50%|#####| 10/20')]);
    assert.equal(b.lines.length, 0);
    assert.equal(b.current.text, ' 50%|#####| 10/20');
    b.append([e('\r100%|######| 20/20'), e('\n')]);
    assert.deepEqual(b.lines.map(l => l.text), ['100%|######| 20/20']);
});

test('CRLF ends a line without blanking it', () => {
    const b = new LogBuffer();
    b.append([e('done\r\n')]);
    assert.deepEqual(b.lines.map(l => l.text), ['done']);
});

test('ANSI colour codes are stripped', () => {
    assert.equal(stripAnsi('\x1b[33mwarn\x1b[0m'), 'warn');
});

test('levels: warnings, errors and the whole traceback', () => {
    const b = new LogBuffer();
    b.append([e([
        'Prompt executed in 1.2 seconds',
        'WARNING: something odd',
        '!!! Exception during processing !!! boom',
        'Traceback (most recent call last):',
        '  File "x.py", line 1, in <module>',
        '    run()',
        'RuntimeError: boom',
        'got prompt',
        '',
    ].join('\n'))]);
    assert.deepEqual(b.lines.map(l => l.level), [
        LEVEL.INFO, LEVEL.WARNING, LEVEL.ERROR, LEVEL.ERROR, LEVEL.ERROR, LEVEL.ERROR, LEVEL.ERROR, LEVEL.INFO,
    ]);
});

test('old lines drop off past the limit', () => {
    const b = new LogBuffer({ limit: 3 });
    const r = b.append([e('1\n2\n3\n4\n5\n')]);
    assert.deepEqual(b.lines.map(l => l.text), ['3', '4', '5']);
    assert.equal(r.dropped, 2);
});

test('filter by level and case-insensitive text', () => {
    const line = { text: 'Loading Model', level: LEVEL.WARNING };
    assert.equal(lineMatches(line, LEVEL.INFO, 'model'), true);
    assert.equal(lineMatches(line, LEVEL.ERROR, ''), false);
    assert.equal(lineMatches(line, LEVEL.WARNING, 'vae'), false);
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL ${name}\n     ${err.message}`);
    }
}
process.exit(failed ? 1 : 0);
