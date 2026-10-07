// ============================================================
// UI Bindings, Keyboard Shortcuts, Tool/View Switching
// ============================================================

Object.assign(App, {
    // Reflect current export settings into the modal inputs (called when the modal opens)
    syncExportSettings() {
        const ex = this.export || {};
        const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
        const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
        setVal('export-kerf', ex.kerfWidth);
        setVal('export-units', ex.units);
        setVal('export-dxf-mode', ex.dxfMode);
        setChk('export-mirror', ex.mirror);
        setChk('export-board-size', ex.includeBoardOutline !== false);
        setChk('export-copper', ex.includeCopperOutlines !== false);
        setChk('export-holes', ex.includeHoles !== false);
        setChk('export-traces', ex.includeTraces !== false);
        setChk('export-comps', ex.includeComps !== false);
        const ly = ex.layers || {};
        ['COPPER_TOP', 'COPPER_BOTTOM', 'TRACE_OUTLINE_TOP', 'TRACE_OUTLINE_BOTTOM', 'TRACE_TOP', 'TRACE_BOTTOM', 'PAD_TOP', 'PAD_BOTTOM'].forEach(name => {
            setChk('export-layer-' + name, typeof ly[name] === 'boolean' ? ly[name] : name === 'COPPER_TOP');
        });
        setVal('export-mill-tool', ex.millToolDia);
        setVal('export-mill-drill-tool', ex.millDrillToolDia);
        setVal('export-mill-outline-tool', ex.millOutlineToolDia);
        setVal('export-mill-iso', ex.millIsoDepth);
        setVal('export-mill-safez', ex.millSafeZ);
        setVal('export-mill-feed', ex.millFeed);
        setVal('export-mill-drill-feed', ex.millDrillFeed);
        setVal('export-mill-outline-feed', ex.millOutlineFeed);
        setVal('export-mill-plunge', ex.millPlunge);
        setVal('export-mill-outline-passes', ex.millOutlinePasses);
        setVal('export-mill-drill-overcut', ex.millDrillOvercut);
        setVal('export-mill-outline-overcut', ex.millOutlineOvercut);
        setVal('export-mill-spindle', ex.millSpindle);
        setVal('export-mill-spindle-dwell', ex.millSpindleDwell);
    },

    // Read modal inputs back into this.export (DOM -> state). Keeps last-good values while number fields are mid-edit.
    readExportInputs() {
        const ex = this.export = this.export || {};
        const num = (id, key) => { const el = document.getElementById(id); if (!el) return; const v = parseFloat(el.value); if (isFinite(v)) ex[key] = v; };
        const int = (id, key) => { const el = document.getElementById(id); if (!el) return; const v = parseInt(el.value, 10); if (isFinite(v)) ex[key] = v; };
        const chk = (id, key) => { const el = document.getElementById(id); if (el) ex[key] = el.checked; };
        num('export-kerf', 'kerfWidth');
        const units = document.getElementById('export-units'); if (units) ex.units = units.value;
        const mode = document.getElementById('export-dxf-mode'); if (mode) ex.dxfMode = mode.value;
        chk('export-mirror', 'mirror');
        chk('export-board-size', 'includeBoardOutline');
        chk('export-copper', 'includeCopperOutlines');
        chk('export-holes', 'includeHoles');
        chk('export-traces', 'includeTraces');
        chk('export-comps', 'includeComps');
        ex.layers = ex.layers || {};
        ['COPPER_TOP', 'COPPER_BOTTOM', 'TRACE_OUTLINE_TOP', 'TRACE_OUTLINE_BOTTOM', 'TRACE_TOP', 'TRACE_BOTTOM', 'PAD_TOP', 'PAD_BOTTOM'].forEach(name => {
            const el = document.getElementById('export-layer-' + name); if (el) ex.layers[name] = el.checked;
        });
        num('export-mill-tool', 'millToolDia');
        num('export-mill-drill-tool', 'millDrillToolDia');
        num('export-mill-outline-tool', 'millOutlineToolDia');
        num('export-mill-iso', 'millIsoDepth');
        num('export-mill-safez', 'millSafeZ');
        num('export-mill-feed', 'millFeed');
        num('export-mill-drill-feed', 'millDrillFeed');
        num('export-mill-outline-feed', 'millOutlineFeed');
        num('export-mill-plunge', 'millPlunge');
        int('export-mill-outline-passes', 'millOutlinePasses');
        num('export-mill-drill-overcut', 'millDrillOvercut');
        num('export-mill-outline-overcut', 'millOutlineOvercut');
        num('export-mill-spindle', 'millSpindle');
        num('export-mill-spindle-dwell', 'millSpindleDwell');
    },

    bindEvents() {
        window.addEventListener('resize', () => { this.resizeCanvases(); this.render(); });
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
        });
        document.getElementById('view-board').addEventListener('click', () => this.setView('board'));
        document.getElementById('view-schematic').addEventListener('click', () => this.setView('schematic'));
        const btn3d = document.getElementById('view-3d');
        if (btn3d) btn3d.addEventListener('click', () => { if (typeof Model3D !== 'undefined') Model3D.openBoard(); });
        document.getElementById('btn-zoom-in').addEventListener('click', () => this.setViewZoom(this._activeZoom() * 1.25));
        document.getElementById('btn-zoom-out').addEventListener('click', () => this.setViewZoom(this._activeZoom() / 1.25));
        const zoomSelect = document.getElementById('zoom-select');
        if (zoomSelect) {
            zoomSelect.addEventListener('change', () => {
                if (zoomSelect.value) this.setViewZoom(this.pctToZoom(parseFloat(zoomSelect.value)));
            });
        }
        document.getElementById('btn-zoom-fit').addEventListener('click', () => this.fitToView());
        document.getElementById('btn-undo').addEventListener('click', () => this.undo());
        document.getElementById('btn-redo').addEventListener('click', () => this.redo());
        // File menu — New / Save / Load / Download / Import / Examples
        const fileMenuBtn = document.getElementById('btn-file-menu');
        const fileDropdown = document.getElementById('file-dropdown');
        if (fileMenuBtn && fileDropdown) {
            const closeFileMenu = () => fileDropdown.classList.add('hidden');
            fileMenuBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isOpen = !fileDropdown.classList.contains('hidden');
                if (isOpen) { closeFileMenu(); return; }
                const rect = fileMenuBtn.getBoundingClientRect();
                fileDropdown.style.left = rect.left + 'px';
                fileDropdown.style.top = (rect.bottom + 4) + 'px';
                fileDropdown.classList.remove('hidden');
            });
            fileDropdown.addEventListener('click', () => closeFileMenu());
            document.addEventListener('click', (ev) => {
                if (!fileDropdown.classList.contains('hidden') &&
                    !fileDropdown.contains(ev.target) && ev.target !== fileMenuBtn) {
                    closeFileMenu();
                }
            });
            document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeFileMenu(); });
            document.getElementById('fm-new').addEventListener('click', () => this.newProject());
            document.getElementById('fm-save').addEventListener('click', () => this.saveProject());
            document.getElementById('fm-load').addEventListener('click', () => this.loadProject());
            document.getElementById('fm-download').addEventListener('click', () => this.downloadProjectFile());
            document.getElementById('fm-import').addEventListener('click', () => document.getElementById('project-file-input').click());
        }
        document.getElementById('btn-export').addEventListener('click', () => Export.exportSVG(this));
        // Export buttons open the settings modal (Export SVG stays one-click)
        const exportOverlay = document.getElementById('export-modal-overlay');
        const closeExportModal = () => {
            if (exportOverlay.contains(document.activeElement)) document.activeElement.blur();
            exportOverlay.classList.add('hidden');
        };
        // Export preview pane (DXF entities per current settings) — wheel zoom, drag pan, dblclick reset
        const previewPane = document.getElementById('export-preview-pane');
        const pvBox = document.getElementById('export-preview-svg');
        let pvBase = null, pvView = null, pvDrag = null;
        const pvApplyView = () => {
            const svg = pvBox && pvBox.querySelector('svg');
            if (svg && pvView) svg.setAttribute('viewBox', `${pvView.x} ${pvView.y} ${pvView.w} ${pvView.h}`);
        };
        const renderExportPreview = () => {
            this.readExportInputs();
            const legend = document.getElementById('export-preview-legend');
            if (!pvBox || !legend) return;
            const res = Export.buildPreviewSVG(this);
            if (!res) { pvBox.innerHTML = ''; pvBase = null; pvView = null; legend.innerHTML = '<span class="hint">Export validation failed — fix the settings.</span>'; return; }
            pvBox.innerHTML = res.empty ? '' : res.svg;
            if (res.bounds) {
                // keep current zoom/pan while content bounds are unchanged, otherwise fit
                const same = pvBase && Math.abs(pvBase.x - res.bounds.x) < 1e-6 && Math.abs(pvBase.y - res.bounds.y) < 1e-6 &&
                    Math.abs(pvBase.w - res.bounds.w) < 1e-6 && Math.abs(pvBase.h - res.bounds.h) < 1e-6;
                pvBase = res.bounds;
                if (!pvView || !same) pvView = Object.assign({}, pvBase);
            } else { pvBase = null; pvView = null; }
            pvApplyView(); // re-apply current view to the freshly rendered SVG
            legend.innerHTML = (res.empty ? '<span class="hint">No entities selected.</span>' : '') + res.layers.map(l => `<span class="preview-legend-item"><i style="background:${l.color}\"></i>${l.name}</span>`).join('');
        };
        const pvMouseToSvg = (clientX, clientY) => {
            const rect = pvBox.getBoundingClientRect();
            const v = pvView;
            const scale = Math.min(rect.width / v.w, rect.height / v.h);
            const ox = (rect.width - v.w * scale) / 2, oy = (rect.height - v.h * scale) / 2;
            return { x: v.x + (clientX - rect.left - ox) / scale, y: v.y + (clientY - rect.top - oy) / scale, scale };
        };
        pvBox.addEventListener('wheel', e => {
            if (!pvView || !pvBase) return;
            e.preventDefault();
            const m = pvMouseToSvg(e.clientX, e.clientY);
            const f = e.deltaY < 0 ? 1 / 1.2 : 1.2; // scroll up = zoom in
            const nw = Math.min(Math.max(pvView.w * f, pvBase.w / 40), pvBase.w * 20);
            const r = nw / pvView.w;
            pvView = { x: m.x - (m.x - pvView.x) * r, y: m.y - (m.y - pvView.y) * r, w: nw, h: pvView.h * r };
            pvApplyView();
        }, { passive: false });
        pvBox.addEventListener('mousedown', e => {
            if (e.button !== 0 || !pvView) return;
            const m = pvMouseToSvg(e.clientX, e.clientY);
            pvDrag = { sx: e.clientX, sy: e.clientY, vx: pvView.x, vy: pvView.y, scale: m.scale };
            pvBox.classList.add('dragging');
        });
        window.addEventListener('mousemove', e => {
            if (!pvDrag) return;
            pvView.x = pvDrag.vx - (e.clientX - pvDrag.sx) / pvDrag.scale;
            pvView.y = pvDrag.vy - (e.clientY - pvDrag.sy) / pvDrag.scale;
            pvApplyView();
        });
        window.addEventListener('mouseup', () => { if (pvDrag) { pvDrag = null; pvBox.classList.remove('dragging'); } });
        pvBox.addEventListener('dblclick', () => { if (pvBase) { pvView = Object.assign({}, pvBase); pvApplyView(); } });
        const showPreview = on => {
            previewPane.classList.toggle('hidden', !on);
            document.getElementById('export-modal').classList.toggle('with-preview', on);
            document.getElementById('export-preview-toggle').classList.toggle('active', on);
            if (on) renderExportPreview();
        };
        const openExportModal = (withPreview) => {
            this.syncExportSettings();
            exportOverlay.classList.remove('hidden');
            if (withPreview) showPreview(true);
            document.getElementById('export-modal').focus();
        };
        document.getElementById('btn-export-dxf').addEventListener('click', () => openExportModal(false));
        document.getElementById('btn-export-gcode').addEventListener('click', () => openExportModal(false));
        const exportMenuBtn = document.getElementById('btn-export-menu');
        const exportDropdown = document.getElementById('export-dropdown');
        if (exportMenuBtn && exportDropdown) {
            const closeExportMenu = () => exportDropdown.classList.add('hidden');
            exportMenuBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const isOpen = !exportDropdown.classList.contains('hidden');
                if (isOpen) { closeExportMenu(); return; }
                const rect = exportMenuBtn.getBoundingClientRect();
                exportDropdown.style.left = rect.left + 'px';
                exportDropdown.style.top = (rect.bottom + 4) + 'px';
                exportDropdown.classList.remove('hidden');
            });
            exportDropdown.addEventListener('click', () => closeExportMenu());
            document.addEventListener('click', (ev) => {
                if (!exportDropdown.classList.contains('hidden') &&
                    !exportDropdown.contains(ev.target) && ev.target !== exportMenuBtn) {
                    closeExportMenu();
                }
            });
            document.addEventListener('keydown', (ev) => {
                if (ev.key === 'Escape') closeExportMenu();
            });
        }
        document.getElementById('btn-export-preview').addEventListener('click', () => openExportModal(true));
        document.getElementById('export-preview-toggle').addEventListener('click', () => showPreview(previewPane.classList.contains('hidden')));
        document.getElementById('export-modal').addEventListener('input', () => { if (!previewPane.classList.contains('hidden')) renderExportPreview(); });
        document.getElementById('export-modal-close').addEventListener('click', closeExportModal);
        document.getElementById('export-modal-cancel').addEventListener('click', closeExportModal);
        document.getElementById('export-modal-dxf').addEventListener('click', () => { closeExportModal(); Export.exportDXF(this); });
        document.getElementById('export-modal-gcode').addEventListener('click', () => { closeExportModal(); Export.exportGCode(this); });
        exportOverlay.addEventListener('mousedown', (ev) => { if (ev.target === exportOverlay) closeExportModal(); });
        document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !exportOverlay.classList.contains('hidden')) closeExportModal(); });
        document.getElementById('btn-drc').addEventListener('click', () => this.runDRC());
        const btnAutoroute = document.getElementById('btn-autoroute');
        // Autoroute opens the options modal; Route runs with the chosen options.
        const autorouteOverlay = document.getElementById('autoroute-modal-overlay');
        if (btnAutoroute && autorouteOverlay) {
            const closeAutorouteModal = () => {
                if (autorouteOverlay.contains(document.activeElement)) document.activeElement.blur();
                autorouteOverlay.classList.add('hidden');
            };
            btnAutoroute.addEventListener('click', () => {
                if (this._autorouteRunning) return;
                this.syncAutorouteSettings();
                autorouteOverlay.classList.remove('hidden');
                document.getElementById('autoroute-modal').focus();
            });
            document.getElementById('autoroute-modal-close').addEventListener('click', closeAutorouteModal);
            document.getElementById('autoroute-modal-cancel').addEventListener('click', closeAutorouteModal);
            document.getElementById('autoroute-modal-route').addEventListener('click', () => {
                const opts = this.readAutorouteInputs();
                closeAutorouteModal();
                this.runAutoroute(opts);
            });
            const btnCancel = document.getElementById('btn-autoroute-cancel');
            if (btnCancel) btnCancel.addEventListener('click', () => { this._autorouteCancel = true; });
            autorouteOverlay.addEventListener('mousedown', (ev) => { if (ev.target === autorouteOverlay) closeAutorouteModal(); });
            document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !autorouteOverlay.classList.contains('hidden')) closeAutorouteModal(); });
        }

        // Examples dropdown
        const examplesDropdown = document.getElementById('examples-dropdown');
        const btnExamples = document.getElementById('btn-examples');
        if (examplesDropdown) {
            const closeExamplesDropdown = () => examplesDropdown.classList.add('hidden');
            const buildExamplesMenu = () => {
                if (examplesDropdown.dataset.built) return;
                examplesDropdown.innerHTML = '<div class="sd-title">Example Projects</div>';
                Examples.list.forEach(ex => {
                    const div = document.createElement('div');
                    div.className = 'sd-item';
                    div.innerHTML = `<span class="sd-check">&#10003;</span><span>${ex.name}</span>`;
                    div.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        closeExamplesDropdown();
                        this.loadExample(ex.id);
                    });
                    examplesDropdown.appendChild(div);
                });
                examplesDropdown.dataset.built = '1';
            };
            const openExamplesMenu = (anchor) => {
                buildExamplesMenu();
                if (!examplesDropdown.classList.contains('hidden')) { closeExamplesDropdown(); return; }
                const rect = anchor.getBoundingClientRect();
                examplesDropdown.style.left = rect.left + 'px';
                examplesDropdown.style.top = (rect.bottom + 4) + 'px';
                examplesDropdown.classList.remove('hidden');
            };
            if (btnExamples) btnExamples.addEventListener('click', (ev) => { ev.stopPropagation(); openExamplesMenu(btnExamples); });
            const fmExamples = document.getElementById('fm-examples');
            const fileMenuBtnEl = document.getElementById('btn-file-menu');
            if (fmExamples && fileMenuBtnEl) fmExamples.addEventListener('click', (ev) => { ev.stopPropagation(); openExamplesMenu(fileMenuBtnEl); });
            document.addEventListener('click', (ev) => {
                if (!examplesDropdown.classList.contains('hidden') &&
                    !examplesDropdown.contains(ev.target) && ev.target !== btnExamples) {
                    closeExamplesDropdown();
                }
            });
        }

        const jumperFollowEl = document.getElementById('status-jumper-follow');
        if (jumperFollowEl) {
            jumperFollowEl.addEventListener('click', () => {
                this.params.jumperFollow = this.params.jumperFollow === 'joints' ? 'pads' : 'joints';
                this.syncStatusModeToggles();
            });
        }
        const routeAngleEl = document.getElementById('status-route-angle');
        if (routeAngleEl) {
            routeAngleEl.addEventListener('click', () => {
                this.params.routeAngle = this.params.routeAngle === 'free' ? 'hv45' : 'free';
                this.syncStatusModeToggles();
            });
        }
        const rulerEl = document.getElementById('status-ruler');
        if (rulerEl) {
            rulerEl.addEventListener('click', () => {
                this.params.showRulers = !this.params.showRulers;
                this.syncStatusModeToggles();
                this.render();
            });
        }
        const snapEl = document.getElementById('status-snap');
        if (snapEl) {
            snapEl.addEventListener('click', () => {
                this.params.schemSnap = !this.params.schemSnap;
                this.syncStatusModeToggles();
                this.render();
            });
        }
        this.syncStatusModeToggles();

        // DRC constraint parameter inputs
        const minTraceEl = document.getElementById('param-min-trace');
        if (minTraceEl) { minTraceEl.value = this.params.minTraceWidth; minTraceEl.addEventListener('change', () => { this.params.minTraceWidth = parseFloat(minTraceEl.value) || 0.38; }); }
        const minDrillEl = document.getElementById('param-min-drill');
        if (minDrillEl) { minDrillEl.value = this.params.minDrill; minDrillEl.addEventListener('change', () => { this.params.minDrill = parseFloat(minDrillEl.value) || 0.1; }); }
        const minClrEl = document.getElementById('param-min-clearance');
        if (minClrEl) { minClrEl.value = this.params.minClearance; minClrEl.addEventListener('change', () => { this.params.minClearance = parseFloat(minClrEl.value) || 0.38; }); }

        // Palette: click item to place, click ▼ to show size dropdown
        const sizeDropdown = document.getElementById('size-dropdown');
        this.interaction.placingSize = {}; // tracks selected size index per type
        let openDropdownFor = null;

        const closeDropdown = () => {
            sizeDropdown.classList.add('hidden');
            openDropdownFor = null;
            document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('size-selected'));
        };

        const showDropdown = (ev, item, compType) => {
            ev.stopPropagation();
            ev.preventDefault();
            if (openDropdownFor === compType) { closeDropdown(); return; }
            closeDropdown();
            openDropdownFor = compType;
            item.classList.add('size-selected');

            const def = ComponentDefs.get(compType);
            if (!def) return;
            const selectedIdx = this.interaction.placingSize[compType] !== undefined ? this.interaction.placingSize[compType] : def.defaultSize;

            sizeDropdown.innerHTML = `<div class="sd-title">${compType} package</div>`;
            if (compType === 'connector') {
                const gen = document.createElement('div');
                gen.className = 'sd-gen';
                gen.innerHTML = `
                    <div class="sd-gen-title">Pin header</div>
                    <label>Style <select id="hdr-style"><option value="male">Male pins</option><option value="female">Female socket</option></select></label>
                    <label>Rows <select id="hdr-rows"><option value="1">1</option><option value="2">2</option></select></label>
                    <label>Cols <select id="hdr-cols"></select></label>
                    <label>Pitch <select id="hdr-pitch"><option value="2.54" selected>2.54 mm</option><option value="5.08">5.08 mm</option><option value="2">2.00 mm</option><option value="1.27">1.27 mm</option></select></label>
                    <button type="button" class="sd-gen-btn" id="hdr-apply">Use this header</button>`;
                sizeDropdown.appendChild(gen);
                const colSel = gen.querySelector('#hdr-cols');
                for (let n = 2; n <= 16; n++) {
                    const opt = document.createElement('option');
                    opt.value = String(n); opt.textContent = String(n);
                    if (n === 8) opt.selected = true;
                    colSel.appendChild(opt);
                }
                gen.querySelector('#hdr-apply').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const rows = parseInt(gen.querySelector('#hdr-rows').value, 10) || 1;
                    const cols = parseInt(gen.querySelector('#hdr-cols').value, 10) || 2;
                    const pitch = parseFloat(gen.querySelector('#hdr-pitch').value) || 2.54;
                    const kind = gen.querySelector('#hdr-style').value === 'female' ? 'female' : 'male';
                    const idx = ComponentDefs.ensureHeaderSize(rows, cols, pitch, kind);
                    this.interaction.placingSize[compType] = idx;
                    const s = def.sizes[idx];
                    const label = item.querySelector('.comp-label');
                    if (label && s) label.textContent = s.name;
                    closeDropdown();
                    this.interaction.placingComponent = compType;
                    if (this.view.mode !== 'schematic') this.setView('board');
                    this.setStatus(this.view.mode === 'schematic' ? 'Click on schematic to place header (' + s.name + ')' : 'Click on board to place header (' + s.name + ')');
                });
            }
            if (compType === 'switch') {
                const gen = document.createElement('div');
                gen.className = 'sd-gen';
                gen.innerHTML = `
                    <div class="sd-gen-title">DIP switch</div>
                    <label>Positions <select id="dipsw-n"></select></label>
                    <button type="button" class="sd-gen-btn" id="dipsw-apply">Use this DIP switch</button>`;
                sizeDropdown.appendChild(gen);
                const nSel = gen.querySelector('#dipsw-n');
                for (let n = 1; n <= 12; n++) {
                    const opt = document.createElement('option');
                    opt.value = String(n); opt.textContent = String(n);
                    if (n === 4) opt.selected = true;
                    nSel.appendChild(opt);
                }
                gen.querySelector('#dipsw-apply').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const n = parseInt(gen.querySelector('#dipsw-n').value, 10) || 4;
                    const idx = ComponentDefs.ensureDipSwitch(n);
                    this.interaction.placingSize[compType] = idx;
                    const s = def.sizes[idx];
                    const label = item.querySelector('.comp-label');
                    if (label && s) label.textContent = s.name;
                    closeDropdown();
                    this.interaction.placingComponent = compType;
                    if (this.view.mode !== 'schematic') this.setView('board');
                    this.setStatus(this.view.mode === 'schematic' ? 'Click on schematic to place ' + s.name : 'Click on board to place ' + s.name);
                });
            }
            // Jumper palette rows carry data-jkind so 0Ω and wire sizes never mix.
            const jkindFilter = item.dataset.jkind;
            def.sizes.forEach((s, i) => {
                if (jkindFilter && s.jkind !== jkindFilter) return;
                const div = document.createElement('div');
                div.className = 'sd-item' + (i === selectedIdx ? ' active' : '');
                div.innerHTML = `<span class="sd-check">&#10003;</span><span>${s.name}</span>`;
                div.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.interaction.placingSize[compType] = i;
                    // Update label to show selected size
                    const label = item.querySelector('.comp-label');
                    if (label) label.textContent = s.name;
                    closeDropdown();
                    // Immediately activate placement so user can click on board without re-selecting.
                    this.interaction.placingComponent = compType;
                    const isWireJumper = compType === 'jumper' && s.jkind === 'wire';
                    if (this.view.mode !== 'schematic' || isWireJumper) this.setView('board');
                    this.setStatus(this.view.mode === 'schematic' ? `Click on schematic to place ${compType} (${s.name})` : `Click on board to place ${compType} (${s.name})`);
                });
                sizeDropdown.appendChild(div);
            });

            // Position dropdown next to the item (fixed/viewport coords)
            const rect = item.getBoundingClientRect();
            let left = rect.right + 4;
            let top = rect.top;
            // If would overflow right edge, position to the left instead
            if (left + 140 > window.innerWidth) {
                left = rect.left - 140;
            }
            // If would overflow bottom, adjust up
            if (top + 340 > window.innerHeight) {
                top = Math.max(8, window.innerHeight - 350);
            }
            sizeDropdown.style.left = left + 'px';
            sizeDropdown.style.top = top + 'px';
            sizeDropdown.classList.remove('hidden');
        };

        // Delegate palette clicks to #component-palette so dynamically-injected
        // items (e.g. imported KiCad parts) work without re-binding after import/restore.
        const paletteEl = document.getElementById('component-palette');
        if (paletteEl) {
            paletteEl.addEventListener('mousedown', (e) => {
                const item = e.target.closest('.comp-item');
                if (!item || !item.dataset.comp) return;
                const compType = item.dataset.comp;
                const def = ComponentDefs.get(compType);
                if (!def) return;
                // Click on ▼ button → show size dropdown (showDropdown stops propagation).
                const btn = e.target.closest('.comp-size-btn');
                if (btn && item.contains(btn)) { showDropdown(e, item, compType); return; }
                // Click anywhere else on item → place component
                e.preventDefault();
                closeDropdown();
                if (compType === 'jumper') {
                    // Jumper rows are split by data-jkind; pick this row's kind size.
                    const jkind = item.dataset.jkind || 'smd';
                    let jIdx = this.interaction.placingSize[compType];
                    if (jIdx === undefined || !def.sizes[jIdx] || def.sizes[jIdx].jkind !== jkind) {
                        jIdx = def.sizes.findIndex(s => s.jkind === jkind);
                        if (jIdx < 0) jIdx = def.defaultSize;
                    }
                    this.interaction.placingSize[compType] = jIdx;
                }
                this.interaction.placingComponent = compType;
                this.interaction.placingJumperKind = (compType === 'jumper') ? (item.dataset.jkind || 'smd') : null;
                // Highlight the armed palette item so user can see which component is selected.
                document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('placing-active'));
                item.classList.add('placing-active');
                this.interaction._placingOnCanvas = false;
                // Wire jumpers need two board clicks, so they always go to the board view.
                const wireJumper = this.interaction.placingJumperKind === 'wire';
                if (this.view.mode !== 'schematic' || wireJumper) this.setView('board');
                const sizeIdx = this.interaction.placingSize[compType] !== undefined ? this.interaction.placingSize[compType] : def.defaultSize;
                const size = ComponentDefs.getSize(def, sizeIdx);
                const sizeName = (size && size.name) || compType;
                if (wireJumper) {
                    this.interaction.jumperFirst = null;
                    this.setStatus('Wire jumper: click the first solder hole (snaps to pads & trace ends)');
                } else if (this.view.mode === 'schematic') {
                    this.setStatus(`Click on schematic to place ${compType} (${sizeName}) — Esc to cancel`);
                } else {
                    this.setStatus(`Click on board to place ${compType} (${sizeName})`);
                }
            });
        }

        // Close dropdown on outside click
        document.addEventListener('mousedown', (e) => {
            if (!sizeDropdown.contains(e.target) && !e.target.closest('.comp-size-btn')) closeDropdown();
        });

        document.querySelectorAll('#layer-list input').forEach(cb => {
            cb.addEventListener('change', () => { this.view.visibleLayers[cb.dataset.layer] = cb.checked; this.render(); });
        });

        document.querySelectorAll('.layer-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.view.activeLayer = btn.dataset.actlayer;
                document.querySelectorAll('.layer-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (btn.dataset.actlayer.startsWith('silk')) {
                    this.setTool('text');
                } else if (this.view.tool === 'text') {
                    this.setTool('trace');
                }
                this.setStatus('Active layer: ' + btn.dataset.actlayer);
            });
        });

        const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('change', fn); };
        bind('param-width', () => { this.board.width = parseFloat(document.getElementById('param-width').value); this.render(); });
        bind('param-height', () => { this.board.height = parseFloat(document.getElementById('param-height').value); this.render(); });
        this.bindPlanPanel();
        bind('param-thickness', () => { this.board.thickness = parseFloat(document.getElementById('param-thickness').value); });
        bind('param-copper', () => { this.board.copperWeight = parseFloat(document.getElementById('param-copper').value); });
        bind('param-material', () => { this.board.material = document.getElementById('param-material').value; });
        bind('export-board-size', () => { this.export.includeBoardOutline = document.getElementById('export-board-size').checked; });
        bind('export-copper', () => { this.export.includeCopperOutlines = document.getElementById('export-copper').checked; });
        bind('export-kerf', () => { this.export.kerfWidth = parseFloat(document.getElementById('export-kerf').value); });
        bind('export-units', () => { this.export.units = document.getElementById('export-units').value; });
        bind('export-dxf-mode', () => { this.export.dxfMode = document.getElementById('export-dxf-mode').value; });
        const dxfModeEl = document.getElementById('export-dxf-mode');
        if (dxfModeEl) dxfModeEl.value = this.export.dxfMode || 'standard';
        bind('export-holes', () => { this.export.includeHoles = document.getElementById('export-holes').checked; });
        bind('export-traces', () => { this.export.includeTraces = document.getElementById('export-traces').checked; });
        bind('export-comps', () => { this.export.includeComps = document.getElementById('export-comps').checked; });
        bind('export-mirror', () => { this.export.mirror = document.getElementById('export-mirror').checked; });
        ['COPPER_TOP', 'COPPER_BOTTOM', 'TRACE_OUTLINE_TOP', 'TRACE_OUTLINE_BOTTOM', 'TRACE_TOP', 'TRACE_BOTTOM', 'PAD_TOP', 'PAD_BOTTOM'].forEach(name => {
            bind('export-layer-' + name, () => { this.export.layers = this.export.layers || {}; this.export.layers[name] = document.getElementById('export-layer-' + name).checked; });
        });
        bind('export-mill-tool', () => { this.export.millToolDia = parseFloat(document.getElementById('export-mill-tool').value); });
        bind('export-mill-drill-tool', () => { this.export.millDrillToolDia = parseFloat(document.getElementById('export-mill-drill-tool').value); });
        bind('export-mill-outline-tool', () => { this.export.millOutlineToolDia = parseFloat(document.getElementById('export-mill-outline-tool').value); });
        bind('export-mill-iso', () => { this.export.millIsoDepth = parseFloat(document.getElementById('export-mill-iso').value); });
        bind('export-mill-safez', () => { this.export.millSafeZ = parseFloat(document.getElementById('export-mill-safez').value); });
        bind('export-mill-feed', () => { this.export.millFeed = parseFloat(document.getElementById('export-mill-feed').value); });
        bind('export-mill-drill-feed', () => { this.export.millDrillFeed = parseFloat(document.getElementById('export-mill-drill-feed').value); });
        bind('export-mill-outline-feed', () => { this.export.millOutlineFeed = parseFloat(document.getElementById('export-mill-outline-feed').value); });
        bind('export-mill-plunge', () => { this.export.millPlunge = parseFloat(document.getElementById('export-mill-plunge').value); });
        bind('export-mill-outline-passes', () => { this.export.millOutlinePasses = parseInt(document.getElementById('export-mill-outline-passes').value, 10); });
        bind('export-mill-drill-overcut', () => { this.export.millDrillOvercut = parseFloat(document.getElementById('export-mill-drill-overcut').value); });
        bind('export-mill-outline-overcut', () => { this.export.millOutlineOvercut = parseFloat(document.getElementById('export-mill-outline-overcut').value); });
        bind('export-mill-spindle', () => { this.export.millSpindle = parseFloat(document.getElementById('export-mill-spindle').value); });
        bind('export-mill-spindle-dwell', () => { this.export.millSpindleDwell = parseFloat(document.getElementById('export-mill-spindle-dwell').value); });

        document.getElementById('btn-add-net').addEventListener('click', () => {
            const name = prompt('Net name:');
            if (name) {
                const colors = ['#ff4444','#44ff44','#4488ff','#ff44ff','#ffff44','#44ffff','#ff8844'];
                this.nets.push({ name, color: colors[this.nets.length % colors.length] });
                this.updateNetsList();
            }
        });

        // Supply-voltage inputs are regenerated by updateNetsList(); a single
        // delegated listener on the (stable) container keeps them working across
        // re-renders and avoids inline handlers built from untrusted net names.
        const _netsList = document.getElementById('nets-list');
        if (_netsList) {
            _netsList.addEventListener('change', (e) => {
                const inp = (e.target && e.target.closest) ? e.target.closest('.net-voltage') : null;
                if (!inp) return;
                this.setNetVoltage(inp.getAttribute('data-net'), inp.value);
            });
        }

        document.querySelectorAll('#context-menu .ctx-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                const action = item.dataset.action;
                // Snapshot before hideContextMenu — a later hide impl clears contextTarget.
                const target = this.interaction.contextTarget;
                const selSeg = this.interaction.selectedSegment;
                this.hideContextMenu();
                if (action === 'group') { this.groupComponents(); return; }
                if (action === 'ungroup') { this.ungroupComponents(); return; }
                if (action === 'cut') {
                    const traceId = (target && target.type === 'trace' && target.obj) ? target.obj.id
                        : (selSeg && selSeg.traceId);
                    const segIndex = (target && target.type === 'trace' && target.segIndex !== undefined)
                        ? target.segIndex
                        : (selSeg && selSeg.segIndex);
                    this.cutSelectedSegment(traceId, segIndex);
                    return;
                }
                if (action === 'calcResistor') {
                    let comp = null;
                    if (target && target.type === 'component') comp = target.obj;
                    else if (this.interaction.selectedObject && this.interaction.selectedObject.type === 'component') comp = this.interaction.selectedObject.obj;
                    if (comp && comp.type === 'led') this.calcLedResistor(comp);
                    return;
                }
                if (action === 'delete') {
                    if (target && target.type === 'trace' && target.obj && target.obj.schemWire && this.view.mode === 'schematic') {
                        this.deleteObject(target);   // right-click on a schematic net run
                    }
                    else if (this.interaction.selectedVertices && this.interaction.selectedVertices.length) this.deleteSelectedVertices();
                    else if (this.view.mode === 'board' && selSeg) {
                        this.deleteTraceSegment(selSeg.traceId, selSeg.segIndex);
                    }
                    else if (this.interaction.schemSelectedJoint) {
                        const j = this.interaction.schemSelectedJoint;
                        this.deleteSchemJoint(j.traceId, j.waypointIndex);
                    }
                    else if (this.interaction.selectedObjects && this.interaction.selectedObjects.length) this.deleteSelected();
                    else if (this.interaction.selectedObject) {
                        const sel = this.interaction.selectedObject;
                        if (sel.type === 'component') this.deleteSelected();
                        else this.deleteObject(sel);
                    } else if (target) {
                        this.deleteObject(target);
                    }
                    return;
                }
                if (!target) return;
                if (action === 'clone') {
                    this.cloneObject(target);
                } else if (action === 'move') {
                    this.setTool('select');
                    const obj = target.obj;
                    this.interaction.selectedObject = target;
                    if (target.type === 'component') {
                        this.interaction.draggingComp = obj;
                        this.interaction.dragOffsetX = 0;
                        this.interaction.dragOffsetY = 0;
                        this.showProperties(obj);
                    }
                } else if (action === 'splitTrace') {
                    this.splitTraceAtVertex(target.traceId, target.pointIndex);
                } else if (action === 'deleteNode') {
                    this.deleteTraceVertex(target.traceId, target.pointIndex);
                }
            });
        });

        // Context menu keyboard navigation (roving tabindex; focus enters on open)
        const ctxMenu = document.getElementById('context-menu');
        if (ctxMenu) {
            const visibleCtxItems = () => Array.from(ctxMenu.querySelectorAll('.ctx-item')).filter(i => i.style.display !== 'none');
            const focusCtxItem = idx => {
                const items = visibleCtxItems();
                if (!items.length) return;
                const n = items.length;
                const i = ((idx % n) + n) % n;
                items.forEach((it, k) => it.setAttribute('tabindex', k === i ? '0' : '-1'));
                items[i].focus();
            };
            ctxMenu.addEventListener('keydown', (e) => {
                const items = visibleCtxItems();
                if (!items.length) return;
                const idx = items.indexOf(document.activeElement);
                let handled = false;
                switch (e.key) {
                    case 'ArrowDown': e.preventDefault(); focusCtxItem(idx + 1); handled = true; break;
                    case 'ArrowUp': e.preventDefault(); focusCtxItem(idx - 1); handled = true; break;
                    case 'Home': e.preventDefault(); focusCtxItem(0); handled = true; break;
                    case 'End': e.preventDefault(); focusCtxItem(items.length - 1); handled = true; break;
                    case 'Enter':
                    case ' ':
                        if (document.activeElement.classList.contains('ctx-item')) { e.preventDefault(); document.activeElement.click(); }
                        handled = true;
                        break;
                    case 'Escape': e.preventDefault(); this.hideContextMenu(); handled = true; break;
                }
                if (handled) e.stopPropagation(); // don't let global shortcuts (Space=rotate, Esc=cancel) double-fire
            });
        }

        document.addEventListener('mousedown', (e) => {
            const menu = document.getElementById('context-menu');
            if (menu.style.display === 'block' && !menu.contains(e.target)) {
                this.hideContextMenu();
                this.render();
            }
        });

        this.bindCanvasEvents();
        document.addEventListener('keydown', (e) => this.handleKeydown(e));
    },

    // Escape a value for safe interpolation into HTML (defends against net names
    // containing quotes or markup reaching innerHTML / attribute values).
    _escAttr(s) {
        return String(s).replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        })[c]);
    },

    updateNetsList() {
        const list = document.getElementById('nets-list');
        if (!list) return;
        const esc = (s) => this._escAttr(s);
        list.innerHTML = this.nets.map(n => {
            const v = (n.voltage !== undefined && n.voltage !== null && n.voltage !== '') ? n.voltage : '';
            // Net name/color are escaped and the value is read back from the
            // data-net attribute by a delegated change listener — no inline
            // handler is ever built from an untrusted net name.
            return `<div class="net-item"><span class="net-color" style="background:${esc(n.color)}"></span><span>${esc(n.name)}</span><input type="number" step="0.1" class="net-voltage" data-net="${esc(n.name)}" value="${esc(v)}" placeholder="V" title="Supply voltage (V)"></div>`;
        }).join('');
    },

    // Set (or clear, when empty) a net's supply voltage in volts. Feeds the LED
    // resistor calculator. Nets are not part of undo snapshots, so no saveState.
    setNetVoltage(name, value) {
        const n = this.nets.find(x => x.name === name);
        if (!n) return;
        const v = parseFloat(value);
        if (value === '' || !isFinite(v)) {
            delete n.voltage;
        } else if (v < 0) {
            // A supply can't be negative; clear it and reset the field.
            this.setStatus('Supply voltage must be 0 V or higher — value cleared.');
            delete n.voltage;
            this.updateNetsList();
        } else {
            n.voltage = v;
        }
    },

    handleKeydown(e) {
        if (e.ctrlKey && e.key === 'z') { e.preventDefault(); this.undo(); return; }
        if (e.ctrlKey && e.key === 'y') { e.preventDefault(); this.redo(); return; }
        if (e.ctrlKey && e.key === 's') { e.preventDefault(); this.saveProject(); return; }
        if (e.ctrlKey && e.key === 'o') { e.preventDefault(); this.loadProject(); return; }

        // Ignore single-key shortcuts while the user is typing in a form field.
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

        const selectedComp = (this.interaction.selectedObject && this.interaction.selectedObject.type === 'component') ? this.interaction.selectedObject.obj : null;
        const rotateSel = () => {
            if (!selectedComp) return false;
            if (this.view.mode === 'schematic') {
                this.rotateSchemComp(selectedComp);
            } else if (this.isWireJumper(selectedComp)) {
                return false;
            } else {
                const newRot = ((selectedComp.rotation || 0) + 90) % 360;
                this.rotateCompWithTraces(selectedComp, newRot);
                this.saveState();
                this.render();
                this.showProperties(selectedComp);
            }
            return true;
        };

        // Arrow keys nudge the selected component by one grid step (Shift = 5x).
        const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (ARROWS[e.key] && this.view.mode === 'board' && this.view.tool === 'select' && selectedComp) {
            e.preventDefault();
            const step = this.params.gridSize * (e.shiftKey ? 5 : 1);
            const [ax, ay] = ARROWS[e.key];
            const comps = (this.interaction.selectedObjects && this.interaction.selectedObjects.length)
                ? this.interaction.selectedObjects
                : [selectedComp];
            // One undo snapshot per burst of key presses instead of one per press.
            const now = Date.now();
            if (!this._nudgeLast || now - this._nudgeLast > 500) this.saveState();
            this._nudgeLast = now;
            for (const c of comps) {
                const ox = c.x, oy = c.y;
                c.x += ax * step;
                c.y += ay * step;
                this.moveCompWithTraces(c, ox, oy);
            }
            this.render();
            this.showProperties(selectedComp);
        }

        // Ctrl+G group / Ctrl+Shift+G ungroup
        if (e.ctrlKey && (e.key === 'g' || e.key === 'G')) {
            e.preventDefault();
            if (e.shiftKey) this.ungroupComponents();
            else this.groupComponents();
            return;
        }
        // Delete multi-selected joints first (single undo step for the whole batch).
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.interaction.selectedVertices && this.interaction.selectedVertices.length) {
            e.preventDefault();
            this.deleteSelectedVertices();
            return;
        }
        // Board: selected trace segment → remove that run (not the whole trace).
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.view.mode === 'board' && this.interaction.selectedSegment) {
            e.preventDefault();
            const s = this.interaction.selectedSegment;
            this.deleteTraceSegment(s.traceId, s.segIndex);
            return;
        }
        // Schematic joint selection wins over wire deletion.
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.interaction.schemSelectedJoint) {
            e.preventDefault();
            const j = this.interaction.schemSelectedJoint;
            this.deleteSchemJoint(j.traceId, j.waypointIndex);
            return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.interaction.selectedObject) {
            e.preventDefault();
            const sel = this.interaction.selectedObject;
            if (sel.type === 'zone') { this.deleteZone(sel.obj); return; }
            if (sel.type === 'component') this.deleteSelected();   // also removes connected traces/wires
            else this.deleteObject(sel);
            return;
        }

        // R -> rotate the selected component.
        if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey) {
            if (rotateSel()) { e.preventDefault(); return; }
        }

        if (e.key === 'Enter' || e.key === ' ') {
            // Commit an in-progress schematic wire at its current snapped point.
            if (e.key === 'Enter' && this.view.mode === 'schematic' && this.interaction.schemWireStart) { e.preventDefault(); this.commitSchemWireDraw(); return; }
            if (this.view.tool === 'trace' && this.interaction.tracePoints.length >= 2) { e.preventDefault(); this.finishTrace(); return; }
            if (this.view.tool === 'outline' && this.interaction.outlinePoints.length >= 3) { e.preventDefault(); this.boardOutline = [...this.interaction.outlinePoints]; this.saveState(); this.interaction.outlinePoints = []; this.render(); return; }
            // Space rotates selected component or placement ghost
            if (e.key === ' ') {
                e.preventDefault();
                if (this.view.mode === 'board' && this.interaction.placingComponent) {
                    this.interaction.placingRotation = (this.interaction.placingRotation + 90) % 360;
                    this.render(); return;
                }
                if (rotateSel()) return;
            }
        }
        if (e.key === 'Escape') {
            this.interaction.tracePoints = [];
            this.interaction.outlinePoints = [];
            this.interaction.placingComponent = null;
            this.interaction.jumperFirst = null;
            this.interaction.placingJumperKind = null;
            this.interaction.draggingComp = null;
            if (this.interaction.schemWireStart) this.cancelSchemWireDraw();
            document.querySelectorAll('.comp-item').forEach(i => i.classList.remove('placing-active'));
            this.setTool('select');
            this.render(); return;
        }
        if (e.key === '3' && !e.ctrlKey) { if (typeof Model3D !== 'undefined') Model3D.openBoard(); return; }
        const keyMap = { 'v': 'select', 't': 'trace', 'o': 'outline', 'z': 'zone', 's': 'text', 'd': 'delete' };
        if (keyMap[e.key] && !e.ctrlKey) this.setTool(keyMap[e.key]);
    },

    syncStatusModeToggles() {
        const jf = document.getElementById('status-jumper-follow');
        if (jf) jf.textContent = this.params.jumperFollow === 'joints' ? 'Follow joints' : 'Pads stay';
        const ra = document.getElementById('status-route-angle');
        if (ra) ra.textContent = this.params.routeAngle === 'free' ? 'Free' : '45°';
        const rl = document.getElementById('status-ruler');
        if (rl) rl.classList.toggle('off', !this.params.showRulers);
        const sn = document.getElementById('status-snap');
        if (sn) { sn.textContent = this.params.schemSnap === false ? 'Snap: Off' : 'Snap: On'; sn.classList.toggle('off', this.params.schemSnap === false); }
    },

    setTool(tool) {
        this.view.tool = tool;
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
        if (btn) btn.classList.add('active');
        document.getElementById('status-tool').textContent = `Tool: ${tool.charAt(0).toUpperCase() + tool.slice(1)}`;
        this.boardCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
        this.interaction.tracePoints = [];
        this.interaction.outlinePoints = [];
        this.render();
    },

    setView(mode) {
        this.view.mode = mode;
        document.getElementById('board-canvas').style.display = mode === 'board' ? 'block' : 'none';
        document.getElementById('schematic-canvas').style.display = mode === 'schematic' ? 'block' : 'none';
        document.getElementById('view-board').classList.toggle('active', mode === 'board');
        document.getElementById('view-schematic').classList.toggle('active', mode === 'schematic');
        this.updateStatusZoom();   // status zoom label now reflects the schematic zoom
        this.render();
    },

    fitToView() {
        const canvas = this.boardCanvas;
        const zoomX = (canvas.width - 80) / this.board.width;
        const zoomY = (canvas.height - 80) / this.board.height;
        this.view.zoom = Math.min(zoomX, zoomY);
        this.view.panX = 0; this.view.panY = 0; // board is centered on the world origin → centered on screen
        this.updateStatusZoom();
        this.render();
    },

    // Frame the schematic sheet on the symbols so a preview switch is not an empty canvas.
    fitSchematic() {
        const canvas = this.schematicCanvas;
        const comps = this.components || [];
        if (!canvas || !comps.length) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of comps) {
            const x = typeof c.schemX === 'number' ? c.schemX : 0;
            const y = typeof c.schemY === 'number' ? c.schemY : 0;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const pad = 120;
        const w = Math.max(80, maxX - minX + pad * 2);
        const h = Math.max(80, maxY - minY + pad * 2);
        const zoom = Math.min((canvas.width - 40) / w, (canvas.height - 40) / h, 1.6);
        this.view.schemZoom = Math.max(0.12, zoom);
        this.view.schemPanX = (minX + maxX) / 2;
        this.view.schemPanY = (minY + maxY) / 2;
        this.updateStatusZoom();
        this.render();
    },

    // -----------------------------------------------------------------------
    // Design Plan panel (CAP-1/CAP-2 UI) — thin wrapper over the plan data
    // the MCP tools use (requirements / zones / assignments / flowDirection).
    // Placement guides the layout; a single-layer crossing is fixed with a JP
    // wire (solder holes + a wire over the trace), not a via.
    // -----------------------------------------------------------------------
    bindPlanPanel() {
        const flow = document.getElementById('plan-flow');
        if (flow) {
            flow.value = this.flowDirection || 'lr';
            flow.addEventListener('change', () => { this.flowDirection = flow.value; this.saveState(); this.render(); });
        }
        const req = document.getElementById('plan-requirements');
        if (req) {
            req.value = (this.requirements && this.requirements.notes) || '';
            req.addEventListener('input', () => { this.requirements = req.value.trim() ? { notes: req.value } : null; });
            req.addEventListener('change', () => { this.saveState(); });
        }
        const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
        on('btn-plan-add-zone', 'click', () => this.planAddZone());
        on('btn-plan-assign', 'click', () => this.planAssignSelected());
        on('btn-plan-place', 'click', () => this.planPlace());
        on('btn-plan-check', 'click', () => this.planCheck());
        this.renderPlanPanel();
    },

    renderPlanPanel() {
        const box = document.getElementById('plan-zones');
        if (!box) return;
        const zones = this.zones || [];
        box.innerHTML = zones.map((z, i) => `
            <div class="plan-zone-row" data-zone="${i}">
                <input class="zone-name" data-k="name" value="${(z.name || '').replace(/"/g, '&quot;')}" placeholder="Zone ${z.id}">
                <input data-k="x" type="number" step="1" value="${+z.x.toFixed(1)}" title="center X">
                <input data-k="y" type="number" step="1" value="${+z.y.toFixed(1)}" title="center Y">
                <input data-k="w" type="number" step="1" value="${+z.w.toFixed(1)}" title="width">
                <input data-k="h" type="number" step="1" value="${+z.h.toFixed(1)}" title="height">
                <button class="plan-zone-del" data-del="${i}" title="Delete zone">×</button>
            </div>`).join('');
        box.querySelectorAll('.plan-zone-row').forEach(row => {
            const i = +row.dataset.zone;
            row.querySelectorAll('input[data-k]').forEach(inp => {
                inp.addEventListener('change', () => {
                    const z = this.zones[i];
                    const k = inp.dataset.k;
                    z[k] = (k === 'name') ? inp.value : parseFloat(inp.value) || 0;
                    this.saveState(); this.render();
                });
            });
            const del = row.querySelector('[data-del]');
            if (del) del.addEventListener('click', () => {
                const zid = this.zones[i].id;
                this.zones.splice(i, 1);
                Object.keys(this.assignments).forEach(cid => { if (this.assignments[cid] === zid) delete this.assignments[cid]; });
                this.saveState(); this.render(); this.renderPlanPanel();
            });
        });
    },

    planAddZone() {
        this.zones = this.zones || [];
        const id = this.zones.reduce((m, z) => Math.max(m, z.id), 0) + 1;
        this.zones.push({ id, name: `Zone ${id}`, x: 0, y: 0, w: 20, h: 20 });
        this.saveState(); this.render(); this.renderPlanPanel();
    },

    // Remove a placement zone (canvas Delete key or panel ×). Clears its assignments.
    deleteZone(zone) {
        const zid = zone && zone.id;
        this.zones = (this.zones || []).filter(z => z.id !== zid);
        Object.keys(this.assignments || {}).forEach(cid => { if (this.assignments[cid] === zid) delete this.assignments[cid]; });
        this.interaction.selectedObject = null;
        this.saveState(); this.render(); this.renderPlanPanel();
        this.setStatus(`Zone ${zid} removed.`);
    },

    planAssignSelected() {
        const zones = this.zones || [];
        if (!zones.length) { this.setStatus('Add a zone first.'); return; }
        const zid = zones[zones.length - 1].id;
        const multi = (this.interaction.selectedObjects || []).map(o => o.id).filter(id => id != null);
        const single = this.interaction.selectedObject && this.interaction.selectedObject.type === 'component'
            ? [this.interaction.selectedObject.obj.id] : [];
        const ids = multi.length ? multi : single;
        if (!ids.length) { this.setStatus('Select components to assign.'); return; }
        this.assignments = this.assignments || {};
        ids.forEach(cid => { this.assignments[cid] = zid; });
        this.saveState(); this.render();
        this.setStatus(`Assigned ${ids.length} component(s) to ${zones[zones.length - 1].name}.`);
    },

    planPlace() {
        if (typeof Plan === 'undefined') return;
        const moves = Plan.placeByPlan(this);
        if (!moves.length) { this.setStatus('Assign components to zones before placing.'); return; }
        Plan.applyPlacement(this, moves);
        this.saveState(); this.render();
        this.planCheck();
    },

    planCheck() {
        if (typeof Plan === 'undefined') return;
        const out = document.getElementById('plan-results');
        const v = Plan.planCheck(this).concat(Plan.qualityCheck(this));
        if (!out) return;
        if (!v.length) { out.innerHTML = '<p class="ok">Plan OK — placement valid, no crossings.</p>'; return; }
        out.innerHTML = v.map(x => `<p class="bad">${x.msg}${x.type === 'crossing' ? ' → add a JP wire' : ''}</p>`).join('');
    },

    // Schematic canvas events (planned - stub for now)
    bindSchemCanvasEvents() {
        const canvas = this.schematicCanvas;
        canvas.addEventListener('mousedown', (e) => {
            const rect = canvas.getBoundingClientRect();
            const sx = e.clientX - rect.left;
            const sy = e.clientY - rect.top;
            const world = this.schemScreenToWorld(sx, sy);
            if (this.view.tool === 'select') {
                // Future: hit-test schematic components/pins
            }
        });
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            this.view.schemZoom = Math.min(Math.max(this.view.schemZoom * factor, 0.1), 20);
            this.render();
        }, { passive: false });
    },

    // ---- Context Menu ----
    showContextMenu(x, y) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        menu.style.display = 'block';
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        // Determine which items to show
        const multi = this.interaction.selectedObjects && this.interaction.selectedObjects.length > 0;
        const single = this.interaction.selectedObject && this.interaction.selectedObject.type === 'component';
        const target = this.interaction.contextTarget;
        const isVertexTarget = !!(target && target.type === 'traceVertex');
        const isSegmentTarget = !!(this.view.mode === 'board' && target && target.type === 'trace' && target.segIndex !== undefined);
        const isSchemWireTarget = !!(this.view.mode === 'schematic' && target && target.type === 'trace' && target.obj && target.obj.schemWire);
        const multiVertex = this.interaction.selectedVertices && this.interaction.selectedVertices.length > 0;
        const hasSelection = multi || single || (target && target.type === 'component') || isVertexTarget || isSegmentTarget || isSchemWireTarget || multiVertex || this.interaction.schemSelectedJoint;

        // Group button: show if >= 2 selected, or single component that's not already grouped with others
        const groupBtn = menu.querySelector('[data-action="group"]');
        const ungroupBtn = menu.querySelector('[data-action="ungroup"]');
        const deleteBtn = menu.querySelector('[data-action="delete"]');
        const cutBtn = menu.querySelector('[data-action="cut"]');
        const segmentBoard = isSegmentTarget && this.view.mode === 'board';
        if (cutBtn) cutBtn.style.display = segmentBoard ? 'flex' : 'none';
        // LED resistor calculator: only offered for a single LED component.
        const calcBtn = menu.querySelector('[data-action="calcResistor"]');
        if (calcBtn) {
            let ledComp = null;
            if (single) ledComp = this.interaction.selectedObject.obj;
            else if (target && target.type === 'component') ledComp = target.obj;
            calcBtn.style.display = (ledComp && ledComp.type === 'led' && this.view.mode === 'schematic') ? 'flex' : 'none';
        }

        if (multi) {
            groupBtn.style.display = 'flex';
            // Check if all selected share a groupId
            const ids = this.interaction.selectedObjects.map(c => c.groupId).filter(Boolean);
            ungroupBtn.style.display = (ids.length > 0 && ids.every(id => id === ids[0])) ? 'flex' : 'none';
        } else if (single || (target && target.type === 'component')) {
            const comp = single ? this.interaction.selectedObject.obj : target.obj;
            groupBtn.style.display = 'none';
            ungroupBtn.style.display = comp.groupId ? 'flex' : 'none';
        } else {
            groupBtn.style.display = 'none';
            ungroupBtn.style.display = 'none';
        }
        deleteBtn.style.display = hasSelection ? 'flex' : 'none';

        // Update delete label (joints get a clearer verb than components)
        const delLabel = deleteBtn.querySelector('.ctx-label');
        if (multiVertex) delLabel.textContent = `Delete ${this.interaction.selectedVertices.length} Joints`;
        else if (isVertexTarget) delLabel.textContent = 'Delete Joint';
        else if (isSegmentTarget) delLabel.textContent = 'Join Segment';
        else if (isSchemWireTarget) delLabel.textContent = 'Delete Wire';
        else if (this.interaction.schemSelectedJoint) delLabel.textContent = 'Delete Joint';
        else if (multi) delLabel.textContent = `Delete ${this.interaction.selectedObjects.length} Components`;
        else delLabel.textContent = 'Delete';

        // Keyboard access: roving tabindex, focus first visible item
        const items = Array.from(menu.querySelectorAll('.ctx-item')).filter(i => i.style.display !== 'none');
        items.forEach((it, k) => it.setAttribute('tabindex', k === 0 ? '0' : '-1'));
        if (items[0]) items[0].focus();
    },
    hideContextMenu() {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        if (menu.contains(document.activeElement)) document.activeElement.blur();
        menu.style.display = 'none';
    },

    // ---- Group / Ungroup / Delete Operations ----
    groupComponents() {
        const sel = this.interaction.selectedObjects;
        if (!sel || sel.length < 2) {
            this.setStatus('Select 2 or more components (drag a box or Ctrl+click), then Group');
            return;
        }
        const groupId = 'grp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        sel.forEach(c => { c.groupId = groupId; });
        this.saveState();
        this.hideContextMenu();
        this.setStatus('Grouped ' + sel.length + ' components');
        this.render();
    },
    ungroupComponents() {
        const sel = this.interaction.selectedObjects || (this.interaction.selectedObject && this.interaction.selectedObject.type === 'component' ? [this.interaction.selectedObject.obj] : []);
        if (!sel || sel.length === 0) return;
        sel.forEach(c => { delete c.groupId; });
        this.saveState();
        this.hideContextMenu();
        this.render();
    },
    deleteSelected() {
        const sel = this.interaction.selectedObjects || (this.interaction.selectedObject && this.interaction.selectedObject.type === 'component' ? [this.interaction.selectedObject.obj] : []);
        if (!sel || sel.length === 0) return;
        const ids = new Set(sel.map(c => c && c.id).filter(id => id !== undefined && id !== null));
        if (!ids.size) return;
        this.components = this.components.filter(c => !ids.has(c.id));
        this.interaction.selectedObject = null;
        this.interaction.selectedObjects = null;
        document.getElementById('properties-content').innerHTML = '<p class="hint">Select an object to see its properties.</p>';
        this.saveState();
        this.hideContextMenu();
        this.render();
    },

    // ---- Autoroute (Epic 1 UI wiring) ----
    // The toolbar button opens the options modal; Route runs one whole-board
    // pass of the pure kernel (js/autorouter.js). Rules come from project
    // params (Min Trace / Min Clearance) unless the modal overrides them.
    // Committed traces land in one undo step.

    // Reflect saved project options (params.autoroute) + last-used session opts.
    syncAutorouteSettings() {
        if (typeof document === 'undefined') return;
        const saved = (this.params && this.params.autoroute) || {};
        const o = Object.assign({}, saved, this.autorouteOpts || {});
        const setVal = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
        setVal('autoroute-layer', o.layer || ((this.view && this.view.activeLayer === 'bottom') ? 'bottom' : 'top'));
        setVal('autoroute-width', o.traceWidth || (Number(this.params.traceWidth) > 0 ? this.params.traceWidth : 0.5));
        setVal('autoroute-clearance', o.clearance || (Number(this.params.minClearance) > 0 ? this.params.minClearance : 0.38));
        setVal('autoroute-grid', o.gridSize || '0.1');
        const skip = document.getElementById('autoroute-skip');
        if (skip) skip.checked = o.skipRouted !== false;
    },

    // Read modal inputs -> route() options; persist on the project.
    readAutorouteInputs() {
        const num = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) : NaN; };
        const opts = {};
        const layerEl = document.getElementById('autoroute-layer');
        if (layerEl) opts.layer = layerEl.value;
        if (isFinite(num('autoroute-width'))) opts.traceWidth = num('autoroute-width');
        if (isFinite(num('autoroute-clearance'))) opts.clearance = num('autoroute-clearance');
        const gridEl = document.getElementById('autoroute-grid');
        if (gridEl && isFinite(parseFloat(gridEl.value))) opts.gridSize = parseFloat(gridEl.value);
        const skipEl = document.getElementById('autoroute-skip');
        if (skipEl) opts.skipRouted = skipEl.checked;
        this.autorouteOpts = opts;
        if (!this.params) this.params = {};
        this.params.autoroute = Object.assign({}, (this.params.autoroute || {}), opts);
        if (this._mergeAutorouteParams) this._mergeAutorouteParams(this.params);
        return opts;
    },

    _setAutorouteRunning(on) {
        const btn = document.getElementById('btn-autoroute');
        const cancel = document.getElementById('btn-autoroute-cancel');
        if (btn) btn.disabled = !!on;
        if (cancel) cancel.classList.toggle('hidden', !on);
    },

    // Whole-board run. Yields between nets so Cancel can fire and the board
    // updates live. One saveState at the end = one undo step.
    async runAutoroute(opts) {
        if (this._autorouteRunning) return null;
        if (typeof Autoroute === 'undefined') { this.setStatus('Autorouter not loaded'); return null; }
        if (!this.components || this.components.length === 0) {
            this.renderAutoroutePanel(null, 0);
            this.setStatus('Nothing to route — place components first');
            return null;
        }
        const o = opts || {};
        const layer = (o.layer === 'bottom' || (this.view && this.view.activeLayer === 'bottom')) ? 'bottom' : 'top';
        const options = { layer: layer };
        if (o.traceWidth > 0) options.traceWidth = o.traceWidth;
        if (o.clearance > 0) options.clearance = o.clearance;
        if (o.gridSize > 0) options.gridSize = o.gridSize;
        if (typeof o.skipRouted === 'boolean') options.skipRouted = o.skipRouted;
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const t0 = now();

        let planned;
        try { planned = Autoroute.planNets(this, options); }
        catch (e) { this.setStatus('Autoroute failed: ' + e.message); return null; }

        let nets = planned.nets || [];
        const agg = {
            success: true,
            routedNets: [],
            failedNets: [],
            diagnostics: (planned.diagnostics || []).slice()
        };
        if (options.skipRouted) {
            const kept = [];
            for (let i = 0; i < nets.length; i++) {
                // Only skip nets whose pads are already fully joined by copper on
                // this layer; partially routed nets still need their remaining legs.
                if (Autoroute.isFullyWired(this, nets[i].name, layer)) {
                    agg.diagnostics.push({ code: 'SKIPPED_ROUTED', net: nets[i].name });
                } else kept.push(nets[i]);
            }
            nets = kept;
        }

        if (nets.length === 0) {
            this.renderAutoroutePanel(agg, 0);
            const unassigned = agg.diagnostics.filter(d => d.code === 'UNASSIGNED_PIN').length;
            this.setStatus(unassigned
                ? `Autoroute: no routable nets — wire the schematic first (${unassigned} unwired pin(s))`
                : 'Autoroute: no routable nets');
            return agg;
        }

        this._autorouteRunning = true;
        this._autorouteCancel = false;
        this._setAutorouteRunning(true);

        try {
            for (let i = 0; i < nets.length; i++) {
                if (this._autorouteCancel) {
                    agg.diagnostics.push({ code: 'CANCELED', done: i, total: nets.length });
                    agg.success = false;
                    break;
                }
                this.setStatus(`Autoroute: ${i + 1}/${nets.length} ${nets[i].name}`);
                let res;
                try {
                    res = Autoroute.route(this, Object.assign({}, options, { onlyNet: nets[i].name, skipRouted: false }));
                } catch (e) {
                    this.setStatus('Autoroute failed: ' + e.message);
                    agg.success = false;
                    break;
                }
                if (res.routedNets) for (let k = 0; k < res.routedNets.length; k++) agg.routedNets.push(res.routedNets[k]);
                if (res.failedNets) for (let k = 0; k < res.failedNets.length; k++) agg.failedNets.push(res.failedNets[k]);
                if (res.diagnostics) {
                    for (let k = 0; k < res.diagnostics.length; k++) {
                        const d = res.diagnostics[k];
                        if (d.code === 'UNASSIGNED_PIN' || d.code === 'SKIPPED_ROUTED') continue;
                        agg.diagnostics.push(d);
                    }
                }
                if (!res.success) agg.success = false;
                this.renderAutoroutePanel(agg, Math.round(now() - t0));
                this.render();
                await new Promise(r => setTimeout(r, 0));
            }
        } finally {
            this._autorouteRunning = false;
            this._setAutorouteRunning(false);
        }

        const ms = Math.round(now() - t0);
        if (agg.failedNets.length > 0 || this._autorouteCancel) agg.success = false;
        if (agg.routedNets.length > 0) this.saveState();
        this.renderAutoroutePanel(agg, ms);
        this.render();
        this.setStatus(this._autorouteCancel
            ? `Autoroute canceled — ${agg.routedNets.length} routed, ${agg.failedNets.length} failed (${ms} ms)`
            : (agg.success
                ? `Autoroute: OK — ${agg.routedNets.length} net(s) routed (${ms} ms)`
                : `Autoroute: ${agg.routedNets.length} routed, ${agg.failedNets.length} failed (${ms} ms)`));
        return agg;
    },

    // Render autoroute results into the right-hand panel. DOM-safe: no-op when
    // the element does not exist (e.g. headless / agent preview feed).
    renderAutoroutePanel(res, ms) {
        if (typeof document === 'undefined') return;
        const panel = document.getElementById('autoroute-results');
        if (!panel) return;
        if (!res) { panel.innerHTML = '<p class="hint">Click Autoroute to route all nets.</p>'; return; }
        const msStr = (ms > 0) ? ` — ${ms} ms` : '';
        if (res.success) {
            panel.innerHTML = `<div class="ar-pass">✓ Routed ${res.routedNets.length} net(s)${msStr}</div>` + this._autorouteDiagHtml(res.diagnostics);
        } else {
            let html = `<div class="ar-summary">${res.routedNets.length} routed, ${res.failedNets.length} failed${msStr}</div>`;
            res.failedNets.slice(0, 20).forEach(f => { html += `<div class="ar-item">${f.net}: ${f.reason}</div>`; });
            if (res.failedNets.length > 20) html += `<div class="ar-item">... and ${res.failedNets.length - 20} more</div>`;
            html += this._autorouteDiagHtml(res.diagnostics);
            panel.innerHTML = html;
        }
    },

    // Diagnostics → panel rows. SHORT / NET_DISCONNECTED are errors (red), the
    // rest are informational (orange). Capped so a bad board can't flood the UI.
    _autorouteDiagHtml(diags) {
        let html = '';
        const list = (diags || []).slice(0, 10);
        for (const d of list) {
            let txt;
            if (d.code === 'SHORT') txt = `Short ${d.netA}↔${d.netB}: gap ${Number(d.gap).toFixed(2)}mm`;
            else if (d.code === 'NET_DISCONNECTED') txt = `Net ${d.net} still disconnected`;
            else txt = d.code + (d.net ? ` (${d.net})` : '');
            const cls = (d.code === 'SHORT' || d.code === 'NET_DISCONNECTED') ? '' : 'warning';
            html += `<div class="ar-item ${cls}">${txt}</div>`;
        }
        return html;
    },

    // --- Draggable panels -----------------------------------------
    // Drag `el` by its `handle` (pointer events). The panel leaves the layout
    // flow the moment it moves and its position is remembered per browser.
    makeDraggable(el, handle, key) {
        if (!el || !handle || el._dragBound) return;
        el._dragBound = true;
        handle.classList.add('drag-handle');
        const storeKey = 'millpcb.drag.' + (key || el.id || 'panel');
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch (e) { saved = null; }
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            // Re-attach only if the saved spot is still on screen.
            if (saved.x > -60 && saved.y > -60 && saved.x < window.innerWidth - 40 && saved.y < window.innerHeight - 40) {
                this._floatPanel(el, saved.x, saved.y, saved.w);
            }
        }
        let drag = null;
        handle.addEventListener('pointerdown', e => {
            if (e.button !== 0 || (e.target.closest && e.target.closest('button,select,input,a,textarea'))) return;
            const r = el.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
            this._floatPanel(el, r.left, r.top, r.width);
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
            e.preventDefault();
        });
        handle.addEventListener('pointermove', e => {
            if (!drag) return;
            const x = Math.min(Math.max(2 - drag.w + 60, e.clientX - drag.dx), window.innerWidth - 60);
            const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 24);
            this._floatPanel(el, x, y, drag.w);
        });
        const end = () => {
            if (!drag) return;
            drag = null;
            const r = el.getBoundingClientRect();
            try { localStorage.setItem(storeKey, JSON.stringify({ x: r.left, y: r.top, w: r.width })); } catch (e) { /* private mode */ }
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        // Double-click the handle: put the panel back where the layout wants it.
        handle.addEventListener('dblclick', e => {
            if (e.target.closest && e.target.closest('button,select,input,a,textarea')) return;
            try { localStorage.removeItem(storeKey); } catch (err) { /* private mode */ }
            ['left', 'top', 'right', 'bottom', 'position', 'width'].forEach(p => { el.style[p] = ''; });
            el.classList.remove('floating-panel');
        });
    },

    _floatPanel(el, x, y, w) {
        el.style.position = 'fixed';
        el.style.left = Math.round(x) + 'px';
        el.style.top = Math.round(y) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        if (w) el.style.width = Math.round(w) + 'px';
        el.classList.add('floating-panel');
    }
});
