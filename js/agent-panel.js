// ============================================================
// agent-panel.js — "Agent" toolbar modal on the normal app page.
// Shows the user's session id and the MCP URL configured once in an
// agent, plus the agent-server connection status. The session id is
// the same one js/agent-preview.js uses (localStorage). The prompt
// only needs that id. A server token, if any, stays in the agent
// config — it is not part of the prompt.
// No-op on file:// and in preview mode (?preview=1) — there the Agent
// toolbar button is left visible but disabled, with an explanatory tooltip.
// Server URLs: localStorage['millpcb-preview-url'] (default
// https://agent.millpcb.com:2053), localStorage['millpcb-mcp-url']
// (default = preview URL with port 2053 -> 2096).
// ============================================================
(function () {
    'use strict';
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const params = new URLSearchParams(location.search);
    if (location.protocol === 'file:' || params.get('preview') === '1') {
        // A preview page already follows an agent session, so this modal has
        // nothing to show. Keep the button visible but inert (CSS
        // #toolbar button:disabled dims it) so it doesn't look broken.
        if (params.get('preview') === '1') {
            const btn = document.getElementById('btn-agent');
            if (btn) {
                btn.disabled = true;
                btn.title = 'Live view of an agent session — open millpcb.com to set up your own';
            }
        }
        return;
    }

    const overlay = document.getElementById('agent-overlay');
    if (!overlay) return;
    const $ = (id) => document.getElementById(id);

    const PREVIEW_URL = (localStorage.getItem('millpcb-preview-url') || 'https://agent.millpcb.com:2053').replace(/\/+$/, '');
    const MCP_URL = (localStorage.getItem('millpcb-mcp-url') || PREVIEW_URL.replace(/:2053/, ':2096')).replace(/\/+$/, '');

    // One secret for this browser. The server binds it to the session the tab is holding.
    function userToken() {
        let s = localStorage.getItem('millpcb-session-secret') || '';
        if (!/^[a-f0-9]{32}$/.test(s)) {
            const bytes = new Uint8Array(16);
            (self.crypto || crypto).getRandomValues(bytes);
            s = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem('millpcb-session-secret', s);
        }
        return s;
    }

    function sessionId() {
        let id = (localStorage.getItem('millpcb-session-id') || '').trim().toLowerCase();
        if (!id) {
            id = (self.crypto && crypto.randomUUID)
                ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
                : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            localStorage.setItem('millpcb-session-id', id);
        }
        return id;
    }

    const sessionInput = $('agent-session-id');
    const urlInput = $('agent-mcp-url');
    let pollTimer = null;

    function fill() {
        const id = sessionId();
        const secret = userToken();
        sessionInput.value = id;
        const tokenInput = $('agent-token');
        if (tokenInput) tokenInput.value = secret;
        urlInput.value = MCP_URL + '/mcp?token=' + encodeURIComponent(secret);
        $('agent-live-link').href = PREVIEW_URL + '/index.html?preview=1&session=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(secret);
        const prompt = $('agent-prompt');
        if (prompt) prompt.value = 'create a LED circuit using millPCB session id ' + id;
    }

    async function checkStatus() {
        const st = $('agent-status');
        try {
            const r = await fetch(PREVIEW_URL + '/api/health?session=' + encodeURIComponent(sessionId()), { signal: AbortSignal.timeout(5000) });
            const j = await r.json();
            const live = j.ok && j.active === true;
            st.textContent = !j.ok ? 'Agent server: odd response'
                : (live ? 'Agent server: online — this session is live' : 'Agent server: online — keep this tab open');
            st.className = 'agent-status ' + (j.ok ? 'on' : 'off');
        } catch (e) {
            st.textContent = 'Agent server: offline (is the server running?)';
            st.className = 'agent-status off';
        }
    }

    function open() {
        fill();
        overlay.classList.remove('hidden');
        checkStatus();
        pollTimer = setInterval(checkStatus, 8000);
    }
    function close() {
        overlay.classList.add('hidden');
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function copyField(input, btn) {
        const done = () => { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = t; }, 1200); };
        if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, () => { input.select(); document.execCommand('copy'); done(); });
        else { input.select(); document.execCommand('copy'); done(); }
    }

    $('btn-agent').addEventListener('click', open);
    $('agent-close').addEventListener('click', close);
    $('agent-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('agent-copy-session').addEventListener('click', () => copyField(sessionInput, $('agent-copy-session')));
    if ($('agent-copy-token')) $('agent-copy-token').addEventListener('click', () => copyField($('agent-token'), $('agent-copy-token')));
    $('agent-copy-prompt').addEventListener('click', () => copyField($('agent-prompt'), $('agent-copy-prompt')));
    $('agent-copy-url').addEventListener('click', () => copyField(urlInput, $('agent-copy-url')));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
})();
