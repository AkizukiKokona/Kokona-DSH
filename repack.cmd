@echo off
setlocal enableextensions
title Kokona DSH - repack

cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"

echo ==========================================
echo   Kokona DSH - rebuild + repack + relaunch
echo ==========================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [x] npm not found. Node is not on PATH.
  echo     Expected at: C:\Program Files\nodejs
  goto :fail
)

:wait
tasklist /FI "IMAGENAME eq Kokona DSH.exe" 2>nul | find /I "Kokona DSH.exe" >nul
if not errorlevel 1 (
  echo [.] Kokona DSH.exe is still running.
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

echo.
echo [ok] Packed: release\win-unpacked
echo [.] Launching (detached) ...
rem Launch through explorer.exe instead of "start". Electron attaches to the
rem parent console, so an app started with "start" gets killed when this window
rem is closed. explorer.exe has no console and is not inside this console job
rem object, so the relaunched app is completely independent of this script.
explorer.exe "%~dp0release\win-unpacked\Kokona DSH.exe"
echo.
echo Done. Closing this window is safe - the app is independent now.
ping -n 3 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [x] Failed. Nothing was launched, the previous build is untouched.
pause
exit /b 1
