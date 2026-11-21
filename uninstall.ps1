# Removes the Ollic Sketch helper from every Revit year. The Claude extension is removed in
# Claude Desktop > Settings > Extensions. Your Naira rates file is kept unless you delete
# %LOCALAPPDATA%\OllicSketch yourself.
$ErrorActionPreference = 'Continue'
if (Get-Process -Name 'Revit' -ErrorAction SilentlyContinue) {
    Write-Host 'Close Revit first, then press Enter.' -ForegroundColor Yellow
    Read-Host | Out-Null
}
$root = Join-Path $env:APPDATA 'Autodesk\Revit\Addins'
Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $manifest = Join-Path $_.FullName 'OllicSketch.addin'
    $folder = Join-Path $_.FullName 'OllicSketch'
    if (Test-Path $manifest) { Remove-Item $manifest -Force; Write-Host "Removed from Revit $($_.Name)" }
    if (Test-Path $folder) { Remove-Item $folder -Recurse -Force }
}
$bl = Join-Path $env:APPDATA 'Blender Foundation\Blender'
Get-ChildItem $bl -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $a = Join-Path $_.FullName 'scripts\addons\ollic_sketch'
    if (Test-Path $a) { Remove-Item $a -Recurse -Force; Write-Host "Removed from Blender $($_.Name)" }
}
Remove-Item (Join-Path $env:LOCALAPPDATA 'OllicSketch\build') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'OllicSketch\instances') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Ollic Sketch was removed from Revit. Remove the extension in Claude Desktop > Settings > Extensions.' -ForegroundColor Green
Read-Host 'Press Enter to close'
