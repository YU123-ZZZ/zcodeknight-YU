@echo off
rem ============================================================================
rem  ZcodeKnight - first-run setup (Windows)
rem
rem  Downloads the Bun runtime that `ZcodeKnight.bat` launches. It is not
rem  committed to the repository: it is an 83 MB third-party binary whose
rem  provenance is upstream, and vendoring it would bloat every clone.
rem ============================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if exist "server\runtime.exe" (
  echo   [=] server\runtime.exe already present - nothing to do.
  goto :done
)

echo   [*] Fetching the Bun runtime (about 83 MB)...
where curl >nul 2>&1
if errorlevel 1 (
  echo   [X] curl not found. Install it, or download Bun manually:
  echo       https://github.com/oven-sh/bun/releases
  echo       Save the Windows x64 binary as server\runtime.exe
  pause
  exit /b 1
)

rem Pin a known-good version: the engine is developed and tested against it,
rem and an unpinned "latest" can change runtime behavior under the user.
set "BUN_VERSION=1.4.2"
set "URL=https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/bun-windows-x64.zip"
set "TMPZIP=%TEMP%\zk-bun-%RANDOM%.zip"

curl -L --fail --progress-bar -o "%TMPZIP%" "%URL%"
if errorlevel 1 (
  echo   [X] Download failed. Check your network, then retry.
  del "%TMPZIP%" 2>nul
  pause
  exit /b 1
)

echo   [*] Extracting...
if not exist "server" mkdir server
tar -xf "%TMPZIP%" -C "%TEMP%" >nul 2>&1
if errorlevel 1 (
  echo   [X] Extraction failed - is tar available? (Windows 10 1803+ ships it)
  del "%TMPZIP%" 2>nul
  pause
  exit /b 1
)

rem The zip contains bun-windows-x64/bun.exe
if exist "%TEMP%\bun-windows-x64\bun.exe" (
  copy /y "%TEMP%\bun-windows-x64\bun.exe" "server\runtime.exe" >nul
  rmdir /s /q "%TEMP%\bun-windows-x64" 2>nul
) else (
  echo   [X] bun.exe not found inside the archive.
  del "%TMPZIP%" 2>nul
  pause
  exit /b 1
)
del "%TMPZIP%" 2>nul

echo   [+] Done: server\runtime.exe
echo.
echo   Next: run ZcodeKnight.bat

:done
echo.
pause
