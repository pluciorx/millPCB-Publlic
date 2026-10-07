// ============================================================
// Component Library modal
// Browse installed parts (built-in + imported KiCad) and public
// online footprint repositories (GitHub), preview the pin layout
// and 3D body, and place a part directly on the board.
// Online tab is optional: it degrades gracefully offline/file://.
// ============================================================

const ComponentLibrary = {
    tab: 'installed',
    rows: [],
    selected: null,          // { key, def, size, sizeIdx, source }
    onlineFiles: [],
    _repo: null,
    _onlineLoaded: false,
    _selToken: 0,

    repos: [
        { label: 'KiCad official footprints', owner: 'KiCad', repo: 'kicad-footprints' }
    ],

    init() {
        const btn = document.getElementById('component-library-btn');
        if (!btn) return;
        btn.addEventListener('click', () => this.open());
        document.getElementById('lib-close').addEventListener('click', () => this.close());
        document.getElementById('lib-cancel').addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !document.getElementById('lib-overlay').classList.contains('hidden')) this.close();
        });
        document.getElementById('lib-search').addEventListener('input', () => this.renderList());
        document.getElementById('lib-tab-installed').addEventListener('click', () => this.setTab('installed'));
        document.getElementById('lib-tab-online').addEventListener('click', () => this.setTab('online'));
        document.getElementById('lib-place').addEventListener('click', () => this.placeSelected());
        document.getElementById('lib-remove').addEventListener('click', () => this.removeSelected());
        document.getElementById('lib-size').addEventListener('change', (e) => {
            if (!this.selected) return;
            this._showPreview(this.selected.key, this.selected.def, parseInt(e.target.value, 10) || 0, this.selected.source);
        });
        document.getElementById('lib-repo').addEventListener('change', () => this._repoChanged());
        document.getElementById('lib-repo-custom').addEventListener('change', () => this._repoChanged());
        document.getElementById('lib-folder').addEventListener('change', (e) => this._loadFolder(e.target.value));
        document.getElementById('lib-list').addEventListener('click', (e) => {
            const row = e.target.closest('.lib-row');
            if (!row) return;
            const r = this.rows[parseInt(row.dataset.idx, 10)];
            if (r) this.selectRow(r);
        });
        if (typeof Model3D !== 'undefined') Model3D.bind('lib-3d-canvas');
        this._populateRepos();
    },

    open() {
        document.getElementById('lib-overlay').classList.remove('hidden');
        this.setTab(this.tab);
    },

    close() {
        document.getElementById('lib-overlay').classList.add('hidden');
    },

    setTab(tab) {
        this.tab = tab;
        document.getElementById('lib-tab-installed').classList.toggle('active', tab === 'installed');
        document.getElementById('lib-tab-online').classList.toggle('active', tab === 'online');
        document.getElementById('lib-online-controls').classList.toggle('hidden', tab !== 'online');
        this.selected = null;
        this._clearPreview();
        this.renderList();
        if (tab === 'online' && !this._onlineLoaded) {
            this._onlineLoaded = true;
            this._repoChanged();
        }
    },

    // ---------- list ----------

    renderList() {
        const q = (document.getElementById('lib-search').value || '').toLowerCase().trim();
        let items = this.tab === 'installed' ? this._installedItems() : this.onlineFiles.slice();
        if (q) items = items.filter(r => ((r.label || '') + ' ' + (r.key || '') + ' ' + (r.meta || '')).toLowerCase().includes(q));
        this.rows = items;
        const el = document.getElementById('lib-list');
        if (!items.length) {
            el.innerHTML = '<div class="lib-empty">' + (this.tab === 'online' ? 'No .kicad_mod files in this folder.' : 'No components match the search.') + '</div>';
            return;
        }
        el.innerHTML = items.map((r, i) =>
            '<div class="lib-row' + (this.selected && this.selected.key === r.key ? ' active' : '') + '" data-idx="' + i + '">' +
            '<span class="lib-row-name">' + this._esc(r.label) + '</span>' +
            '<span class="lib-row-meta">' + this._esc(r.meta || '') + '</span></div>'
        ).join('');
    },

    _installedItems() {
        const out = [];
        for (const key of Object.keys(ComponentDefs.defs)) {
            const def = ComponentDefs.defs[key];
            if (!def || !def.sizes || !def.sizes.length) continue;
            const imported = def.kicadImported || String(key).indexOf('kx_') === 0;
            const fullLabel = def.label || key;
            out.push({
                key, def, source: 'installed',
                label: (imported && typeof KicadImport !== 'undefined' && KicadImport._shortLabel) ? KicadImport._shortLabel(fullLabel) : fullLabel,
                meta: (imported ? 'imported' : key) + ' · ' + def.sizes.length + ' pkg'
            });
        }
        return out;
    },

    _setList(html) {
        this.rows = [];
        document.getElementById('lib-list').innerHTML = html;
    },

    // ---------- selection & preview ----------

    async selectRow(row) {
        if (row.source === 'online') {
            const token = ++this._selToken;
            document.getElementById('lib-preview-title').textContent = 'Loading ' + row.label + '…';
            try {
                const resp = await fetch(row.download_url);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const fp = KicadImport._parseFootprint(await resp.text());
                if (!fp) throw new Error('Unparsable footprint');
                if (token !== this._selToken) return;
                const def = KicadImport._buildDef(fp, null);
                this._showPreview(def.key, def, 0, 'online');
            } catch (e) {
                if (token !== this._selToken) return;
                this._clearPreview('Preview failed: ' + e.message);
            }
            return;
        }
        this._showPreview(row.key, row.def, row.def.defaultSize || 0, 'installed');
    },

    _showPreview(key, def, sizeIdx, source) {
        const size = ComponentDefs.getSize(def, sizeIdx) || def.sizes[0];
        if (!size) return;
        sizeIdx = def.sizes.indexOf(size);
        this.selected = { key, def, size, sizeIdx, source };
        document.getElementById('lib-preview-title').textContent = (def.label || key) + ' — ' + (size.name || 'package ' + sizeIdx);
        document.getElementById('lib-pin-svg').innerHTML = this._pinSVG(size);
        if (typeof Model3D !== 'undefined') {
            const canvas = document.getElementById('lib-3d-canvas');
            Model3D.resetView(canvas);
            Model3D.buildScene(size, def);
            Model3D.render(canvas);
        }
        const info = [
            Math.max(size.width, 0.1).toFixed(2) + ' × ' + Math.max(size.height, 0.1).toFixed(2) + ' mm',
            (size.pins || []).length + ' pins',
            size.th ? 'Through-hole' : 'SMD'
        ];
        if (size.kicad && size.kicad.layer) info.push(size.kicad.layer);
        document.getElementById('lib-preview-info').textContent = info.join(' · ');
        const m3d = size.model3d || [];
        document.getElementById('lib-preview-refs').innerHTML = m3d.length
            ? m3d.map(m => '<a href="' + m.uri + '" target="_blank" rel="noopener" style="color:#4fc3f7">' + this._esc(m.name) + '</a>').join(' &nbsp; ')
            : '';
        const sizeSel = document.getElementById('lib-size');
        sizeSel.innerHTML = def.sizes.map((s, i) =>
            '<option value="' + i + '"' + (i === sizeIdx ? ' selected' : '') + '>' + this._esc(s.name || ('package ' + i)) + '</option>'
        ).join('');
        sizeSel.classList.remove('hidden');
        document.getElementById('lib-remove').classList.toggle('hidden', !(def.kicadImported || String(key).indexOf('kx_') === 0));
        document.getElementById('lib-place').disabled = false;
        document.querySelectorAll('#lib-list .lib-row').forEach(r => r.classList.remove('active'));
        const idx = this.rows.findIndex(r => r.key === key);
        if (idx >= 0) {
            const activeRow = document.querySelector('#lib-list .lib-row[data-idx="' + idx + '"]');
            if (activeRow) activeRow.classList.add('active');
        }
    },

    _clearPreview(msg) {
        this.selected = null;
        document.getElementById('lib-preview-title').textContent = msg || 'Select a component';
        document.getElementById('lib-pin-svg').innerHTML = '';
        document.getElementById('lib-preview-info').textContent = '';
        document.getElementById('lib-preview-refs').innerHTML = '';
        document.getElementById('lib-size').classList.add('hidden');
        document.getElementById('lib-size').innerHTML = '';
        document.getElementById('lib-remove').classList.add('hidden');
        document.getElementById('lib-place').disabled = true;
        // The 3D canvas needs a WebGL context; the CSS background covers the
        // empty state - never acquire a 2D context here (it would lock WebGL).
    },

    // Top-view pin layout: fab outline + copper pads + drill holes + pad numbers.
    _pinSVG(size) {
        const k = size.kicad;
        const w = Math.max(size.width, 1), h = Math.max(size.height, 1);
        let els = '';
        if (k) {
            const gfx = (g, stroke) => {
                if (g.type === 'line') els += '<line x1="' + g.x1 + '" y1="' + g.y1 + '" x2="' + g.x2 + '" y2="' + g.y2 + '" stroke="' + stroke + '" stroke-width="0.1"/>';
                else if (g.type === 'rect') els += '<rect x="' + Math.min(g.x1, g.x2) + '" y="' + Math.min(g.y1, g.y2) + '" width="' + Math.abs(g.x2 - g.x1) + '" height="' + Math.abs(g.y2 - g.y1) + '" fill="none" stroke="' + stroke + '" stroke-width="0.1"/>';
                else if (g.type === 'circle') els += '<circle cx="' + g.x + '" cy="' + g.y + '" r="' + g.r + '" fill="none" stroke="' + stroke + '" stroke-width="0.1"/>';
                else if (g.type === 'arc' && g.r > 0) {
                    const x1 = g.x + g.r * Math.cos(g.a0), y1 = g.y + g.r * Math.sin(g.a0);
                    const x2 = g.x + g.r * Math.cos(g.a0 + g.sweep), y2 = g.y + g.r * Math.sin(g.a0 + g.sweep);
                    const large = Math.abs(g.sweep) > Math.PI ? 1 : 0;
                    const sweep = g.sweep > 0 ? 1 : 0;
                    els += '<path d="M ' + x1 + ' ' + y1 + ' A ' + g.r + ' ' + g.r + ' 0 ' + large + ' ' + sweep + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="' + stroke + '" stroke-width="0.1"/>';
                } else if (g.type === 'poly' && g.pts) els += '<polygon points="' + g.pts.map(p => p.x + ',' + p.y).join(' ') + '" fill="none" stroke="' + stroke + '" stroke-width="0.1"/>';
            };
            (k.fab || []).forEach(g => gfx(g, '#6f7d8c'));
            (k.silk || []).forEach(g => gfx(g, '#d5dde6'));
            (k.pads || []).forEach(p => {
                const pw = Math.max(p.w || 1, 0.3), ph = Math.max(p.h || 1, 0.3);
                const rot = p.rot ? ' transform="rotate(' + p.rot + ' ' + p.x + ' ' + p.y + ')"' : '';
                if (p.shape === 'circle' || p.shape === 'round' || p.drillOval) {
                    els += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (Math.max(pw, ph) / 2) + '" fill="#c9973c" stroke="#8a6a28" stroke-width="0.08"/>';
                } else {
                    els += '<rect x="' + (p.x - pw / 2) + '" y="' + (p.y - ph / 2) + '" width="' + pw + '" height="' + ph + '" rx="' + (Math.min(pw, ph) * 0.15) + '" fill="#c9973c" stroke="#8a6a28" stroke-width="0.08"' + rot + '/>';
                }
                if (p.drill > 0.05) els += '<circle cx="' + p.x + '" cy="' + p.y + '" r="' + (Math.min(p.drill, pw, ph) / 2) + '" fill="#0c1424"/>';
                els += '<text x="' + p.x + '" y="' + (p.y - Math.max(pw, ph) / 2 - 0.25) + '" font-size="0.85" fill="#cfe3f5" text-anchor="middle">' + this._esc(p.num || '') + '</text>';
            });
        } else {
            els += '<rect x="' + (-w / 2) + '" y="' + (-h / 2) + '" width="' + w + '" height="' + h + '" fill="none" stroke="#6f7d8c" stroke-width="0.12"/>';
            (size.pins || []).forEach(p => {
                els += '<circle cx="' + p.x + '" cy="' + p.y + '" r="0.55" fill="#c9973c" stroke="#8a6a28" stroke-width="0.08"/>';
                els += '<text x="' + p.x + '" y="' + (p.y - 0.9) + '" font-size="0.85" fill="#cfe3f5" text-anchor="middle">' + this._esc(p.name || '') + '</text>';
            });
        }
        const pad = Math.max(w, h) * 0.18 + 1.2;
        return '<svg viewBox="' + (-w / 2 - pad).toFixed(2) + ' ' + (-h / 2 - pad).toFixed(2) + ' ' + (w + 2 * pad).toFixed(2) + ' ' + (h + 2 * pad).toFixed(2) + '" preserveAspectRatio="xMidYMid meet">' + els + '</svg>';
    },

    // ---------- actions ----------

    placeSelected() {
        const sel = this.selected;
        if (!sel) return;
        let key = sel.key;
        if (sel.source === 'online') KicadImport.registerEntries([sel.def]);
        const def = ComponentDefs.get(key);
        if (!def) { App.setStatus('Component unavailable.'); return; }
        const sizeIdx = sel.sizeIdx || 0;
        const size = ComponentDefs.getSize(def, sizeIdx) || def.sizes[0];
        const i = App.interaction;
        i.placingComponent = key;
        i.placingSize[key] = sizeIdx;
        i.placingJumperKind = null;
        i.jumperFirst = null;
        i._placingOnCanvas = false;
        document.querySelectorAll('.comp-item').forEach(x => x.classList.remove('placing-active'));
        if (App.setView) App.setView('board');
        App.setStatus('Click on board to place ' + (def.label || key) + ' (' + ((size && size.name) || '') + ')');
        this.close();
    },

    removeSelected() {
        const sel = this.selected;
        if (!sel) return;
        const key = sel.key;
        const def = ComponentDefs.defs[key];
        if (!def || !(def.kicadImported || String(key).indexOf('kx_') === 0)) return;
        delete ComponentDefs.defs[key];
        this._clearPreview();
        this.renderList();
        App.setStatus('Removed ' + (def.label || key) + ' from the library.');
    },

    // ---------- online repositories ----------

    _populateRepos() {
        const sel = document.getElementById('lib-repo');
        sel.innerHTML = this.repos.map((r, i) => '<option value="' + i + '">' + r.label + '</option>').join('') +
            '<option value="custom">Custom GitHub repo…</option>';
    },

    _currentRepo() {
        const sel = document.getElementById('lib-repo');
        if (sel.value === 'custom') {
            const raw = (document.getElementById('lib-repo-custom').value || '').trim()
                .replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '');
            const parts = raw.split('/').filter(Boolean);
            if (parts.length < 2) return null;
            return { owner: parts[0], repo: parts[1], path: parts.slice(2).join('/') };
        }
        const r = this.repos[parseInt(sel.value, 10)];
        return r ? { owner: r.owner, repo: r.repo } : null;
    },

    async _repoChanged() {
        const r = this._currentRepo();
        if (!r) {
            this._setList('<div class="lib-empty">Enter a public GitHub repo as owner/repo (optionally owner/repo/folder).</div>');
            return;
        }
        await this._loadDirs(r.owner, r.repo, r.path);
    },

    async _loadDirs(owner, repo, path) {
        const folderSel = document.getElementById('lib-folder');
        this._repo = { owner, repo };
        this._setList('<div class="lib-empty">Loading repository…</div>');
        try {
            if (path) {
                folderSel.innerHTML = '<option>' + this._esc(path) + '</option>';
                await this._loadFolder(path);
                return;
            }
            const data = await this._gh('https://api.github.com/repos/' + owner + '/' + repo + '/contents/');
            const dirs = (data || []).filter(e => e.type === 'dir').map(e => e.name).sort();
            folderSel.innerHTML = dirs.map(d => '<option>' + this._esc(d) + '</option>').join('');
            if (dirs.length) await this._loadFolder(dirs[0]);
            else this._setList('<div class="lib-empty">No folders found in this repository.</div>');
        } catch (e) {
            folderSel.innerHTML = '';
            this.onlineFiles = [];
            this._setList('<div class="lib-empty">Repository unavailable: ' + this._esc(e.message) + ' — check the name, your network, or the GitHub rate limit.</div>');
        }
    },

    async _loadFolder(name) {
        const r = this._repo;
        if (!r) return;
        this._setList('<div class="lib-empty">Loading ' + this._esc(name) + '…</div>');
        const p = String(name).split('/').map(encodeURIComponent).join('/');
        try {
            const data = await this._gh('https://api.github.com/repos/' + r.owner + '/' + r.repo + '/contents/' + p);
            this.onlineFiles = (data || [])
                .filter(e => e.type === 'file' && /\.(kicad_mod|mod)$/i.test(e.name))
                .map(e => ({
                    label: e.name.replace(/\.(kicad_)?mod$/i, ''),
                    key: e.path, meta: 'online',
                    download_url: e.download_url, source: 'online'
                }));
            this.renderList();
        } catch (e) {
            this.onlineFiles = [];
            this._setList('<div class="lib-empty">Folder unavailable: ' + this._esc(e.message) + '</div>');
        }
    },

    async _gh(url) {
        const resp = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
};
