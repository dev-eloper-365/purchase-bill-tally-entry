# Purchase Bill Tally Entry - local bridge server
# Serves the web/ folder and proxies POST /api/tally requests to the
# TallyPrime HTTP-XML server (which has no CORS headers, so the browser
# cannot talk to it directly). Everything here stays on localhost.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Join-Path $root 'web'
$configPath = Join-Path $root 'config.json'
$envPath = Join-Path $root '.env'

# .env holds local-only values that must never be committed (Groq API key,
# a Tally port override) - config.json stays trackable in git as-is.
function Get-DotEnv {
    $result = @{}
    if (-not (Test-Path $envPath)) { return $result }
    foreach ($line in Get-Content -Path $envPath -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -lt 1) { continue }
        $key = $trimmed.Substring(0, $idx).Trim()
        $value = $trimmed.Substring($idx + 1).Trim()
        $result[$key] = $value
    }
    return $result
}

function Get-Config {
    $raw = Get-Content -Path $configPath -Raw -Encoding UTF8
    $cfg = $raw | ConvertFrom-Json
    $dotenv = Get-DotEnv
    if ($dotenv.ContainsKey('TALLY_PORT') -and $dotenv.TALLY_PORT) {
        $cfg.tallyUrl = "http://localhost:$($dotenv.TALLY_PORT)"
    }
    return $cfg
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

$aiTemplateLogDir = Join-Path $logDir 'ai-templates'
if (-not (Test-Path $aiTemplateLogDir)) { New-Item -ItemType Directory -Path $aiTemplateLogDir | Out-Null }

# Called automatically by extract.js whenever a bill's supplier GSTIN
# doesn't match any known template. Sends the already-extracted PDF text to
# Groq server-side (the key never reaches the browser) and asks for a
# best-guess field extraction plus a candidate regex per field. The result
# is used to pre-fill the current row and is logged as a draft for manual
# review - it is never auto-wired into extract.js's trusted templates.
function Handle-AiProfile($context) {
    $dotenv = Get-DotEnv
    $apiKey = $dotenv.GROQ_API_KEY
    $apiUrl = if ($dotenv.GROQ_API_URL) { $dotenv.GROQ_API_URL } else { 'https://api.groq.com/openai/v1/chat/completions' }
    $model = if ($dotenv.GROQ_MODEL) { $dotenv.GROQ_MODEL } else { 'openai/gpt-oss-120b' }

    if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey -eq 'gsk_your_key_here') {
        Write-JsonResponse $context 503 @{ error = 'GROQ_API_KEY not configured in .env' }
        return
    }

    $reader = New-Object System.IO.StreamReader($context.Request.InputStream, [System.Text.Encoding]::UTF8)
    $body = $reader.ReadToEnd()
    $reader.Close()

    try {
        $data = $body | ConvertFrom-Json
        $billText = $data.text
        if ([string]::IsNullOrWhiteSpace($billText)) {
            Write-JsonResponse $context 400 @{ error = 'No text provided' }
            return
        }

        $systemPrompt = @'
You extract fields from an Indian purchase invoice's raw PDF text (text item order may not match visual layout). Reply with ONLY a JSON object, no markdown, no commentary, matching exactly this shape:
{
  "fields": {
    "invoiceNo": string|null,
    "invoiceDateRaw": string|null,
    "supplierInvoiceNo": string|null,
    "supplierName": string|null,
    "supplierGSTIN": string|null,
    "vehicleNo": string|null,
    "qty": number|null,
    "rate": number|null
  },
  "regex": {
    "invoiceNo": string|null,
    "invoiceDateRaw": string|null,
    "vehicleNo": string|null,
    "qty": string|null,
    "rate": string|null
  }
}
"regex" holds a JavaScript-compatible regex source string (no slashes) that would capture each field from text with this same layout in future bills, using one capture group. Use null where a field can't be found or a reliable pattern can't be inferred.
Vehicle numbers look like two letters, two digits, two-to-four letters, four digits (e.g. GJ12BT1208). Some invoices split one order across multiple trucks and print more than one vehicle number (often each paired with its own partial quantity next to the main line item) - if you find more than one, put all of them in "vehicleNo" joined by " / " (e.g. "GJ12BT1208 / GJ12BZ5543") rather than picking just one or leaving it null.
The buyer on every one of these invoices is us: "DELTA GLOBAL" (various suffixes - PRIVATE LIMITED, PVT LTD, RESOURCES PVT LTD), GSTIN 24AAECD5633K1ZN. Never put our own name or GSTIN in "supplierName"/"supplierGSTIN" even if it appears more prominently in the text (e.g. near the top, or under a "Bill To" heading before the actual seller's details appear further down) - the supplier is always the OTHER party, the one actually selling the goods.
'@

        $reqBody = @{
            model    = $model
            messages = @(
                @{ role = 'system'; content = $systemPrompt }
                @{ role = 'user'; content = $billText }
            )
            temperature     = 0
            response_format = @{ type = 'json_object' }
        } | ConvertTo-Json -Depth 10

        $resp = Invoke-WebRequest -Uri $apiUrl `
            -Method Post -Body $reqBody -ContentType 'application/json' -TimeoutSec 30 -UseBasicParsing `
            -Headers @{ Authorization = "Bearer $apiKey" }

        $respObj = $resp.Content | ConvertFrom-Json
        $content = $respObj.choices[0].message.content
        $parsed = $content | ConvertFrom-Json

        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $safeName = ($data.fileName -replace '[\\/:*?"<>|]', '_')
        $logFile = Join-Path $aiTemplateLogDir "$stamp`_$safeName.json"
        @{ fileName = $data.fileName; sourceText = $billText; result = $parsed } | ConvertTo-Json -Depth 10 | Out-File -FilePath $logFile -Encoding utf8
        Write-Host "[ai-profile] Drafted template, logged to logs\ai-templates\$stamp`_$safeName.json" -ForegroundColor Yellow

        # Running index of every supplier the AI has ever profiled, keyed
        # by GSTIN, so "has AI already seen this supplier" is one small
        # file to check instead of scanning every timestamped draft. Never
        # lets an indexing problem break the actual field-extraction
        # response - it's bookkeeping, not the feature.
        try {
            $supplierGstin = $parsed.fields.supplierGSTIN
            if ($supplierGstin -and $supplierGstin -ne '24AAECD5633K1ZN') {
                $indexPath = Join-Path $aiTemplateLogDir '_index.json'
                $index = [ordered]@{}
                if (Test-Path $indexPath) {
                    $existing = (Get-Content -Path $indexPath -Raw -Encoding UTF8) | ConvertFrom-Json
                    foreach ($prop in $existing.PSObject.Properties) { $index[$prop.Name] = $prop.Value }
                }
                $nowStamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
                if ($index.Contains($supplierGstin)) {
                    $entry = $index[$supplierGstin]
                    $entry.timesSeen = [int]$entry.timesSeen + 1
                    $entry.lastSeen = $nowStamp
                    if ($parsed.fields.supplierName) { $entry.supplierName = $parsed.fields.supplierName }
                } else {
                    $index[$supplierGstin] = [ordered]@{
                        supplierName = $parsed.fields.supplierName
                        firstSeen    = $nowStamp
                        lastSeen     = $nowStamp
                        timesSeen    = 1
                        promoted     = $false
                    }
                }
                ($index | ConvertTo-Json -Depth 10) | Out-File -FilePath $indexPath -Encoding utf8
            }
        }
        catch {
            Write-Host "[ai-profile] Index update failed (non-fatal): $($_.Exception.Message)" -ForegroundColor Yellow
        }

        Write-JsonResponse $context 200 $parsed
    }
    catch {
        Write-Host "[ai-profile] ERROR: $($_.Exception.Message)" -ForegroundColor Red
        Write-JsonResponse $context 502 @{ error = $_.Exception.Message }
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
        elseif ($context.Request.HttpMethod -eq 'POST' -and $urlPath -eq '/api/ai-profile') {
            Handle-AiProfile $context
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
