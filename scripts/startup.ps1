param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$floatRoot = Split-Path -Parent $PSScriptRoot
$floatExecutable = Join-Path $floatRoot 'app\SpotifyFloat.exe'
if (-not (Test-Path -LiteralPath $floatExecutable -PathType Leaf)) {
    throw 'SpotifyFloat.exe is missing. Extract the whole Windows release ZIP first.'
}
if ($DryRun) { Write-Host 'Startup paths checked. No task was changed.'; return }
$floatUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$floatAction = New-ScheduledTaskAction -Execute $floatExecutable -Argument '--background' -WorkingDirectory (Split-Path -Parent $floatExecutable)
$floatTrigger = New-ScheduledTaskTrigger -AtLogOn -User $floatUser
$floatPrincipal = New-ScheduledTaskPrincipal -UserId $floatUser -LogonType Interactive -RunLevel Limited
$floatSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Spotify Float Background' -Action $floatAction -Trigger $floatTrigger -Principal $floatPrincipal -Settings $floatSettings -Description 'Prepare the local Spotify Float bridge at sign-in so the Spotify button can open the visualizer.' -Force | Out-Null
Write-Host 'Spotify Float will start quietly at sign-in. The visuals open only when requested.'
