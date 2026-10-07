# millPCB hosting helper. Run: .\hosting\hosting.ps1 <command>
# Commands: test | deploy | start | stop | status | logs | public | tunnel
# Connection settings: copy hosting/hosting.example.ps1 to hosting/hosting.local.ps1 (gitignored).

$Local = Join-Path $PSScriptRoot 'hosting.local.ps1'
if (-not (Test-Path $Local)) {
    Write-Error "Missing hosting/hosting.local.ps1. Copy hosting/hosting.example.ps1 and set `$User, `$Host_, and `$Port."
    exit 1
}
. $Local
if (-not $User -or -not $Host_ -or -not $Port) {
    Write-Error "hosting.local.ps1 must set `$User, `$Host_, and `$Port."
    exit 1
}
if (-not $Key) { $Key = "$env:USERPROFILE\.ssh\millpcb_hostido" }
$Remote  = '~'          # home directory on the host
$Repo    = Split-Path -Parent $PSScriptRoot

function Run-Ssh([string]$cmd) {
    ssh -i $Key -p $Port "$User@$Host_" $cmd
}

switch ($args[0]) {
    'test' {
        Run-Ssh "echo connected; node -v; npm -v"
    }
    'deploy' {
        Run-Ssh "mkdir -p $Remote/millPCB/css $Remote/millPCB/js $Remote/millPCB/libs $Remote/millPCB/img $Remote/millPCB/mcp"
        scp -i $Key -P $Port "$Repo\index.html" "$Repo\help.html" "${User}@${Host_}:$Remote/millPCB/"
        foreach ($d in 'css', 'js', 'libs', 'img') {
            scp -i $Key -P $Port -r "$Repo\$d" "${User}@${Host_}:$Remote/millPCB/"
        }
        # mcp sources without node_modules (npm install runs remotely)
        foreach ($f in 'server.mjs', 'host.mjs', 'preview-http.mjs', 'package.json', 'package-lock.json', 'README.md', 'server.sh') {
            scp -i $Key -P $Port "$Repo\mcp\$f" "${User}@${Host_}:$Remote/millPCB/mcp/"
        }
        # scp carries CRLF from the Windows working copy; server.sh must be LF for sh
        Run-Ssh "sed -i 's/\r$//' $Remote/millPCB/mcp/server.sh"
        Run-Ssh "cd $Remote/millPCB/mcp; npm install --omit=dev"
        Write-Host 'Deploy done. Start with: .\hosting\hosting.ps1 start'
    }
    'start' { Run-Ssh "sh $Remote/millPCB/mcp/server.sh start" }
    'stop'  { Run-Ssh "sh $Remote/millPCB/mcp/server.sh stop" }
    'status' { Run-Ssh "sh $Remote/millPCB/mcp/server.sh status" }
    'logs'  { Run-Ssh "tail -n 60 $Remote/millPCB/mcp/server.log" }
    'public' {
        Write-Host 'Public endpoints (token: ssh host -> cat ~/millPCB/mcp/server.env):'
        Write-Host '  preview : https://agent.millpcb.com:2053/index.html?preview=1&token=<token>'
        Write-Host '  agent   : https://agent.millpcb.com:2096/mcp?session=<id>&token=<token>'
        Write-Host 'Cloudflare proxies agent.millpcb.com (SSL mode Full).'
    }
    'tunnel' {
        Write-Host 'Tunnel active: preview http://localhost:7847/ , MCP http://localhost:8090/mcp (Ctrl+C stops)'
        ssh -i $Key -p $Port -N -L 7847:localhost:7847 -L 8090:localhost:8090 "${User}@${Host_}"
    }
    default { Write-Host 'usage: hosting.ps1 test|deploy|start|stop|status|logs|public|tunnel' }
}
