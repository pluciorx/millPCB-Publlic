// millPCB library — validated KiCad footprint upload + persistent library.
// Agents supply .kicad_mod source text through millpcb_import_kicad (content form);
// the text is security-checked, parsed by the kernel KicadImport parser,
// registered into ComponentDefs, and saved under <root>/.mcp/library/ so
// every future session and server restart re-loads the same footprints.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 200 * 1024;      // bytes of .kicad_mod source
const MAX_LINES = 5000;
const MAX_PADS = 500;
const MAX_COORD = 500;            // mm from footprint center
const MAX_DIM = 300;              // mm pad width/height
const MAX_DRILL = 20;             // mm
const MAX_NAME = 64;

/** Security + sanity check of raw .kicad_mod text. Returns { fp } or throws.
 *  The kernel parser is a strict s-expression tokenizer (no eval), so the
 *  main risks here are size bombs, control chars, and absurd geometry. */
export function validateFootprintText(text, KicadImport, ComponentDefs, opts = {}) {
    if (typeof text !== 'string') throw new Error('content must be text');
    // Optional genuine .kicad_sym pairing: real symbol gives real pin names.
    let sym = null;
    if (opts.symbolText != null) {
        if (typeof opts.symbolText !== 'string') throw new Error('symbol must be text');
        if (opts.symbolText.length > MAX_TEXT) throw new Error('symbol too large');
        if (/[^\x09\x0A\x0D\x20-\x7E]/.test(opts.symbolText)) throw new Error('symbol contains non-printable characters');
        const parsed = KicadImport._parseSymbol(opts.symbolText);
        const names = parsed ? Object.keys(parsed) : [];
        if (!names.length) throw new Error('symbol text is not a parseable .kicad_sym library');
        const fpName = String((KicadImport._parseFootprint(text) || {}).name || '').trim().toLowerCase();
        const pick = names.find(n => n.toLowerCase() === fpName) || (names.length === 1 ? names[0] : null);
        if (!pick) throw new Error(`symbol library has ${names.length} symbols and none matches the footprint name — pass a matching .kicad_sym`);
        sym = parsed[pick];
    }    if (text.length > MAX_TEXT) throw new Error(`footprint too large (${text.length} bytes, max ${MAX_TEXT})`);
    if (text.split('\n').length > MAX_LINES) throw new Error(`too many lines (max ${MAX_LINES})`);
    // Printable ASCII + \n \r \t only — no control/NUL bytes.
    if (/[^\x09\x0A\x0D\x20-\x7E]/.test(text)) throw new Error('footprint contains non-printable characters');
    // Balanced parentheses (cheap structural check before parsing).
    let depth = 0;
    for (const ch of text) {
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth < 0) throw new Error('unbalanced parentheses — not a valid .kicad_mod'); }
    }
    if (depth !== 0) throw new Error('unbalanced parentheses — not a valid .kicad_mod');

    const fp = KicadImport._parseFootprint(text);
    if (!fp) throw new Error('not a parseable .kicad_mod footprint (no (footprint ...) root)');
    const name = String(fp.name || '').trim();
    if (!name) throw new Error('footprint has no name');
    if (name.length > MAX_NAME) throw new Error(`footprint name too long (max ${MAX_NAME})`);
    // Authenticity gate: agents must import REAL library parts, not invent
    // geometry. Genuine KiCad exports always carry (version ...) +
    // (generator ...) headers and courtyard/body graphics; hand-invented
    // pad-only stubs do not.
    if (!/\(\s*version\b/.test(text) || !/\(\s*generator\b/.test(text)) {
        throw new Error('missing (version ...) / (generator ...) header — paste a genuine .kicad_mod exported from KiCad, do not invent footprint geometry');
    }
    if (!fp.fab.length && !fp.silk.length && !fp.texts.length) {
        throw new Error('footprint has no fab/silk graphics (no body or courtyard) — real KiCad footprints always have them; do not invent footprints');
    }
    const pads = fp.pads || [];
    if (!pads.length) throw new Error('footprint has no pads — nothing to mill');
    if (pads.length > MAX_PADS) throw new Error(`too many pads (${pads.length}, max ${MAX_PADS})`);
    for (const p of pads) {
        if (!isFinite(p.x) || !isFinite(p.y) || Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD)
            throw new Error(`pad ${p.num}: coordinate out of range (max ±${MAX_COORD}mm)`);
        if (!isFinite(p.w) || !isFinite(p.h) || p.w <= 0 || p.h <= 0 || p.w > MAX_DIM || p.h > MAX_DIM)
            throw new Error(`pad ${p.num}: bad pad size (max ${MAX_DIM}x${MAX_DIM}mm)`);
        if (p.drill != null && (p.drill < 0 || p.drill > MAX_DRILL))
            throw new Error(`pad ${p.num}: drill out of range (max ${MAX_DRILL}mm)`);
    }

    const def = KicadImport._buildDef(fp, sym || null);
    if (!def || !def.key) throw new Error('footprint produced no component definition');
    // Optional agent-supplied 3D model reference(s) — URI text only, validated.
    if (opts.model3d != null) {
        const list = Array.isArray(opts.model3d) ? opts.model3d : [opts.model3d];
        const clean = [];
        for (const m of list) {
            const uri = String(m && m.uri != null ? m.uri : m);
            if (!uri || uri.length > 300) throw new Error('model3d uri too long (max 300 chars)');
            if (/[^\x20-\x7E]/.test(uri)) throw new Error('model3d uri contains non-printable characters');
            clean.push({ name: String((m && m.name) || uri.split('/').pop() || 'model').slice(0, 120), uri });
            if (clean.length >= 10) break;
        }
        if (clean.length && def.sizes[0]) def.sizes[0].model3d = clean;
    }
    // Never silently overwrite a built-in footprint (known pitfall). Imported
    // (kx_) entries may be refreshed — that is the normal re-import update.
    const existing = ComponentDefs.defs[def.key];
    if (existing && !existing.kicadImported && !opts.overwrite) {
        throw new Error(`"${def.key}" collides with a built-in footprint — pass overwrite:true to replace it`);
    }
    return { fp, def };
}

/** Register a validated def and persist its source for future reuse.
 *  The saved file is the original footprint text with the optional symbol
 *  and 3D-model references appended as comment blocks, so re-loads keep
 *  the pin names and model references. */
export function persistFootprint(rootDir, defKey, text, symbolText, model3d) {
    const dir = path.join(rootDir, '.mcp', 'library');
    fs.mkdirSync(dir, { recursive: true });
    const safeKey = defKey.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    let payload = text;
    if (symbolText) payload += `\n;KICAD_SYM_BEGIN\n${symbolText}\n;KICAD_SYM_END`;
    if (model3d && model3d.length) payload += `\n;KICAD_MODEL3D ${JSON.stringify(model3d)}`;
    fs.writeFileSync(path.join(dir, `${safeKey}.kicad_mod`), payload + '\n');
    return `.mcp/library/${safeKey}.kicad_mod`;
}

/** Split a persisted file back into footprint + optional symbol text + model refs. */
export function splitPersisted(content) {
    const m = /;KICAD_SYM_BEGIN\r?\n([\s\S]*?)\r?\n;KICAD_SYM_END/.exec(content);
    const mm = /;KICAD_MODEL3D (.*)/.exec(content);
    let model3d = null;
    if (mm) { try { model3d = JSON.parse(mm[1]); } catch (e) { model3d = null; } }
    const text = m ? content.slice(0, m.index) : (mm ? content.slice(0, mm.index) : content);
    return { text: text, symbolText: m ? m[1] : null, model3d };
}

/** Re-load every persisted footprint (called at server startup). */
export function loadPersistentLibrary(rootDir, KicadImport, ComponentDefs) {
    const dir = path.join(rootDir, '.mcp', 'library');
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { return 0; }
    let loaded = 0;
    for (const f of files) {
        if (!f.toLowerCase().endsWith('.kicad_mod')) continue;
        try {
            const { text, symbolText, model3d } = splitPersisted(fs.readFileSync(path.join(dir, f), 'utf8'));
            const { def } = validateFootprintText(text, KicadImport, ComponentDefs, { overwrite: true, symbolText, model3d });
            KicadImport.registerEntries([def]);
            loaded++;
        } catch (e) { console.error(`[millpcb-mcp] library ${f} skipped: ${e.message}`); }
    }
    return loaded;
}
