// ============================================================
// Save / Load / AutoLoad
// ============================================================

Object.assign(App, {
    _defaultExport() {
        return {
            kerfWidth: 0.15, units: 'mm', includeHoles: true, includeTraces: true, includeComps: true,
            includeBoardOutline: true, includeCopperOutlines: true,
            millToolDia: 0.2, millIsoDepth: 0.1, millSafeZ: 5,
            millFeed: 120, millPlunge: 50, millSpindle: 10000,
            millDrillToolDia: 0.8, millOutlineToolDia: 0.2,
            millDrillFeed: 50, millOutlineFeed: 72,
            millOutlinePasses: 3, millOutlineOvercut: 0, millDrillOvercut: 0.1,
            millSpindleDwell: 2, millProfile: 'grbl', dxfMode: 'standard', mirror: false,
            layers: { COPPER_TOP: true, COPPER_BOTTOM: false, TRACE_OUTLINE_TOP: false, TRACE_OUTLINE_BOTTOM: false, TRACE_TOP: false, TRACE_BOTTOM: false, PAD_TOP: false, PAD_BOTTOM: false }
        };
    },

    _defaultParams() {
        return {
            traceWidth: 0.5, viaDiameter: 1.0, gridSize: 1.0, minTraceWidth: 0.38, minDrill: 0.1, minClearance: 0.38,
            jumperFollow: 'pads', routeAngle: 'hv45',
            autoroute: { gridSize: 0.1, layer: 'top', skipRouted: true }
        };
    },

    _mergeAutorouteParams(params) {
        const d = { gridSize: 0.1, layer: 'top', skipRouted: true };
        const src = (params && params.autoroute && typeof params.autoroute === 'object') ? params.autoroute : {};
        const g = Number(src.gridSize);
        params.autoroute = {
            gridSize: (g === 0.05 || g === 0.1 || g === 0.2 || g === 0.25) ? g : d.gridSize,
            layer: src.layer === 'bottom' ? 'bottom' : 'top',
            skipRouted: src.skipRouted !== false
        };
        if (Number(src.traceWidth) > 0) params.autoroute.traceWidth = Number(src.traceWidth);
        if (Number(src.clearance) > 0) params.autoroute.clearance = Number(src.clearance);
    },

    applyProjectData(data) {
        this.board = data.board || this.board;
        this.params = Object.assign({}, this._defaultParams(), data.params || {});
        if (this.params.jumperFollow !== 'joints') this.params.jumperFollow = 'pads';
        if (this.params.routeAngle !== 'free') this.params.routeAngle = 'hv45';
        this._mergeAutorouteParams(this.params);
        this.export = Object.assign(this._defaultExport(), data.export || {});
        this.nets = data.nets || this.nets;
        this.traces = data.traces || [];
        this.components = data.components || [];
        this.vias = data.vias || [];
        this.boardOutline = data.boardOutline || [];
        this.silkTexts = data.silkTexts || [];
        this.requirements = data.requirements || null;
        this.zones = data.zones || [];
        this.assignments = data.assignments || {};
        this.flowDirection = data.flowDirection || 'lr';
        this.netlist = (data.netlist && typeof data.netlist === 'object') ? JSON.parse(JSON.stringify(data.netlist)) : {};
        this.groups = Array.isArray(data.groups) ? JSON.parse(JSON.stringify(data.groups)) : [];
        this.circuitContract = (data.circuitContract && typeof data.circuitContract === 'object') ? JSON.parse(JSON.stringify(data.circuitContract)) : null;
        this.electricalValidation = (data.electricalValidation && typeof data.electricalValidation === 'object') ? JSON.parse(JSON.stringify(data.electricalValidation)) : null;
        this.idCounter = data.idCounter || 0;
        if (typeof KicadImport !== 'undefined' && data.importedDefs) KicadImport.restoreDefs(data.importedDefs);
        this.undoStack = [];
        this.redoStack = [];
        this.interaction.selectedObject = null;
        this.interaction.selectedSegment = null;
        this.interaction.selectedVertices = [];
        this.interaction.schemSelectedWires = [];
        this.interaction.schemSelectedJoint = null;
        this.interaction.schemDraggingSeg = null;
        this.interaction.schemWireStart = null;
        this.interaction.schemWireInterior = [];
        this.interaction.schemWireCursor = null;
        this.ensureSchemPositions();
        this.ensureLabels();
        this.ensureAllCompSilkLayouts();
        if (this.ensureWireJumperJoints) this.ensureWireJumperJoints();
        if (this.syncStatusModeToggles) this.syncStatusModeToggles();
        if (this.updateNetsList) this.updateNetsList(); // refresh nets panel (incl. supply voltages)
        this.saveState();
        this.fitToView();
    },

    loadExample(id) {
        if (!confirm('Load this example? Current work will be replaced.')) return;
        try {
            const data = Examples.build(id);
            this.applyProjectData(data);
            this.projectMeta = null; // examples are not saved projects
            this.setView('schematic');
            const name = Examples.list.find(e => e.id === id);
            this.setStatus('Loaded example: ' + (name ? name.name : id));
        } catch (err) {
            alert('Failed to load example: ' + err.message);
        }
    },

    // ============================================================
    // Local project store (localStorage)
    //   millpcb.projects          → [{id, title, description, savedAt}]
    //   millpcb.project.<id>      → serialized project JSON
    // ============================================================

    _readProjectIndex() {
        try {
            const raw = localStorage.getItem('millpcb.projects');
            if (raw) {
                const list = JSON.parse(raw);
                if (Array.isArray(list)) return list;
            }
        } catch (e) { /* corrupt index → start fresh */ }
        return [];
    },

    _writeProjectIndex(list) {
        localStorage.setItem('millpcb.projects', JSON.stringify(list));
    },

    // One-time migration of the old single-project autosave key.
    _migrateLegacyProject() {
        const legacy = localStorage.getItem('pcb-project');
        if (!legacy) return;
        try {
            JSON.parse(legacy); // only migrate valid JSON
            const id = 'legacy-' + Date.now();
            localStorage.setItem('millpcb.project.' + id, legacy);
            const list = this._readProjectIndex();
            list.push({ id, title: 'Imported Project', description: 'Migrated from previous autosave', savedAt: Date.now() });
            this._writeProjectIndex(list);
        } catch (e) { /* corrupt legacy save — drop it */ }
        localStorage.removeItem('pcb-project');
    },

    listLocalProjects() {
        this._migrateLegacyProject();
        return this._readProjectIndex().slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    },

    serializeProjectData() {
        // Prefer the shared kernel serializer so the SPA and the MCP
        // server produce byte-identical project files; fall back to the
        // inline shape if ProjectApi is unavailable.
        if (typeof ProjectApi !== 'undefined' && typeof ProjectApi.serialize === 'function') {
            return ProjectApi.serialize(this);
        }
        return {
            version: 1,
            board: { ...this.board },
            params: { ...this.params },
            export: { ...this.export },
            nets: [...this.nets],
            traces: this.traces,
            components: this.components,
            vias: this.vias,
            boardOutline: this.boardOutline,
            requirements: this.requirements || null,
            zones: this.zones || [],
            assignments: this.assignments || {},
            flowDirection: this.flowDirection || 'lr',
            netlist: this.netlist || {},
            groups: this.groups || [],
            circuitContract: this.circuitContract || null,
            electricalValidation: this.electricalValidation || null,
            idCounter: this.idCounter,
            importedDefs: (typeof KicadImport !== 'undefined') ? KicadImport.getImportedDefs() : []
        };
    },

    _downloadProjectData(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    // Save current design into browser storage (title/desc from modal inputs).
    saveCurrentToStorage() {
        const title = (document.getElementById('project-title').value || '').trim() || 'Untitled Project';
        const description = (document.getElementById('project-description').value || '').trim();
        const id = (this.projectMeta && this.projectMeta.id) || ('p-' + Date.now());
        try {
            localStorage.setItem('millpcb.project.' + id, JSON.stringify(this.serializeProjectData(), null, 2));
            const list = this._readProjectIndex();
            const entry = list.find(e => e.id === id);
            if (entry) Object.assign(entry, { title, description, savedAt: Date.now() });
            else list.push({ id, title, description, savedAt: Date.now() });
            this._writeProjectIndex(list);
        } catch (e) {
            alert('Could not save project to browser storage: ' + e.message);
            return false;
        }
        this.projectMeta = { id, title, description };
        this.setStatus('Saved "' + title + '" to this browser');
        this._renderProjectList();
        return true;
    },

    downloadProjectFile() {
        const title = (this.projectMeta && this.projectMeta.title) || 'project';
        const name = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project') + '.pcb.json';
        this._downloadProjectData(this.serializeProjectData(), name);
        this.setStatus('Downloaded ' + name);
    },

    loadLocalProject(id) {
        const raw = localStorage.getItem('millpcb.project.' + id);
        if (!raw) { alert('Project data not found in browser storage.'); return; }
        const entry = this.listLocalProjects().find(e => e.id === id);
        const title = (entry && entry.title) || 'this project';
        if (!confirm('Load "' + title + '"? Current work will be replaced.')) return;
        try {
            this.applyProjectData(JSON.parse(raw));
            this.projectMeta = { id, title: entry ? entry.title : '', description: entry ? entry.description : '' };
            this.setStatus('Loaded project: ' + title);
            this.closeProjectModal();
        } catch (err) {
            alert('Failed to load project: ' + err.message);
        }
    },

    deleteLocalProject(id) {
        const entry = this.listLocalProjects().find(e => e.id === id);
        if (!confirm('Delete "' + ((entry && entry.title) || 'this project') + '" from browser storage?')) return;
        localStorage.removeItem('millpcb.project.' + id);
        this._writeProjectIndex(this._readProjectIndex().filter(e => e.id !== id));
        this._renderProjectList();
    },

    saveProject() {
        this.openSaveProjectModal();
    },

    loadProject() {
        this.openOpenProjectModal();
    },

    // ============================================================
    // Project modals: Save (Save button / Ctrl+S) and Open (Load button / Ctrl+O)
    // ============================================================

    openSaveProjectModal() {
        const overlay = document.getElementById('save-project-overlay');
        if (!overlay) return;
        this._bindProjectModals();
        if (overlay.classList.contains('hidden')) { // don't clobber inputs while editing
            const meta = this.projectMeta || {};
            document.getElementById('project-title').value = meta.title || '';
            document.getElementById('project-description').value = meta.description || '';
        }
        const hint = document.getElementById('project-overwrite-hint');
        if (this.projectMeta && this.projectMeta.id) {
            hint.textContent = 'Saving again updates "' + (this.projectMeta.title || 'Untitled Project') + '".';
            hint.classList.remove('hidden');
        } else {
            hint.classList.add('hidden');
        }
        overlay.classList.remove('hidden');
        document.getElementById('project-title').focus();
    },

    openOpenProjectModal() {
        const overlay = document.getElementById('open-project-overlay');
        if (!overlay) return;
        this._bindProjectModals();
        this._renderProjectList();
        overlay.classList.remove('hidden');
        document.getElementById('open-project-modal').focus();
    },

    closeProjectModal(overlayId) {
        const overlay = document.getElementById(overlayId);
        if (!overlay) return;
        if (overlay.contains(document.activeElement)) document.activeElement.blur();
        overlay.classList.add('hidden');
    },

    _bindProjectModals() {
        if (this._projectModalBound) return;
        this._projectModalBound = true;
        const bindDismiss = (overlayId, buttonIds) => {
            const overlay = document.getElementById(overlayId);
            overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) this.closeProjectModal(overlayId); });
            for (const id of buttonIds) document.getElementById(id).addEventListener('click', () => this.closeProjectModal(overlayId));
            document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) this.closeProjectModal(overlayId); });
        };
        bindDismiss('save-project-overlay', ['save-project-close']);
        bindDismiss('open-project-overlay', ['open-project-close', 'open-project-cancel']);
        document.getElementById('project-save-btn').addEventListener('click', () => { if (this.saveCurrentToStorage()) this.closeProjectModal('save-project-overlay'); });
        document.getElementById('project-download-btn').addEventListener('click', () => this.downloadProjectFile());
        document.getElementById('project-import-btn').addEventListener('click', () => document.getElementById('project-file-input').click());
        document.getElementById('project-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    this.applyProjectData(data);
                    // Imported files are unnamed until the user saves them.
                    this.projectMeta = { id: null, title: file.name.replace(/\.(pcb\.json|json|pcb)$/i, ''), description: '' };
                    this.setStatus('Imported project from ' + file.name);
                    this.closeProjectModal('open-project-overlay');
                } catch (err) {
                    alert('Failed to import project: ' + err.message);
                }
            };
            reader.readAsText(file);
        });
    },

    _renderProjectList() {
        const listEl = document.getElementById('project-list');
        if (!listEl) return;
        const items = this.listLocalProjects();
        if (!items.length) {
            listEl.innerHTML = '<div class="project-empty">No saved projects yet.</div>';
            return;
        }
        listEl.innerHTML = '';
        for (const it of items) {
            const row = document.createElement('div');
            row.className = 'project-item';
            const info = document.createElement('div');
            info.className = 'project-item-info';
            const title = document.createElement('div');
            title.className = 'project-item-title';
            title.textContent = it.title || 'Untitled Project';
            const desc = document.createElement('div');
            desc.className = 'project-item-desc';
            desc.textContent = (it.description ? it.description + ' · ' : '') + new Date(it.savedAt || 0).toLocaleString();
            info.append(title, desc);
            const loadBtn = document.createElement('button');
            loadBtn.type = 'button';
            loadBtn.textContent = 'Load';
            loadBtn.addEventListener('click', () => this.loadLocalProject(it.id));
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'project-item-delete';
            delBtn.textContent = '🗑';
            delBtn.title = 'Delete from browser storage';
            delBtn.addEventListener('click', () => this.deleteLocalProject(it.id));
            row.append(info, loadBtn, delBtn);
            listEl.appendChild(row);
        }
    },

    autoLoad() {
        let data = null, meta = null;
        try {
            const list = this.listLocalProjects(); // newest first (also migrates legacy key)
            if (list.length) {
                meta = list[0];
                data = JSON.parse(localStorage.getItem('millpcb.project.' + meta.id));
            }
        } catch (e) { /* ignore corrupt save */ }
        if (!data) return;
        this.projectMeta = { id: meta.id, title: meta.title || '', description: meta.description || '' };
        this.board = data.board || this.board;
        this.params = Object.assign({}, this._defaultParams(), data.params || {});
        if (this.params.jumperFollow !== 'joints') this.params.jumperFollow = 'pads';
        if (this.params.routeAngle !== 'free') this.params.routeAngle = 'hv45';
        this._mergeAutorouteParams(this.params);
        this.export = Object.assign(this._defaultExport(), data.export || {});
        this.nets = data.nets || this.nets;
        this.traces = data.traces || [];
        this.components = data.components || [];
        this.vias = data.vias || [];
        this.boardOutline = data.boardOutline || [];
        this.silkTexts = data.silkTexts || [];
        this.requirements = data.requirements || null;
        this.zones = data.zones || [];
        this.assignments = data.assignments || {};
        this.flowDirection = data.flowDirection || 'lr';
        this.netlist = (data.netlist && typeof data.netlist === 'object') ? JSON.parse(JSON.stringify(data.netlist)) : {};
        this.groups = Array.isArray(data.groups) ? JSON.parse(JSON.stringify(data.groups)) : [];
        this.circuitContract = (data.circuitContract && typeof data.circuitContract === 'object') ? JSON.parse(JSON.stringify(data.circuitContract)) : null;
        this.electricalValidation = (data.electricalValidation && typeof data.electricalValidation === 'object') ? JSON.parse(JSON.stringify(data.electricalValidation)) : null;
        this.idCounter = data.idCounter || 0;
        if (typeof KicadImport !== 'undefined' && data.importedDefs) KicadImport.restoreDefs(data.importedDefs);
        this.ensureSchemPositions();
        this.ensureLabels();
        this.ensureAllCompSilkLayouts();
        if (this.syncStatusModeToggles) this.syncStatusModeToggles();
    }
});
