# Purchase Bill Tally Entry - local bridge server
# Serves the web/ folder and proxies POST /api/tally requests to the
# TallyPrime HTTP-XML server (which has no CORS headers, so the browser
# cannot talk to it directly). Everything here stays on localhost.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Join-Path $root 'web'
$configPath = Join-Path $root 'config.json'

function Get-Config {
    $raw = Get-Content -Path $configPath -Raw -Encoding UTF8
    return $raw | ConvertFrom-Json
}

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
    '.wasm' = 'application/wasm'
    '.gz'   = 'application/gzip'
}

function Write-JsonResponse($context, $statusCode, $obj) {
    $json = $obj | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $context.Response.StatusCode = $statusCode
    $context.Response.ContentType = 'application/json; charset=utf-8'
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.OutputStream.Close()
}

function Write-FileResponse($context, $filePath) {
    $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
    $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $context.Response.StatusCode = 200
    $context.Response.ContentType = $contentType
    # This app is under active development - never let the browser cache
    # index.html/app.js/extract.js/tally.js, otherwise a hard refresh can
    # still silently run stale code.
    $context.Response.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
    $context.Response.Headers.Add('Pragma', 'no-cache')
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.OutputStream.Close()
}

$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

function Handle-TallyProxy($context) {
    $cfg = Get-Config
    $reader = New-Object System.IO.StreamReader($context.Request.InputStream, [System.Text.Encoding]::UTF8)
    $xmlBody = $reader.ReadToEnd()
    $reader.Close()

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $logFile = Join-Path $logDir "$stamp.log"
    $isImport = $xmlBody -match '<TALLYREQUEST>\s*Import'

    try {
        $resp = Invoke-WebRequest -Uri $cfg.tallyUrl -Method Post -Body $xmlBody -ContentType 'text/xml' -TimeoutSec 60 -UseBasicParsing
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($resp.Content)
        $context.Response.StatusCode = 200
        $context.Response.ContentType = 'text/xml; charset=utf-8'
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.OutputStream.Close()
        Write-Host "[tally-proxy] OK  ($($bytes.Length) bytes)" -ForegroundColor Green
        # Every Import (voucher-send) request/response is logged in full so a
        # rejected or misparsed send can be diagnosed from the real Tally
        # reply instead of guessing. Plain Export/lookup traffic is not
        # logged to avoid filling the disk with routine reads.
        if ($isImport) {
            "=== REQUEST ===`n$xmlBody`n`n=== RESPONSE ===`n$($resp.Content)" | Out-File -FilePath $logFile -Encoding utf8
            Write-Host "[tally-proxy] Import logged to logs\$stamp.log" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "[tally-proxy] ERROR: $($_.Exception.Message)" -ForegroundColor Red
        if ($isImport) {
            "=== REQUEST ===`n$xmlBody`n`n=== ERROR ===`n$($_.Exception.Message)" | Out-File -FilePath $logFile -Encoding utf8
        }
        Write-JsonResponse $context 502 @{ error = $_.Exception.Message }
    }
}

function Handle-Config($context) {
    $cfg = Get-Config
    Write-JsonResponse $context 200 $cfg
}

$extractionLogDir = Join-Path $logDir 'extractions'
if (-not (Test-Path $extractionLogDir)) { New-Item -ItemType Directory -Path $extractionLogDir | Out-Null }

# The browser posts each bill's raw pdf.js text here right after
# extraction, purely so it can be read back from disk afterward instead of
# needing a manual copy/paste out of the "Show raw extracted text" panel
# every time a new supplier layout needs diagnosing.
function Handle-ExtractionLog($context) {
    $reader = New-Object System.IO.StreamReader($context.Request.InputStream, [System.Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    $reader.Close()

    try {
        $data = $body | ConvertFrom-Json
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $safeName = ($data.fileName -replace '[\\/:*?"<>|]', '_')
        $logFile = Join-Path $extractionLogDir "$stamp`_$safeName.txt"
        $diagJson = if ($data.diag) { $data.diag | ConvertTo-Json -Compress } else { '(none)' }
        "=== FILE: $($data.fileName) ===`n=== SUPPLIER GSTIN: $($data.supplierGSTIN) ===`n=== TEMPLATE: $($data.template) ===`n=== DIAG: $diagJson ===`n`n$($data.rawText)" | Out-File -FilePath $logFile -Encoding utf8
        Write-Host "[extraction-log] Saved logs\extractions\$stamp`_$safeName.txt" -ForegroundColor Yellow
        Write-JsonResponse $context 200 @{ ok = $true }
    }
    catch {
        Write-Host "[extraction-log] ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-JsonResponse $context 400 @{ error = $_.Exception.Message }
    }
}

$cfg = Get-Config
$port = $cfg.bridgePort
$prefix = "http://localhost:$port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
}
catch {
    Write-Host "Could not start listener on $prefix" -ForegroundColor Red
    Write-Host "Another process may already be using port $port. Error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Purchase Bill Tally Entry - bridge server running" -ForegroundColor Cyan
Write-Host " Open:      http://localhost:$port/" -ForegroundColor Cyan
Write-Host " Tally URL: $($cfg.tallyUrl)" -ForegroundColor Cyan
Write-Host " Company:   $($cfg.companyName)" -ForegroundColor Cyan
Write-Host " Env:       $($cfg.environment)" -ForegroundColor $(if ($cfg.environment -eq 'SERVER') { 'Red' } else { 'Yellow' })
Write-Host " Press Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    }
    catch {
        break
    }

    $urlPath = $context.Request.Url.AbsolutePath

    try {
        if ($context.Request.HttpMethod -eq 'POST' -and $urlPath -eq '/api/tally') {
            Handle-TallyProxy $context
        }
        elseif ($context.Request.HttpMethod -eq 'GET' -and $urlPath -eq '/api/config') {
            Handle-Config $context
        }
        elseif ($context.Request.HttpMethod -eq 'POST' -and $urlPath -eq '/api/extraction-log') {
            Handle-ExtractionLog $context
        }
        else {
            $relPath = $urlPath.TrimStart('/')
            if ([string]::IsNullOrWhiteSpace($relPath)) { $relPath = 'index.html' }
            $filePath = Join-Path $webRoot $relPath

            $fullWebRoot = (Resolve-Path $webRoot).Path
            $resolvedFile = [System.IO.Path]::GetFullPath($filePath)

            if (-not $resolvedFile.StartsWith($fullWebRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                $context.Response.StatusCode = 403
                $context.Response.OutputStream.Close()
            }
            elseif (Test-Path $resolvedFile -PathType Leaf) {
                Write-FileResponse $context $resolvedFile
            }
            else {
                $context.Response.StatusCode = 404
                $context.Response.OutputStream.Close()
            }
        }
    }
    catch {
        Write-Host "[bridge] Unhandled error: $($_.Exception.Message)" -ForegroundColor Red
        try {
            $context.Response.StatusCode = 500
            $context.Response.OutputStream.Close()
        }
        catch {}
    }
}

$listener.Stop()
$listener.Close()
