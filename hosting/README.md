# millPCB on Hostido (SSH Node)

Runs the MCP server + live preview on the hosting account; your PC reaches it
through an SSH tunnel (no public ports). Sessions are per-user: the preview
page shows a **session id**, the agent connects with `?session=<id>`.

## One-time setup

1. Copy `hosting/hosting.example.ps1` to `hosting/hosting.local.ps1` and set the SSH user, host, and port. That file is gitignored. Private key stays in `%USERPROFILE%\.ssh\millpcb_hostido` (never share it). Add the matching public key in the host panel (SSH / authorized keys).

2. Check the connection (Node 18+ required, Node 24 recommended):

   ```powershell
   .\hosting\hosting.ps1 test
   ```

## Daily use

```powershell
.\hosting\hosting.ps1 deploy   # upload app + mcp, npm install on the host
.\hosting\hosting.ps1 start    # start MCP (:8090) + preview (:7847) on the host
.\hosting\hosting.ps1 tunnel   # keep this open: forwards both ports to localhost
```

Then in a browser: `http://localhost:7847/index.html?preview=1` — the banner
shows **Session xxx** (click to copy). Point the agent's MCP client at:

```json
{ "mcpServers": { "millpcb": { "url": "http://localhost:8090/mcp?session=<id>" } } }
```

`.\hosting\hosting.ps1 stop | status | logs` control the remote server.

## CI deploy (automatic)

Push to `main` → GitHub Actions **Build & Deploy to Hosting**: tars `dist/`
into `~/domains/millpcb.com/public_html` (the live docroot — the SSH account
is on the same machine as the old FTP server), then deploys the MCP server
(copies SPA + `mcp/*` sources, `npm install --omit=dev`, `server.sh`
restart, health-checks `https://localhost:2053/api/health`). Requires the
repo secrets **`SSH_KEY_MCP`** (private key), **`SSH_HOST`**, **`SSH_PORT`**, and **`SSH_USER`**. The step skips itself when any of them is absent. `mcp/server.env`
(token, TLS, ports) lives only on the host and is never touched by CI.
The old FTP/lftp steps are gone (they cost ~2.5 min; the tar-over-SSH
publish takes seconds).

Manual path stays available: `.\hosting\hosting.ps1 deploy` + `start`.

## User flow (what a visitor does)

1. Open `https://millpcb.com` and leave the tab open.
2. Click **Agent** in the toolbar → modal shows **your session id**, a
   ready-to-paste prompt, the **Agent MCP URL** (copy once into the agent),
   server status, and a **Live view** link.
3. Put the MCP URL into the agent client (Claude Desktop config `url`,
   Copilot/Cursor MCP settings). The URL is **shared — configure it once**.
   If the host set `MILLPCB_TOKEN`, that token goes in the agent config
   (`?token=` or `Authorization: Bearer`). It is the server lock. It is
   not part of the prompt.
4. Prompt with the session id, for example **"create a LED circuit using
   millPCB session id \<your id\>"**. The agent calls `millpcb_use_session`.
   If the millpcb.com tab is closed, it replies that there is no active session.
5. The board on that tab updates as the agent works. **Live view** opens the
   same session on the agent host.

The session id is per-browser (localStorage) — same browser = same session.
Agents are scoped: an agent with your id sees/edits only your session's
project; other visitors have their own ids. One MCP URL serves all users;
switching is per-connection, and each session keeps its own autosaved board.

## Public mode (no tunnel — verified working)

`mcp/server.env` on the host (chmod 600, NOT in the repo) enables public TLS:

```
MILLPCB_BIND=0.0.0.0
MILLPCB_TOKEN=<shared token>
MILLPCB_PROJECTS_DIR=$HOME/millPCB/data/projects
MILLPCB_RESTORE=1
MILLPCB_TLS_CERT=$HOME/millPCB/mcp/ssl/cert.pem
MILLPCB_TLS_KEY=$HOME/millPCB/mcp/ssl/key.pem
MILLPCB_PREVIEW_PORT=2053
MILLPCB_MCP_PORT=2096
```

TLS: self-signed cert for `agent.millpcb.com` in `mcp/ssl/` (regenerate:
`openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout key.pem -out
cert.pem -subj "/CN=agent.millpcb.com" -addext "subjectAltName=DNS:agent.millpcb.com"`).
Cloudflare proxies `agent.millpcb.com` with edge
SSL; its encryption mode must be **Full** (not Full strict). Keep the origin address in the Cloudflare dashboard, not in this repo. Cloudflare free
plans accept client HTTPS on ports 443/2053/2083/2087/2096 and proxy to the
same origin port — that's why preview=2053, MCP=2096.

Public endpoints (token required on `/mcp` and `/api/project`; named `/events?session=<id>` is open so the site can hold the session):

- **Preview SPA:** `https://agent.millpcb.com:2053/index.html?preview=1&token=<token>` — banner shows the session id (click to copy).
- **Agent MCP URL (shared, configure once):** `https://agent.millpcb.com:2096/mcp?token=<token>` — the agent picks the user's session with `millpcb_use_session` (prompt: "use session \<id\>"). `?session=<id>` in the URL also works for a fixed per-user binding.
- **Agent chat SSE:** `https://agent.millpcb.com:2053/api/chat/events?session=<id>` — no token, chat events only. This is the URL `eventsUrl` returns. Do not use the link-local `169.254` address, and do not use `/events` for agent chat (that stream requires the browser session token and sends the whole board). Set `MILLPCB_PUBLIC_ORIGIN=https://agent.millpcb.com:2053` if the host should advertise a different name.
- **From millpcb.com (https):** on the deployed page run once
  `localStorage['millpcb-preview-url'] = 'https://agent.millpcb.com:2053'`,
  then open `https://millpcb.com/index.html?token=<token>` — same session id
  is kept in `localStorage['millpcb-session-id']`. No mixed-content problem
  (both sides https).

Direct origin access (no Cloudflare) is a private host detail. Do not write the origin address into the repo. Chrome upgrades hostnames to HTTPS, and https pages cannot watch plain-HTTP fallbacks.

## Notes

- Shared hosting kills long-running processes occasionally. Keep the server
  alive with a watchdog cron (`crontab -e`):

  ```
  @reboot      sh ~/millPCB/mcp/server.sh start
  */10 * * * * sh ~/millPCB/mcp/server.sh ensure >/dev/null 2>&1
  ```

  The server then stays up waiting for agents at any time; sessions are
  created on first use by either side (page or agent), so no restart is ever
  needed per session.
- The server binds 127.0.0.1 on the host — only the SSH tunnel can reach it.
  Set `MILLPCB_TOKEN` in `mcp/server.sh` before ever binding elsewhere.
- Each session autosaves to `millPCB/mcp/.mcp/preview/project-<id>.pcb.json`
  and is restored when the server restarts; idle sessions (>12 h, no preview
  client, no MCP transport) are swept from memory.
- The deployed millpcb.com page can also watch this server: set
  `localStorage['millpcb-preview-url'] = 'http://localhost:7847'` in the
  browser console on the page, then reload — the session id is kept in
  `localStorage['millpcb-session-id']`.
