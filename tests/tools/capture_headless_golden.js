// Capture golden prompts for the headless engine from a real ComfyUI frontend.
//
// Paste into the devtools console of a ComfyUI tab. For every workflow in
// user/default/workflows/<SRC_DIR>/ it loads the workflow as an unsaved tab,
// builds the prompt with the frontend's own graphToPrompt for several node-mode
// variants, and writes user/default/drawer-golden/<name>.json. Nothing is
// queued and the source workflows are not modified.
// Then: python tests/tools/build_headless_fixture.py CAPTURE WORKFLOW OBJECT_INFO OUT
(async () => {
    const SRC_DIR = 'workflows/_golden_src';
    const app = window.app ?? window.comfyAPI.app.app;
    const rng = (seed) => {
        let s = seed >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    };
    const files = await (await fetch(`/api/userdata?dir=${encodeURIComponent(SRC_DIR)}`)).json();
    const results = [];
    for (const f of files) {
        const raw = await (await fetch('/api/userdata/' + encodeURIComponent(`${SRC_DIR}/${f}`))).json();
        await app.loadGraphData(structuredClone(raw), true, false, null);
        const g = app.rootGraph ?? app.graph;
        const base = Object.fromEntries(g._nodes.map(n => [n.id, n.mode]));
        const variants = [
            { name: 'asis', modes: { ...base } },
            { name: 'allActive', modes: Object.fromEntries(Object.entries(base).map(([k, m]) => [k, m === 4 || m === 2 ? 0 : m])) },
        ];
        for (const [i, seed] of [[1, 12345], [2, 987654]]) {
            const r = rng(seed + f.length);
            variants.push({
                name: `mix${i}`,
                modes: Object.fromEntries(Object.keys(base).map(k => { const x = r(); return [k, x < 0.6 ? 0 : x < 0.9 ? 4 : 2]; })),
            });
        }
        const out = { source: f, frontendVersion: window.__COMFYUI_FRONTEND_VERSION__, variants: [] };
        for (const v of variants) {
            for (const n of g._nodes) n.mode = v.modes[n.id];
            let expected = null;
            let error = null;
            try { expected = (await app.graphToPrompt(g)).output; } catch (e) { error = String(e?.message || e); }
            out.variants.push({ name: v.name, modes: v.modes, expected, error });
        }
        const resp = await fetch('/api/userdata/' + encodeURIComponent(`drawer-golden/${f}`) + '?overwrite=true',
            { method: 'POST', body: JSON.stringify(out) });
        results.push([f, resp.status]);
    }
    console.table(results);
})();
