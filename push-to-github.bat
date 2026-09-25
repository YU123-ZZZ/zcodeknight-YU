@echo off
rem ============================================================================
rem  ZcodeKnight - push to GitHub (run this when you are ready)
rem
rem  Prepares and pushes the repository. It does NOT run automatically and it
rem  asks before doing anything irreversible.
rem
rem  Before the first push, create an EMPTY repository at:
rem      https://github.com/new  ->  name: zcodeknight-YU  ->  do NOT add README
rem  The remote is already configured to https://github.com/YU123-ZZZ/zcodeknight-YU
rem ============================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ZcodeKnight - GitHub push
echo   ========================
echo.

rem --- 1. sanity: nothing sensitive staged -----------------------------------
echo   [1/5] Checking for files that must not be published...
git diff --cached --name-only | findstr /r /c:"^data/" /c:"config.yaml" /c:"runtime.exe" /c:"_reverse" >nul 2>&1
if not errorlevel 1 (
  echo   [X] Sensitive files are staged. Aborting.
  git diff --cached --name-only
  pause
  exit /b 1
)
echo         ok - no credentials, config or reverse-engineering artifacts staged

rem --- 2. tests ---------------------------------------------------------------
echo   [2/5] Running the test suite...
if not exist "server\runtime.exe" (
  echo   [!] server\runtime.exe missing - run setup.bat first. Skipping tests.
) else (
  pushd server
  call runtime.exe test
  set "TESTRC=%errorlevel%"
  popd
  if not "%TESTRC%"=="0" (
    echo   [X] Tests failed. Aborting - a broken build should not be published.
    pause
    exit /b 1
  )
  echo         ok
)

rem --- 3. review what will go up ----------------------------------------------
echo   [3/5] Commits to be pushed:
git log --oneline -5
echo.
echo         Files tracked:
git ls-files | find /c /v ""
echo.

rem --- 4. confirm -------------------------------------------------------------
echo   [4/5] About to push to:
git remote get-url origin
echo.
set /p GO="         Continue? (y/N) "
if /i not "%GO%"=="y" (
  echo         Cancelled - nothing was pushed.
  pause
  exit /b 0
)

rem --- 5. push ----------------------------------------------------------------
echo   [5/5] Pushing...
rem  A local proxy is used when present: direct connections to github.com time
rem  out on some networks (observed on this machine), and the proxy is the only
rem  route out. Remove the -c flags if your network reaches GitHub directly.
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push -u origin master
if errorlevel 1 (
  echo.
  echo   [X] Push failed.
  echo       - Not authenticated? Install Git Credential Manager, or use a PAT:
  echo           git remote set-url origin https://YOUR_TOKEN@github.com/YU123-ZZZ/zcodeknight-YU.git
  echo       - No proxy running? Retry without the -c http.proxy flags.
  pause
  exit /b 1
)

echo.
echo   [+] Pushed. Repository: https://github.com/YU123-ZZZ/zcodeknight-YU
echo.
echo   Next: create a release (tag v2.0.0) and attach ZcodeKnight.exe as an asset
echo         so the panel's "Check for updates" can find it.
echo.
pause
