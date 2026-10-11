@echo off
setlocal
set "SCRIPT=%~dp0BarCodeAnywhere.ahk"

set "AHK="
if exist "%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe" set "AHK=%ProgramFiles%\AutoHotkey\v2\AutoHotkey64.exe"
if exist "%ProgramFiles%\AutoHotkey\v2\AutoHotkey32.exe" set "AHK=%ProgramFiles%\AutoHotkey\v2\AutoHotkey32.exe"
if exist "%LocalAppData%\Programs\AutoHotkey\v2\AutoHotkey64.exe" set "AHK=%LocalAppData%\Programs\AutoHotkey\v2\AutoHotkey64.exe"

if not defined AHK (
  echo AutoHotkey v2 was not found.
  echo Install from https://www.autohotkey.com/ then run this again.
  start "" "https://www.autohotkey.com/"
  pause
  exit /b 1
)

start "" "%AHK%" "%SCRIPT%"
echo BarCode Anywhere is starting (warm Edge UI)...
echo Ctrl+Shift+B = scan from selection
echo Ctrl+Shift+P = print layout (use Import to paste)
echo Esc hides the window.
timeout /t 3 >nul
