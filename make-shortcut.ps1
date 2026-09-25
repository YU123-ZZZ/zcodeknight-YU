# Create a desktop shortcut to the launcher, carrying the knight icon.
#
# A .bat file cannot hold a custom icon in Windows — the icon lives on the
# shortcut, not the script. This writes the .lnk with the project's own icon so
# the desktop entry shows the black-knight helm instead of the generic gear.
#
# Run:  powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
#       powershell -ExecutionPolicy Bypass -File make-shortcut.ps1 -Name "ZcodeKnight"
#
# It writes to the CURRENT USER's real desktop (%USERPROFILE%\Desktop), not to
# whatever a sandboxed shell reports as "Desktop". A redirected profile can
# point [Environment]::GetFolderPath('Desktop') somewhere the user never sees,
# which is how a shortcut can be reported as created yet be invisible.
param([string]$Name = 'ZcodeKnight')

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico  = Join-Path $root 'icons\ZcodeKnight.ico'
$bat  = Join-Path $root 'ZcodeKnight.bat'

if (-not (Test-Path $ico)) { Write-Host "ERROR: icon missing: $ico"; exit 1 }
if (-not (Test-Path $bat)) { Write-Host "ERROR: launcher missing: $bat"; exit 1 }

# Prefer the real user profile over the shell's folder API. OneDrive-redirected
# and sandboxed profiles disagree, and the user looks at the real one.
$desktop = Join-Path $env:USERPROFILE 'Desktop'
if (-not (Test-Path $desktop)) { $desktop = [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Path $desktop)) { Write-Host "ERROR: no desktop folder found"; exit 1 }

$lnk = Join-Path $desktop "$Name.lnk"
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath       = $bat
$s.WorkingDirectory = $root
$s.IconLocation     = "$ico,0"
$s.Description      = 'ZcodeKnight'
$s.Save()

# Verify by reading it back. Reporting success from the Save() call alone is not
# enough: Save() can write to a redirected location and still return quietly.
if (-not (Test-Path $lnk)) { Write-Host "ERROR: shortcut was not created at $lnk"; exit 1 }
$check = $sh.CreateShortcut($lnk)
if ($check.TargetPath -ne $bat) { Write-Host "ERROR: shortcut target is wrong: $($check.TargetPath)"; exit 1 }

# The shell caches shortcut icons; without this a replaced .ico keeps rendering
# as the old image until the user logs out.
(Get-Item $ico).LastWriteTime = Get-Date

Write-Host "created : $lnk"
Write-Host "target  : $($check.TargetPath)"
Write-Host "icon    : $($check.IconLocation)"
