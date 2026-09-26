@echo off
setlocal enableextensions enabledelayedexpansion
title KokonaHarness - repack

cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "EXE=%~dp0release\win-unpacked\KokonaHarness.exe"

echo ==========================================
echo   KokonaHarness - rebuild + repack + relaunch
echo ==========================================
echo.

rem Report the version this run will produce. If package.json is stale this is the
rem first place it shows, instead of the update prompt afterwards.
rem No pipe in the PowerShell expression on purpose: a pipe inside for /f backticks
rem has to be caret-escaped for cmd, and the caret then reaches PowerShell verbatim.
set "SRCVER="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content 'package.json' -Raw)).version"`) do set "SRCVER=%%v"
if defined SRCVER (echo [.] Source version: !SRCVER!) else (echo [.] Source version: could not be read from package.json)

where npm >nul 2>nul
if errorlevel 1 (
  echo [x] npm not found. Node is not on PATH.
  echo     Expected at: C:\Program Files\nodejs
  goto :fail
)

rem The app must be fully closed. electron-builder cannot overwrite the exe or
rem app.asar while they are locked, and closing the window only hides it to the tray.
:wait
set "RUNNING="
tasklist /FI "IMAGENAME eq KokonaHarness.exe" 2>nul | find /I "KokonaHarness.exe" >nul
if not errorlevel 1 set "RUNNING=KokonaHarness.exe"
rem The pre-rename build, in case an old one is still resident.
tasklist /FI "IMAGENAME eq Kokona DSH.exe" 2>nul | find /I "Kokona DSH.exe" >nul
if not errorlevel 1 set "RUNNING=Kokona DSH.exe"
if defined RUNNING (
  echo [.] !RUNNING! is still running.
  echo     Closing the window does NOT quit it - it hides to the tray.
  echo     Quit it from the tray icon, then this window continues on its own.
  echo     Waiting...
  ping -n 4 127.0.0.1 >nul
  goto :wait
)

echo [.] App is closed. Running npm run pack ...
echo.
call npm run pack
if errorlevel 1 goto :fail

rem The build runs scripts/local-version.mjs first, which may bump the patch once after
rem a release. Re-read package.json so the comparison below uses the version that was
rem actually packed, not the one from before the build.
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content 'package.json' -Raw)).version"`) do set "SRCVER=%%v"
if defined SRCVER echo [.] Source version after the build: !SRCVER!

rem Read back what was actually stamped into the build, so "did it update?" is
rem answered right here rather than by the update prompt on the next launch.
set "PACKED="
if exist "%EXE%" for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Item '%EXE%').VersionInfo.ProductVersion"`) do set "PACKED=%%v"

echo.
echo [ok] Packed: release\win-unpacked
if defined PACKED (
  echo [.] Packed version: !PACKED!
  if defined SRCVER if not "!PACKED!"=="!SRCVER!" if not "!PACKED!"=="!SRCVER!.0" (
    echo [!] Packed version does not match the source version - check package.json.
  )
) else (
  echo [!] Could not read the packed version back.
)

echo [.] Launching (detached) ...
rem Let the filesystem settle first. Relaunching the instant a 600 MB repack finishes
rem means the boot screen's very first load runs cold, which is exactly the window in
rem which the core can come ready while that navigation is still in flight.
ping -n 4 127.0.0.1 >nul
rem Launch through explorer.exe instead of "start". Electron attaches to the
rem parent console, so an app started with "start" gets killed when this window
rem is closed. explorer.exe has no console and is not inside this console job
rem object, so the relaunched app is completely independent of this script.
explorer.exe "%EXE%"
echo.
echo Done. Closing this window is safe - the app is independent now.
ping -n 3 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [x] Failed. Nothing was launched, the previous build is untouched.
pause
exit /b 1
