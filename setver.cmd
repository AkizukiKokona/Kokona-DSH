@echo off
setlocal enableextensions enabledelayedexpansion
title KokonaHarness - set local version

cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
set "ASAR=%~dp0release\win-unpacked\resources\app.asar"
set "EXE=%~dp0release\win-unpacked\KokonaHarness.exe"

echo ==========================================
echo   KokonaHarness - stamp the local version
echo ==========================================
echo.
echo   Patches the packed build's version to match package.json, so the app
echo   stops announcing an update that is really itself. Local only - nothing
echo   is downloaded, rebuilt or published.
echo.

set "SRCVER="
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(ConvertFrom-Json (Get-Content 'package.json' -Raw)).version"`) do set "SRCVER=%%v"
if not defined SRCVER (
  echo [x] Could not read the version from package.json.
  goto :fail
)
echo [.] package.json version: !SRCVER!

if not exist "%ASAR%" (
  echo [x] Not found: %ASAR%
  echo     Run "npm run pack" once to produce a local build.
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo [x] node not found. Node is not on PATH.
  echo     Expected at: C:\Program Files\nodejs
  goto :fail
)

rem The archive is memory-mapped by the running app, so it cannot be written while
rem the app lives. Closing the window only hides it to the tray.
:wait
set "RUNNING="
tasklist /FI "IMAGENAME eq KokonaHarness.exe" 2>nul | find /I "KokonaHarness.exe" >nul
if not errorlevel 1 set "RUNNING=KokonaHarness.exe"
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

echo [.] App is closed. Patching ...
echo.
node "%~dp0scripts\set-packed-version.mjs"
if errorlevel 1 goto :fail

echo.
echo [.] Launching (detached) ...
rem Launch through explorer.exe instead of "start": an app started with "start"
rem attaches to this console and dies with the window.
explorer.exe "%EXE%"
echo.
echo Done. Closing this window is safe - the app is independent now.
ping -n 3 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [x] Failed. The packed build is untouched.
pause
exit /b 1
