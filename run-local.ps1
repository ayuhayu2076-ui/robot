# DarkPaw Controller PWA - Local Launcher
# Usage: Right-click -> Run with PowerShell, or in a PowerShell console: ./run-local.ps1
# Opens http://localhost:8080/ (installable PWA on localhost).

param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Start-StaticServer($port) {
  $code = @"
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Collections.Generic;

class StaticServer {
  static HttpListener _listener;
  static string _root;
  static Dictionary<string, string> _ct;
  static void Main(string[] args) {
    _root = args[0];
    int port = int.Parse(args[1]);
    _ct = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
      {".html", "text/html; charset=utf-8"},
      {".js",   "application/javascript; charset=utf-8"},
      {".css",  "text/css; charset=utf-8"},
      {".json", "application/json; charset=utf-8"},
      {".png",  "image/png"},
      {".jpg",  "image/jpeg"},
      {".jpeg", "image/jpeg"},
      {".svg",  "image/svg+xml"},
      {".ico",  "image/x-icon"},
      {".webmanifest", "application/manifest+json"}
    };
    _listener = new HttpListener();
    _listener.Prefixes.Add("http://localhost:" + port + "/");
    _listener.Start();
    Console.WriteLine("DarkPaw PWA running at http://localhost:" + port + "/");
    Console.WriteLine("Press Ctrl+C to stop.");
    while(true) {
      var ctx = _listener.GetContext();
      ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
    }
  }
  static void Handle(HttpListenerContext ctx) {
    try {
      var req = ctx.Request;
      var url = req.Url.AbsolutePath;
      if (url.EndsWith("/")) url += "index.html";
      var path = _root + Uri.UnescapeDataString(url.Replace("/", Path.DirectorySeparatorChar.ToString()));
      if (!File.Exists(path)) {
        ctx.Response.StatusCode = 404;
        var b404 = Encoding.UTF8.GetBytes("404 Not Found: " + path);
        ctx.Response.OutputStream.Write(b404, 0, b404.Length);
        ctx.Response.Close();
        return;
      }
      var ext = Path.GetExtension(path).ToLowerInvariant();
      string ct;
      if (!_ct.TryGetValue(ext, out ct)) ct = "application/octet-stream";
      ctx.Response.ContentType = ct;
      if (ext == ".html" || ext == ".js" || ext == ".css" || ext == ".json" || ext == ".webmanifest") {
        ctx.Response.AddHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        ctx.Response.AddHeader("Pragma", "no-cache");
        ctx.Response.AddHeader("Expires", "0");
      } else {
        ctx.Response.AddHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
      var bytes = File.ReadAllBytes(path);
      ctx.Response.ContentLength64 = bytes.LongLength;
      ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
      ctx.Response.Close();
    } catch (Exception e) {
      try {
        ctx.Response.StatusCode = 500;
        var be = Encoding.UTF8.GetBytes("500: " + e.Message);
        ctx.Response.OutputStream.Write(be, 0, be.Length);
        ctx.Response.Close();
      } catch {}
    }
  }
}
"@
  function Find-Csc {
    $candidates = @(
      (Get-Command "csc.exe" -ErrorAction SilentlyContinue).Source,
      "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
      "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe",
      "$env:WINDIR\Microsoft.NET\Framework64\v2.0.50727\csc.exe",
      "$env:WINDIR\Microsoft.NET\Framework\v2.0.50727\csc.exe"
    )
    foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
    if (Get-Command "dotnet" -ErrorAction SilentlyContinue) { return "dotnet:csc" }
    return $null
  }

  $cscPath = Find-Csc
  if ($cscPath -and $cscPath -ne "dotnet:csc") {
    $tmpDir = Join-Path $env:TEMP ("DarkPawSrv-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $csFile = Join-Path $tmpDir "Server.cs"
    Set-Content -Path $csFile -Value $code -Encoding UTF8
    $exe = Join-Path $tmpDir "DarkPawSrv.exe"
    & $cscPath /nologo /out:$exe $csFile | Out-Host
    if ($LASTEXITCODE -eq 0 -and (Test-Path $exe)) {
      & $exe $here $port
      return
    }
    Write-Warning "C# compile fallback or failed; using pure PowerShell listener instead."
  }

  $typeMap = [ordered]@{
    ".html" = "text/html; charset=utf-8";
    ".js"   = "application/javascript; charset=utf-8";
    ".css"  = "text/css; charset=utf-8";
    ".json" = "application/json; charset=utf-8";
    ".png"  = "image/png";
    ".jpg"  = "image/jpeg";
    ".jpeg" = "image/jpeg";
    ".svg"  = "image/svg+xml";
    ".ico"  = "image/x-icon";
    ".webmanifest" = "application/manifest+json"
  }
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$port/")
  $listener.Start()
  Write-Host "DarkPaw PWA running at http://localhost:$port/"
  Write-Host "Press Ctrl+C to stop."
  try {
    while ($listener.IsListening) {
      $ctx = $listener.GetContext()
      $req = $ctx.Request
      $url = $req.Url.AbsolutePath
      if ($url.EndsWith("/")) { $url += "index.html" }
      $filePath = Join-Path $here ([Uri]::UnescapeDataString($url.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)))
      if ([System.IO.File]::Exists($filePath)) {
        $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
        $ct = "application/octet-stream"
        if ($typeMap.Contains($ext)) { $ct = $typeMap[$ext] }
        $ctx.Response.ContentType = $ct
        if (".html",".js",".css",".json",".webmanifest" -contains $ext) {
          $ctx.Response.AddHeader("Cache-Control","no-cache, no-store, must-revalidate")
          $ctx.Response.AddHeader("Pragma","no-cache")
          $ctx.Response.AddHeader("Expires","0")
        } else {
          $ctx.Response.AddHeader("Cache-Control","public, max-age=31536000, immutable")
        }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $ctx.Response.ContentLength64 = $bytes.LongLength
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
        $buf = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $filePath")
        $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
      }
      $ctx.Response.Close()
    }
  } finally {
    if ($listener) { $listener.Stop() }
  }
}

Start-StaticServer $Port
