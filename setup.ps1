# Ollic Sketch setup for Windows.
# Run by double-clicking "Install Ollic Sketch.bat". No administrator rights needed.
#   1. Finds every Revit 2024 or later on this computer.
#   2. Gets the free Microsoft .NET build tools if missing (per user, about 200 MB, once).
#   3. Builds the Ollic Sketch helper for each Revit year and installs it.
#   4. Installs the Ollic Sketch add-on into Blender 4.2 or later, if Blender is installed.
#   5. Opens the Ollic Sketch extension so Claude Desktop can install it.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'OllicSketch-setup.log'
Start-Transcript -Path $log -Force | Out-Null

function Say($text, $color = 'White') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say ''
    Say "Setup stopped: $text" 'Red'
    Say "Details are saved in $log" 'DarkGray'
    Stop-Transcript | Out-Null
    Read-Host 'Press Enter to close'
    exit 1
}

Say ''
Say '  OLLIC SKETCH SETUP' 'Cyan'
Say '  Connects Claude to your Revit so you can design in plain language.' 'Gray'
Say ''

# Files downloaded from the internet are marked as blocked; clear that on our own files.
Get-ChildItem -Path $here -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# ---------- 1. Find Revit ----------
$supported = 2024..2030
$found = @()
foreach ($year in $supported) {
    $exe = Join-Path $env:ProgramFiles "Autodesk\Revit $year\Revit.exe"
    if (Test-Path $exe) { $found += $year }
}
if ($found.Count -eq 0) {
    $older = Get-ChildItem (Join-Path $env:ProgramFiles 'Autodesk') -Directory -Filter 'Revit 20*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
    if ($older) { Fail "found $($older -join ', '), but Ollic Sketch needs Revit 2024 or later. Revit LT is not supported." }
    Fail 'no Revit 2024 or later was found in Program Files\Autodesk. Install Revit, then run setup again.'
}
Say "[1/5] Found Revit: $($found -join ', ')" 'Green'

if (Get-Process -Name 'Revit' -ErrorAction SilentlyContinue) {
    Say '      Revit is open. Save your work and close Revit, then press Enter.' 'Yellow'
    Read-Host | Out-Null
    if (Get-Process -Name 'Revit' -ErrorAction SilentlyContinue) { Fail 'Revit is still open. Close it and run setup again.' }
}

# ---------- 2. .NET build tools ----------
# One SDK builds every Revit year: net48 (2024), net8 (2025-2026), net10 (2027+).
$needSdk = 10
$dotnet = $null
foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'), (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'))) {
    if (Test-Path $candidate) {
        $sdks = & $candidate --list-sdks 2>$null
        if ($sdks | Where-Object { $_ -match "^$needSdk\." }) { $dotnet = $candidate; break }
    }
}
if (-not $dotnet) {
    Say '[2/5] Getting Microsoft .NET build tools (one time, a few minutes)...' 'White'
    $installer = Join-Path $env:TEMP 'dotnet-install.ps1'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer -UseBasicParsing
    } catch { Fail 'could not download the .NET installer. Check the internet connection and try again.' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -Channel "$needSdk.0" -InstallDir (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet') -NoPath
    $dotnet = Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe'
    if (-not (Test-Path $dotnet)) { Fail '.NET build tools did not install.' }
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
Say "[2/5] .NET build tools ready" 'Green'

# ---------- 3. Build and install the Revit helper ----------
$src = Join-Path $here 'revit-helper'
$work = Join-Path $env:LOCALAPPDATA 'OllicSketch\build'
$installed = @()
foreach ($year in $found) {
    Say "[3/5] Building the helper for Revit $year..." 'White'
    $yearSrc = Join-Path $work "src-$year"
    $yearOut = Join-Path $work "out-$year"
    Remove-Item $yearSrc, $yearOut -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $yearSrc -Force | Out-Null
    Copy-Item (Join-Path $src '*') $yearSrc -Recurse -Force

    $buildLog = Join-Path $work "build-$year.log"
    & $dotnet build (Join-Path $yearSrc 'OllicSketch.Revit.csproj') -c Release "-p:RevitVersion=$year" -o $yearOut *> $buildLog
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $yearOut 'OllicSketch.Revit.dll'))) {
        Get-Content $buildLog -Tail 25 | Write-Host
        Fail "the helper for Revit $year did not build. The build log is $buildLog"
    }

    $addins = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year"
    $dest = Join-Path $addins 'OllicSketch'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Get-ChildItem $yearOut -File | Where-Object { $_.Extension -in '.dll', '.pdb', '.json' -and $_.Name -notlike 'RevitAPI*' -and $_.Name -notlike 'AdWindows*' } |
        Copy-Item -Destination $dest -Force
    Copy-Item (Join-Path $src 'OllicSketch.addin') (Join-Path $addins 'OllicSketch.addin') -Force
    $installed += $year
    Say "      Installed for Revit $year" 'Green'
}

# ---------- 4. Blender add-on ----------
$blenders = @()
$bf = Join-Path $env:ProgramFiles 'Blender Foundation'
if (Test-Path $bf) {
    foreach ($dir in Get-ChildItem $bf -Directory -Filter 'Blender *') {
        $exe = Join-Path $dir.FullName 'blender.exe'
        if ($dir.Name -match 'Blender (\d+)\.(\d+)' -and (Test-Path $exe)) {
            $ver = [version]"$($Matches[1]).$($Matches[2])"
            if ($ver -ge [version]'4.2') { $blenders += [pscustomobject]@{ Version = "$($Matches[1]).$($Matches[2])"; Exe = $exe } }
        }
    }
}
if ($blenders.Count -eq 0) {
    Say '[4/5] Blender 4.2 or later not found. Renders, walkthroughs and buyer tours need it.' 'Yellow'
    Say '      Install Blender free from blender.org, then run this setup again.' 'Yellow'
} else {
    if (Get-Process -Name 'blender' -ErrorAction SilentlyContinue) {
        Say '      Blender is open. Save your work and close Blender, then press Enter.' 'Yellow'
        Read-Host | Out-Null
    }
    foreach ($b in $blenders) {
        $addonDir = Join-Path $env:APPDATA "Blender Foundation\Blender\$($b.Version)\scripts\addons\ollic_sketch"
        Remove-Item $addonDir -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $addonDir -Force | Out-Null
        Copy-Item (Join-Path $here 'blender-helper\ollic_sketch\*') $addonDir -Recurse -Force
        $enable = "import bpy, addon_utils; addon_utils.enable('ollic_sketch', default_set=True, persistent=True); bpy.ops.wm.save_userpref(); print('OLLIC_ENABLED')"
        $out = & $b.Exe --background --python-expr $enable 2>&1 | Out-String
        if ($out -match 'OLLIC_ENABLED') { Say "[4/5] Installed the add-on in Blender $($b.Version)" 'Green' }
        else { Say "[4/5] Copied the add-on to Blender $($b.Version), but could not switch it on. In Blender: Edit > Preferences > Add-ons, search Ollic Sketch, tick it." 'Yellow' }
    }
}

# ---------- 5. Claude extension ----------
$bundle = Join-Path $here 'OllicSketch.mcpb'
if (-not (Test-Path $bundle)) { Fail 'OllicSketch.mcpb is missing from the setup folder.' }
Say '[5/5] Opening the Ollic Sketch extension for Claude Desktop...' 'White'
try { Start-Process $bundle } catch { Say '      Could not open it automatically. Double-click OllicSketch.mcpb in this folder.' 'Yellow' }

Say ''
Say '  Done.' 'Green'
Say ''
Say '  Next:' 'Cyan'
Say '   1. In Claude Desktop, click Install on the Ollic Sketch extension.'
Say '      (If nothing opened: Claude Desktop > Settings > Extensions > Advanced settings > Install extension, and pick OllicSketch.mcpb.)'
Say '   2. Open Revit and a project. If Revit asks about loading "Ollic Sketch", choose "Always Load".'
Say '   3. For renders, walkthroughs and buyer tours, also open Blender.'
Say '   4. In Claude Desktop, start a chat and type: "Check the Ollic Sketch connection".'
Say ''
Stop-Transcript | Out-Null
Read-Host 'Press Enter to close'
