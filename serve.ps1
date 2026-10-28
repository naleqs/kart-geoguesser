# Tiny static web server for Kart GeoGuesser. Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000] [-NoBrowser]
param([int]$Port = 8000, [switch]$NoBrowser)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root at http://localhost:$Port/  (Ctrl+C to stop)"

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'; '.nds' = 'application/octet-stream'; '.txt' = 'text/plain'
}

if (-not $NoBrowser) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) { Start-Process $edge "http://localhost:$Port/" } else { Start-Process "http://localhost:$Port/" }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($path -eq '/') { $path = '/index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
    if (-not $file.StartsWith($root) -or -not (Test-Path $file -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($file)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch { $res.StatusCode = 500 }
  $res.Close()
}
