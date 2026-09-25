@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================================
rem  Launcher. Starts the engine, waits until it answers, opens the panel in the
rem  browser, then CLOSES THIS WINDOW.
rem
rem  The engine has no console of its own: the release build is compiled with
rem  --windows-hide-console, so it runs as a GUI-subsystem process with no
rem  window at all. Its output therefore goes to files instead of a window:
rem      data\engine.log      engine stdout (startup banner, pool and account
rem                           lines, the "listening on" line)
rem      data\engine.err.log  engine stderr (crash traces)
rem  Both are recreated on every start, so they always describe the CURRENT
rem  engine. When startup fails, this script prints their last lines, which
rem  turns "did not answer" into the actual reason.
rem
rem  To stop the engine later:  stop.bat   (or: taskkill /IM ZcodeKnight.exe /F)
rem ============================================================================

rem --- curl is the readiness probe below; fail loudly if it is missing ---
where curl >nul 2>&1
if errorlevel 1 (
  echo   [X] curl.exe was not found.
  echo.
  echo       The launcher uses it to check whether the engine answers. Windows
  echo       10 and 11 ship it under C:\Windows\System32 - if it is missing,
  echo       your PATH is broken or the file was removed.
  echo.
  pause
  exit /b 1
)

rem --- pick the engine: standalone build first, source + Bun runtime second ---
set "ENGINE="
set "ENGINE_ARGS="
if exist "ZcodeKnight.exe" (
  set "ENGINE=ZcodeKnight.exe"
) else if exist "server\runtime.exe" (
  if exist "server\src\index.ts" (
    set "ENGINE=server\runtime.exe"
    set "ENGINE_ARGS=run server\src\index.ts"
  )
)

if not defined ENGINE (
  echo   [X] No engine found.
  echo.
  echo       Expected either ZcodeKnight.exe ^(the release build^) or
  echo       server\runtime.exe with server\src\ ^(the source build^).
  echo.
  echo       Run setup.bat to fetch the Bun runtime for the source build.
  echo.
  pause
  exit /b 1
)

rem --- decide the port the engine will actually use ---
rem
rem Order matters and mirrors the engine's own resolution (config/loader.ts):
rem   1. ZCODE_PROXY_PORT  -- the engine reads this first, so the launcher must
rem      too, or the two disagree and the launcher waits on the wrong port.
rem   2. config.yaml server.port
rem   3. the built-in default
rem Parsed with findstr rather than a YAML reader because this must work on a
rem bare Windows box with nothing installed.
set "PORT=17800"
if defined ZCODE_PROXY_PORT set "PORT=%ZCODE_PROXY_PORT%"
if not defined ZCODE_PROXY_PORT if exist "config.yaml" (
  for /f "tokens=1,2" %%a in ('findstr /r /c:"^ *port: *[0-9]" config.yaml 2^>nul') do (
    set "PORT=%%b"
    set "PORT=!PORT: =!"
  )
)
rem A malformed value would make every later test compare against garbage, so
rem fall back rather than proceeding with it.
for /f "delims=0123456789" %%x in ("!PORT!") do set "PORT=17800"
if "!PORT!"=="" set "PORT=17800"

rem --- already running? open the panel and go ---
rem
rem This is the common case ^(double-clicked twice^), and it is also what makes
rem the launcher safe to keep on the desktop: a second run never starts a second
rem engine on the same store. The /admin probe tells an engine of ours (answers:
rem open the panel) apart from some other program that merely holds the port.
netstat -ano | findstr /r /c:"TCP .*:!PORT! .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  curl -s -o nul -m 3 "http://127.0.0.1:!PORT!/admin" 2>nul
  if not errorlevel 1 (
    start "" "http://127.0.0.1:!PORT!/admin"
    exit /b 0
  )
  echo   [X] Port !PORT! is taken by another program, not by ZcodeKnight.
  echo.
  echo       Something is LISTENING there but does not answer /admin. Stop that
  echo       program, or change server.port in config.yaml, then run this again.
  echo.
  pause
  exit /b 1
)

rem --- start the engine ---
rem
rem Started through Start-Process rather than cmd's `start`: cmd's redirect
rem does not reach a GUI-subsystem exe (the log file stays empty), while
rem Start-Process hands the engine real file handles for stdout/stderr and
rem reports the PID, which the wait loop uses to notice a crash immediately.
rem Everything travels in environment variables so no path quoting can break
rem on spaces or non-ASCII folder names.
if not exist "data" mkdir "data"
set "ZK_WD=%CD%"
set "ZK_ENGINE=%CD%\!ENGINE!"
set "ZK_OUT=%CD%\data\engine.log"
set "ZK_ERR=%CD%\data\engine.err.log"
set "ZK_ARGS=!ENGINE_ARGS! --cli serve"

rem The PID is written to data\engine.pid BY PowerShell itself and the PS output
rem goes to the NUL device. It must not be read through a cmd pipe (`for /f`):
rem the engine inherits the pipe's write handle at CreateProcess time, so the
rem pipe never sees EOF while the engine lives and the launcher hangs forever.
set "EPID="
set "ZK_PID=%CD%\data\engine.pid"
powershell -NoProfile -Command "$p = Start-Process -FilePath $env:ZK_ENGINE -ArgumentList $env:ZK_ARGS -WorkingDirectory $env:ZK_WD -RedirectStandardOutput $env:ZK_OUT -RedirectStandardError $env:ZK_ERR -WindowStyle Hidden -PassThru; if ($p) { [IO.File]::WriteAllText($env:ZK_PID, [string]$p.Id) }" >nul 2>&1
if exist "!ZK_PID!" set /p EPID=<"!ZK_PID!"
if defined EPID del "!ZK_PID!" >nul 2>&1
rem A non-numeric PID would poison the tasklist check below, so drop it.
if defined EPID for /f "delims=0123456789" %%x in ("!EPID!") do set "EPID="

if not defined EPID (
  rem Fallback for a machine where PowerShell is missing or blocked: launch the
  rem old way. No log capture and no PID, but the engine still starts. Stale
  rem logs from an earlier PowerShell-launched run are removed first, so the
  rem failure path below cannot show a previous run's log as if it were this
  rem one's.
  del "data\engine.log" "data\engine.err.log" >nul 2>&1
  start "ZcodeKnight" %ENGINE% %ENGINE_ARGS% --cli serve >nul 2>&1
)

rem --- wait for the engine to answer, then open the panel ---
rem
rem 60 tries at ~1s instead of 20: the FIRST launch of a freshly extracted
rem 89 MB exe can sit behind antivirus scanning for tens of seconds before the
rem process even exists. With a 20s cap the launcher gave up, printed an error,
rem and the engine came up seconds later - an error report for a gateway that
rem was actually running.
set /a TRIES=0
:waitloop
rem `ping` instead of `timeout`: timeout.exe needs a console and refuses to run
rem when this script is launched from a shortcut or another detached process,
rem which printed "invalid time interval" and skipped the wait entirely.
ping -n 2 127.0.0.1 >nul 2>&1
set /a TRIES+=1
curl -s -o nul -m 2 "http://127.0.0.1:!PORT!/admin" 2>nul
if not errorlevel 1 goto ready
rem Engine process gone means it crashed during startup - waiting out the rest
rem of the minute would only delay the answer. Checked only when the PID is
rem known (the PowerShell launch above); the `start` fallback just waits it out.
if defined EPID (
  tasklist /FI "PID eq !EPID!" 2>nul | find "!EPID!" >nul 2>&1
  if errorlevel 1 goto died
)
if !TRIES! lss 60 goto waitloop

echo   [X] The engine did not answer on port !PORT! within 60s.
goto failed

:died
echo   [X] The engine exited during startup, before answering on port !PORT!.
echo       The reason is in its log - last lines below.

:failed
echo.
if not exist "data\engine.log" if not exist "data\engine.err.log" (
  echo       ^(No engine log was captured on this run - the engine was started
  echo       without log capture, so there is nothing to show.^)
  goto afterlog
)
echo   ---- last lines of data\engine.log / data\engine.err.log ----
powershell -NoProfile -Command "Get-Content -LiteralPath $env:ZK_OUT,$env:ZK_ERR -Tail 12 -ErrorAction SilentlyContinue"
echo   ---- end of engine log ----
echo.
echo       If the log above is empty or a single cut-off line, the engine binary
echo       itself could not run on this machine - for example a CPU without the
echo       SSE4.2 instruction set (pre-2011 AMD / old Celerons) cannot run the
echo       runtime, and the process dies right after printing its crash banner.
:afterlog
echo.
pause
exit /b 1

:ready
echo   Opening the panel...
start "" "http://127.0.0.1:!PORT!/admin"
rem Brief pause so the browser has time to start before this window vanishes.
ping -n 2 127.0.0.1 >nul 2>&1
exit /b 0
