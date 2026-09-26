# KokonaHarness -> Codeberg sync, with live progress bars.
# Runs in its own visible console window so the transfer can be watched rather than guessed at.
#
# Measured on this line: one connection to GitHub's asset host gets ~25 KB/s, four together
# measured ~140 KB/s. So the parallelism does pay here - it is not splitting a fixed trickle.
# Every download is resumable (-C -), so killing this window costs nothing already on disk.
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'KokonaHarness -> Codeberg   v1.1.0'

$tok = (Get-Content "$env:LOCALAPPDATA\KokonaDSH\tools\codeberg-token" -Raw).Trim()
$h = @{ Authorization = "token $tok" }
$api = 'https://codeberg.org/api/v1/repos/AkizukiKokona/KokonaHarness'
$dl = Join-Path $env:TEMP 'kokona-1.1.0-assets'
$gh = 'C:\Program Files\GitHub CLI\gh.exe'

Write-Host ''
Write-Host '  KokonaHarness 1.1.0  ->  Codeberg' -ForegroundColor Cyan
Write-Host '  ================================' -ForegroundColor Cyan
Write-Host ''

$names = @(
  'KokonaHarness-Setup-1.1.0.exe'
  'KokonaHarness-1.1.0-mac-arm64.dmg'
  'KokonaHarness-1.1.0-mac-x64.dmg'
  'KokonaHarness-1.1.0-linux-x86_64.AppImage'
)
$base = 'https://github.com/AkizukiKokona/KokonaHarness/releases/download/v1.1.0'

# Expected sizes, straight from the GitHub release, so the bar has a real denominator.
$expected = 0
try {
  $j = (& $gh release view v1.1.0 --json assets | ConvertFrom-Json)
  foreach ($a in $j.assets) { $expected += $a.size }
} catch { }
if ($expected -le 0) { $expected = 420MB }

# Deliberately not wiped: partial files are what -C - resumes from.
New-Item -ItemType Directory -Force -Path $dl | Out-Null

Write-Host '  [1/3] downloading from GitHub - 4 at once, resumable' -ForegroundColor Yellow
$sw = [Diagnostics.Stopwatch]::StartNew()
$procs = @()
foreach ($n in $names) {
  $procs += Start-Process -FilePath 'curl.exe' -PassThru -WindowStyle Hidden -ArgumentList @(
    '-L', '--fail', '-s', '-C', '-', '--retry', '5', '--retry-delay', '3',
    '--retry-all-errors', '-o', (Join-Path $dl $n), "$base/$n"
  )
}
do {
  Start-Sleep -Milliseconds 500
  $got = 0
  foreach ($n in $names) {
    $f = Join-Path $dl $n
    if (Test-Path $f) { $got += (Get-Item $f).Length }
  }
  $pct = [math]::Min(100, [int]($got / $expected * 100))
  $rate = if ($sw.Elapsed.TotalSeconds -gt 0) { ($got / 1MB) / $sw.Elapsed.TotalSeconds } else { 0 }
  Write-Progress -Id 1 -Activity 'Downloading from GitHub' `
    -Status ('{0:N0} / {1:N0} MB   {2:N2} MB/s   {3}%' -f ($got / 1MB), ($expected / 1MB), $rate, $pct) `
    -PercentComplete $pct
  $alive = 0
  foreach ($p in $procs) { if (-not $p.HasExited) { $alive++ } }
} while ($alive -gt 0)
$sw.Stop()
Write-Progress -Id 1 -Activity 'Downloading from GitHub' -Completed

$got = 0
foreach ($n in $names) {
  $f = Join-Path $dl $n
  $here = if (Test-Path $f) { (Get-Item $f).Length } else { 0 }
  $got += $here
  $col = if ($here -gt 1MB) { 'Green' } else { 'Red' }
  Write-Host ('        {0,-46} {1,7:N0} MB' -f $n, ($here / 1MB)) -ForegroundColor $col
}
Write-Host ('        total {0:N0} MB in {1:N0}s' -f ($got / 1MB), $sw.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host ''

Write-Host '  [2/3] Codeberg release' -ForegroundColor Yellow
$rel = $null
try { $rel = Invoke-RestMethod -Uri "$api/releases/tags/v1.1.0" -Headers $h -Method Get } catch { }
if ($null -eq $rel) {
  $notes = Join-Path $PSScriptRoot '..\.github\release-notes-1.1.0.md'
  $body = @{
    tag_name   = 'v1.1.0'
    name       = 'v1.1.0'
    body       = (Get-Content $notes -Raw -ErrorAction SilentlyContinue)
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json
  $rel = Invoke-RestMethod -Uri "$api/releases" -Headers $h -Method Post -Body $body -ContentType 'application/json'
  Write-Host ('        created, id ' + $rel.id) -ForegroundColor Green
} else {
  Write-Host ('        already there, id ' + $rel.id) -ForegroundColor Green
}
Write-Host ''

Write-Host '  [3/3] uploading to Codeberg' -ForegroundColor Yellow
$have = @()
if ($rel.assets) { $have = @($rel.assets | ForEach-Object { $_.name }) }

$i = 0
foreach ($n in $names) {
  $i++
  if ($have -contains $n) {
    Write-Host ('        [{0}/4] {1}  skipped, already uploaded' -f $i, $n) -ForegroundColor DarkGray
    continue
  }
  $f = Join-Path $dl $n
  if (-not (Test-Path $f)) {
    Write-Host ('        [{0}/4] {1}  MISSING, download did not finish' -f $i, $n) -ForegroundColor Red
    continue
  }
  $size = [math]::Floor((Get-Item $f).Length / 1MB)
  Write-Progress -Id 2 -Activity ('Uploading to Codeberg ({0}/4)' -f $i) -Status "$n  ($size MB)" -PercentComplete -1
  $u = "$api/releases/$($rel.id)/assets?name=" + [uri]::EscapeDataString($n)
  Invoke-RestMethod -Uri $u -Headers $h -Method Post -InFile $f -ContentType 'application/octet-stream' | Out-Null
  Write-Host ('        [{0}/4] {1}  {2} MB  uploaded' -f $i, $n, $size) -ForegroundColor Green
}
Write-Progress -Id 2 -Activity 'Uploading to Codeberg' -Completed
Write-Host ''

Write-Host '  verifying by reading the rendered badge, not the status code' -ForegroundColor Yellow
$after = Invoke-RestMethod -Uri "$api/releases/tags/v1.1.0" -Headers $h -Method Get
foreach ($a in $after.assets) {
  Write-Host ('        {0,-46} {1,7:N0} MB' -f $a.name, ($a.size / 1MB)) -ForegroundColor Gray
}
$svg = (Invoke-WebRequest -Uri 'https://codeberg.org/AkizukiKokona/KokonaHarness/badges/release.svg' -UseBasicParsing).Content
$rendered = ([regex]::Matches($svg, '>([^<>]{1,40})</text>') | ForEach-Object { $_.Groups[1].Value.Trim() }) -join ' | '
Write-Host ''
Write-Host ('  release badge renders: ' + $rendered) -ForegroundColor Cyan
if ($rendered -match 'v1\.1\.0') {
  Write-Host '  OK - Codeberg is serving 1.1.0' -ForegroundColor Green
} else {
  Write-Host '  WARNING - the badge does not say v1.1.0 yet' -ForegroundColor Red
}
Write-Host ''
Remove-Item $dl -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '  done. this window stays open.' -ForegroundColor Cyan
Write-Host ''
