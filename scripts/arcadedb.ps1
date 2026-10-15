param([ValidateSet('start', 'status', 'stop')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$arcadeRepo = Split-Path -Parent $PSScriptRoot
$arcadeRoot = Join-Path $arcadeRepo 'artifacts/arcadedb'
$arcadeRuntime = Join-Path $arcadeRoot 'runtime'
$arcadeExecutable = Join-Path $arcadeRuntime 'arcadedb-26.9.1-windows-x86_64.exe'
$arcadePasswordFile = Join-Path $arcadeRoot 'password.txt'
$arcadePidFile = Join-Path $arcadeRoot 'server.pid'
$arcadeBase = 'http://127.0.0.1:12481'

function Get-ArcadeProcess {
    if (-not (Test-Path -LiteralPath $arcadePidFile)) { return $null }
    $arcadeStoredId = 0
    if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $arcadePidFile).Trim(), [ref]$arcadeStoredId)) {
        throw 'ARCADEDB_PID_INVALID'
    }
    $arcadeFound = Get-Process -Id $arcadeStoredId -ErrorAction SilentlyContinue
    if ($arcadeFound -and $arcadeFound.Path -ne $arcadeExecutable) { throw 'ARCADEDB_PID_IDENTITY_MISMATCH' }
    return $arcadeFound
}

function Test-ArcadeReady {
    try {
        $arcadeResponse = Invoke-WebRequest -UseBasicParsing -Uri "$arcadeBase/api/v1/ready" -TimeoutSec 3
        if ($arcadeResponse.StatusCode -notin @(200,204)) { return $false }
        $arcadeSocket = New-Object Net.Sockets.TcpClient
        try {
            return $arcadeSocket.ConnectAsync('127.0.0.1',17688).Wait(1000) -and $arcadeSocket.Connected
        } finally { $arcadeSocket.Dispose() }
    } catch { return $false }
}

$arcadeRunning = Get-ArcadeProcess
if ($Action -eq 'status') {
    [pscustomobject]@{ backend='arcadedb'; version='26.9.1'; state=$(if ($arcadeRunning -and (Test-ArcadeReady)) {'READY'} elseif ($arcadeRunning) {'STARTING'} else {'STOPPED'}) } | ConvertTo-Json -Compress
    exit 0
}
if ($Action -eq 'stop') {
    if ($arcadeRunning) {
        $arcadePassword = (Get-Content -Raw -LiteralPath $arcadePasswordFile).Trim()
        $arcadeAuth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('root:' + $arcadePassword))
        try {
            Invoke-RestMethod -Method Post -Uri "$arcadeBase/api/v1/server" -Headers @{Authorization="Basic $arcadeAuth"} -ContentType 'application/json' -Body '{"command":"shutdown"}' -TimeoutSec 10 | Out-Null
        } catch {
            if (Get-ArcadeProcess) { throw 'ARCADEDB_GRACEFUL_SHUTDOWN_FAILED' }
        }
        for ($arcadeAttempt=0; $arcadeAttempt -lt 30 -and (Get-ArcadeProcess); $arcadeAttempt++) { Start-Sleep -Milliseconds 500 }
        if (Get-ArcadeProcess) { throw 'ARCADEDB_SHUTDOWN_TIMEOUT' }
    }
    [pscustomobject]@{backend='arcadedb';state='STOPPED'} | ConvertTo-Json -Compress
    exit 0
}
if ($arcadeRunning) {
    if (-not (Test-ArcadeReady)) { throw 'ARCADEDB_PROCESS_NOT_READY' }
    [pscustomobject]@{backend='arcadedb';state='READY';reused=$true} | ConvertTo-Json -Compress
    exit 0
}
if (-not (Test-Path -LiteralPath $arcadeExecutable)) { throw 'ARCADEDB_RUNTIME_MISSING' }
if (-not (Test-Path -LiteralPath $arcadePasswordFile)) { throw 'ARCADEDB_PASSWORD_FILE_MISSING' }
$arcadeManifest = Get-Content -Raw -LiteralPath (Join-Path $arcadeRoot 'runtime-manifest.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $arcadeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $arcadeManifest.executableSha256) {
    throw 'ARCADEDB_EXECUTABLE_HASH_MISMATCH'
}
foreach ($arcadePort in @(12481,17688)) {
    if (netstat -ano -p tcp | Select-String (':' + $arcadePort + '\s+.*LISTENING')) { throw "ARCADEDB_PORT_OCCUPIED:$arcadePort" }
}
$arcadeArguments = @(
    '-Xms512m','-Xmx4g',
    '-Darcadedb.server.rootPasswordPath=../password.txt',
    '-Darcadedb.server.httpIncomingHost=127.0.0.1',
    '-Darcadedb.server.httpIncomingPort=12481',
    '-Darcadedb.server.plugins=Bolt:com.arcadedb.bolt.BoltProtocolPlugin',
    '-Darcadedb.bolt.host=127.0.0.1',
    '-Darcadedb.bolt.port=17688',
    '-Darcadedb.server.mode=production'
)
$arcadeStarted = Start-Process -FilePath $arcadeExecutable -ArgumentList $arcadeArguments -WorkingDirectory $arcadeRuntime -WindowStyle Hidden -RedirectStandardOutput (Join-Path $arcadeRoot 'server.stdout.log') -RedirectStandardError (Join-Path $arcadeRoot 'server.stderr.log') -PassThru
$arcadeStarted.Id | Set-Content -LiteralPath $arcadePidFile
for ($arcadeAttempt=0; $arcadeAttempt -lt 40; $arcadeAttempt++) {
    if (Test-ArcadeReady) {
        [pscustomobject]@{backend='arcadedb';version='26.9.1';state='READY';reused=$false} | ConvertTo-Json -Compress
        exit 0
    }
    if ($arcadeStarted.HasExited) { throw 'ARCADEDB_START_FAILED' }
    Start-Sleep -Milliseconds 500
}
throw 'ARCADEDB_START_TIMEOUT'
