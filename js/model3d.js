// ============================================================
// Model3D - component 3D preview (Three.js, vendored).
// Builds a realistic per-package scene from KiCad footprint
// geometry: FR-4 slab with copper pads/drills/silkscreen, plus
// a package-accurate body (DIP capsule + notch, SOIC/QFP
// gull-wing leads, TO-92, TO-220, SOT-23, domed LED,
// electrolytic can, axial resistor/diode, SMD chip, headers)
// with PBR materials, soft shadows and ACES tone mapping.
// Left-drag orbits, right/middle-drag pans, wheel zooms toward
// the cursor. Each preview canvas has its own camera. The
// orientation cube is a second canvas and never shares the
// part view's WebGL context. KiCad 3D model references
// (size.model3d) are listed as links.
// Requires: js/vendor/three.min.js (browser-only; the MCP
// kernel never loads this file).
// ============================================================

const Model3D = {
    yaw: 0.7, pitch: 0.9, zoom: 1, panX: 0, panZ: 0,
    parts: [],
    _version: 0,
    _viewers: (typeof WeakMap !== 'undefined') ? new WeakMap() : null,
    _failed: (typeof WeakSet !== 'undefined') ? new WeakSet() : null,
    _mats: {},

    // Open the modal for a placed component (by id).
    openFor(compId) {
        const comp = (App.components || []).find(c => c.id === compId);
        if (!comp) return;
        const def = ComponentDefs.get(comp.type);
        if (!def) return;
        const idx = comp.size !== undefined ? comp.size : (def.defaultSize || 0);
        const size = def.sizes && def.sizes[idx];
        if (!size) return;
        this.buildScene(size, def, comp.type);
        const overlay = document.getElementById('model3d-overlay');
        const title = document.getElementById('model3d-title');
        const refs = document.getElementById('model3d-refs');
        title.textContent = '3D preview - ' + (comp.label || comp.type);
        const m3d = size.model3d || [];
        refs.innerHTML = m3d.length
            ? m3d.map(m => '<a href="' + m.uri + '" target="_blank" rel="noopener" style="color:#4fc3f7">' + m.name + '</a>').join(' &nbsp; ')
            : '<span style="color:#777">No 3D model reference for this part - preview shows generated package geometry.</span>';
        overlay.classList.remove('hidden');
        const canvas = document.getElementById('model3d-canvas');
        this.resetView(canvas);
        this.render(canvas);
    },

    close() {
        document.getElementById('model3d-overlay').classList.add('hidden');
    },

    // Open the whole-board 3D view (overlay canvas next to the toolbar 3D button).
    openBoard() {
        if (typeof THREE === 'undefined') return;
        this.buildBoardScene();
        const overlay = document.getElementById('board3d-overlay');
        if (!overlay) return;
        overlay.classList.remove('hidden');
        const canvas = document.getElementById('board3d-canvas');
        this.resetView(canvas);
        this.render(canvas);
    },

    closeBoard() {
        const overlay = document.getElementById('board3d-overlay');
        if (overlay) overlay.classList.add('hidden');
    },

    buildBoardScene() {
        this.parts = _buildBoardParts(typeof App !== 'undefined' ? App : null);
        this._version++;
    },

    // Build the mesh spec for a component size (mm, board top = y 0).
    buildScene(size, def, typeKey) {
        this.parts = _buildParts(size, typeKey || (def && def.key), def);
        this._version++;
    },

    // Camera state lives on the canvas so the library strip, the part
    // modal and the board modal do not overwrite each other.
    _view(canvas) {
        if (!canvas) return { yaw: 0.75, pitch: 0.85, zoom: 1, panX: 0, panZ: 0 };
        if (!canvas._m3dView) canvas._m3dView = { yaw: 0.75, pitch: 0.85, zoom: 1, panX: 0, panZ: 0 };
        return canvas._m3dView;
    },

    render(canvasEl) {
        const canvas = canvasEl || document.getElementById('model3d-canvas');
        if (!canvas || typeof THREE === 'undefined' || !this._viewers) return;
        const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
        const w = cssW || canvas.width, h = cssH || canvas.height;
        if (w < 8 || h < 8) return;
        // The overlay is display:none until opened. If layout has not run yet,
        // paint again on the next frame once the canvas has a CSS size.
        if ((cssW < 8 || cssH < 8) && !canvas._m3dWait && typeof requestAnimationFrame === 'function') {
            canvas._m3dWait = requestAnimationFrame(() => {
                canvas._m3dWait = 0;
                if ((canvas.clientWidth || 0) >= 8) this.render(canvas);
            });
        }
        let v = this._viewers.get(canvas);
        if (!v) {
            if (this._failed && this._failed.has(canvas)) return;
            try {
                v = _makeViewer(canvas);
                this._viewers.set(canvas, v);
            } catch (err) {
                if (this._failed) this._failed.add(canvas);
                return;
            }
        }
        if (v.lastW !== w || v.lastH !== h) {
            v.renderer.setSize(w, h, false);
            v.camera.aspect = w / h;
            v.lastW = w; v.lastH = h;
        }
        if (v.partsVersion !== this._version) {
            _rebuildMeshes(v, this.parts);
            v.partsVersion = this._version;
            v.fit = _fitOf(this.parts);
        }
        const fit = v.fit;
        const view = this._view(canvas);
        const dist = _orbitDist(fit, view.zoom);
        const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
        const s = fit.radius * 0.8;
        const tx = view.panX * s, tz = view.panZ * s;
        v.camera.near = Math.max(0.05, dist / 80);
        v.camera.far = Math.max(500, dist * 40);
        v.camera.aspect = w / h;
        v.camera.updateProjectionMatrix();
        v.camera.position.set(
            tx + dist * cp * Math.sin(view.yaw),
            fit.cy + dist * sp,
            tz + dist * cp * Math.cos(view.yaw)
        );
        v.camera.lookAt(tx, fit.cy, tz);
        v.key.position.set(tx + fit.radius * 1.2, fit.cy + fit.radius * 2.4, tz + fit.radius * 1.5);
        v.key.target.position.set(tx, fit.cy, tz);
        v.key.target.updateMatrixWorld();
        const sh = fit.radius * 2.4;
        v.key.shadow.camera.left = -sh;
        v.key.shadow.camera.right = sh;
        v.key.shadow.camera.top = sh;
        v.key.shadow.camera.bottom = -sh;
        v.key.shadow.camera.near = 0.1;
        v.key.shadow.camera.far = fit.radius * 12;
        v.key.shadow.camera.updateProjectionMatrix();
        if (v.rim) v.rim.position.set(tx - fit.radius, fit.cy + fit.radius, tz - fit.radius * 1.4);
        v.renderer.render(v.scene, v.camera);
        this._renderCube(canvas);
    },

    // Left-drag orbits (including the underside). Right or middle drag pans.
    // Wheel zooms toward the cursor. Double-click and the reset button restore
    // the default view. Arrow keys pan while the canvas is focused.
    bind(canvasId) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || canvas._m3dBound) return;
        canvas._m3dBound = true;
        this._wireModals();
        const self = this;
        const TAN17 = Math.tan(17 * Math.PI / 180);
        const clampPan = v => Math.min(15, Math.max(-15, v));
        const view = () => self._view(canvas);
        const fitNow = () => {
            const v = self._viewers && self._viewers.get(canvas);
            return (v && v.fit) || { radius: 10, cy: 1, maxY: 1 };
        };
        const off = () => {
            const cam = view(), s = fitNow().radius * 0.8;
            return { x: cam.panX * s, z: cam.panZ * s };
        };
        const mmPerPx = () => {
            const h = canvas.clientHeight || canvas.height || 1;
            return 2 * _orbitDist(fitNow(), view().zoom) * TAN17 / h;
        };
        // Cursor ray against the plane through the pivot, facing the camera.
        const rayWorld = e => {
            const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
            if (w < 8 || h < 8) return null;
            const rect = canvas.getBoundingClientRect();
            const cam = view();
            const fit = fitNow();
            const dist = _orbitDist(fit, cam.zoom);
            const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
            const o = off();
            const fx = -cp * Math.sin(cam.yaw), fy = -sp, fz = -cp * Math.cos(cam.yaw);
            const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
            const px = ((e.clientX - rect.left) / w - 0.5) * 2 * TAN17;
            const pz = ((e.clientY - rect.top) / h - 0.5) * 2 * TAN17;
            const dx = fx + px * rx + pz * sp * Math.sin(cam.yaw);
            const dy = fy - pz * cp;
            const dz = fz + px * rz + pz * sp * Math.cos(cam.yaw);
            const denom = dx * fx + dy * fy + dz * fz;
            if (Math.abs(denom) < 1e-6) return null;
            const t = dist / denom;
            const wx = o.x + dist * cp * Math.sin(cam.yaw) + t * dx;
            const wz = o.z + dist * cp * Math.cos(cam.yaw) + t * dz;
            if (Math.hypot(wx - o.x, wz - o.z) > fit.radius * 8) return null;
            return { x: wx, z: wz };
        };
        let mode = 0, lx = 0, ly = 0;
        canvas.addEventListener('webglcontextlost', e => {
            e.preventDefault();
            if (self._viewers) self._viewers.delete(canvas);
        });
        canvas.addEventListener('contextmenu', e => e.preventDefault());
        canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
        canvas.addEventListener('mousedown', e => {
            mode = (e.button === 0) ? 1 : 2;
            lx = e.clientX; ly = e.clientY;
            canvas.focus();
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!mode) return;
            const dx = e.clientX - lx, dy = e.clientY - ly;
            lx = e.clientX; ly = e.clientY;
            const cam = view();
            if (mode === 1) {
                cam.yaw += dx * 0.012;
                cam.pitch = Math.min(1.45, Math.max(-1.2, cam.pitch + dy * 0.012));
            } else {
                const s = fitNow().radius * 0.8;
                const k = mmPerPx() / s;
                const sx = Math.sin(cam.yaw), sz = Math.cos(cam.yaw);
                cam.panX = clampPan(cam.panX + (dx * sx + dy * sz) * k);
                cam.panZ = clampPan(cam.panZ + (dx * sz - dy * sx) * k);
            }
            self.render(canvas);
        });
        window.addEventListener('mouseup', () => { mode = 0; });
        canvas.addEventListener('dblclick', () => { self.resetView(canvas); self.render(canvas); });
        canvas.tabIndex = 0;
        canvas.addEventListener('keydown', e => {
            if (e.target && e.target.tagName === 'INPUT') return;
            const cam = view();
            const step = 0.15;
            let hit = true;
            if (e.key === 'ArrowLeft') cam.panX = clampPan(cam.panX - step);
            else if (e.key === 'ArrowRight') cam.panX = clampPan(cam.panX + step);
            else if (e.key === 'ArrowUp') cam.panZ = clampPan(cam.panZ - step);
            else if (e.key === 'ArrowDown') cam.panZ = clampPan(cam.panZ + step);
            else hit = false;
            if (hit) { e.preventDefault(); self.render(canvas); }
        });
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const cam = view();
            const z0 = cam.zoom;
            const z1 = Math.min(8, Math.max(0.35, z0 * (e.deltaY < 0 ? 1.12 : 0.9)));
            if (z1 !== z0) {
                const wp = rayWorld(e);
                if (wp) {
                    const s = fitNow().radius * 0.8, o = off();
                    const g = z0 / z1;
                    cam.panX = clampPan((o.x + (wp.x - o.x) * g) / s);
                    cam.panZ = clampPan((o.z + (wp.z - o.z) * g) / s);
                }
                cam.zoom = z1;
            }
            self.render(canvas);
        }, { passive: false });
    },

    resetView(canvasEl) {
        const canvas = (canvasEl && canvasEl.getContext) ? canvasEl : document.getElementById('model3d-canvas');
        const cam = this._view(canvas);
        cam.yaw = 0.75; cam.pitch = 0.85; cam.zoom = 1; cam.panX = 0; cam.panZ = 0;
        this.yaw = cam.yaw; this.pitch = cam.pitch; this.zoom = cam.zoom; this.panX = 0; this.panZ = 0;
    },

    // Orientation cube on the sibling canvas. A second WebGL context on the
    // part canvas replaces the preview, so this never touches that canvas.
    _renderCube(host) {
        if (typeof THREE === 'undefined' || !host || !host.parentNode) return;
        const cube = host.parentNode.querySelector('.m3d-cube canvas');
        if (!cube) return;
        if (!cube._cubeView) {
            try { cube._cubeView = _makeCube(cube); }
            catch (e) { cube._cubeView = null; return; }
        }
        const cv = cube._cubeView;
        if (!cv) return;
        const w = cube.clientWidth || 92, h = cube.clientHeight || 92;
        if (w < 8 || h < 8) return;
        if (cv.lastW !== w || cv.lastH !== h) {
            cv.renderer.setSize(w, h, false);
            cv.camera.aspect = w / h;
            cv.camera.updateProjectionMatrix();
            cv.lastW = w; cv.lastH = h;
        }
        const cam = this._view(host);
        const dist = 3.8;
        const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
        cv.camera.position.set(dist * cp * Math.sin(cam.yaw), dist * sp, dist * cp * Math.cos(cam.yaw));
        cv.camera.lookAt(0, 0, 0);
        cv.renderer.render(cv.scene, cv.camera);
    },

    // Modal close buttons + Escape (wired once, independent of canvas binding).
    _wireModals() {
        if (this._modalsWired || typeof document === 'undefined') return;
        this._modalsWired = true;
        const add = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
        add('model3d-close', () => this.close());
        add('model3d-ok', () => this.close());
        add('board3d-close', () => this.closeBoard());
        add('board3d-ok', () => this.closeBoard());
        add('model3d-reset', () => { const c = document.getElementById('model3d-canvas'); this.resetView(c); this.render(c); });
        add('board3d-reset', () => { const c = document.getElementById('board3d-canvas'); this.resetView(c); this.render(c); });
        document.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            const mo = document.getElementById('model3d-overlay');
            if (mo && !mo.classList.contains('hidden')) this.close();
            const bo = document.getElementById('board3d-overlay');
            if (bo && !bo.classList.contains('hidden')) this.closeBoard();
        });
    }
};

// ---------- materials ----------

const _MAT_DEFS = {
    board: { c: 0x14532d, r: 0.85, m: 0 },
    copper: { c: 0xb87333, r: 0.3, m: 0.85 },
    tin: { c: 0xd0d4da, r: 0.3, m: 0.8 },
    cap: { c: 0x9aa0a8, r: 0.35, m: 0.7 },
    plastic: { c: 0x2b2d34, r: 0.5, m: 0.05 },
    headerplastic: { c: 0x141a28, r: 0.45, m: 0.05 },
    dark: { c: 0x0a0b0e, r: 0.6, m: 0 },
    hole: { c: 0x12151c, r: 0.35, m: 0.65 },
    silk: { c: 0xe8ecf2, r: 0.9, m: 0 },
    alu: { c: 0xbfc4cc, r: 0.35, m: 0.7 },
    board3d: { c: 0x1a6b38, r: 0.8, m: 0.05 },
    vent: { c: 0x767c86, r: 0.45, m: 0.5 },
    resbody: { c: 0xd8c39a, r: 0.6, m: 0 },
    blackbody: { c: 0x1b1b20, r: 0.55, m: 0 },
    sleeve: { c: 0x1f3a93, r: 0.4, m: 0.2 },
    stripe: { c: 0x0e1118, r: 0.5, m: 0 },
    ceramic: { c: 0xc4a574, r: 0.62, m: 0.02 },
    film: { c: 0xb33a3a, r: 0.5, m: 0.04 }
};

function _mat(name, colorOverride) {
    const key = name + '|' + (colorOverride || '');
    if (Model3D._mats[key]) return Model3D._mats[key];
    const def = _MAT_DEFS[name] || _MAT_DEFS.plastic;
    const opts = { color: colorOverride || def.c, roughness: def.r, metalness: def.m };
    if (name === 'led') {
        opts.emissive = colorOverride || 0xff2d2d;
        opts.emissiveIntensity = 0.4;
        opts.roughness = 0.18;
        opts.transparent = true;
        opts.opacity = 0.95;
    }
    const mat = new THREE.MeshStandardMaterial(opts);
    Model3D._mats[key] = mat;
    return mat;
}

const _LED_COLORS = { RED: 0xff2d2d, GRN: 0x35e05a, GREEN: 0x35e05a, BLU: 0x2d6bff, BLUE: 0x2d6bff, YEL: 0xffd23f, YELLOW: 0xffd23f, WHT: 0xeef4ff, WHITE: 0xeef4ff };

// ---------- orientation cube (own canvas, own WebGL context) ----------
function _makeCube(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(canvas.clientWidth || 76, canvas.clientHeight || 76, false);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.2, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x243044, roughness: 0.5, metalness: 0.08 })
    );
    scene.add(box);
    scene.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1.22, 1.22, 1.22)),
        new THREE.LineBasicMaterial({ color: 0x8fd4ff })
    ));
    const label = (txt, x, y, z, rx, ry, rz, bg) => {
        const el = document.createElement('canvas');
        el.width = 256; el.height = 256;
        const g = el.getContext('2d');
        g.fillStyle = bg;
        g.fillRect(8, 8, 240, 240);
        g.fillStyle = '#f7fbff';
        g.font = 'bold 78px sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(txt, 128, 136);
        const tex = new THREE.CanvasTexture(el);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.86),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        mesh.position.set(x, y, z);
        mesh.rotation.set(rx || 0, ry || 0, rz || 0);
        scene.add(mesh);
    };
    // World Y is up. Top text reads when the camera is on the +Z side.
    label('TOP', 0, 0.67, 0, -Math.PI / 2, 0, 0, '#1a6b38');
    label('BOT', 0, -0.67, 0, Math.PI / 2, 0, 0, '#3a4658');
    label('R', 0.67, 0, 0, 0, Math.PI / 2, 0, '#a5683a');
    label('L', -0.67, 0, 0, 0, -Math.PI / 2, 0, '#2c3340');
    label('F', 0, 0, 0.67, 0, 0, 0, '#4d6278');
    label('B', 0, 0, -0.67, 0, Math.PI, 0, '#161b24');
    return { renderer, scene, camera, lastW: 0, lastH: 0 };
}

function _ledColor(size) {
    const v = String(size.value || size.name || '').toUpperCase();
    for (const k of Object.keys(_LED_COLORS)) {
        if (v.indexOf(k) >= 0) return _LED_COLORS[k];
    }
    return 0xff2d2d;
}

// ---------- viewer ----------

// 34° vertical FOV: about 3.2 fit-radii frames the part, and the height
// floor keeps the eye outside small cans such as TO-92.
function _orbitDist(fit, zoom) {
    const r = Math.max(3, (fit && fit.radius) || 10);
    const maxY = Math.max(1, (fit && fit.maxY) || r);
    return Math.max(r * 3.2, maxY * 2.8) / Math.max(0.2, zoom || 1);
}

function _makeViewer(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 800);
    scene.add(new THREE.HemisphereLight(0xe7eeff, 0x1a2433, 0.85));
    const key = new THREE.DirectionalLight(0xfff6ea, 1.45);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    scene.add(key.target);
    const fill = new THREE.DirectionalLight(0x9eb6e8, 0.38);
    fill.position.set(-8, 6, -10);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xc5d4ff, 0.28);
    rim.position.set(4, 3, -8);
    scene.add(rim);
    const group = new THREE.Group();
    scene.add(group);
    return { renderer, scene, camera, key, rim, group, partsVersion: -1, fit: { radius: 8, cy: 1, maxY: 2 }, lastW: 0, lastH: 0 };
}

function _rebuildMeshes(v, parts) {
    while (v.group.children.length) {
        const c = v.group.children[0];
        if (c.geometry) c.geometry.dispose();
        v.group.remove(c);
    }
    parts.forEach(p => {
        const mesh = _makeMesh(p);
        if (mesh) v.group.add(mesh);
    });
}

function _pos(n) { return typeof n === 'number' && isFinite(n) && n > 0.001; }

function _makeMesh(p) {
    let geo;
    try {
        switch (p.t) {
            case 'b':
                if (!_pos(p.w) || !_pos(p.h) || !_pos(p.d)) return null;
                geo = new THREE.BoxGeometry(p.w, p.h, p.d);
                break;
            case 'c': {
                if (!_pos(p.r) || !_pos(p.h)) return null;
                const sweep = (p.thl === undefined || !(p.thl > 0)) ? Math.PI * 2 : p.thl;
                geo = new THREE.CylinderGeometry(p.r, p.r, p.h, 28, 1, false, p.th0 || 0, sweep);
                if (p.ax === 'x') geo.rotateZ(-Math.PI / 2);
                if (p.ax === 'z') geo.rotateX(Math.PI / 2);
                break;
            }
            case 't': {
                if (!p.pts || p.pts.length < 2 || !_pos(p.r)) return null;
                if (!p.pts.every(q => q && isFinite(q[0]) && isFinite(q[1]) && isFinite(q[2]))) return null;
                const curve = new THREE.CatmullRomCurve3(p.pts.map(q => new THREE.Vector3(q[0], q[1], q[2])));
                geo = new THREE.TubeGeometry(curve, Math.max(8, p.pts.length * 8), p.r, 8, false);
                break;
            }
            case 's':
                if (!_pos(p.r)) return null;
                geo = new THREE.SphereGeometry(p.r, 24, 18);
                if (p.sx) geo.scale(p.sx, p.sy || 1, p.sz || 1);
                break;
            case 'o':
                if (!_pos(p.r) || !_pos(p.tube)) return null;
                geo = new THREE.TorusGeometry(p.r, p.tube, 8, 24);
                geo.rotateX(Math.PI / 2);
                break;
            case 'poly': {
                if (!p.pts || p.pts.length < 3 || !_pos(p.h)) return null;
                const shape = new THREE.Shape();
                p.pts.forEach((q, i) => { if (i === 0) shape.moveTo(q.x, q.y); else shape.lineTo(q.x, q.y); });
                shape.closePath();
                geo = new THREE.ExtrudeGeometry(shape, { depth: p.h, bevelEnabled: false });
                geo.translate(0, 0, -p.h / 2);
                geo.rotateX(-Math.PI / 2); // shape XY (board x, -board y) -> three XZ
                break;
            }
            default: return null;
        }
    } catch (e) {
        return null;
    }
    const mesh = new THREE.Mesh(geo, _mat(p.m, p.c));
    if (p.t !== 't') mesh.position.set(p.x || 0, p.y || 0, p.z || 0);
    if (p.ry) mesh.rotation.y = -p.ry * Math.PI / 180;
    if (p.rx) mesh.rotation.x = p.rx * Math.PI / 180;
    mesh.castShadow = p.m !== 'board' && !p.noShadow;
    mesh.receiveShadow = true;
    return mesh;
}

function _fitOf(parts) {
    let r2 = 0, maxY = 1;
    parts.forEach(p => {
        if (p.t === 'b') {
            r2 = Math.max(r2, (p.w / 2) * (p.w / 2) + (p.d / 2) * (p.d / 2) + p.y * p.y);
            maxY = Math.max(maxY, p.y + p.h / 2);
        } else if (p.t === 'c') {
            r2 = Math.max(r2, (p.r + Math.abs(p.x)) * (p.r + Math.abs(p.x)) + (p.r + Math.abs(p.z)) * (p.r + Math.abs(p.z)));
            maxY = Math.max(maxY, p.y + p.h / 2);
        } else if (p.t === 's') {
            r2 = Math.max(r2, (p.r + Math.abs(p.x)) * (p.r + Math.abs(p.x)) + (p.r + Math.abs(p.z)) * (p.r + Math.abs(p.z)));
            maxY = Math.max(maxY, p.y + p.r);
        } else if (p.t === 't') {
            p.pts.forEach(q => {
                r2 = Math.max(r2, q[0] * q[0] + q[2] * q[2]);
                maxY = Math.max(maxY, q[1]);
            });
        } else if (p.t === 'poly') {
            p.pts.forEach(q => { r2 = Math.max(r2, q.x * q.x + q.y * q.y); });
            maxY = Math.max(maxY, (p.y || 0) + (p.h || 0) / 2);
        }
    });
    return { radius: Math.max(3, Math.sqrt(r2) + 1.4), cy: Math.max(0.5, maxY * 0.4), maxY: maxY };
}

// ---------- geometry ----------

function _bbOf(pads) {
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    pads.forEach(p => {
        const rot = (p.rot || 0) * Math.PI / 180;
        const w = Math.abs(p.w * Math.cos(rot)) + Math.abs(p.h * Math.sin(rot));
        const h = Math.abs(p.w * Math.sin(rot)) + Math.abs(p.h * Math.cos(rot));
        minX = Math.min(minX, p.x - w / 2); maxX = Math.max(maxX, p.x + w / 2);
        minY = Math.min(minY, p.y - h / 2); maxY = Math.max(maxY, p.y + h / 2);
    });
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

function _rowsOf(pads) {
    const rows = [];
    pads.forEach(p => {
        let r = rows.find(g => Math.abs(g.y - p.y) < 0.6);
        if (!r) { r = { y: p.y, xs: [] }; rows.push(r); }
        r.xs.push(p.x);
    });
    rows.forEach(r => r.xs.sort((a, b) => a - b));
    return rows;
}

function _famOf(size, typeKey, def) {
    const n = String(size.kicad && size.kicad.name || '').toUpperCase();
    const sn = String(size.name || '').toUpperCase();
    // These win over the DIP / two-pad guesses below. A 6mm tact has four
    // drilled pads and would otherwise become a pin header; a 1xN header
    // would become an axial part.
    if (size.push || n.indexOf('PUSH') >= 0 || n.indexOf('TACT') >= 0 || sn.indexOf('PUSH') >= 0 || sn.indexOf('TACT') >= 0) return 'push';
    if (size.dipsw || sn.indexOf('DIP ') === 0 || n.indexOf('SW_DIP') >= 0 || (n.indexOf('DIP') >= 0 && n.indexOf('SW') >= 0)) return 'dipsw';
    if (size.hdrKind === 'female' || sn.indexOf('FEMALE') >= 0 || n.indexOf('FEMALE') >= 0 || n.indexOf('PINSOCKET') >= 0) return 'socket';
    if (n.indexOf('SPST') >= 0 || n.indexOf('SLIDE') >= 0 || sn.indexOf('SPST') >= 0) return 'slide';
    if (size.rows && size.cols) return 'hdr';
    if (n) {
        if (n.indexOf('DIP') >= 0 || n.indexOf('DIL') >= 0) return 'dip';
        if (n.indexOf('SOIC') >= 0 || n.indexOf('SOJ') >= 0 || /^SO\b/.test(n) || n.indexOf('_SO_') >= 0 || n.indexOf('SO-') >= 0) return 'so';
        if (n.indexOf('QFP') >= 0 || n.indexOf('LQFP') >= 0) return 'qfp';
        if (n.indexOf('TO-92') >= 0 || n.indexOf('TO92') >= 0) return 'to92';
        if (n.indexOf('TO-2') >= 0 || n.indexOf('TO2') >= 0 || n.indexOf('TO-3') >= 0) return 'to220';
        if (n.indexOf('SOT-23') >= 0 || n.indexOf('SOT23') >= 0 || n.indexOf('SOT-1') >= 0) return 'sot';
        if (n.indexOf('HEADER') >= 0 || n.indexOf('PINHEAD') >= 0 || n.indexOf('PIN_STRIP') >= 0 || n.indexOf('CONNECTOR') >= 0) return 'hdr';
        if (n.indexOf('LED') >= 0 && (n.indexOf('0402') >= 0 || n.indexOf('0603') >= 0 || n.indexOf('0805') >= 0 || n.indexOf('1206') >= 0 || n.indexOf('1210') >= 0 || n.indexOf('SMD') >= 0)) return 'ledsmd';
        if (n.indexOf('LED') >= 0 && n.indexOf('SMD') < 0 && n.indexOf('PLCC') < 0) return 'ledth';
        if (n.indexOf('LED') >= 0 && n.indexOf('PLCC') >= 0) return 'ledplcc';
        if (n.indexOf('LED') >= 0) return 'ledsmd';
        if (n.indexOf('CRYSTAL') >= 0 || n.indexOf('HC49') >= 0 || n.indexOf('HC-49') >= 0) return 'crystal';
        // Capacitor bodies. Order matters: CP_Axial is a horizontal can, C_Rect_MKP is a
        // film box, and only radial electrolytics are vertical cans. A generic C_ match
        // below would otherwise draw every THT capacitor as an SMD chip.
        if (n.indexOf('AXIAL') >= 0) return 'axial';
        if (n.indexOf('C_DISC') >= 0 || n.indexOf('_DISC') >= 0 || n.indexOf('DISC_') >= 0 || n.indexOf('CERAMIC') >= 0) return 'disc';
        if (n.indexOf('C_RECT') >= 0 || n.indexOf('MKS') >= 0 || n.indexOf('MKP') >= 0 || n.indexOf('FKS') >= 0 || n.indexOf('FKP') >= 0) return 'box';
        if (n.indexOf('C_RADIAL') >= 0 || n.indexOf('CP_') >= 0 || n.indexOf('_CP') >= 0 || n.indexOf('CP-') >= 0 || n.indexOf('ELECTROLYTIC') >= 0 || n.indexOf('CAP_POL') >= 0 || n.indexOf('POLAR') >= 0 || n.indexOf('TANT') >= 0 || n.indexOf('CYLINDRICAL') >= 0) return 'polar';
        if (n.indexOf('C_THT') >= 0 || n.indexOf('VARIANT') >= 0) return 'disc';
        if (n.indexOf('DIODE') >= 0) return 'diode';
        if (/(0402|0603|0805|1206|1210|1218|Metric|SMD)/.test(n) && n.indexOf('DIP') < 0) return 'chip';
        if (n.indexOf('RESISTOR') >= 0 || n.indexOf('AXIAL') >= 0) return 'axial';
        if (n.indexOf('R_)') >= 0 || n.indexOf('R_0') >= 0 || n.indexOf('R_1') >= 0) return 'chip';
        if (n.indexOf('C_') >= 0) return 'chip';
        if (n.indexOf('IND') >= 0) return 'chip';
    }
    // Geometry fallback for imported footprints with unrecognised names:
    // classify by pad layout (drills = THT) so parts never render as a
    // mystery box. 2 drilled pads far apart = axial; close = radial/disc.
    const pads = (size.kicad && size.kicad.pads) || [];
    if (pads.length) {
        const drilled = pads.filter(p => (p.drill || 0) > 0.1);
        const xs = pads.map(p => p.x), ys = pads.map(p => p.y);
        const sx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        const sy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
        const span = Math.max(sx, sy);
        const t = String((def && def.refPrefix) || (size.kicad && size.kicad.name || '')).charAt(0).toUpperCase();
        if (pads.length === 2 && drilled.length === 2) {
            if (t === 'L') return 'axial';
            if (t === 'D') return 'diode';
            if (t === 'C') return span > 6 ? 'polar' : 'disc';
            return span > 6 ? 'axial' : 'disc';
        }
        if (pads.length === 2 && !drilled.length) return 'chip';
        if (pads.length === 3 && drilled.length === 3 && span < 6) return 'to92';
        if (drilled.length === pads.length && pads.length > 2 && span > 2) return 'hdr';
        return 'gen';
    }
    const t = String(typeKey || '');
    if (t === 'led') {
        if (/(0402|0603|0805|1206|1210|SMD|PLCC|WS2812)/.test(sn)) return sn.indexOf('PLCC') >= 0 || sn.indexOf('WS2812') >= 0 ? 'ledplcc' : 'ledsmd';
        return 'ledth';
    }
    if (sn.indexOf('SOT-23') >= 0 || sn.indexOf('SOT23') >= 0) return 'sot';
    if (sn.indexOf('TO-220') >= 0 || sn.indexOf('TO220') >= 0) return 'to220';
    if (sn.indexOf('DIP') >= 0 || sn.indexOf('DIL') >= 0) return 'dip';
    if (sn.indexOf('SOIC') >= 0 || sn.indexOf('SOP') >= 0) return 'so';
    if (sn.indexOf('TO-92') >= 0 || sn.indexOf('TO92') >= 0) return 'to92';
    if (t === 'resistor') return 'axial';
    if (t === 'capacitor') return 'chip';
    if (t === 'diode') return 'diode';
    if (t === 'inductor') return 'chip';
    if (t === 'transistor' || t === 'pnp') return 'to92';
    if (t === 'connector') return 'hdr';
    return 'gen';
}

function _addBoard(parts, bb) {
    const w = Math.max(2, bb.width / 2 + 1.5), d = Math.max(2, bb.height / 2 + 1.5);
    parts.push({ t: 'b', x: 0, y: -0.4, z: 0, w: 2 * w, h: 0.8, d: 2 * d, m: 'board' });
}

function _addPads(parts, pads) {
    pads.forEach(p => {
        const rot = (p.rot || 0) * Math.PI / 180;
        const w = Math.max(0.3, Math.abs(p.w * Math.cos(rot)) + Math.abs(p.h * Math.sin(rot)));
        const h = Math.max(0.3, Math.abs(p.w * Math.sin(rot)) + Math.abs(p.h * Math.cos(rot)));
        parts.push({ t: 'b', x: p.x, y: 0.03, z: p.y, w: w, h: 0.06, d: h, m: 'copper' });
        const dr = p.drill || (p.drillOval ? Math.min(p.drillOval.w, p.drillOval.h) : 0);
        if (dr > 0.1) {
            parts.push({ t: 'c', x: p.x, y: -0.4, z: p.y, r: dr / 2, h: 0.82, m: 'hole' });
            // Bottom-side annulus so drilled pads read from underneath too.
            parts.push({ t: 'c', x: p.x, y: -0.77, z: p.y, r: Math.max(dr / 2 + 0.35, Math.max(w, h) / 2), h: 0.06, m: 'copper' });
        }
    });
}

// Through-hole leads: a tin wire at every drilled pad running from below the
// board (y = -0.8) up to topY, so legs visibly pass through the holes.
function _addTHLeads(parts, pads, topY, r) {
    const rr = r || 0.3;
    pads.forEach(p => {
        if ((p.drill || 0) <= 0.1 && !p.drillOval) return;
        parts.push({ t: 'c', x: p.x, y: (topY - 0.8) / 2, z: p.y, r: rr, h: topY + 0.8, m: 'tin' });
    });
}

// KiCad draws filled silk (electrolytic body, polarity blob) as dozens of
// parallel strokes ~0.04mm apart. Extruding those is a solid plate under the part.
function _hatchSet(gs) {
    const buckets = {};
    (gs || []).forEach(g => {
        if (g.type !== 'line' || g.x1 == null) return;
        const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
        const len = Math.hypot(dx, dy);
        if (len < 0.3) return;
        let ang = Math.atan2(dy, dx) * 180 / Math.PI;
        if (ang < 0) ang += 180;
        if (ang >= 180) ang -= 180;
        const key = Math.round(ang / 8) * 8;
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(g);
    });
    const drop = new Set();
    Object.keys(buckets).forEach(key => {
        const b = buckets[key];
        if (b.length < 8) return;
        const dx = b[0].x2 - b[0].x1, dy = b[0].y2 - b[0].y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const offs = b.map(g => ((g.x1 + g.x2) / 2) * nx + ((g.y1 + g.y2) / 2) * ny).sort((a, c) => a - c);
        const gaps = [];
        for (let i = 1; i < offs.length; i++) gaps.push(offs[i] - offs[i - 1]);
        gaps.sort((a, c) => a - c);
        if (gaps[Math.floor(gaps.length / 2)] < 0.25) b.forEach(g => drop.add(g));
    });
    return drop;
}

function _addSilk(parts, k) {
    const silkDrop = _hatchSet(k.silk);
    const draw = (g, y, mat) => {
        if (g.type === 'line' && g.x1 != null) {
            const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 0.05) return;
            parts.push({ t: 'b', x: (g.x1 + g.x2) / 2, y: y, z: (g.y1 + g.y2) / 2, w: len, h: 0.03, d: Math.max(0.1, g.w || 0.12), m: mat, ry: Math.atan2(dy, dx) * 180 / Math.PI });
        } else if (g.type === 'rect' && g.x1 != null) {
            draw({ type: 'line', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y1, w: 0.12 }, y, mat);
            draw({ type: 'line', x1: g.x2, y1: g.y1, x2: g.x2, y2: g.y2, w: 0.12 }, y, mat);
            draw({ type: 'line', x1: g.x2, y1: g.y2, x2: g.x1, y2: g.y2, w: 0.12 }, y, mat);
            draw({ type: 'line', x1: g.x1, y1: g.y2, x2: g.x1, y2: g.y1, w: 0.12 }, y, mat);
        } else if (g.type === 'circle' && g.r > 0.2) {
            parts.push({ t: 'o', x: g.x, y: y, z: g.y, r: g.r, tube: 0.06, m: mat });
        } else if (g.type === 'arc' && g.r > 0.05 && typeof g.a0 === 'number') {
            const sweep = g.sweep || 0;
            const n = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 8)));
            for (let i = 0; i < n; i++) {
                const a = g.a0 + sweep * i / n;
                const b = g.a0 + sweep * (i + 1) / n;
                draw({ type: 'line', x1: g.x + g.r * Math.cos(a), y1: g.y + g.r * Math.sin(a), x2: g.x + g.r * Math.cos(b), y2: g.y + g.r * Math.sin(b), w: g.w || 0.12 }, y, mat);
            }
        }
    };
    (k.silk || []).forEach(g => { if (!silkDrop.has(g)) draw(g, 0.045, 'silk'); });
    (k.fab || []).forEach(g => draw(g, 0.045, 'dark'));
}

function _buildParts(size, typeKey, def) {
    const k = size.kicad;
    if (!k || !k.pads || !k.pads.length) return _buildBuiltIn(size, typeKey, def);
    const parts = [];
    const bb = _bbOf(k.pads);
    _addBoard(parts, bb);
    _addPads(parts, k.pads);
    _addSilk(parts, k);
    let fam = _famOf(size, typeKey, def);
    // SMD guards: name-based families that assume through-hole geometry fall
    // back to the flat chip body when the footprint has no drilled pads.
    const drilled = k.pads.some(p => (p.drill || 0) > 0.1);
    if (!drilled && (fam === 'axial' || fam === 'diode' || fam === 'polar' || fam === 'box' || fam === 'disc' || fam === 'to92' || fam === 'ledth' || fam === 'crystal')) fam = 'chip';
    const fabbb = KicadImport._fabBodySize({ fab: k.fab });
    // Accept the fab courtyard as body size even when it is considerably
    // larger than the pad bbox (DIP pads sit well inside the plastic body).
    const fabok = fabbb && fabbb.width < bb.width * 2.2 + 2 && fabbb.height < bb.height * 2.2 + 2;
    const body = fabok ? fabbb : bb;
    if (fam === 'dip') _buildDip(parts, k, body);
    else if (fam === 'so') _buildSo(parts, k, body);
    else if (fam === 'qfp') _buildQfp(parts, k, body);
    else if (fam === 'to92') _buildTO92(parts, k);
    else if (fam === 'to220') _buildTO220(parts, k, body);
    else if (fam === 'sot') _buildSot(parts, k, body);
    else if (fam === 'hdr') _buildHdr(parts, k, body, false);
    else if (fam === 'socket') _buildHdr(parts, k, body, true);
    else if (fam === 'push') _buildPush(parts, k, body);
    else if (fam === 'slide') _buildSlide(parts, k, body);
    else if (fam === 'dipsw') _buildDipSw(parts, k, body);
    else if (fam === 'axial' || fam === 'diode') _buildAxial(parts, k, fam);
    else if (fam === 'polar') _buildPolar(parts, body, k);
    else if (fam === 'box') _buildBox(parts, body, k);
    else if (fam === 'disc') _buildDisc(parts, body, k);
    else if (fam === 'crystal') _buildCrystal(parts, k);
    else if (fam === 'ledth') _buildLedTH(parts, k, size);
    else if (fam === 'ledsmd') _buildLedSMD(parts, body, size);
    else if (fam === 'ledplcc') _buildLedPlcc(parts, body, size);
    else if (fam === 'chip') _buildChip(parts, body, fam);
    else _buildGen(parts, body);
    return parts;
}

// ---------- package builders ----------
// KiCad mm coords: (x, y) -> three (x, z); board top y = 0.

// Pads that share an X (or Y) within 0.45mm are one row.
function _clusterPads(pads, axis) {
    const items = (pads || []).map(p => ({ p, v: p[axis] })).sort((a, b) => a.v - b.v);
    const groups = [];
    items.forEach(it => {
        const g = groups.length ? groups[groups.length - 1] : null;
        if (g && Math.abs(it.v - g.v) < 0.45) {
            g.pads.push(it.p);
            g.v = g.pads.reduce((s, p) => s + p[axis], 0) / g.pads.length;
        } else groups.push({ v: it.v, pads: [it.p] });
    });
    return groups;
}

// Two pin rows. KiCad DIP and SOIC put the rows on ±X, the body long on Y.
function _padSides(pads) {
    if (!pads || pads.length < 3) return null;
    const gx = _clusterPads(pads, 'x');
    const gy = _clusterPads(pads, 'y');
    const sep = (gs) => (gs.length === 2) ? Math.abs(gs[0].v - gs[1].v) : -1;
    if (gx.length === 2 && sep(gx) >= sep(gy)) return { axis: 'x', groups: gx };
    if (gy.length === 2) return { axis: 'y', groups: gy };
    return null;
}

function _pin1(pads) {
    let best = null, bestN = Infinity;
    (pads || []).forEach(p => {
        const n = parseInt(p.num, 10);
        const v = isFinite(n) ? n : 10000;
        if (v < bestN) { bestN = v; best = p; }
    });
    return best || (pads && pads[0]) || null;
}

// Gull wing from the body edge (x0, z) out to the pad (x1, z). yTop is the exit height.
function _gull(parts, x0, x1, z, y0, r, yTop) {
    const dx = x1 - x0;
    const top = yTop == null ? y0 + 1.15 : yTop;
    parts.push({ t: 't', r: r || 0.09, pts: [
        [x0, top, z],
        [x0 + dx * 0.2, top * 0.55 + y0 * 0.45, z],
        [x0 + dx * 0.75, y0 + 0.1, z],
        [x1, y0, z]
    ]});
}

function _gullZ(parts, z0, z1, x, y0, r, yTop) {
    const dz = z1 - z0;
    const top = yTop == null ? y0 + 1.15 : yTop;
    parts.push({ t: 't', r: r || 0.09, pts: [
        [x, top, z0],
        [x, top * 0.55 + y0 * 0.45, z0 + dz * 0.2],
        [x, y0 + 0.1, z0 + dz * 0.75],
        [x, y0, z1]
    ]});
}

// Plastic rectangle between the two pin rows. Shrinks so the leads still stick out.
function _icBody(k, body, inset) {
    const fb = _gfxBox(k.fab) || _gfxBox(k.silk);
    const pads = k.pads || [];
    const sides = _padSides(pads);
    let bx = 0, bz = 0, bw = Math.max(1.2, (body && body.width) || 4), bd = Math.max(1.2, (body && body.height) || 6);
    if (fb && fb.w > 0.8 && fb.d > 0.8) {
        bx = fb.cx; bz = fb.cy; bw = fb.w; bd = fb.d;
    } else if (sides) {
        const ys = pads.map(p => p.y), xs = pads.map(p => p.x);
        if (sides.axis === 'x') {
            const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
            bw = Math.max(1.2, span - (inset || 1.2));
            bd = (Math.max.apply(null, ys) - Math.min.apply(null, ys)) + 2.54;
            bx = (sides.groups[0].v + sides.groups[1].v) / 2;
            bz = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
        } else {
            const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
            bd = Math.max(1.2, span - (inset || 1.2));
            bw = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) + 2.54;
            bz = (sides.groups[0].v + sides.groups[1].v) / 2;
            bx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
        }
    }
    if (sides && sides.axis === 'x') {
        const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
        if (bw > span - 0.3) bw = Math.max(0.8, span - 0.3);
    } else if (sides && sides.axis === 'y') {
        const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
        if (bd > span - 0.3) bd = Math.max(0.8, span - 0.3);
    }
    return { bx, bz, bw, bd, sides };
}

function _leadOut(parts, sides, box, y0, r, yTop) {
    if (!sides) return;
    const { bx, bz, bw, bd } = box;
    if (sides.axis === 'x') {
        sides.groups.forEach(g => {
            const side = Math.sign(g.v - bx) || 1;
            const edge = bx + side * (bw / 2);
            g.pads.forEach(p => _gull(parts, edge, p.x, p.y, y0, r, yTop));
        });
    } else {
        sides.groups.forEach(g => {
            const side = Math.sign(g.v - bz) || 1;
            const edge = bz + side * (bd / 2);
            g.pads.forEach(p => _gullZ(parts, edge, p.y, p.x, y0, r, yTop));
        });
    }
}

function _buildDip(parts, k, body) {
    const y0 = 0.15, hgt = 3.3;
    const box = _icBody(k, body, 1.27);
    const { bx, bz, bw, bd } = box;
    parts.push({ t: 'b', x: bx, y: y0 + hgt / 2, z: bz, w: bw, h: hgt, d: bd, m: 'plastic' });
    // Pin-1 index on the top face (NE555 and other PDIPs). The semicircular
    // notch is the silk arc on the board; a solid cylinder on the end reads
    // as a handle, not a scoop.
    const p1 = _pin1(k.pads);
    const nr = Math.min(0.85, Math.min(bw, bd) * 0.14);
    if (p1 && nr > 0.15) {
        const longZ = bd >= bw;
        const end = longZ ? (p1.y < bz ? -1 : 1) : (p1.x < bx ? -1 : 1);
        parts.push({
            t: 'c',
            x: longZ ? bx : bx + end * (bw / 2 - nr),
            y: y0 + hgt + 0.05,
            z: longZ ? bz + end * (bd / 2 - nr) : bz,
            r: nr, h: 0.1, m: 'dark'
        });
    }
    _leadOut(parts, box.sides, box, y0, 0.24, y0 + hgt * 0.42);
    _addTHLeads(parts, k.pads, y0, 0.22);
}

function _buildSo(parts, k, body) {
    const y0 = 0.06, hgt = 1.5;
    const box = _icBody(k, body, 0.9);
    const { bx, bz, bw, bd } = box;
    parts.push({ t: 'b', x: bx, y: y0 + hgt / 2, z: bz, w: bw, h: hgt, d: bd, m: 'plastic' });
    const p1 = _pin1(k.pads);
    if (p1) {
        const dx = Math.sign(p1.x - bx) || -1;
        const dz = Math.sign(p1.y - bz) || -1;
        parts.push({ t: 's', x: bx + dx * (bw / 2 - Math.min(0.45, bw * 0.2)), y: y0 + hgt + 0.02, z: bz + dz * (bd / 2 - Math.min(0.45, bd * 0.18)), r: 0.22, sx: 1, sy: 0.3, sz: 1, m: 'tin' });
    }
    _leadOut(parts, box.sides, box, y0, 0.08, y0 + hgt * 0.72);
}

function _buildQfp(parts, k, body) {
    const box = _icBody(k, body, 0.6);
    const { bx, bz, bw, bd } = box;
    const y0 = 0.06, hgt = 1.6;
    parts.push({ t: 'b', x: bx, y: y0 + hgt / 2, z: bz, w: bw, h: hgt, d: bd, m: 'plastic' });
    const p1 = _pin1(k.pads);
    if (p1) {
        const dx = Math.sign(p1.x - bx) || -1;
        const dz = Math.sign(p1.y - bz) || -1;
        parts.push({ t: 's', x: bx + dx * (bw / 2 - 0.45), y: y0 + hgt + 0.02, z: bz + dz * (bd / 2 - 0.45), r: 0.28, sx: 1, sy: 0.25, sz: 1, m: 'tin' });
    }
    (k.pads || []).forEach(p => {
        const adx = Math.abs(p.x - bx), adz = Math.abs(p.y - bz);
        if (adz >= adx) {
            const side = Math.sign(p.y - bz) || 1;
            _gullZ(parts, bz + side * (bd / 2), p.y, p.x, y0, 0.08, y0 + hgt * 0.72);
        } else {
            const side = Math.sign(p.x - bx) || 1;
            _gull(parts, bx + side * (bw / 2), p.x, p.y, y0, 0.08, y0 + hgt * 0.72);
        }
    });
}

// TO-92 D profile from the footprint arcs (flat chord + round body).
// Shape points are (boardX, -boardY): the extrude rotates shape-Y onto -Z.
function _to92Outline(k) {
    const arcs = [].concat(k.fab || [], k.silk || []).filter(g => g.type === 'arc' && g.r > 1.2 && typeof g.a0 === 'number');
    if (!arcs.length) return null;
    const a = arcs.slice().sort((p, q) => q.r - p.r)[0];
    const lines = [].concat(k.fab || [], k.silk || []).filter(g => g.type === 'line');
    let flat = null;
    lines.forEach(g => {
        const len = Math.hypot((g.x2 || 0) - (g.x1 || 0), (g.y2 || 0) - (g.y1 || 0));
        if (len < a.r * 0.4) return;
        const d1 = Math.abs(Math.hypot(g.x1 - a.x, g.y1 - a.y) - a.r);
        const d2 = Math.abs(Math.hypot(g.x2 - a.x, g.y2 - a.y) - a.r);
        if (d1 > 0.7 || d2 > 0.7) return;
        if (!flat || len > flat.len) flat = { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, len };
    });
    let a0, sweep;
    if (flat) {
        const aA = Math.atan2(flat.y1 - a.y, flat.x1 - a.x);
        const aB = Math.atan2(flat.y2 - a.y, flat.x2 - a.x);
        let ccw = (aB - aA) % (Math.PI * 2);
        if (ccw < 0) ccw += Math.PI * 2;
        // The flat is the short gap; the body is the long way around.
        if (ccw <= Math.PI) { a0 = aA; sweep = ccw - Math.PI * 2; }
        else { a0 = aA; sweep = ccw; }
    } else {
        a0 = a.a0; sweep = Math.abs(a.sweep) > 1 ? a.sweep : Math.PI * 1.5;
    }
    const n = 22;
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const ang = a0 + sweep * i / n;
        const x = a.x + a.r * Math.cos(ang);
        const y = a.y + a.r * Math.sin(ang);
        pts.push({ x, y: -y });
    }
    return _ccwPts(pts);
}

function _ccwPts(pts) {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        area += p.x * q.y - q.x * p.y;
    }
    if (area < 0) pts.reverse();
    return pts;
}

function _buildTO92(parts, k) {
    const y0 = 0.12, hgt = 4.7;
    let pts = _to92Outline(k);
    if (!pts) {
        const pads = k.pads || [];
        const xs = pads.map(p => p.x), ys = pads.map(p => p.y);
        const cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
        const cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
        const sx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
        const sy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
        const alongX = sx >= sy;
        const r = 2.35;
        // In-line leads: flat parallel to the lead row, dome on the -side.
        const a0 = alongX ? Math.PI * 0.2 : -Math.PI * 0.3;
        const sweep = Math.PI * 1.6;
        pts = [];
        const ox = alongX ? 0 : -r * 0.25;
        const oy = alongX ? -r * 0.25 : 0;
        for (let i = 0; i <= 20; i++) {
            const ang = a0 + sweep * i / 20;
            const x = cx + ox + r * Math.cos(ang);
            const y = cy + oy + r * Math.sin(ang);
            pts.push({ x, y: -y });
        }
        pts = _ccwPts(pts);
    }
    parts.push({ t: 'poly', x: 0, y: y0 + hgt / 2, z: 0, h: hgt, pts, m: 'plastic' });
    parts.push({ t: 'c', x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: y0 + hgt + 0.02, z: -pts.reduce((s, p) => s + p.y, 0) / pts.length, r: 0.7, h: 0.08, m: 'dark' });
    _addTHLeads(parts, k.pads, y0 + 0.15, 0.22);
}

function _buildTO220(parts, k, body) {
    const y0 = 0.06;
    const pads = k.pads || [];
    const drilled = pads.filter(p => (p.drill || 0) > 0.2);
    const maxD = drilled.length ? Math.max.apply(null, drilled.map(p => p.drill || 0)) : 0;
    let hole = maxD >= 2 ? drilled.filter(p => (p.drill || 0) === maxD)[0] : null;
    const leads = pads.filter(p => p !== hole && ((p.drill || 0) > 0.2 || pads.length <= 3));
    if (leads.length < 2) { _buildGen(parts, body || { width: 10, height: 4 }); return; }
    const lx = leads.reduce((s, p) => s + p.x, 0) / leads.length;
    const ly = leads.reduce((s, p) => s + p.y, 0) / leads.length;
    const xs = leads.map(p => p.x), ys = leads.map(p => p.y);
    const spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    const spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    if (!hole) {
        // No mounting hole in the footprint: tab sits behind an in-line lead row.
        const back = spanX >= spanY ? { x: 0, y: -1 } : { x: -1, y: 0 };
        hole = { x: lx + back.x * 15, y: ly + back.y * 15, drill: 3.2 };
    }
    let dx = hole.x - lx, dz = hole.y - ly;
    const span = Math.hypot(dx, dz) || 1;
    dx /= span; dz /= span;
    const alongZ = Math.abs(dz) >= Math.abs(dx);
    const across = (alongZ ? spanX : spanY) + 5;
    const plasticLen = Math.min(10, Math.max(7.2, span * 0.48));
    const leadStick = Math.min(4.2, Math.max(2.4, span * 0.2));
    const mid = leadStick + plasticLen / 2;
    const bx = lx + dx * mid, bz = ly + dz * mid;
    const thick = 4.5;
    if (alongZ) parts.push({ t: 'b', x: lx, y: y0 + thick / 2, z: bz, w: Math.max(8, across), h: thick, d: plasticLen, m: 'plastic' });
    else parts.push({ t: 'b', x: bx, y: y0 + thick / 2, z: ly, w: plasticLen, h: thick, d: Math.max(8, across), m: 'plastic' });
    const back = mid + plasticLen / 2;
    const tabEnd = span + 1.8;
    const tabLen = Math.max(2.2, tabEnd - back);
    const tabMid = back + tabLen / 2;
    const tx = lx + dx * tabMid, tz = ly + dz * tabMid;
    const tabT = 1.5;
    if (alongZ) parts.push({ t: 'b', x: lx, y: y0 + tabT / 2 + 0.15, z: tz, w: Math.max(8, across), h: tabT, d: tabLen, m: 'alu' });
    else parts.push({ t: 'b', x: tx, y: y0 + tabT / 2 + 0.15, z: ly, w: tabLen, h: tabT, d: Math.max(8, across), m: 'alu' });
    parts.push({ t: 'c', x: hole.x, y: y0 + tabT / 2 + 0.15, z: hole.y, r: Math.max(0.8, (hole.drill || 3.2) / 2), h: tabT + 0.3, m: 'hole' });
    const front = leadStick;
    leads.forEach(p => {
        if (alongZ) {
            const fz = ly + dz * front;
            parts.push({ t: 't', r: 0.32, pts: [[p.x, y0 + thick * 0.38, fz], [p.x, y0 + 0.45, (fz + p.y) / 2], [p.x, y0, p.y]] });
        } else {
            const fx = lx + dx * front;
            parts.push({ t: 't', r: 0.32, pts: [[fx, y0 + thick * 0.38, p.y], [(fx + p.x) / 2, y0 + 0.45, p.y], [p.x, y0, p.y]] });
        }
    });
    _addTHLeads(parts, leads.filter(p => (p.drill || 0) > 0.2 || pads.indexOf(p) >= 0), y0, 0.28);
}

function _buildSot(parts, k, body) {
    const y0 = 0.06, hgt = 1.1;
    const fb = _gfxBox(k.fab) || _gfxBox(k.silk);
    let bx = 0, bz = 0, bw = 1.3, bd = 2.9;
    if (fb && fb.w > 0.5 && fb.d > 0.5 && fb.w < 4 && fb.d < 4) {
        bx = fb.cx; bz = fb.cy; bw = fb.w; bd = fb.d;
    } else if (body && body.width && body.height) {
        bw = Math.min(3.2, Math.max(1.0, body.width));
        bd = Math.min(3.6, Math.max(1.0, body.height));
    }
    const sides = _padSides(k.pads);
    if (sides && sides.axis === 'x') {
        const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
        if (bw > span - 0.25) bw = Math.max(0.7, span - 0.25);
    } else if (sides && sides.axis === 'y') {
        const span = Math.abs(sides.groups[0].v - sides.groups[1].v);
        if (bd > span - 0.25) bd = Math.max(0.7, span - 0.25);
    }
    parts.push({ t: 'b', x: bx, y: y0 + hgt / 2, z: bz, w: bw, h: hgt, d: bd, m: 'plastic' });
    const p1 = _pin1(k.pads);
    if (p1) {
        const dx = Math.sign(p1.x - bx) || -1;
        const dz = Math.sign(p1.y - bz) || -1;
        parts.push({ t: 's', x: bx + dx * (bw / 2 - 0.22), y: y0 + hgt + 0.01, z: bz + dz * (bd / 2 - 0.28), r: 0.16, sx: 1, sy: 0.3, sz: 1, m: 'tin' });
    }
    _leadOut(parts, sides, { bx, bz, bw, bd }, y0, 0.07, y0 + hgt * 0.65);
    (k.pads || []).forEach(p => {
        const horiz = Math.abs(p.x - bx) >= Math.abs(p.y - bz);
        parts.push({ t: 'b', x: p.x, y: y0 + 0.05, z: p.y, w: horiz ? 0.5 : 0.32, h: 0.1, d: horiz ? 0.32 : 0.5, m: 'tin' });
    });
}

function _pinField(pads) {
    const list = pads || [];
    let cx = 0, cz = 0;
    list.forEach(p => { cx += p.x; cz += p.y; });
    const n = Math.max(1, list.length);
    cx /= n; cz /= n;
    const xs = list.map(p => p.x), ys = list.map(p => p.y);
    return {
        cx: cx, cz: cz,
        spanX: Math.max.apply(null, xs) - Math.min.apply(null, xs),
        spanY: Math.max.apply(null, ys) - Math.min.apply(null, ys)
    };
}

// Male header: short black base, square pins standing above it.
// Female socket: tall housing, pins only in the base, a dark mouth on top.
function _buildHdr(parts, k, body, female) {
    const f = _pinField(k.pads);
    const w = Math.max(2.2, f.spanX + 2.54);
    const d = Math.max(2.2, f.spanY + 2.54);
    const y0 = 0.12;
    if (female) {
        const h = 8.5;
        parts.push({ t: 'b', x: f.cx, y: y0 + h / 2, z: f.cz, w: w, h: h, d: d, m: 'headerplastic' });
        (k.pads || []).forEach(p => {
            parts.push({ t: 'b', x: p.x, y: 1.1, z: p.y, w: 0.64, h: 2.2, d: 0.64, m: 'tin' });
            // Slot sits on the top face. Buried inside the housing it never shows.
            const wide = f.spanX >= f.spanY;
            const slotH = 0.5;
            parts.push({
                t: 'b', x: p.x, y: y0 + h - slotH / 2 + 0.12, z: p.y,
                w: wide ? 1.05 : Math.min(1.8, w * 0.72),
                h: slotH,
                d: wide ? Math.min(1.8, d * 0.72) : 1.05,
                m: 'dark'
            });
        });
    } else {
        const h = 2.54;
        parts.push({ t: 'b', x: f.cx, y: y0 + h / 2, z: f.cz, w: w, h: h, d: d, m: 'headerplastic' });
        (k.pads || []).forEach(p => {
            parts.push({ t: 'b', x: p.x, y: 4.26, z: p.y, w: 0.64, h: 8.28, d: 0.64, m: 'tin' });
        });
    }
    _addTHLeads(parts, k.pads, y0, 0.28);
}

// 6mm tact: square body and a round cap. Leads are the drilled pads.
function _buildPush(parts, k, body) {
    const fb = _gfxBox(k.fab) || _gfxBox(k.silk);
    const f = _pinField(k.pads);
    let w = 6, d = 6, cx = f.cx, cz = f.cz;
    if (fb && fb.w > 2 && fb.d > 2 && fb.w < 14 && fb.d < 14) {
        w = fb.w; d = fb.d; cx = fb.cx; cz = fb.cy;
    } else if (body && body.width && body.height) {
        w = body.width; d = body.height;
    }
    const y0 = 0.1, h = 3.4;
    parts.push({ t: 'b', x: cx, y: y0 + h / 2, z: cz, w: w, h: h, d: d, m: 'plastic' });
    parts.push({ t: 'c', x: cx, y: y0 + h + 0.65, z: cz, r: Math.min(w, d) * 0.28, h: 1.3, m: 'dark' });
    _addTHLeads(parts, k.pads, y0 + 0.3, 0.28);
}

// Small slide switch (SPST): low body and one actuator.
function _buildSlide(parts, k, body) {
    const fb = _gfxBox(k.fab);
    const f = _pinField(k.pads);
    let w = 6, d = 5, cx = f.cx, cz = f.cz;
    if (fb && fb.w > 2 && fb.d > 1.5) {
        w = fb.w; d = fb.d; cx = fb.cx; cz = fb.cy;
    } else if (body && body.width && body.height) {
        w = body.width; d = body.height;
    }
    const y0 = 0.1, h = 2.6;
    parts.push({ t: 'b', x: cx, y: y0 + h / 2, z: cz, w: w, h: h, d: d, m: 'plastic' });
    const p1 = _pin1(k.pads);
    const side = p1 ? (Math.sign(p1.x - cx) || 1) : 1;
    parts.push({ t: 'b', x: cx + side * w * 0.16, y: y0 + h + 0.4, z: cz, w: Math.min(2.2, w * 0.32), h: 0.8, d: Math.min(1.6, d * 0.4), m: 'dark' });
    _addTHLeads(parts, k.pads, y0, 0.28);
}

// DIP switch: plastic bar over the two pin rows, one slider per position.
function _buildDipSw(parts, k, body) {
    const f = _pinField(k.pads);
    const fb = _gfxBox(k.fab);
    let w = Math.max(6.5, f.spanX + 2.2);
    let d = Math.max(4, f.spanY + 2.2);
    let cx = f.cx, cz = f.cz;
    if (fb && fb.w > 4 && fb.d > 3) {
        w = fb.w; d = fb.d; cx = fb.cx; cz = fb.cy;
    }
    const y0 = 0.1, h = 4.2;
    parts.push({ t: 'b', x: cx, y: y0 + h / 2, z: cz, w: w, h: h, d: d, m: 'plastic' });
    const gy = _clusterPads(k.pads, 'y');
    const gx = _clusterPads(k.pads, 'x');
    const alongY = gy.length >= gx.length;
    const groups = alongY ? gy : gx;
    groups.forEach(g => {
        if (alongY) parts.push({ t: 'b', x: cx + w * 0.14, y: y0 + h + 0.35, z: g.v, w: Math.min(2.4, w * 0.28), h: 0.7, d: 1.5, m: 'dark' });
        else parts.push({ t: 'b', x: g.v, y: y0 + h + 0.35, z: cz + d * 0.14, w: 1.5, h: 0.7, d: Math.min(2.4, d * 0.28), m: 'dark' });
    });
    _addTHLeads(parts, k.pads, y0, 0.25);
}

// Lx.xmm / Dx.xmm from the footprint name (axial resistors and capacitors).
function _namedLD(k) {
    const nm = String((k && k.name) || '');
    const ml = nm.match(/L\s*(\d+(?:\.\d+)?)\s*mm/i);
    const md = nm.match(/D\s*(\d+(?:\.\d+)?)\s*mm/i);
    const mw = nm.match(/W\s*(\d+(?:\.\d+)?)\s*mm/i);
    const mH = nm.match(/H\s*(\d+(?:\.\d+)?)\s*mm/i);
    return {
        l: ml ? parseFloat(ml[1]) : null,
        d: md ? parseFloat(md[1]) : null,
        w: mw ? parseFloat(mw[1]) : null,
        h: mH ? parseFloat(mH[1]) : null
    };
}

function _buildAxial(parts, k, fam) {
    const xs = k.pads.map(p => p.x), ys = k.pads.map(p => p.y);
    const sx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    const sy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    const vertical = sy > sx; // leads along the board Y axis
    const span = vertical ? sy : sx;
    const named = _namedLD(k);
    let bl, r;
    if (named.l && named.d && named.l < span + 0.6) {
        bl = named.l;
        r = named.d / 2;
    } else {
        bl = Math.max(1.5, span - 2.2);
        r = Math.min(1.1, bl / 2.2);
    }
    r = Math.max(0.4, Math.min(r, 8));
    const y = 0.06 + r;
    const diode = fam === 'diode';
    const nm = String((k && k.name) || '').toUpperCase();
    const cap = nm.indexOf('C_') >= 0 || nm.indexOf('CP_') >= 0 || nm.indexOf('CAP') >= 0;
    const m = diode ? 'blackbody' : (cap && (nm.indexOf('CP_') >= 0 || nm.indexOf('ELECTRO') >= 0) ? 'alu' : (cap ? 'film' : 'resbody'));
    const body = { t: 'c', ax: 'x', x: 0, y: y, z: 0, r: r, h: bl, m: m };
    const capA = { t: 's', x: bl / 2, y: y, z: 0, r: r, sx: 0.5, sy: 1, sz: 1, m: m };
    const capB = { t: 's', x: -bl / 2, y: y, z: 0, r: r, sx: 0.5, sy: 1, sz: 1, m: m };
    const leadR = Math.max(0.22, Math.min(0.45, r * 0.35)), leadLen = Math.max(0.5, span - bl);
    const leadA = { t: 'c', ax: 'x', x: (span + bl) / 4, y: y, z: 0, r: leadR, h: leadLen, m: 'tin' };
    const leadB = { t: 'c', ax: 'x', x: -(span + bl) / 4, y: y, z: 0, r: leadR, h: leadLen, m: 'tin' };
    const list = [body, capA, capB, leadA, leadB];
    if (diode) list.push({ t: 'c', ax: 'x', x: bl / 2 - 0.35, y: y, z: 0, r: r + 0.05, h: 0.5, m: 'stripe' });
    if (vertical) list.forEach(p => { p.rx = 90; }); // x-axis cylinder -> z-axis
    list.forEach(p => parts.push(p));
    // Leads bend down into the holes at each pad.
    k.pads.forEach(p => parts.push({ t: 'c', x: p.x, y: (y - 0.8) / 2, z: p.y, r: leadR, h: y + 0.8, m: 'tin' }));
}

// Radial electrolytic can: centre, diameter and height taken from the
// footprint (silk circle / name "D5.0mm" / fab box), not the courtyard.
function _canDims(body, k) {
    const nm = String((k && k.name) || '');
    let d = null, h = null;
    const mh = nm.match(/(\d+(?:\.\d+)?)\s*[xX*]\s*(\d+(?:\.\d+)?)\s*mm/i); // "8x11.5mm"
    const named = _namedLD(k);
    if (named.d) d = named.d;
    if (mh) { d = parseFloat(mh[1]); h = parseFloat(mh[2]); }
    if (named.h) h = named.h;
    if (!d && k) {
        const circ = _circleOf(k.fab) || _circleOf(k.silk);
        if (circ && circ.r > 0.5) d = 2 * circ.r;
    }
    if (!d) {
        const xs = k.pads.map(p => p.x), ys = k.pads.map(p => p.y);
        d = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs), Math.max.apply(null, ys) - Math.min.apply(null, ys));
    }
    d = Math.max(1.6, Math.min(d, 22));
    if (h) h = Math.max(2, Math.min(h, 40));
    else h = Math.max(4, Math.min(d * 1.4, 18));
    return { r: d / 2, h: h };
}

function _circleOf(list) {
    let best = null;
    (list || []).forEach(g => {
        if (g.type === 'circle' && g.r > 0.6 && (!best || g.r > best.r)) best = g;
    });
    return best;
}

function _isPolarizedCan(k) {
    const n = String((k && k.name) || '').toUpperCase();
    if (n.indexOf('NON-POL') >= 0 || n.indexOf('NONPOL') >= 0) return false;
    // KiCad: C_Radial is the non-polar can, CP_Radial is the polarized one.
    if (n.indexOf('C_RADIAL') >= 0 && n.indexOf('TANT') < 0 && n.indexOf('POLAR') < 0) return false;
    return true;
}

function _buildPolar(parts, body, k) {
    const y0 = 0.06;
    const xs = k.pads.map(p => p.x), ys = k.pads.map(p => p.y);
    let cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
    let cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
    const circ = _circleOf(k.fab) || _circleOf(k.silk);
    if (circ) { cx = circ.x; cy = circ.y; }
    const d = _canDims(body, k);
    const r = d.r, hgt = d.h;
    parts.push({ t: 'c', x: cx, y: y0 + hgt / 2, z: cy, r: r, h: hgt, m: 'alu' });
    parts.push({ t: 'c', x: cx, y: y0 + hgt + 0.03, z: cy, r: r * 0.85, h: 0.06, m: 'vent' });
    parts.push({ t: 'b', x: cx, y: y0 + hgt + 0.09, z: cy, w: r * 1.3, h: 0.07, d: r * 0.3, m: 'vent' });
    parts.push({ t: 'b', x: cx, y: y0 + hgt + 0.09, z: cy, w: r * 0.3, h: 0.07, d: r * 1.3, m: 'vent' });
    _addTHLeads(parts, k.pads, y0 + Math.min(1.2, hgt * 0.25));
    if (!_isPolarizedCan(k)) return;
    parts.push({ t: 'c', x: cx, y: y0 + hgt * 0.3, z: cy, r: r + 0.06, h: hgt * 0.55, m: 'sleeve' });
    // Stripe marks the negative lead: the pad furthest from the can centre.
    const p0 = k.pads[0], p1 = k.pads[1] || k.pads[0];
    const neg = (Math.abs(p0.x - cx) + Math.abs(p0.y - cy) >= Math.abs(p1.x - cx) + Math.abs(p1.y - cy)) ? p0 : p1;
    const dirX = neg.x - cx, dirZ = neg.y - cy;
    const len = Math.max(0.001, Math.hypot(dirX, dirZ));
    const stripe = { t: 'b', x: cx + dirX / len * r * 0.92, y: y0 + hgt * 0.3, z: cy + dirZ / len * r * 0.92, w: r * 0.5, h: hgt * 0.55, d: r * 0.2, m: 'stripe' };
    stripe.ry = Math.atan2(-dirZ, dirX) * 180 / Math.PI;
    parts.push(stripe);
}

function _gfxBox(gs) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
    const add = (x, y) => {
        if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;
        n++;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    };
    (gs || []).forEach(g => {
        if (g.type === 'line' || g.type === 'rect') { add(g.x1, g.y1); add(g.x2, g.y2); }
        else if (g.type === 'circle' && g.r > 0.3) { add(g.x - g.r, g.y - g.r); add(g.x + g.r, g.y + g.r); }
        else if (g.type === 'arc' && g.r > 0.3 && typeof g.a0 === 'number') {
            const n = 8, sweep = g.sweep || 0;
            for (let i = 0; i <= n; i++) {
                const a = g.a0 + sweep * i / n;
                add(g.x + g.r * Math.cos(a), g.y + g.r * Math.sin(a));
            }
        }
    });
    if (n < 2 || maxX - minX < 0.4 || maxY - minY < 0.4) return null;
    return { w: maxX - minX, d: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// Leads for every pad (built-in pins have no drill flag; KiCad pads do).
function _leadAll(parts, pads, topY) {
    (pads || []).forEach(p => {
        parts.push({ t: 'c', x: p.x, y: (topY - 0.8) / 2, z: p.y, r: 0.28, h: topY + 0.8, m: 'tin' });
    });
}

// Film / box capacitor (C_Rect, MKP, MKS): the fab rectangle is the body, stood up.
function _buildBox(parts, body, k) {
    const y0 = 0.06;
    const fb = _gfxBox(k.fab) || _gfxBox(k.silk);
    const w = Math.max(1.6, fb ? fb.w : (body.width || 4));
    const dp = Math.max(1.2, fb ? fb.d : (body.height || 2));
    const cx = fb ? fb.cx : 0;
    const cy = fb ? fb.cy : 0;
    const hgt = Math.max(3.2, Math.min(Math.min(w, dp) * 1.7, 8));
    parts.push({ t: 'b', x: cx, y: y0 + hgt / 2, z: cy, w: w, h: hgt, d: dp, m: 'film' });
    _leadAll(parts, k.pads, y0 + Math.min(hgt * 0.4, 2));
}

// Small 2-pad parts that are not capacitors (the geometry fallback). Flat slab.
function _buildSlab(parts, body, k) {
    const y0 = 0.06;
    const xs = k.pads.map(p => p.x), ys = k.pads.map(p => p.y);
    const sx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    const sy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    const cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
    const cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
    const alongX = sx >= sy;
    const w = Math.max(1.5, Math.min(alongX ? body.width : 3.2, sx + 1.2));
    const dp = Math.max(1.5, Math.min(alongX ? 3.2 : body.height, sy + 1.2));
    const hgt = 2.6;
    parts.push({ t: 'b', x: cx, y: y0 + hgt / 2, z: cy, w: w, h: hgt, d: dp, m: 'cap' });
    _leadAll(parts, k.pads, y0 + 0.3);
}

// THT ceramic disc: a disc standing on edge between the leads (diameter D, thickness W).
function _buildDisc(parts, body, k) {
    const nm = String((k && k.name) || '').toUpperCase();
    const ceramic = nm.indexOf('DISC') >= 0 || nm.indexOf('CERAMIC') >= 0;
    if (!ceramic) { _buildSlab(parts, body, k); return; }
    const y0 = 0.06;
    const pads = k.pads || [];
    const xs = pads.map(p => p.x), ys = pads.map(p => p.y);
    const sx = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    const sy = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    const cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
    const cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
    const alongX = sx >= sy;
    const named = _namedLD(k);
    let dia = named.d || Math.max(3, alongX ? (body.width || sx || 5) : (body.height || sy || 5));
    let thick = named.w || Math.min(dia * 0.4, 3);
    dia = Math.max(2.4, Math.min(dia, 20));
    thick = Math.max(0.8, Math.min(thick, dia * 0.75));
    const r = dia / 2;
    parts.push({ t: 'c', ax: alongX ? 'z' : 'x', x: cx, y: y0 + r, z: cy, r: r, h: thick, m: 'ceramic' });
    // Stop at the board. A taller lead at the disc's edge sticks up beside the body.
    const yLead = y0 + 0.15;
    _leadAll(parts, pads, yLead);
    pads.forEach(p => {
        const along = alongX ? Math.abs(p.x - cx) : Math.abs(p.y - cy);
        const limit = Math.max(0.2, r - 0.15);
        if (along <= limit + 0.2) return;
        const span = along - limit;
        const dir = alongX ? (Math.sign(p.x - cx) || 1) : (Math.sign(p.y - cy) || 1);
        const lead = { t: 'c', ax: alongX ? 'x' : 'z', y: yLead, r: 0.28, h: span, m: 'tin' };
        if (alongX) { lead.x = cx + dir * (limit + span / 2); lead.z = p.y; }
        else { lead.z = cy + dir * (limit + span / 2); lead.x = p.x; }
        parts.push(lead);
    });
}

// Vertical crystal (HC-49 style): upright lozenge between the two pads.
function _buildCrystal(parts, k) {
    const y0 = 0.06;
    const xs = k.pads.map(p => p.x);
    const span = Math.max.apply(null, xs) - Math.min.apply(null, xs);
    const r = Math.min(2.5, Math.max(1.2, span / 2 + 0.6));
    parts.push({ t: 's', x: 0, y: y0 + r * 1.15, z: 0, r: r, sx: 0.55, sy: 1.15, sz: 1, m: 'alu' });
    _addTHLeads(parts, k.pads, y0);
}

function _buildLedTH(parts, k, size) {
    const r = Math.min(size.width || 5.2, 5.2) / 2;
    const bodyH = 3.2, y0 = 0.06;
    const col = _ledColor(size);
    parts.push({ t: 'c', x: 0, y: y0 + bodyH / 2, z: 0, r: r, h: bodyH, m: 'led', c: col });
    parts.push({ t: 's', x: 0, y: y0 + bodyH, z: 0, r: r, sx: 1, sy: 0.55, sz: 1, m: 'led', c: col });
    parts.push({ t: 'b', x: r * 0.92, y: y0 + bodyH / 2, z: 0, w: r * 0.16, h: bodyH * 0.9, d: r * 1.5, m: 'led', c: col });
    const xs = k.pads.map(p => p.x);
    const cathX = xs[0] < xs[1] ? xs[1] : xs[0];
    parts.push({ t: 'c', x: cathX, y: y0 + bodyH / 2, z: 0, r: 0.35, h: bodyH, m: 'dark' });
    _addTHLeads(parts, k.pads, y0);
}

function _buildLedSMD(parts, body, size) {
    const hl = Math.max(0.6, body.width / 2 - 0.3), hw = Math.max(0.6, body.height / 2 - 0.3);
    const col = _ledColor(size);
    parts.push({ t: 'b', x: 0, y: 0.06 + 0.4, z: 0, w: 2 * hl, h: 0.8, d: 2 * hw, m: 'plastic' });
    parts.push({ t: 's', x: 0, y: 0.06 + 0.8, z: 0, r: Math.min(hl, hw) * 0.7, sx: 1, sy: 0.5, sz: 1, m: 'led', c: col });
}

function _buildLedPlcc(parts, body, size) {
    const hl = Math.max(1.5, body.width / 2 - 0.5), hw = Math.max(1.5, body.height / 2 - 0.5);
    const col = _ledColor(size);
    parts.push({ t: 'b', x: 0, y: 0.06 + 0.7, z: 0, w: 2 * hl, h: 1.4, d: 2 * hw, m: 'plastic' });
    parts.push({ t: 's', x: 0, y: 0.06 + 1.4, z: 0, r: Math.min(hl, hw) * 0.75, sx: 1, sy: 0.55, sz: 1, m: 'led', c: col });
}

function _buildChip(parts, body, fam) {
    const hl = Math.max(0.5, body.width / 2 - 0.35), hw = Math.max(0.4, body.height / 2 - 0.2);
    const m = fam === 'diode' ? 'blackbody' : fam === 'resistor' ? 'resbody' : 'cap';
    const hgt = Math.min(1.4, Math.max(0.45, Math.min(body.width, body.height) * 0.4));
    parts.push({ t: 'b', x: 0, y: 0.06 + hgt / 2, z: 0, w: 2 * hl, h: hgt, d: 2 * hw, m: m });
    parts.push({ t: 'b', x: hl + 0.15, y: 0.06 + hgt / 2, z: 0, w: 0.3, h: hgt, d: 2 * hw, m: 'tin' });
    parts.push({ t: 'b', x: -hl - 0.15, y: 0.06 + hgt / 2, z: 0, w: 0.3, h: hgt, d: 2 * hw, m: 'tin' });
}

function _buildGen(parts, body) {
    const hl = Math.max(0.5, body.width / 2 - 0.3), hw = Math.max(0.5, body.height / 2 - 0.3);
    parts.push({ t: 'b', x: 0, y: 0.06 + 0.5, z: 0, w: 2 * hl, h: 1, d: 2 * hw, m: 'plastic' });
    parts.push({ t: 'b', x: 0, y: 0.06 + 1.0, z: 0, w: 2 * hl - 0.6, h: 0.12, d: 2 * hw - 0.6, m: 'plastic' });
    parts.push({ t: 's', x: -hl + 0.5, y: 0.06 + 1.06, z: hw - 0.5, r: 0.3, sx: 1, sy: 0.25, sz: 1, m: 'tin' });
}

// ---------- built-in sizes (no KiCad footprint) ----------

function _buildBuiltIn(size, typeKey, def) {
    const parts = [];
    const pins = size.pins || [];
    if (!pins.length) {
        parts.push({ t: 'b', x: 0, y: -0.4, z: 0, w: Math.max(2, (size.width || 3) + 2), h: 0.8, d: Math.max(2, (size.height || 3) + 2), m: 'board' });
        parts.push({ t: 'b', x: 0, y: 0.06 + 1.5, z: 0, w: Math.max(1, (size.width || 2)), h: 3, d: Math.max(1, (size.height || 2)), m: 'dark' });
        return parts;
    }
    const px = pins.map(p => p.x), py = pins.map(p => p.y);
    const spanX = Math.max.apply(null, px) - Math.min.apply(null, px);
    const spanY = Math.max.apply(null, py) - Math.min.apply(null, py);
    const w = Math.max((size.width || 3) / 2 + 1.2, spanX / 2 + 1);
    const d = Math.max((size.height || 3) / 2 + 1.2, spanY / 2 + 1);
    parts.push({ t: 'b', x: 0, y: -0.4, z: 0, w: 2 * w, h: 0.8, d: 2 * d, m: 'board' });
    // Pads mirror the 2D board view: round for through-hole sizes, SMD
    // rectangles otherwise (square 1.4mm stubs looked wrong for GND/VCC/NC).
    let minD = Infinity;
    for (let i = 0; i < pins.length; i++) {
        for (let j = i + 1; j < pins.length; j++) minD = Math.min(minD, Math.hypot(pins[i].x - pins[j].x, pins[i].y - pins[j].y));
    }
    if (!isFinite(minD)) minD = 2.54;
    const th = !!size.th || /^TH/.test(String(size.name || '').toUpperCase());
    const twoPad = pins.length === 2;
    // VCC/GND/NC are pads on the copper, not packages.
    const bare = typeKey === 'gnd' || typeKey === 'power' || typeKey === 'nc' || typeKey === 'testpoint';
    pins.forEach(p => {
        if (th || bare) {
            const pr = size.padR || (bare && !th
                ? Math.max(0.7, Math.min(size.width || 2.5, size.height || 2.5) * 0.42)
                : Math.max(0.35, Math.min(1.0, minD * 0.4)));
            const holeR = th ? (((size.drillDia != null) ? size.drillDia : pr * 0.8) / 2) : 0;
            parts.push({ t: 'c', x: p.x, y: 0.03, z: p.y, r: pr, h: 0.06, m: 'copper' });
            if (holeR > 0.1) {
                parts.push({ t: 'c', x: p.x, y: -0.77, z: p.y, r: pr, h: 0.06, m: 'copper' });
                parts.push({ t: 'c', x: p.x, y: -0.36, z: p.y, r: Math.max(0.15, holeR), h: 0.92, m: 'hole' });
            }
        } else {
            const dim = (typeof Export !== 'undefined' && Export.smdPadWH) ? Export.smdPadWH(p, minD, twoPad) : { pw: 1.4, ph: 1.4 };
            parts.push({ t: 'b', x: p.x, y: 0.03, z: p.y, w: Math.max(0.4, dim.pw), h: 0.06, d: Math.max(0.4, dim.ph), m: 'copper' });
        }
    });
    const fam0 = _famOf(size, typeKey, def);
    const fam = (!th && ['ledth', 'to92', 'polar', 'axial', 'diode', 'disc', 'crystal'].indexOf(fam0) >= 0) ? 'chip' : fam0;
    if (bare) return parts;
    const y0 = 0.06;
    if (fam === 'ledth') {
        const r = Math.min(size.width || 5.2, 5.2) / 2, col = _ledColor(size);
        parts.push({ t: 'c', x: 0, y: y0 + 1.6, z: 0, r: r, h: 3.2, m: 'led', c: col });
        parts.push({ t: 's', x: 0, y: y0 + 3.2, z: 0, r: r, sx: 1, sy: 0.55, sz: 1, m: 'led', c: col });
        parts.push({ t: 'b', x: r * 0.92, y: y0 + 1.6, z: 0, w: r * 0.16, h: 2.9, d: r * 1.5, m: 'led', c: col });
        const cathX = px[0] < px[1] ? px[1] : px[0];
        parts.push({ t: 'c', x: cathX, y: y0 + 1.6, z: 0, r: 0.35, h: 3.2, m: 'dark' });
        pins.forEach(p => parts.push({ t: 'c', x: p.x, y: (y0 - 0.8) / 2, z: p.y, r: 0.3, h: y0 + 0.8, m: 'tin' }));
    } else if (fam === 'polar') {
        const pd = Math.max.apply(null, pins.map(p => Math.hypot(p.x, p.y))) * 2;
        const r = Math.max(0.8, Math.min(pd * 0.9, 6));
        const hgt = Math.max(2, Math.min(r * 1.8, 10));
        parts.push({ t: 'c', x: 0, y: y0 + hgt / 2, z: 0, r: r, h: hgt, m: 'alu' });
        parts.push({ t: 'c', x: 0, y: y0 + hgt + 0.05, z: 0, r: r * 0.85, h: 0.06, m: 'vent' });
        parts.push({ t: 'c', x: 0, y: y0 + hgt * 0.3, z: 0, r: r + 0.06, h: hgt * 0.55, m: 'sleeve' });
        const neg = pins.reduce((a, b) => (a.x < b.x ? a : b));
        parts.push({ t: 'b', x: neg.x < 0 ? -r * 0.92 : r * 0.92, y: y0 + hgt * 0.3, z: 0, w: r * 0.5, h: hgt * 0.55, d: r * 0.2, m: 'stripe' });
    } else if (fam === 'disc') {
        _buildDisc(parts, { width: size.width || 5, height: size.height || 5 }, { pads: pins });
    } else if (fam === 'push' || fam === 'slide' || fam === 'dipsw' || fam === 'hdr' || fam === 'socket') {
        const fake = {
            name: size.name || '',
            pads: pins.map((p, i) => ({
                x: p.x, y: p.y, w: 1.6, h: 1.6,
                drill: th ? (size.drillDia || 1) : 0,
                num: String(p.name || (i + 1))
            })),
            fab: [], silk: []
        };
        const b = { width: size.width || 4, height: size.height || 4 };
        if (fam === 'push') _buildPush(parts, fake, b);
        else if (fam === 'slide') _buildSlide(parts, fake, b);
        else if (fam === 'dipsw') _buildDipSw(parts, fake, b);
        else _buildHdr(parts, fake, b, fam === 'socket');
    } else if (fam === 'axial' || fam === 'diode') {
        const bl = Math.max(1.5, spanX - 2.2), r = Math.min(1.1, bl / 2.2), y = y0 + r;
        const m = fam === 'diode' ? 'blackbody' : 'resbody';
        parts.push({ t: 'c', ax: 'x', x: 0, y: y, z: 0, r: r, h: bl, m: m });
        parts.push({ t: 's', x: bl / 2, y: y, z: 0, r: r, sx: 0.5, sy: 1, sz: 1, m: m });
        parts.push({ t: 's', x: -bl / 2, y: y, z: 0, r: r, sx: 0.5, sy: 1, sz: 1, m: m });
        parts.push({ t: 'c', ax: 'x', x: (spanX + bl) / 4, y: y, z: 0, r: 0.3, h: spanX - bl, m: 'tin' });
        parts.push({ t: 'c', ax: 'x', x: -(spanX + bl) / 4, y: y, z: 0, r: 0.3, h: spanX - bl, m: 'tin' });
        if (fam === 'diode') parts.push({ t: 'c', ax: 'x', x: bl / 2 - 0.35, y: y, z: 0, r: r + 0.05, h: 0.5, m: 'stripe' });
        pins.forEach(p => parts.push({ t: 'c', x: p.x, y: (y - 0.8) / 2, z: p.y, r: 0.3, h: y + 0.8, m: 'tin' }));
    } else if (fam === 'chip') {
        parts.push({ t: 'b', x: 0, y: y0 + 0.3, z: 0, w: Math.max(0.8, spanX - 0.6), h: 0.6, d: 1.3, m: 'cap' });
        parts.push({ t: 'b', x: spanX / 2 - 0.15, y: y0 + 0.3, z: 0, w: 0.3, h: 0.6, d: 1.3, m: 'tin' });
        parts.push({ t: 'b', x: -spanX / 2 + 0.15, y: y0 + 0.3, z: 0, w: 0.3, h: 0.6, d: 1.3, m: 'tin' });
    } else if (fam === 'dip' || fam === 'so' || fam === 'to92' || fam === 'to220' || fam === 'sot') {
        const fake = {
            name: size.name || '',
            pads: pins.map((p, i) => ({
                x: p.x, y: p.y, w: 1.5, h: 1.5,
                drill: th ? (size.drillDia || 0.8) : 0,
                num: /^\d+$/.test(String(p.name || '')) ? String(p.name) : String(i + 1)
            })),
            fab: [], silk: []
        };
        const b = { width: size.width || 4, height: size.height || 4 };
        if (fam === 'dip') _buildDip(parts, fake, b);
        else if (fam === 'so') _buildSo(parts, fake, b);
        else if (fam === 'to92') _buildTO92(parts, fake);
        else if (fam === 'to220') _buildTO220(parts, fake, b);
        else _buildSot(parts, fake, b);
    } else {
        const w2 = Math.max(1, (size.width || 2) / 2), d2 = Math.max(1, (size.height || 2) / 2);
        parts.push({ t: 'b', x: 0, y: y0 + 0.6, z: 0, w: 2 * w2, h: 1.2, d: 2 * d2, m: 'plastic' });
        parts.push({ t: 'b', x: 0, y: y0 + 1.2, z: 0, w: 2 * w2 - 0.5, h: 0.12, d: 2 * d2 - 0.5, m: 'plastic' });
        parts.push({ t: 's', x: -w2 + 0.45, y: y0 + 1.26, z: d2 - 0.45, r: 0.28, sx: 1, sy: 0.25, sz: 1, m: 'tin' });
        if (th) pins.forEach(p => parts.push({ t: 'c', x: p.x, y: (y0 - 0.8) / 2, z: p.y, r: 0.3, h: y0 + 0.8, m: 'tin' }));
    }
    return parts;
}

// One copper ribbon per trace. Separate boxes leave a notch where a diagonal
// meets another run, and their side faces stair-step in the shadow map.
function _addTraceCopper(parts, app, tr, half) {
    if (!tr || tr.schemWire) return;
    const pts = tr.points || [];
    if (pts.length < 2) return;
    const layer = tr.layer === 'bottom' ? -1 : 1;
    const cuH = 0.1;
    const y = layer * (half + 0.04 + cuH / 2);
    let polys = [];
    if (typeof Export !== 'undefined' && Export.generateTraceOutline) {
        try { polys = Export.generateTraceOutline(app, tr) || []; } catch (e) { polys = []; }
    }
    if (polys.length) {
        polys.forEach(poly => {
            if (!poly || poly.length < 3) return;
            // Shape Y is flipped: extrude rotates it back onto board +Z.
            parts.push({
                t: 'poly', x: 0, y: y, z: 0, h: cuH, m: 'copper', noShadow: true,
                pts: _ccwPts(poly.map(p => ({ x: p.x, y: -p.y })))
            });
        });
        return;
    }
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        const w = (tr.segmentWidths && tr.segmentWidths[i]) || tr.width || 0.5;
        const pad = Math.max(0.15, w) / 2;
        parts.push({
            t: 'b', x: (a.x + b.x) / 2, y: y, z: (a.y + b.y) / 2,
            w: len + pad * 2, h: cuH, d: Math.max(0.15, w), m: 'copper', noShadow: true,
            ry: Math.atan2(dy, dx) * 180 / Math.PI
        });
    }
}

// ---------- whole-board scene ----------
// Builds every board object into one part list: FR-4 slab (outline-extruded
// when a custom outline exists), copper traces, vias, solder holes, and each
// component placed with its board position/rotation on top.

function _buildBoardParts(app) {
    const parts = [];
    if (!app) return parts;
    const t = Math.max(0.8, app.board && app.board.thickness || 1.2);
    const bw = app.board.width, bh = app.board.height;
    const outline = (app.boardOutline || []).filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
    if (outline.length >= 3) {
        parts.push({ t: 'poly', pts: outline, h: t, m: 'board3d' });
    } else {
        parts.push({ t: 'b', x: 0, y: 0, z: 0, w: bw, h: t, d: bh, m: 'board3d' });
    }
    const half = t / 2;
    (app.traces || []).forEach(tr => _addTraceCopper(parts, app, tr, half));
    (app.vias || []).forEach(v => {
        const d = v.diameter || 1;
        parts.push({ t: 'c', x: v.x, y: half + 0.03, z: v.y, r: d / 2, h: 0.06, m: 'copper' });
        parts.push({ t: 'c', x: v.x, y: 0, z: v.y, r: Math.max(0.15, d / 2 - 0.35), h: t + 0.1, m: 'hole' });
    });
    const comps = (app.components || []).slice(0, 400);
    comps.forEach(comp => {
        const def = ComponentDefs.get(comp.type);
        if (!def) return;
        const idx = comp.size !== undefined ? comp.size : (def.defaultSize || 0);
        const size = def.sizes && def.sizes[idx];
        if (!size) return;
        const local = _buildParts(size, comp.type || def.key, def).filter(p => p.m !== 'board');
        const ang = (comp.rotation || 0) * Math.PI / 180;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        // Local y=0 is the board surface. The slab is centered on y=0, so lift
        // parts onto the top (or bottom) face, level with the traces.
        const side = comp.layer === 'bottom' ? -1 : 1;
        const yBase = side * half;
        local.forEach(p => {
            const lx = p.x || 0, lz = p.z || 0;
            p.x = comp.x + lx * ca - lz * sa;
            p.z = comp.y + lx * sa + lz * ca;
            if (p.ry) p.ry += comp.rotation || 0;
            if (p.t === 't' && p.pts) {
                p.pts = p.pts.map(q => [
                    comp.x + q[0] * ca - q[2] * sa,
                    yBase + side * q[1],
                    comp.y + q[0] * sa + q[2] * ca
                ]);
            } else {
                p.y = yBase + side * (p.y || 0);
            }
            parts.push(p);
        });
    });
    return parts;
}
