#!/bin/sh
# millPCB MCP server control for shared hosting (run on the host, e.g. Hostido).
# Usage: sh server.sh start|stop|status|ensure
# ensure = watchdog for cron: starts the server only when it is not running.
# MCP HTTP on :8090 (/mcp?session=<id>), preview SPA on :7847 — /mcp is also
# mounted on the preview port, so behind Cloudflare (which only forwards
# 443/2053/2083/2087/2096/8443) clients can use the preview port alone.
# Reach them from your PC through an SSH tunnel:
# ssh -L 7847:localhost:7847 -L 8090:localhost:8090 user@host
DIR=$(cd "$(dirname "$0")" && pwd)
PIDFILE="$DIR/server.pid"
LOG="$DIR/server.log"
# Public exposure: put MILLPCB_BIND=0.0.0.0 + MILLPCB_TOKEN in server.env
# (chmod 600, next to this file) — the token gates /mcp, /events, /api/project.
if [ -f "$DIR/server.env" ]; then set -a; . "$DIR/server.env"; set +a; fi
export MILLPCB_TRANSPORT=http
export MILLPCB_BIND=${MILLPCB_BIND:-127.0.0.1}
export MILLPCB_MCP_PORT=${MILLPCB_MCP_PORT:-8090}
export MILLPCB_PREVIEW_PORT=${MILLPCB_PREVIEW_PORT:-7847}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "$1" in
start)
    if running; then
        echo "already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    node -e 'const v=parseInt(process.versions.node);if(v<18){console.error("Node 18+ required, found "+process.versions.node);process.exit(1)}' || exit 1
    nohup node "$DIR/server.mjs" >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    echo "started (pid $(cat "$PIDFILE")) — log: $LOG"
    ;;
stop)
    if [ -f "$PIDFILE" ]; then
        kill "$(cat "$PIDFILE")" 2>/dev/null && echo stopped
        rm -f "$PIDFILE"
    else
        echo "not running"
    fi
    ;;
ensure)
    # Watchdog target (cron): start when dead, silent when alive.
    if running; then exit 0; fi
    sh "$0" start
    ;;
status)
    if running; then
        echo "running (pid $(cat "$PIDFILE"))"
        curl -s "http://localhost:${MILLPCB_PREVIEW_PORT:-7847}/api/health" || true
        echo
    else
        echo "not running"
    fi
    ;;
*)
    echo "usage: server.sh start|stop|status|ensure"
    ;;
esac
