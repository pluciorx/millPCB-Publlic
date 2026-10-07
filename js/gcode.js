// ============================================================
// G-code generation — machine profiles, validation, toolpaths
// ============================================================
const GCode = {
    MACHINE_PROFILES: {
        grbl: {
            name: 'GRBL (generic)',
            units: 'mm',
            supportsDwell: true,
            supportsToolChange: false,
            supportsCannedCycles: false,
            spindleStartCommand: (rpm) => `M3 S${Math.round(rpm)}`,
            spindleStopCommand: () => 'M5',
            safeZ: 5,
            dwellSeconds: 2,
            headerLines(units) {
                const u = units === 'inches' ? 'G20' : 'G21';
                return [u, 'G90', 'G17', 'G94', 'G40', 'G49', 'G54'];
            },
            programEndLines(fmt, safeZ) {
                return [
                    'M5',
                    `G0 Z${fmt(safeZ)}`,
                    'G0 X0 Y0',
                    'M30'
                ];
            }
        }
    },

    parseConfig(app, exportApi) {
        const ex = app.export || {};
        const board = app.board || {};
        const inches = ex.units === 'inches';
        return {
            units: inches ? 'inches' : 'mm',
            inches,
            scale: inches ? (1 / 25.4) : 1,
            boardWidth: parseFloat(board.width) || 0,
            boardHeight: parseFloat(board.height) || 0,
            boardThickness: parseFloat(board.thickness) || 0,
            boardMaterial: board.material || '',
            isolationToolDiameter: parseFloat(ex.millToolDia) || 0.2,
            drillToolDiameter: parseFloat(ex.millDrillToolDia) || 0.8,
            outlineToolDiameter: parseFloat(ex.millOutlineToolDia) || parseFloat(ex.millToolDia) || 0.2,
            isolationDepth: parseFloat(ex.millIsoDepth) || 0.1,
            safeZ: parseFloat(ex.millSafeZ),
            plungeFeed: parseFloat(ex.millPlunge) || 50,
            isolationFeed: parseFloat(ex.millFeed) || 120,
            drillFeed: parseFloat(ex.millDrillFeed) || parseFloat(ex.millPlunge) || 50,
            outlineFeed: parseFloat(ex.millOutlineFeed) || Math.max(30, (parseFloat(ex.millFeed) || 120) * 0.6),
            spindleRpm: parseInt(ex.millSpindle, 10) || 10000,
            spindleDwell: ex.millSpindleDwell != null ? parseFloat(ex.millSpindleDwell) : 2,
            outlinePassCount: parseInt(ex.millOutlinePasses, 10) || 3,
            outlineOvercut: parseFloat(ex.millOutlineOvercut) || 0,
            drillOvercut: ex.millDrillOvercut != null ? parseFloat(ex.millDrillOvercut) : 0.1,
            profileName: ex.millProfile || 'grbl',
            includeBoardOutline: ex.includeBoardOutline !== false,
            includeIsolation: ex.includeCopperOutlines !== false,
            includeDrilling: !!ex.includeHoles,
            includeBottomIsolation: exportApi && typeof exportApi.layerEnabled === 'function'
                ? !!exportApi.layerEnabled(app, 'bottom')
                : !!(app.view && app.view.visibleLayers && app.view.visibleLayers.bottom),
            mirror: !!ex.mirror
        };
    },

    getProfile(config) {
        return this.MACHINE_PROFILES[config.profileName] || this.MACHINE_PROFILES.grbl;
    },

    outlinePassDepths(boardThickness, passCount, outlineOvercut) {
        const thickness = Math.max(0, boardThickness);
        const passes = Math.max(1, passCount | 0);
        const overcut = Math.max(0, outlineOvercut || 0);
        const depths = [];
        for (let i = 1; i <= passes; i++) {
            let d = (thickness * i) / passes;
            if (i === passes && overcut > 0) d += overcut;
            depths.push(d);
        }
        return depths;
    },

    drillDepth(boardThickness, drillOvercut) {
        return Math.max(0, boardThickness) + Math.max(0, drillOvercut || 0);
    },

    cutterRadius(toolDiameter) {
        return Math.max(0, toolDiameter) / 2;
    },

    // Outside board cut: expand bounds by cutter radius (G-code coords, Y up).
    outlineToolpathBounds(minX, maxX, minY, maxY, toolDiameter) {
        const r = this.cutterRadius(toolDiameter);
        return {
            minX: minX - r,
            maxX: maxX + r,
            minY: minY - r,
            maxY: maxY + r,
            cutterRadius: r
        };
    },

    validateConfig(config, options) {
        const opts = options || {};
        const errors = [];
        const zSafe = isFinite(config.safeZ) ? config.safeZ : 5;
        config.safeZ = zSafe;

        if (!(config.boardWidth > 0)) errors.push('Board width must be greater than 0.');
        if (!(config.boardHeight > 0)) errors.push('Board height must be greater than 0.');
        if (!(config.boardThickness > 0)) errors.push('Board thickness must be greater than 0.');
        if (!(config.isolationToolDiameter > 0)) errors.push('Isolation tool diameter must be greater than 0.');
        if (!(config.drillToolDiameter > 0)) errors.push('Drill tool diameter must be greater than 0.');
        if (!(config.outlineToolDiameter > 0)) errors.push('Outline tool diameter must be greater than 0.');
        if (!(config.isolationDepth > 0)) errors.push('Isolation depth must be greater than 0.');
        if (!(config.plungeFeed > 0)) errors.push('Plunge feed must be greater than 0.');
        if (!(config.isolationFeed > 0)) errors.push('Isolation feed must be greater than 0.');
        if (!(config.drillFeed > 0)) errors.push('Drill feed must be greater than 0.');
        if (!(config.outlineFeed > 0)) errors.push('Outline feed must be greater than 0.');
        if (!(config.spindleRpm > 0)) errors.push('Spindle RPM must be greater than 0.');
        if (!(config.outlinePassCount >= 1)) errors.push('Outline pass count must be at least 1.');
        if (!(zSafe > 0)) errors.push('Safe Z must be greater than 0.');

        const isoZ = config.isolationDepth;
        const drillZ = this.drillDepth(config.boardThickness, config.drillOvercut);
        const outlineDepths = this.outlinePassDepths(
            config.boardThickness, config.outlinePassCount, config.outlineOvercut
        );
        const maxCutZ = Math.max(isoZ, drillZ, outlineDepths.length ? outlineDepths[outlineDepths.length - 1] : 0);
        if (!(zSafe > maxCutZ)) {
            errors.push(`Safe Z (${zSafe} mm) must be above all cutting depths (deepest cut ${maxCutZ.toFixed(3)} mm).`);
        }

        if (opts.drillingEnabled) {
            if (!(config.drillToolDiameter > 0)) errors.push('Drill tool diameter must be greater than 0 when drilling is enabled.');
            if (drillZ < config.boardThickness) {
                errors.push('Drill depth must reach at least board thickness for through holes.');
            }
        }

        if (errors.length) {
            return { ok: false, error: errors.join('\n') };
        }
        return { ok: true, maxCutZ, outlineDepths, drillZ };
    },

    buildCoordinateTransform(outlinePoints, flipYFn) {
        const flipped = outlinePoints.map(p => flipYFn(p));
        let originX = Infinity, originY = Infinity;
        flipped.forEach(p => {
            if (p.x < originX) originX = p.x;
            if (p.y < originY) originY = p.y;
        });
        return {
            originX, originY,
            toG(p) {
                const f = flipYFn(p);
                return { x: f.x - originX, y: f.y - originY };
            }
        };
    },

    buildToolpaths(app, exportApi) {
        exportApi.normalizeTraces(app);
        const config = this.parseConfig(app, exportApi);
        const outlineWorld = exportApi.boardOutlinePoints(app);
        // World Y-down → machine Y-up; with mirror on, also flip X (other-side view).
        const flip = (p) => {
            const f = exportApi.flipY(p);
            return config.mirror ? { x: -f.x, y: f.y } : f;
        };
        const transform = this.buildCoordinateTransform(outlineWorld, flip);
        const toG = (p) => transform.toG(p);

        const gOutline = outlineWorld.map(toG);
        let boardMinX = Infinity, boardMaxX = -Infinity, boardMinY = Infinity, boardMaxY = -Infinity;
        gOutline.forEach(p => {
            boardMinX = Math.min(boardMinX, p.x);
            boardMaxX = Math.max(boardMaxX, p.x);
            boardMinY = Math.min(boardMinY, p.y);
            boardMaxY = Math.max(boardMaxY, p.y);
        });

        const sections = [];
        const isoR = this.cutterRadius(config.isolationToolDiameter);
        const outlineR = this.cutterRadius(config.outlineToolDiameter);

        if (config.includeIsolation) {
            ['top', 'bottom'].forEach(layerKey => {
                if (layerKey === 'bottom' && !config.includeBottomIsolation) return;
                const items = exportApi.collectCopperOutlines(app).filter(it => it.layer === layerKey);
                if (!items.length) return;
                const paths = [];
                items.forEach(item => {
                    if (item.kind === 'circle') {
                        paths.push({
                            kind: 'circle',
                            x: toG({ x: item.x, y: item.y }).x,
                            y: toG({ x: item.x, y: item.y }).y,
                            r: item.r + isoR
                        });
                    } else {
                        paths.push({
                            kind: 'poly',
                            points: exportApi.offsetPolygon(item.pts, isoR).map(toG)
                        });
                    }
                });
                sections.push({
                    type: 'isolation',
                    layer: layerKey,
                    toolDiameter: config.isolationToolDiameter,
                    depth: config.isolationDepth,
                    feed: config.isolationFeed,
                    plungeFeed: config.plungeFeed,
                    paths
                });
            });
        }

        const drills = config.includeDrilling ? exportApi.collectDrills(app) : [];
        if (drills.length) {
            // One drill block per distinct hole diameter, so bigger test-point drills
            // (e.g. TH TP XL Ø1.2) get their own labeled pass instead of the default bit.
            const groups = new Map();
            drills.forEach(h => {
                const d = h.oval ? config.drillToolDiameter : Math.round(h.r * 200) / 100;
                if (!groups.has(d)) groups.set(d, []);
                groups.get(d).push(toG({ x: h.x, y: h.y }));
            });
            [...groups.keys()].sort((a, b) => a - b).forEach(d => {
                sections.push({
                    type: 'drill',
                    toolDiameter: d,
                    depth: this.drillDepth(config.boardThickness, config.drillOvercut),
                    feed: config.drillFeed,
                    plungeFeed: config.plungeFeed,
                    holes: groups.get(d)
                });
            });
        }

        if (config.includeBoardOutline) {
            const cutPath = exportApi.offsetPolygon(outlineWorld, outlineR).map(toG);
            const depths = this.outlinePassDepths(
                config.boardThickness, config.outlinePassCount, config.outlineOvercut
            );
            sections.push({
                type: 'outline',
                toolDiameter: config.outlineToolDiameter,
                plungeFeed: config.plungeFeed,
                feed: config.outlineFeed,
                path: cutPath,
                passes: depths.map((depth, i) => ({
                    index: i + 1,
                    depth,
                    feed: config.outlineFeed
                })),
                bounds: this.outlineToolpathBounds(
                    boardMinX, boardMaxX, boardMinY, boardMaxY, config.outlineToolDiameter
                )
            });
        }

        return {
            config,
            transform,
            boardBounds: { minX: boardMinX, maxX: boardMaxX, minY: boardMinY, maxY: boardMaxY },
            sections
        };
    },

    firstMovePoint(sections) {
        for (const sec of sections) {
            if (sec.type === 'isolation' && sec.paths && sec.paths.length) {
                const p = sec.paths[0];
                if (p.kind === 'circle') return { x: p.x, y: p.y };
                if (p.points && p.points.length) return { x: p.points[0].x, y: p.points[0].y };
            }
            if (sec.type === 'drill' && sec.holes && sec.holes.length) {
                return { x: sec.holes[0].x, y: sec.holes[0].y };
            }
            if (sec.type === 'outline' && sec.path && sec.path.length) {
                return { x: sec.path[0].x, y: sec.path[0].y };
            }
        }
        return { x: 0, y: 0 };
    },

    sectionFirstPoint(sec) {
        if (sec.type === 'isolation' && sec.paths && sec.paths.length) {
            const p = sec.paths[0];
            if (p.kind === 'circle') return { x: p.x, y: p.y };
            if (p.points && p.points.length) return { x: p.points[0].x, y: p.points[0].y };
        }
        if (sec.type === 'drill' && sec.holes && sec.holes.length) {
            return { x: sec.holes[0].x, y: sec.holes[0].y };
        }
        if (sec.type === 'outline' && sec.path && sec.path.length) {
            return { x: sec.path[0].x, y: sec.path[0].y };
        }
        return null;
    },

    generate(toolpaths, validationResult) {
        const config = toolpaths.config;
        const profile = this.getProfile(config);
        const fmt = (n) => (n * config.scale).toFixed(config.inches ? 5 : 4);
        const zSafe = config.safeZ;
        const lines = [];
        const emit = (s) => lines.push(s);

        emit('; millPCB isolation + drill + outline');
        if (config.mirror) emit('; Mirrored X - other-side (bottom) view');
        emit(`; Board: ${config.boardWidth} x ${config.boardHeight} x ${config.boardThickness} mm`);
        if (config.boardMaterial) emit(`; Material: ${config.boardMaterial}`);
        emit(`; Isolation tool: ${config.isolationToolDiameter} mm`);
        emit(`; Isolation depth: ${config.isolationDepth} mm`);
        emit(`; Drill tool: ${config.drillToolDiameter} mm`);
        emit(`; Drill depth: ${validationResult.drillZ.toFixed(3)} mm`);
        emit(`; Outline tool: ${config.outlineToolDiameter} mm`);
        emit(`; Outline passes: ${config.outlinePassCount}`);
        emit(`; Safe Z: ${zSafe} mm`);
        emit(`; Spindle: ${config.spindleRpm} RPM`);
        emit(`; Profile: ${profile.name}`);
        emit('; Origin: board south-west corner after Y-up convert (same XY as DXF; isolation/outline then offset by tool radius)');

        emit('; --- INITIALIZATION ---');
        profile.headerLines(config.units).forEach(l => emit(l));
        emit(`G0 Z${fmt(zSafe)}`);

        const dwellSec = profile.supportsDwell ? config.spindleDwell : 0;
        let spindleOn = false;
        let activeToolDiameter = null;

        const rapidTo = (pt) => {
            if (!pt) return;
            emit(`G0 X${fmt(pt.x)} Y${fmt(pt.y)}`);
        };

        const ensureSpindle = () => {
            if (spindleOn) return;
            emit(profile.spindleStartCommand(config.spindleRpm));
            if (dwellSec > 0) emit(`G4 P${dwellSec}`);
            spindleOn = true;
        };

        const stopSpindle = () => {
            if (!spindleOn) return;
            emit(profile.spindleStopCommand());
            emit(`G0 Z${fmt(zSafe)}`);
            spindleOn = false;
        };

        const beginSection = (sec, title, toolLabel) => {
            emit('');
            emit(`; --- ${title} ---`);
            emit(`; Tool: ${toolLabel}`);
            const toolChanged = activeToolDiameter != null &&
                Math.abs(activeToolDiameter - sec.toolDiameter) > 1e-6;
            if (toolChanged) {
                stopSpindle();
                emit('; CHANGE TOOL BEFORE CONTINUING');
            }
            activeToolDiameter = sec.toolDiameter;
            const pt = this.sectionFirstPoint(sec);
            if (pt) {
                rapidTo(pt);
                ensureSpindle();
            }
        };

        const millClosed = (pts, depth, feedRate, plungeRate) => {
            if (!pts || pts.length < 2) return;
            rapidTo(pts[0]);
            ensureSpindle();
            emit(`G1 Z${fmt(-depth)} F${fmt(plungeRate)}`);
            for (let i = 1; i < pts.length; i++) {
                emit(`G1 X${fmt(pts[i].x)} Y${fmt(pts[i].y)} F${fmt(feedRate)}`);
            }
            emit(`G1 X${fmt(pts[0].x)} Y${fmt(pts[0].y)} F${fmt(feedRate)}`);
            emit(`G0 Z${fmt(zSafe)}`);
        };

        const millCircle = (x, y, r, depth, feedRate, plungeRate) => {
            const n = Math.max(16, Math.ceil(2 * Math.PI * r / 0.4));
            const pts = [];
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
            }
            millClosed(pts, depth, feedRate, plungeRate);
        };

        toolpaths.sections.forEach(sec => {
            if (sec.type === 'isolation') {
                const layerName = sec.layer === 'bottom' ? 'BOTTOM' : 'TOP';
                if (sec.layer === 'bottom') {
                    emit('; --- Flip the board before running BOTTOM isolation ---');
                }
                beginSection(sec, `ISOLATION ${layerName}`, `${sec.toolDiameter} mm endmill/V-bit`);
                sec.paths.forEach(p => {
                    if (p.kind === 'circle') {
                        millCircle(p.x, p.y, p.r, sec.depth, sec.feed, sec.plungeFeed);
                    } else if (p.points && p.points.length >= 2) {
                        millClosed(p.points, sec.depth, sec.feed, sec.plungeFeed);
                    }
                });
            } else if (sec.type === 'drill') {
                beginSection(sec, 'DRILL', `${sec.toolDiameter} mm drill`);
                sec.holes.forEach(h => {
                    rapidTo(h);
                    ensureSpindle();
                    emit(`G1 Z${fmt(-sec.depth)} F${fmt(sec.plungeFeed)}`);
                    emit(`G0 Z${fmt(zSafe)}`);
                });
            } else if (sec.type === 'outline') {
                beginSection(sec, 'BOARD CUT', `${sec.toolDiameter} mm endmill`);
                sec.passes.forEach(pass => {
                    emit(`; cut pass ${pass.index}/${sec.passes.length} depth ${pass.depth.toFixed(3)} mm`);
                    millClosed(sec.path, pass.depth, pass.feed, sec.plungeFeed);
                });
            }
        });

        emit('');
        emit('; --- PROGRAM END ---');
        profile.programEndLines(fmt, zSafe).forEach(l => emit(l));
        return lines.join('\n') + '\n';
    },

    generateFromApp(app, exportApi) {
        const toolpaths = this.buildToolpaths(app, exportApi);
        const drillingEnabled = toolpaths.sections.some(s => s.type === 'drill');
        const validation = this.validateConfig(toolpaths.config, { drillingEnabled });
        if (!validation.ok) {
            return { ok: false, error: validation.error };
        }
        const gcode = this.generate(toolpaths, validation);
        return { ok: true, gcode, toolpaths, validation };
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GCode;
}
