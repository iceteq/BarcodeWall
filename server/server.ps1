#Requires -Version 5.1
param(
    [int] $Port = 27123,
    [Parameter(Mandatory = $true)]
    [string] $Root,
    [Parameter(Mandatory = $true)]
    [string] $HideFlag
)

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath($Root)
$prefix = "http://127.0.0.1:$Port/"

$stateLock = New-Object object
$state = @{
    id   = 0
    text = ""
    mode = "scan"
}

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".ico"  = "image/x-icon"
    ".map"  = "application/json"
}

function Write-Response(
    [System.Net.HttpListenerResponse] $res,
    [int] $code,
    [string] $contentType,
    [byte[]] $bytes
) {
    $res.StatusCode = $code
    $res.ContentType = $contentType
    $res.Headers.Add("Cache-Control", "no-store")
    $res.ContentLength64 = $bytes.LongLength
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.OutputStream.Close()
}

function Write-Text(
    [System.Net.HttpListenerResponse] $res,
    [int] $code,
    [string] $contentType,
    [string] $text
) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    Write-Response $res $code $contentType $bytes
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    $msg = $_.Exception.Message
    Write-Error "Could not start server on $prefix - $msg"
    exit 1
}

Write-Output "READY $prefix"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $path = $req.Url.AbsolutePath

        try {
            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/health") {
                Write-Text $res 200 "text/plain; charset=utf-8" "ok"
                continue
            }

            if ($req.HttpMethod -eq "GET" -and $path -eq "/api/state") {
                $snapId = 0
                $snapText = ""
                $snapMode = "scan"
                [System.Threading.Monitor]::Enter($stateLock)
                try {
                    $snapId = [int]$state.id
                    $snapText = [string]$state.text
                    $snapMode = [string]$state.mode
                } finally {
                    [System.Threading.Monitor]::Exit($stateLock)
                }
                if ($snapMode -ne "print") { $snapMode = "scan" }
                $jsonText = ConvertTo-Json -InputObject $snapText -Compress
                $jsonMode = ConvertTo-Json -InputObject $snapMode -Compress
                $json = "{`"id`":$snapId,`"text`":$jsonText,`"mode`":$jsonMode}"
                Write-Text $res 200 "application/json; charset=utf-8" $json
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/show") {
                $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Close()
                $mode = "scan"
                if ($req.QueryString["mode"] -eq "print") {
                    $mode = "print"
                }
                [System.Threading.Monitor]::Enter($stateLock)
                try {
                    $state.id = [int]$state.id + 1
                    $state.text = $body
                    $state.mode = $mode
                } finally {
                    [System.Threading.Monitor]::Exit($stateLock)
                }
                Write-Text $res 200 "application/json; charset=utf-8" "{`"ok`":true}"
                continue
            }

            if ($req.HttpMethod -eq "POST" -and $path -eq "/api/hide") {
                [System.IO.File]::WriteAllText($HideFlag, "1")
                Write-Text $res 200 "application/json; charset=utf-8" "{`"ok`":true}"
                continue
            }

            if ($req.HttpMethod -ne "GET") {
                Write-Text $res 405 "text/plain; charset=utf-8" "Method not allowed"
                continue
            }

            $rel = $path.TrimStart("/")
            if ([string]::IsNullOrWhiteSpace($rel)) {
                $rel = "index.html"
            }
            $rel = $rel -replace "/", [System.IO.Path]::DirectorySeparatorChar
            $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))

            if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Text $res 403 "text/plain; charset=utf-8" "Forbidden"
                continue
            }
            if (-not [System.IO.File]::Exists($full)) {
                Write-Text $res 404 "text/plain; charset=utf-8" "Not found"
                continue
            }

            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            $type = $mime[$ext]
            if (-not $type) {
                $type = "application/octet-stream"
            }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            Write-Response $res 200 $type $bytes
        } catch {
            $err = $_.Exception.Message
            try {
                Write-Text $res 500 "text/plain; charset=utf-8" $err
            } catch {
            }
        }
    }
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}
