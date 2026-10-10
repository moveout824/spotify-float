param([switch]$UpdateSpicetify, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$floatRoot = Split-Path -Parent $PSScriptRoot
$floatApp = Join-Path $floatRoot 'app\SpotifyFloat.exe'
$floatState = Join-Path $floatRoot 'app\state'
$floatCli = Join-Path $floatRoot 'tools\spicetify\spicetify.exe'

function Run-Spicetify([string[]]$Arguments) {
    & $floatCli @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Spicetify could not finish. See docs/TROUBLESHOOTING.md.' }
}

try {
    Write-Host 'Spotify Float setup' -ForegroundColor Cyan
    if ([Environment]::OSVersion.Version.Build -lt 20348) {
        throw 'Spotify-only audio capture requires Windows 11 x64 (build 20348 or later).'
    }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'This download requires 64-bit Windows.' }
    if (-not (Test-Path -LiteralPath $floatApp)) {
        throw 'Download the Windows ZIP from Releases, extract the WHOLE folder, then run install.cmd.'
    }
    $floatSpotify = Get-Process -Name Spotify -ErrorAction SilentlyContinue
    $floatSpotifyFolder = Join-Path $env:APPDATA 'Spotify'
    if (-not $floatSpotify -and -not (Test-Path -LiteralPath (Join-Path $floatSpotifyFolder 'Spotify.exe'))) {
        throw 'Install Spotify Desktop from spotify.com and sign in first. See the README for the download link.'
    }
    if ($DryRun) { Write-Host 'Read-only checks passed. Nothing was changed.'; exit 0 }

    if ($UpdateSpicetify -or -not (Test-Path -LiteralPath $floatCli)) {
        Write-Host 'Getting the official Spicetify CLI release...'
        $floatRelease = Invoke-RestMethod 'https://api.github.com/repos/spicetify/cli/releases/latest'
        $floatAsset = $floatRelease.assets | Where-Object { $_.name -like '*windows-x64.zip' } | Select-Object -First 1
        if (-not $floatAsset -or $floatAsset.browser_download_url -notlike 'https://github.com/spicetify/cli/releases/download/*') {
            throw 'An official Spicetify Windows release could not be found.'
        }
        $floatDownloadRoot = Join-Path $floatRoot 'tools\downloads'
        New-Item -ItemType Directory -Path $floatDownloadRoot -Force | Out-Null
        $floatZip = Join-Path $floatDownloadRoot $floatAsset.name
        Invoke-WebRequest $floatAsset.browser_download_url -OutFile $floatZip
        $floatCliFolder = Split-Path -Parent $floatCli
        New-Item -ItemType Directory -Path $floatCliFolder -Force | Out-Null
        Expand-Archive -LiteralPath $floatZip -DestinationPath $floatCliFolder -Force
        if (-not (Test-Path -LiteralPath $floatCli)) { throw 'Spicetify was downloaded but its executable is missing.' }
    }

    New-Item -ItemType Directory -Path $floatState -Force | Out-Null
    $floatConfigFile = Join-Path $floatState 'stage-config.json'
    $floatConfig = @{}
    if (Test-Path -LiteralPath $floatConfigFile) {
        $floatOldConfig = Get-Content -LiteralPath $floatConfigFile -Raw | ConvertFrom-Json
        foreach ($floatProperty in $floatOldConfig.PSObject.Properties) { $floatConfig[$floatProperty.Name] = $floatProperty.Value }
    }
    if (-not $floatConfig.key) {
        $floatRandom = New-Object byte[] 32
        $floatRandomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
        $floatRandomGenerator.GetBytes($floatRandom)
        $floatRandomGenerator.Dispose()
        $floatConfig.key = -join ($floatRandom | ForEach-Object { $_.ToString('x2') })
    }
    if (-not $floatConfig.ContainsKey('offset')) { $floatConfig.offset = 300 }
    $floatEncoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($floatConfigFile, ($floatConfig | ConvertTo-Json -Depth 6), $floatEncoding)

    $floatIcons = Get-Content -LiteralPath (Join-Path $floatRoot 'renderer\assets\stage-icon-data.json') -Raw | ConvertFrom-Json
    $floatTemplate = [IO.File]::ReadAllText((Join-Path $floatRoot 'extension.template.js'))
    $floatKeyJson = ConvertTo-Json -InputObject $floatConfig.key -Compress
    $floatIconJson = ConvertTo-Json -InputObject $floatIcons.'32' -Compress
    $floatExtension = $floatTemplate.Replace('__STAGE_KEY__', $floatKeyJson).Replace('__STAGE_ICON__', $floatIconJson)

    # Ask Spicetify for its own config directory, preserving an existing setup.
    $floatConfigPath = (& $floatCli -c | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $floatConfigPath) { throw 'Spicetify configuration could not be located.' }
    $floatExtensionFolder = Join-Path (Split-Path -Parent $floatConfigPath) 'Extensions'
    New-Item -ItemType Directory -Path $floatExtensionFolder -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $floatExtensionFolder 'spotify-stage.js'), $floatExtension, $floatEncoding)
    Write-Host 'Adding the Float button. Spotify may restart briefly...'
    Run-Spicetify -Arguments @('config', 'extensions', 'spotify-stage.js')
    Run-Spicetify -Arguments @('backup', 'apply')
    Start-Process -FilePath $floatApp -ArgumentList '--background' -WindowStyle Hidden
    Write-Host ''
    Write-Host 'Ready! Play a song, then click Float immediately beside Spotify repeat.' -ForegroundColor Green
    Write-Host 'Single-mode.cmd and Dual-mode.cmd select the display layout.'
    Write-Host 'Esc closes the visuals. Alt+Tab always works.'
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'See README.md and docs/TROUBLESHOOTING.md.'
    exit 1
}

