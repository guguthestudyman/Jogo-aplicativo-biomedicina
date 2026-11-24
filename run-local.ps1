$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd('\') + '\'
$address = 'http://localhost:8765/'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($address)

try {
  $listener.Start()
  Write-Host "Estudo Biomédico disponível em $address"
  Write-Host 'Mantenha esta janela aberta. Pressione Ctrl+C para encerrar o servidor.'
  Start-Process $address

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.HttpMethod -ne 'GET' -and $context.Request.HttpMethod -ne 'HEAD') {
        $context.Response.StatusCode = 405
        $context.Response.Close()
        continue
      }

      $relativePath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = 'index.html'
      }
      $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath.Replace('/', '\')))
      if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
          -not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        $context.Response.StatusCode = 404
        $context.Response.Close()
        continue
      }

      $context.Response.ContentType = switch ([System.IO.Path]::GetExtension($filePath).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.css' { 'text/css; charset=utf-8' }
        '.js' { 'text/javascript; charset=utf-8' }
        '.webmanifest' { 'application/manifest+json' }
        '.png' { 'image/png' }
        default { 'application/octet-stream' }
      }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $context.Response.ContentLength64 = $bytes.Length
      if ($context.Request.HttpMethod -eq 'GET') {
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      $context.Response.Close()
    } catch {
      $context.Response.StatusCode = 500
      $context.Response.Close()
      Write-Warning "Falha ao atender a solicitação: $_"
    }
  }
} finally {
  if ($listener.IsListening) {
    $listener.Stop()
  }
  $listener.Close()
}
