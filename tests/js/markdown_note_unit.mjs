// Unit checks for Deck's MarkdownNote renderer (#renderMarkdown in
// web/gadgets/deck/deck-gadget.js). The note text is untrusted (it comes from
// the workflow file) and the result is assigned to innerHTML, so the output
// may only consist of the renderer's own tags and escaped text.
// Usage: node tests/js/markdown_note_unit.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(import.meta.dirname, '..', '..');
const { escapeHTML } = await import(pathToFileURL(join(repo, 'web/js/utils.js')));

// The gadget module needs a browser, so run the method body on its own.
const source = readFileSync(join(repo, 'web/gadgets/deck/deck-gadget.js'), 'utf8').replace(/\r\n/g, '\n');
const header = '  #renderMarkdown(md) {\n';
const start = source.indexOf(header) + header.length;
const renderMarkdown = new Function('escapeHTML', 'md', source.slice(start, source.indexOf('\n  }\n', start)))
    .bind(null, escapeHTML);

const OWN_TAGS = /<a href="[^"]*" target="_blank" rel="noopener noreferrer">|<pre class="dk-md-code">|<\/?(?:a|p|em|strong|code|pre|ul|ol|li|h[2-5]|br)>/g;
const assertOnlyOwnTags = (md) => {
    const html = renderMarkdown(md);
    const rest = html.replace(OWN_TAGS, '');
    assert.ok(!/[<>"]/.test(rest), `unexpected markup for ${JSON.stringify(md)}:\n${html}`);
    return html;
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('links and bare URLs are rendered', () => {
    assert.equal(assertOnlyOwnTags('[docs](https://example.com/a?b=1&c=2)'),
        '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
    assert.equal(assertOnlyOwnTags('see https://example.com/x (or (https://example.org))'),
        '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>'
        + ' (or (<a href="https://example.org" target="_blank" rel="noopener noreferrer">https://example.org</a>))</p>');
});

test('a quote in a link URL cannot close the href', () => {
    const html = assertOnlyOwnTags('[x](https://example.com/" data-injected="1)');
    assert.ok(html.includes('href="https://example.com/&quot; data-injected=&quot;1"'), html);
    assertOnlyOwnTags("[x](https://example.com/' onmouseover='alert(1)");
    assertOnlyOwnTags('https://example.com/"onmouseover="alert(1)');
});

test('a bare URL stops at a quote', () => {
    assert.ok(assertOnlyOwnTags('say "hi" (https://example.com/a"b)').includes('>https://example.com/a</a>&quot;b'));
    assert.ok(assertOnlyOwnTags("it's (https://example.com/a'b)").includes('>https://example.com/a</a>&#39;b'));
});

test('a URL inside a link URL is not linked a second time', () => {
    const html = assertOnlyOwnTags('[x](https://a.example/ https://b.example/onmouseover=alert`1`//)');
    assert.equal(html.match(/<a /g).length, 1);
    assertOnlyOwnTags('[https://a.example](https://b.example) [y](https://c.example/ (https://d.example)');
});

test('a code block cannot land inside an href', () => {
    const html = assertOnlyOwnTags('[x](https://a.example/```\ncode "q"\n```)\nhttps://b.example/```\nmore\n```');
    assert.ok(!/href="[^"]*<pre/.test(html), html);
    assert.equal(html.match(/<pre class="dk-md-code">/g).length, 2);
});

test('unsafe schemes stay plain text', () => {
    for (const md of ['[x](javascript:alert(1))', '[x](data:text/html,<script>alert(1)</script>)',
        '[x](&#106;avascript:alert(1))', '[x]( JaVaScRiPt:alert(1))', '[x](vbscript:msgbox)']) {
        assert.ok(!assertOnlyOwnTags(md).includes('<a '), md);
    }
});

test('other markdown keeps rendering', () => {
    assert.equal(assertOnlyOwnTags('# Title\n- **bold** and *em* `a<b>`\n\n```\n<i>*raw*</i>\n```'),
        '<h2>Title</h2>\n<ul>\n<li><strong>bold</strong> and <em>em</em> <code>a&lt;b&gt;</code></li>\n</ul>\n<br>\n'
        + '<pre class="dk-md-code"><code>&lt;i&gt;*raw*&lt;/i&gt;</code></pre>');
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
