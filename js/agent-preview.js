// ============================================================
// agent-preview.js — live preview client for the MCP server
// ------------------------------------------------------------
// When this page is opened in "preview mode" (URL param ?preview=1
// or a stored SSE URL), it connects to the millPCB MCP preview
// HTTP server via Server-Sent Events and applies project updates
// pushed by coding agents in real time.
//
// On file:// this script is a no-op. On millpcb.com it holds an SSE
// connection so the Agent session id is live for an MCP client.
// ?preview=1 (the agent host) does the same and shows the banner.
// ============================================================

(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // --- Resolve the SSE endpoint ---
    // Preview pages and millpcb.com hold the session open. Anywhere else
    // (localhost, file://) stays quiet unless a preview URL was stored.
    const AGENT_ORIGIN = 'https://agent.millpcb.com:2053';
    let sseUrl = null;
    let sessionId = null;
    let token = null;
    let quiet = false;
    try {
        const params = new URLSearchParams(location.search);
        const host = location.hostname;
        const onPublicSite = host === 'millpcb.com' || host === 'www.millpcb.com' || host === 'agent.millpcb.com';
        if (params.get('preview') === '1') {
            sseUrl = location.origin + '/events';
        } else {
            const stored = localStorage.getItem('millpcb-preview-url');
            if (stored) sseUrl = stored.replace(/\/+$/, '') + '/events';
            else if (onPublicSite) sseUrl = (host === 'agent.millpcb.com' ? location.origin : AGENT_ORIGIN) + '/events';
            quiet = true;
        }
        // Session id: ?session= wins, else the stable id in localStorage.
        // The user pastes this id into the agent prompt. The open SSE is
        // what makes the session "active".
        sessionId = (params.get('session') || localStorage.getItem('millpcb-session-id') || '').trim().toLowerCase();
        if (!sessionId) {
            sessionId = (self.crypto && crypto.randomUUID)
                ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
                : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            try { localStorage.setItem('millpcb-session-id', sessionId); } catch (e) { /* private mode */ }
        }
        if (sseUrl) sseUrl += (sseUrl.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(sessionId);
        // Same per-browser secret the Agent dialog shows. The open tab presents
        // it so the server can bind this session to this user.
        token = params.get('token') || '';
        if (!/^[a-f0-9]{32}$/.test(token)) {
            token = localStorage.getItem('millpcb-session-secret') || '';
            if (!/^[a-f0-9]{32}$/.test(token)) {
                const bytes = new Uint8Array(16);
                (self.crypto || crypto).getRandomValues(bytes);
                token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
                try { localStorage.setItem('millpcb-session-secret', token); } catch (e) { /* private mode */ }
            }
        }
        if (sseUrl) sseUrl += '&token=' + encodeURIComponent(token);
    } catch (e) { /* file:// etc. — stay a no-op */ }
    if (!sseUrl) return;

    let lastAppliedRev = -1;
    let flashTimer = null;

    // --- Banner (top of page) -------------------------------------
    const banner = document.createElement('div');
    banner.className = 'agent-preview-banner';
    const dot = document.createElement('span');
    dot.className = 'agent-preview-dot';
    const text = document.createElement('span');
    text.className = 'agent-preview-text';
    banner.appendChild(dot);
    banner.appendChild(text);

    // Session chip: the id the user pastes into the agent's MCP URL.
    const chip = document.createElement('button');
    chip.className = 'agent-preview-session';
    chip.type = 'button';
    chip.title = 'Copy session id — paste it in the agent prompt';
    chip.textContent = 'Session ' + sessionId;
    chip.addEventListener('click', () => {
        const done = () => { chip.textContent = 'Copied!'; setTimeout(() => { chip.textContent = 'Session ' + sessionId; }, 1200); };
        if (navigator.clipboard) navigator.clipboard.writeText(sessionId).then(done, () => window.prompt('Session id', sessionId));
        else window.prompt('Session id', sessionId);
    });
    banner.appendChild(chip);
    // Sit at the top of the board grid, not over the toolbar buttons.
    const bannerHost = document.getElementById('canvas-container') || document.body;
    // The public site holds the session quietly. The banner appears when an
    // agent actually pushes a board. Preview pages show it immediately.
    let bannerShown = false;
    function showBanner() {
        if (bannerShown) return;
        bannerHost.appendChild(banner);
        bannerShown = true;
    }
    if (!quiet) showBanner();

    function setBanner(state, msg) {
        showBanner();
        banner.className = 'agent-preview-banner ' + state;
        dot.textContent = '';
        text.textContent = (state === 'connected' ? 'Agent preview · connected' :
            state === 'reconnecting' ? 'Agent preview · reconnecting…' :
            'Agent preview') + (msg ? ' — ' + msg : '');
    }

    // --- Collaboration panel (agent roster + shared chat + edit lock) -------
    // Appears when one or more agents join the session. When 2+ agents are
    // present the server auto-locks the human preview (read-only); the Unlock
    // button POSTs /api/lock to release it. Sets App.editLocked so the SPA
    // refuses local edits while locked.
    const collab = { locked: false, agents: [], list: [], chat: [], shown: false, follow: null, mutationOwner: null };
    const panel = document.createElement('div');
    panel.className = 'agent-collab';
    panel.hidden = true;
    const cHead = document.createElement('div'); cHead.className = 'agent-collab-head';
    const cTitle = document.createElement('span'); cTitle.className = 'agent-collab-title'; cTitle.textContent = 'Agents';
    const cRoster = document.createElement('span'); cRoster.className = 'agent-collab-roster';
    const lockChip = document.createElement('span'); lockChip.className = 'agent-collab-lock';
    const unlockBtn = document.createElement('button'); unlockBtn.type = 'button'; unlockBtn.className = 'agent-collab-unlock'; unlockBtn.textContent = 'Unlock editing';
    const forceBtn = document.createElement('button'); forceBtn.type = 'button'; forceBtn.className = 'agent-collab-force'; forceBtn.textContent = 'Release agent lock'; forceBtn.title = 'Force-release the mutation lock an agent is holding on the board'; forceBtn.hidden = true;
    cHead.appendChild(cTitle); cHead.appendChild(cRoster); cHead.appendChild(lockChip); cHead.appendChild(unlockBtn); cHead.appendChild(forceBtn);
    // "Who is doing what" row: per-agent role chips + a Follow selector.
    const cRoles = document.createElement('div'); cRoles.className = 'agent-collab-roles';
    const followLabel = document.createElement('span'); followLabel.className = 'agent-collab-follow-label'; followLabel.textContent = 'Follow';
    const followSel = document.createElement('select'); followSel.className = 'agent-collab-follow';
    followSel.title = 'Follow an agent — the page switches to the sheet that agent is working on';
    cRoles.appendChild(followLabel); cRoles.appendChild(followSel);
    const cLog = document.createElement('div'); cLog.className = 'agent-collab-log';
    panel.appendChild(cHead); panel.appendChild(cRoles); panel.appendChild(cLog);
    (document.getElementById('canvas-container') || document.body).appendChild(panel);
    // Drag the chat window anywhere on screen by its header row.
    if (typeof App !== 'undefined' && typeof App.makeDraggable === 'function') App.makeDraggable(panel, cHead, 'collab');

    function showCollab() {
        if (collab.shown) return;
        panel.hidden = false;
        collab.shown = true;
    }
    function renderRoster() {
        cRoster.textContent = collab.agents.length ? collab.agents.join(' · ') : 'none';
        lockChip.textContent = collab.mutationOwner ? `🔒 ${collab.mutationOwner} holds the board` : (collab.locked ? '🔒 locked' : '🔓 open');
        lockChip.className = 'agent-collab-lock ' + ((collab.locked || collab.mutationOwner) ? 'on' : 'off');
        unlockBtn.hidden = !collab.locked;
        forceBtn.hidden = !collab.mutationOwner;
        // Role chips: "Name — role (sheet)" in the agent color.
        cRoles.querySelectorAll('.agent-collab-role').forEach(el => el.remove());
        collab.list.forEach(a => {
            const chip = document.createElement('span');
            chip.className = 'agent-collab-role';
            chip.style.color = a.color || '#c8d0da';
            chip.textContent = a.name + (a.model ? ' · ' + a.model : '') + (a.role ? ' · ' + a.role : '') + (a.view ? ' [' + a.view + ']' : '');
            cRoles.appendChild(chip);
        });
        // Keep the Follow selector in sync with the current roster.
        const prev = collab.follow;
        followSel.innerHTML = '';
        const optNone = document.createElement('option'); optNone.value = ''; optNone.textContent = 'no one'; followSel.appendChild(optNone);
        collab.list.forEach(a => { const o = document.createElement('option'); o.value = a.id; o.textContent = a.name; followSel.appendChild(o); });
        collab.follow = (prev && collab.list.some(a => a.id === prev)) ? prev : '';
        followSel.value = collab.follow;
    }
    function applyFollowView() {
        if (!collab.follow) return;
        const a = collab.list.find(x => x.id === collab.follow);
        if (a && (a.view === 'board' || a.view === 'schematic') && typeof App !== 'undefined') {
            if (typeof App.setView === 'function') App.setView(a.view);
            if (a.view === 'schematic' && typeof App.fitSchematic === 'function') App.fitSchematic();
            else if (a.view === 'board' && typeof App.fitToView === 'function') App.fitToView();
        }
    }
    followSel.addEventListener('change', () => { collab.follow = followSel.value; applyFollowView(); });
    function setEditLock(locked) {
        collab.locked = !!locked;
        if (typeof App !== 'undefined') App.editLocked = collab.locked;
        renderRoster();
    }
    function addChat(from, text) {
        const row = document.createElement('div'); row.className = 'agent-collab-msg';
        const who = document.createElement('b'); who.textContent = from + ': ';
        const body = document.createElement('span'); body.textContent = text;
        row.appendChild(who); row.appendChild(body);
        cLog.appendChild(row);
        cLog.scrollTop = cLog.scrollHeight;
        while (cLog.children.length > 200) cLog.removeChild(cLog.firstChild);
    }
    function postLock(payload) {
        const lockUrl = sseUrl.replace(/\/events(\?.*)?$/, '/api/lock$1');
        return fetch(lockUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': token || '' }, body: JSON.stringify(payload) })
            .then(r => r.json()).then(j => {
                if (!j || !j.ok) return;
                if (typeof j.locked === 'boolean') collab.locked = j.locked;
                if ('mutationOwner' in j) collab.mutationOwner = j.mutationOwner || null;
                if (typeof App !== 'undefined') App.editLocked = collab.locked;
                renderRoster();
            })
            .catch(() => { /* server not reachable */ });
    }
    unlockBtn.addEventListener('click', () => postLock({ locked: false }));
    forceBtn.addEventListener('click', () => postLock({ locked: false, releaseMutation: true }));


    // --- Apply a full project snapshot -----------------------------
    function applyProject(p, opts) {
        if (!p || typeof App === 'undefined' || !App.board || typeof App.render !== 'function') return;
        const boardChanged = p.board && (p.board.width !== App.board.width || p.board.height !== App.board.height);

        App.board = p.board || App.board;
        App.params = Object.assign({}, App.params, p.params || {});
        if (p.export) App.export = Object.assign({}, App.export, p.export);
        if (p.nets && p.nets.length) App.nets = p.nets;
        App.traces = p.traces || [];
        App.components = p.components || [];
        App.vias = p.vias || [];
        App.boardOutline = p.boardOutline || null;
        App.silkTexts = p.silkTexts || [];
        App.netlist = p.netlist || {};
        App.groups = p.groups || [];
        if (p.idCounter) App.idCounter = p.idCounter;

        // Drop stale selection that may reference removed objects.
        const ids = new Set([].concat(App.traces, App.components, App.vias, App.silkTexts).map(o => o.id));
        if (App.interaction.selectedObject && !ids.has(App.interaction.selectedObject.id)) {
            App.interaction.selectedObject = null;
        }

        if (typeof App.ensureSchemPositions === 'function') App.ensureSchemPositions();
        if (typeof App.ensureLabels === 'function') App.ensureLabels();
        if (typeof App.ensureAllCompSilkLayouts === 'function') App.ensureAllCompSilkLayouts();

        // Fit the view only on first paint or when the board resized —
        // never on every update (the user keeps their own pan/zoom).
        if ((opts && opts.fit) || boardChanged) {
            try { App.fitToView(); } catch (e) { /* not ready yet */ }
        }
        App.render();
    }

    function flash(ids, message) {
        if (!ids || !ids.length || typeof App === 'undefined' || !App.interaction) return;
        App.interaction.previewFlashIds = ids.slice(0, 50);
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            App.interaction.previewFlashIds = null;
            App.render();
        }, 1800);
        if (message) setBanner('connected', message);
    }

    // Server snapshots use `revision`. Older frames used `rev`.
    function eventRevision(data) {
        if (!data) return null;
        if (typeof data.revision === 'number') return data.revision;
        if (typeof data.rev === 'number') return data.rev;
        return null;
    }

    // Footprints travel beside the project (SSE) and inside it (saved files, /api/project).
    function importedFrom(data) {
        if (!data) return null;
        if (data.importedDefs && data.importedDefs.length) return data.importedDefs;
        if (data.project && data.project.importedDefs && data.project.importedDefs.length) return data.project.importedDefs;
        return null;
    }

    // SSE sends { revision, project, importedDefs }. /api/project sends the project
    // fields flat, with importedDefs next to components (no ok/project wrapper).
    function projectFrom(data) {
        if (!data) return null;
        if (data.project && data.project.board) return data.project;
        if (data.board && Array.isArray(data.components)) return data;
        return null;
    }

    function restoreImported(defs) {
        if (defs && defs.length && typeof KicadImport !== 'undefined') KicadImport.restoreDefs(defs);
    }

    let pending = null;
    let pendingTimer = null;
    let pendingTries = 0;

    function applyIncoming(data, opts) {
        const rev = eventRevision(data);
        if (rev != null && rev < lastAppliedRev) return;
        if (typeof App === 'undefined' || !App.board || typeof App.render !== 'function') {
            pending = { data, opts };
            if (!pendingTimer) {
                pendingTries = 0;
                pendingTimer = setInterval(() => {
                    pendingTries++;
                    const ready = typeof App !== 'undefined' && App.board && typeof App.render === 'function';
                    if (!ready && pendingTries < 200) return;
                    clearInterval(pendingTimer);
                    pendingTimer = null;
                    const job = pending;
                    pending = null;
                    if (ready && job) applyIncoming(job.data, job.opts);
                }, 50);
            }
            return;
        }
        restoreImported(importedFrom(data));
        const project = projectFrom(data);
        if (rev != null) lastAppliedRev = rev;
        if (project) applyProject(project, opts || { fit: false });
        if (rev != null) setBanner('connected', 'rev ' + rev);
    }

    // --- SSE event handling ----------------------------------------
    function handleEvent(name, data) {
        // Any frame may carry the agent that holds the board mutation lock.
        if (data && 'mutationOwner' in data) collab.mutationOwner = data.mutationOwner || null;
        switch (name) {
            case 'hello':
                // Do not mark this revision applied — the snapshot that follows
                // (or the /api/project refetch) is what actually paints the board.
                // The public site skips the refetch: /api/project stays token-locked,
                // and the SSE project frame is what paints later edits.
                if (Array.isArray(data.agents)) { collab.agents = data.agents; if (collab.agents.length) showCollab(); renderRoster(); }
                if (typeof data.locked === 'boolean') setEditLock(data.locked);
                if (!quiet) fetchProject();
                break;
            case 'project':
                applyIncoming(data, { fit: false });
                break;
            case 'library':
                // Agent imported footprints: register in the browser ComponentDefs
                // so bodies/pads/symbols draw, and add the palette row.
                if (data.defs && typeof KicadImport !== 'undefined') {
                    KicadImport.registerEntries(data.defs);
                    if (typeof App !== 'undefined' && typeof App.render === 'function') App.render();
                }
                break;
            case 'focus':
                flash(data.ids, data.message);
                break;
            case 'view':
                // Agent switched the view — flip the page and frame that sheet
                // so the user actually sees the schematic or the board.
                if (data.view === 'board' || data.view === 'schematic') {
                    if (typeof App !== 'undefined' && typeof App.setView === 'function') App.setView(data.view);
                    if (data.view === 'schematic' && typeof App.fitSchematic === 'function') App.fitSchematic();
                    else if (data.view === 'board' && typeof App.fitToView === 'function') App.fitToView();
                }
                break;
            case 'drc':
                if (typeof App !== 'undefined' && typeof App.renderDrcPanel === 'function') {
                    App.renderDrcPanel(data.violations || []);
                }
                break;
            case 'agents':
                collab.agents = data.agents || [];
                if (collab.agents.length) showCollab();
                renderRoster();
                break;
            case 'lock':
                setEditLock(data.locked);
                break;
            case 'chat':
                showCollab();
                addChat(data.from || 'Agent', data.text || '');
                break;
            case 'agents_state':
                // Per-agent board presence + roles: cursors, selection, who does what.
                collab.list = data.agents || [];
                if (collab.list.length) showCollab();
                renderRoster();
                applyFollowView();
                if (typeof App !== 'undefined') {
                    App.agentOverlay = collab.list.map(a => ({
                        name: a.name, color: a.color || '#ffffff',
                        cursor: a.cursor || null, selection: a.selection || []
                    }));
                    if (typeof App.render === 'function') App.render();
                }
                break;
            case 'chat_log':
                if (data.messages && data.messages.length) {
                    showCollab();
                    cLog.innerHTML = '';
                    data.messages.forEach(m => addChat(m.from || 'Agent', m.text || ''));
                }
                break;
        }
    }

    function fetchProject() {
        fetch(sseUrl.replace(/\/events(\?.*)?$/, '/api/project$1'))
            .then(r => r.json())
            .then(j => { applyIncoming(j, { fit: true }); })
            .catch(() => { /* server not ready yet */ });
    }

    function connect() {
        const es = new EventSource(sseUrl);
        if (!quiet) {
            es.onopen = () => setBanner('connected', 'Following agent — local edits will be overwritten');
            es.onerror = () => setBanner('reconnecting', null);
        }
        ['hello', 'project', 'focus', 'drc', 'library', 'view', 'agents', 'lock', 'chat', 'chat_log', 'agents_state'].forEach(name => {
            es.addEventListener(name, e => {
                if (!quiet) setBanner('connected', 'Following agent — local edits will be overwritten');
                else if (name === 'project' || name === 'focus' || name === 'view') setBanner('connected', 'Agent is drawing on this page');
                try { handleEvent(name, JSON.parse(e.data)); } catch (err) { /* ignore bad frame */ }
            });
        });
    }

    connect();
})();