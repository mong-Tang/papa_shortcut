[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$LauncherScriptPath,
    [string]$ShortcutName = 'Papa Shortcut.lnk'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($LauncherScriptPath)) {
    $scriptDirectory = Split-Path -Path $PSCommandPath -Parent
    $LauncherScriptPath = Join-Path $scriptDirectory 'dropdown-launcher.ps1'
}

function New-OrUpdateShortcut {
    param(
        [string]$ShortcutPath,
        [string]$TargetPath,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.WindowStyle = 1
    $shortcut.Save()
}

if (-not (Test-Path -LiteralPath $LauncherScriptPath)) {
    throw "Launcher script not found: $LauncherScriptPath"
}

$launcherAbsolutePath = (Resolve-Path -LiteralPath $LauncherScriptPath).Path
$launcherWorkDir = Split-Path -Path $launcherAbsolutePath -Parent
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$launcherArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcherAbsolutePath`""

$desktopPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$startupPath = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)

$targets = @(
    [pscustomobject]@{
        Location = 'Desktop'
        ShortcutPath = (Join-Path $desktopPath $ShortcutName)
    },
    [pscustomobject]@{
        Location = 'Startup'
        ShortcutPath = (Join-Path $startupPath $ShortcutName)
    }
)

$results = @()

foreach ($target in $targets) {
    $status = 'Skipped'
    $action = "Create or update '$ShortcutName'"

    if ($PSCmdlet.ShouldProcess($target.ShortcutPath, $action)) {
        New-OrUpdateShortcut `
            -ShortcutPath $target.ShortcutPath `
            -TargetPath $powershellPath `
            -Arguments $launcherArguments `
            -WorkingDirectory $launcherWorkDir `
            -Description 'Papa Shortcut Launcher'

        $status = 'Updated'
    }
    else {
        $status = 'Skipped (-WhatIf)'
    }

    $results += [pscustomobject]@{
        Location = $target.Location
        ShortcutPath = $target.ShortcutPath
        Status = $status
    }
}

$results | Format-Table -AutoSize
