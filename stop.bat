@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================================
rem  ZcodeKnight - stop the engine
rem
rem  The engine is compiled with --windows-hide-console: no window, no tray icon,
rem  nothing on the taskbar. And ZcodeKnight.bat exits as soon as it has opened
rem  the panel, so the engine is an independent process that keeps running and
rem  holding its port. That is why "how do I close it" has no obvious answer --
rem  this script is the answer.
rem
rem  Usage:
rem      stop.bat        list the running engines, ask, then stop them
rem      stop.bat /y     no prompt (for calling from another script)
rem
rem  An engine is identified by WHICH PROCESS IS LISTENING ON A LOOPBACK PORT,
rem  not by process name alone. server\runtime.exe is Bun itself, so it carries
rem  that name while running the test suite too; only the one that is LISTENING
rem  is an engine. Matching on the port cannot kill a test run by accident.
rem
rem  Candidate images are matched loosely -- anything whose name contains
rem  "ZcodeKnight", plus runtime.exe. An exact-name list was tried first and
rem  missed real cases: a build writes ZcodeKnight-new.exe before swapping it
rem  into place, and anyone who renames the binary (a rollback copy, a
rem  versioned build) would have an engine this script could not see.
rem
rem  Stopping is safe. The account store is written to disk atomically on every
rem  change, not on exit, so a forced kill loses nothing. What DOES lose accounts
rem  is two engines sharing one store -- which is another reason to have this
rem  script rather than letting a second engine be started by mistake.
rem
rem  NOTE: this file is deliberately ASCII-only. cmd.exe parses a .bat using the
rem  console codepage, and non-ASCII bytes in it are read wrong wherever that
rem  codepage disagrees with the file's encoding -- the usual result is a Chinese
rem  comment being split on a byte that reads as "&" and executed as a command.
rem  A UTF-8 BOM does not help: cmd treats the BOM as part of the first command.
rem  Every .bat in this project is English for the same reason, and the copy
rem  builder rewrites .bat files as UTF-8, so a GBK-encoded file would be mangled.
rem ============================================================================

set "ASSUME_YES="
if /i "%~1"=="/y" set "ASSUME_YES=1"

set /a COUNT=0
set "KILLLIST="
set "SEEN=,"

call :collectall

if !COUNT!==0 (
  echo.
  echo   No engine is running - the port is free.
  echo.
  pause
  exit /b 0
)

echo.
echo   Found !COUNT! running engine^(s^):
echo.
for %%p in (!KILLLIST!) do call :describe %%p
echo.

if !COUNT! GTR 1 (
  echo   Note: more than one. They may belong to different folders ^(the source
  echo   tree and the clean copy, for example^). All of them will be stopped.
  echo.
)

if not defined ASSUME_YES (
  set "GO="
  set /p GO="  Stop the engine(s) above? (y/N) "
  if /i not "!GO!"=="y" (
    echo.
    echo   Cancelled - nothing was stopped.
    echo.
    pause
    exit /b 0
  )
)

echo.
for %%p in (!KILLLIST!) do (
  taskkill /PID %%p /F >nul 2>&1
  if errorlevel 1 (
    echo   [X] PID %%p could not be stopped - permission denied. Re-run this
    echo       script as Administrator.
  ) else (
    echo   [+] stopped PID %%p
  )
)

rem Re-check instead of trusting taskkill's exit code.
rem
rem taskkill fails outright when the shell is not elevated, and reporting "done"
rem from its return code would leave the operator believing the port was free --
rem then starting a second engine on the same account store, which is exactly the
rem situation that loses accounts. So count for real.
ping -n 2 127.0.0.1 >nul 2>&1
call :countall
echo.
if !LEFT!==0 (
  echo   Done - the port is free.
) else (
  echo   !LEFT! engine^(s^) still running - re-run this script as Administrator.
)
echo.
pause
exit /b 0


rem ---- helpers --------------------------------------------------------------

rem Write the candidate image list to a temp file.
rem
rem A temp list rather than a piped `findstr /c:"^\"...\""`: a quote nested inside
rem a quoted pattern inside the for's command string is where this kind of script
rem breaks, and it broke here first. The list is also trivial to eyeball when a
rem match looks wrong.
:cands
set "CANDFILE=%TEMP%\zk-stop-cands.txt"
tasklist /FO CSV /NH 2>nul | findstr /i "ZcodeKnight" > "%CANDFILE%"
tasklist /FO CSV /NH 2>nul | findstr /i /c:"runtime.exe" >> "%CANDFILE%"
exit /b 0

rem Walk the candidates and keep the ones that are listening.
:collectall
call :cands
for /f "tokens=1,2 delims=," %%a in ('type "%CANDFILE%" 2^>nul') do call :consider "%%~a" %%b
del "%CANDFILE%" 2>nul
exit /b 0

rem %1 = image name, %2 = pid. Keep it only when it listens on a loopback port.
:consider
set "HIT="
for /f "tokens=2,5" %%c in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:"127\.0\.0\.1:"') do (
  if "%%d"=="%~2" set "HIT=1"
)
if not defined HIT exit /b 0
rem De-duplicate: SEEN holds ",123,456," so ",PID," answers "already recorded".
echo !SEEN! | findstr /c:",%~2," >nul
if not errorlevel 1 exit /b 0
set "SEEN=!SEEN!%~2,"
set /a COUNT+=1
set "KILLLIST=!KILLLIST! %~2"
set "IMG_%~2=%~1"
exit /b 0

rem Count what is still running, without touching the report list.
rem Uses a HIT flag rather than incrementing directly: the inner for runs once per
rem netstat line, so a direct increment would count one process listening on
rem several ports as several processes and report a number larger than reality.
:countall
call :cands
set /a LEFT=0
for /f "tokens=1,2 delims=," %%a in ('type "%CANDFILE%" 2^>nul') do call :countone %%b
del "%CANDFILE%" 2>nul
exit /b 0

:countone
set "HIT="
for /f "tokens=2,5" %%c in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:"127\.0\.0\.1:"') do (
  if "%%d"=="%~1" set "HIT=1"
)
if defined HIT set /a LEFT+=1
exit /b 0

rem Print one engine: PID, image, listening port^(s^), executable path.
rem The path comes from wmic, which newer Windows has dropped; when it is missing
rem the line simply omits the path instead of failing.
:describe
set "P=%~1"
set "PORTS="
for /f "tokens=2,5" %%c in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr /r /c:"127\.0\.0\.1:"') do (
  if "%%d"=="!P!" set "PORTS=!PORTS! %%~c"
)
set "EXEPATH="
for /f "tokens=1,* delims==" %%e in ('wmic process where "ProcessId=!P!" get ExecutablePath /value 2^>nul') do (
  if /i "%%e"=="ExecutablePath" set "EXEPATH=%%f"
)
echo   PID !P!  !IMG_%P%!   listening !PORTS!
if defined EXEPATH echo         !EXEPATH!
exit /b 0
