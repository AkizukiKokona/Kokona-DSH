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
echo [.] Launching ...
start "" "%~dp0release\win-unpacked\Kokona DSH.exe"
echo.
echo Done. This window closes itself.
ping -n 5 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo [x] Failed. Nothing was launched, the previous build is untouched.
pause
exit /b 1
