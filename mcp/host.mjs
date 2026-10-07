// millPCB MCP host — loads the browser core scripts into one Node vm context
// (mirroring the browser global scope) and owns the in-memory project session.
// Shared by server.mjs (stdio tools) and preview-http.mjs (SSE + SPA).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const MCP_DIR = path.dirname(fileURLToPath(import.meta.url));
// Default sandbox root: the repository (parent of mcp/). Overridable per session.
export const MILLPCB_ROOT_DEFAULT = path.resolve(MCP_DIR, '..');

// Core scripts that must load in this order (same dependency chain as index.html,
// minus DOM modules — project-api.js is the DOM-free kernel entry point).
const KERNEL_SCRIPTS = [
    'component-defs.js',
    'kicad-import.js', // DOM only inside methods; palette injection is guarded for headless use
    'kicad-lib-embed.js',
    'libs-loader.js', // applyEmbed() merges the 144 embedded footprints into ComponentDefs
    'export.js',
    'dxf.js',
    'gcode.js',
    'drc.js',
    'project-api.js',
    'plan.js', // DOM-free design-workflow kernel (placement / plan check / quality checks)
    'schematic-layout.js', // DOM-free schematic topology placer + orthogonal router
    'schematic-view.js', // DOM-free at load: symbol geometry + per-type glyph drawing (canvas ctx passed in)
    'autorouter.js' // DOM-free; loaded last so project-api.js can offer routed schematic legs
];

let kernel = null;

/** Load the DOM-free kernel into a shared vm context (once per process). */
export function loadKernel(rootDir) {
    if (kernel) return kernel;
    const root = path.resolve(rootDir || MILLPCB_ROOT_DEFAULT);
    // The kernel sees ComponentDefs / Export / Dxf / GCode / computeDrcViolations
    // as free globals, exactly like in the browser. `App` is a stub: drc.js does
    // Object.assign(App, {...}) and nothing else at load time.
    const ctx = { console, App: {}, module: { exports: {} } };
    let projectApi = null;
    let plan = null;
    for (const name of KERNEL_SCRIPTS) {
        const file = path.join(root, 'js', name);
        const code = fs.readFileSync(file, 'utf8');
        vm.runInNewContext(code, ctx, { filename: file });
        // project-api.js, plan.js and autorouter.js each claim module.exports; capture
        // each at its own position so a later load can't clobber the earlier one.
        if (name === 'project-api.js') projectApi = ctx.module.exports;
        if (name === 'plan.js') plan = ctx.module.exports;
    }
    // Merge embedded KiCad footprints into ComponentDefs (headless-safe).
    try { vm.runInContext('LibsLoader && LibsLoader.applyEmbed && LibsLoader.applyEmbed()', ctx); }
    catch (e) { console.error('[millpcb-mcp] embed apply failed:', e.message); }
    kernel = {
        ProjectApi: projectApi,
        Plan: plan,
        SchematicLayout: vm.runInContext('typeof SchematicLayout === "undefined" ? null : SchematicLayout', ctx),
        SchematicView: vm.runInContext('typeof SchematicView === "undefined" ? null : SchematicView', ctx),
        // `const ComponentDefs` is a global-lexical binding, not a sandbox property.
        ComponentDefs: vm.runInContext('ComponentDefs', ctx),
        Autoroute: ctx.module.exports,
        // Top-level `const KicadImport` is a global-lexical binding (like in the
        // browser), not a sandbox property — read it through the context.
        KicadImport: vm.runInContext('typeof KicadImport === "undefined" ? null : KicadImport', ctx)
    };
    return kernel;
}

/**
 * Resolve a user-supplied path against the sandbox root. Refuse escapes via
 * `..` / absolute paths outside root. Returns an absolute path inside root.
 */
export function safeResolve(rootDir, p) {
    const root = path.resolve(rootDir || MILLPCB_ROOT_DEFAULT);
    if (!p || typeof p !== 'string') throw new Error('path is required');
    let candidate;
    if (path.isAbsolute(p)) {
        // Absolute paths are allowed only inside the sandbox root.
        candidate = path.normalize(p);
    } else {
        candidate = path.resolve(root, p);
    }
    const rel = path.relative(root, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`path escapes the sandbox root (${root}): ${p}`);
    }
    return candidate;
}

/** Read + parse a .pcb.json file inside the sandbox. */
export function readProjectFile(rootDir, p) {
    const file = safeResolve(rootDir, p);
    if (!file.toLowerCase().endsWith('.json')) throw new Error('only .json project files are supported');
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); } catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
}

/** Write a serialized project to a .pcb.json file inside the sandbox. */
export function writeProjectFile(rootDir, p, data) {
    const file = safeResolve(rootDir, p);
    if (!file.toLowerCase().endsWith('.json')) throw new Error('only .json project files are supported');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}

/** Read + parse a .pcb.json file from an absolute path (trusted dirs outside the sandbox, e.g. MILLPCB_PROJECTS_DIR). */
export function readProjectFileAbs(file) {
    if (!file.toLowerCase().endsWith('.json')) throw new Error('only .json project files are supported');
    const raw = fs.readFileSync(file, 'utf8');
    try { return JSON.parse(raw); } catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
}

/** Write a serialized project to an absolute path (trusted dirs outside the sandbox, e.g. MILLPCB_PROJECTS_DIR). */
export function writeProjectFileAbs(file, data) {
    if (!file.toLowerCase().endsWith('.json')) throw new Error('only .json project files are supported');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}

/** Default session project location (created on first save). */
export function defaultProjectPath(rootDir) {
    return path.join('.mcp', 'preview', 'project.pcb.json');
}

/**
 * In-memory project session: one project per MCP process. `revision` is a
 * monotonic integer bumped by every mutation; the preview server and tools read it.
 */
export class ProjectSession {
    /**
     * @param {string} rootDir sandbox root (repo dir)
     * @param {object} [opts]
     *   projectsDir  trusted absolute dir for user .pcb.json files (Docker: /data/projects)
     *   autoSaveFile trusted absolute file used for default autosave (Docker: /data/projects/project.pcb.json)
     */
    constructor(rootDir, opts = {}) {
        const { ProjectApi, KicadImport } = loadKernel(rootDir);
        this.ProjectApi = ProjectApi;
        this.KicadImport = KicadImport;
        this.rootDir = path.resolve(rootDir || MILLPCB_ROOT_DEFAULT);
        this.projectsDir = opts.projectsDir ? path.resolve(opts.projectsDir) : null;
        this.autoSaveFile = opts.autoSaveFile ? path.resolve(opts.autoSaveFile) : null;
        this._project = null;
        this.revision = 0;
        this.sourcePath = null; // relative to rootDir, if opened from a file
    }

    get project() {
        if (!this._project) throw new Error('no project in session — call millpcb_new_project or millpcb_open_project first');
        return this._project;
    }

    /** Create an empty project (or keep the existing one when `reset` is false). */
    newProject(reset = true) {
        if (!reset && this._project) return this.snapshot();
        this._project = this.ProjectApi.createEmptyProject();
        this.sourcePath = null;
        this.revision++;
        return this.snapshot();
    }

    /** Open a .pcb.json file into the session (inside projectsDir when set, else sandbox-relative). */
    openProject(relPath) {
        let data;
        const inProjects = this.projectsDir ? path.join(this.projectsDir, relPath) : null;
        if (inProjects && fs.existsSync(inProjects)) {
            data = readProjectFileAbs(inProjects);
        } else {
            data = readProjectFile(this.rootDir, relPath);
        }
        this._project = this.ProjectApi.deserialize(data);
        this.sourcePath = relPath;
        this.revision++;
        return this.snapshot();
    }

    /** Every imported footprint in this session, including ones not placed yet. The preview snapshot must carry them as soon as they are imported. */
    importedDefsForPreview() {
        if (!this._project) return [];
        const byKey = new Map();
        const stored = Array.isArray(this._project.importedDefs) ? this._project.importedDefs : [];
        for (const d of stored) if (d && d.key) byKey.set(d.key, d);
        const live = this.KicadImport ? this.KicadImport.getImportedDefs() : [];
        for (const d of live) if (d && d.key) byKey.set(d.key, d);
        return [...byKey.values()];
    }

    /** Persist the session (default: sourcePath, then autoSaveFile, then .mcp/preview/project.pcb.json). */
    saveProject(relPath) {
        if (!this._project) throw new Error('no project in session');
        const defs = this.importedDefsForPreview();
        if (defs.length) this._project.importedDefs = defs;
        const data = this.ProjectApi.serialize(this._project);
        if (relPath && this.projectsDir) {
            writeProjectFileAbs(path.join(this.projectsDir, relPath), data);
            this.sourcePath = relPath;
            return { file: relPath, revision: this.revision };
        }
        if (relPath || this.sourcePath) {
            const file = writeProjectFile(this.rootDir, relPath || this.sourcePath, data);
            this.sourcePath = path.relative(this.rootDir, file).split(path.sep).join('/');
            return { file: this.sourcePath, revision: this.revision };
        }
        const file = writeProjectFileAbs(this.autoSaveFile || path.join(this.rootDir, defaultProjectPath(this.rootDir)), data);
        return { file, revision: this.revision };
    }

    /** Replace the session with an already-parsed project object (used by MILLPCB_RESTORE). */
    loadParsed(data) {
        this._project = this.ProjectApi.deserialize(data);
        if (this.KicadImport && data && data.importedDefs) this.KicadImport.restoreDefs(data.importedDefs);
        this.revision++;
        return this.snapshot();
    }

    /** Run a mutation through the kernel and bump the revision.
     *  Any edit clears electrical validation — a previous PASS is stale
     *  until millpcb_check type="circuit" records it again for this revision. */
    mutate(fn) {
        if (this._project) delete this._project.electricalValidation;
        const result = fn(this.project);
        this.revision++;
        return result;
    }

    /** Full SSE payload: serialized project + stats for the banner. */
    snapshot() {
        if (!this._project) return null;
        const p = this._project;
        const importedDefs = this.importedDefsForPreview();
        const project = this.ProjectApi.serialize(p);
        if (importedDefs.length) project.importedDefs = importedDefs;
        return {
            revision: this.revision,
            project,
            // Same list the project carries, so a client that only reads one of the two still draws.
            importedDefs,
            stats: {
                components: p.components.length,
                traces: p.traces.length,
                vias: p.vias.length,
                nets: p.nets.length,
                board: `${p.board.width}x${p.board.height}mm`
            }
        };
    }

    runDrc() {
        if (!this._project) return null;
        return this.ProjectApi.runDrc(this._project);
    }
}