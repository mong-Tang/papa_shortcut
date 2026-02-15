param(
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $scriptDirectory = Split-Path -Path $PSCommandPath -Parent
    $ConfigPath = Join-Path $scriptDirectory 'shortcuts.json'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show-LauncherError {
    param([string]$Message)

    [void][System.Windows.Forms.MessageBox]::Show(
        $Message,
        'Papa Shortcut',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
}

function Assert-NonEmptyString {
    param(
        [AllowNull()][object]$Value,
        [string]$FieldName,
        [string]$NodePath
    )

    if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "[$NodePath] '$FieldName' must be a non-empty string."
    }
}

function Validate-ShortcutNode {
    param(
        [AllowNull()][object]$Node,
        [string]$NodePath
    )

    if ($null -eq $Node) {
        throw "[$NodePath] node must not be null."
    }

    $properties = $Node.PSObject.Properties.Name
    if (-not ($properties -contains 'name')) {
        throw "[$NodePath] 'name' is required."
    }
    if (-not ($properties -contains 'type')) {
        throw "[$NodePath] 'type' is required."
    }

    Assert-NonEmptyString -Value $Node.name -FieldName 'name' -NodePath $NodePath
    Assert-NonEmptyString -Value $Node.type -FieldName 'type' -NodePath $NodePath

    $nodeName = $Node.name.Trim()
    $normalizedType = $Node.type.Trim().ToLowerInvariant()
    $typedPath = "$NodePath/$nodeName"

    if ($normalizedType -notin @('group', 'shortcut')) {
        throw "[$typedPath] 'type' must be 'group' or 'shortcut'."
    }

    $hasChildren = $properties -contains 'children'
    $hasTarget = $properties -contains 'target'

    if ($normalizedType -eq 'group') {
        if ($hasTarget) {
            throw "[$typedPath] group must not contain 'target'."
        }
        if (-not $hasChildren) {
            throw "[$typedPath] group requires 'children'."
        }
        if (-not ($Node.children -is [System.Array])) {
            throw "[$typedPath] 'children' must be an array."
        }

        for ($index = 0; $index -lt $Node.children.Count; $index++) {
            Validate-ShortcutNode -Node $Node.children[$index] -NodePath "$typedPath.children[$index]"
        }

        return
    }

    if ($hasChildren) {
        throw "[$typedPath] shortcut must not contain 'children'."
    }
    if (-not $hasTarget) {
        throw "[$typedPath] shortcut requires 'target'."
    }

    Assert-NonEmptyString -Value $Node.target -FieldName 'target' -NodePath $typedPath
}

function Read-ShortcutConfig {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Config file not found: $Path"
    }

    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        $config = $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Config parse failed: $($_.Exception.Message)"
    }

    if ($null -eq $config) {
        throw 'Config is empty.'
    }

    $properties = $config.PSObject.Properties.Name
    if (-not ($properties -contains 'version')) {
        throw "'version' is required."
    }
    if (-not ($config.version -is [int] -or $config.version -is [long])) {
        throw "'version' must be integer 1."
    }
    if ([long]$config.version -ne 1) {
        throw "'version' must be 1."
    }

    if (-not ($properties -contains 'items')) {
        throw "'items' is required."
    }
    if (-not ($config.items -is [System.Array])) {
        throw "'items' must be an array."
    }

    for ($index = 0; $index -lt $config.items.Count; $index++) {
        Validate-ShortcutNode -Node $config.items[$index] -NodePath "items[$index]"
    }

    return $config
}

function Open-Target {
    param(
        [string]$Name,
        [string]$Target,
        [System.Windows.Forms.Label]$StatusLabel
    )

    try {
        if ($Target -match '^https?://') {
            Start-Process $Target | Out-Null
        }
        else {
            Start-Process -FilePath $Target | Out-Null
        }

        $StatusLabel.Text = "Launched: $Name"
    }
    catch {
        $StatusLabel.Text = "Launch failed: $Name"
        Show-LauncherError -Message "Failed to launch: $Name`nTarget: $Target`nError: $($_.Exception.Message)"
    }
}

try {
    $config = Read-ShortcutConfig -Path $ConfigPath
}
catch {
    Show-LauncherError -Message $_.Exception.Message
    exit 1
}

$script:RootItems = @($config.items)
$script:CurrentItems = @($script:RootItems)
$script:PathSegments = @()
$script:NavigationStack = New-Object System.Collections.Stack

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Papa Shortcut'
$form.Size = New-Object System.Drawing.Size(640, 500)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.KeyPreview = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(245, 247, 250)

$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Location = New-Object System.Drawing.Point(16, 14)
$titleLabel.Size = New-Object System.Drawing.Size(600, 28)
$titleLabel.Text = 'Papa Shortcut Launcher'
$titleLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 13, [System.Drawing.FontStyle]::Bold)

$breadcrumbLabel = New-Object System.Windows.Forms.Label
$breadcrumbLabel.Location = New-Object System.Drawing.Point(16, 48)
$breadcrumbLabel.Size = New-Object System.Drawing.Size(600, 22)
$breadcrumbLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)
$breadcrumbLabel.ForeColor = [System.Drawing.Color]::FromArgb(70, 70, 70)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.Location = New-Object System.Drawing.Point(16, 72)
$hintLabel.Size = New-Object System.Drawing.Size(600, 22)
$hintLabel.Text = 'Single click: open folder / launch item | Enter: open | Backspace: back | Esc: close'
$hintLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)

$listBox = New-Object System.Windows.Forms.ListBox
$listBox.Location = New-Object System.Drawing.Point(16, 102)
$listBox.Size = New-Object System.Drawing.Size(600, 300)
$listBox.Font = New-Object System.Drawing.Font('Malgun Gothic', 10)
$listBox.HorizontalScrollbar = $true

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(16, 410)
$statusLabel.Size = New-Object System.Drawing.Size(600, 24)
$statusLabel.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(60, 60, 60)

$backButton = New-Object System.Windows.Forms.Button
$backButton.Location = New-Object System.Drawing.Point(16, 436)
$backButton.Size = New-Object System.Drawing.Size(90, 30)
$backButton.Text = 'Back'
$backButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)

$homeButton = New-Object System.Windows.Forms.Button
$homeButton.Location = New-Object System.Drawing.Point(112, 436)
$homeButton.Size = New-Object System.Drawing.Size(90, 30)
$homeButton.Text = 'Home'
$homeButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Location = New-Object System.Drawing.Point(526, 436)
$closeButton.Size = New-Object System.Drawing.Size(90, 30)
$closeButton.Text = 'Close'
$closeButton.Font = New-Object System.Drawing.Font('Malgun Gothic', 9)

function Get-BreadcrumbText {
    if ($script:PathSegments.Count -eq 0) {
        return 'Home'
    }

    return "Home > $($script:PathSegments -join ' > ')"
}

function Render-CurrentView {
    $listBox.BeginUpdate()
    $listBox.Items.Clear()

    foreach ($item in $script:CurrentItems) {
        $prefix = if ($item.type -ieq 'group') { '[Folder]' } else { '[Run]' }
        [void]$listBox.Items.Add("$prefix $($item.name)")
    }

    $listBox.EndUpdate()

    $breadcrumbLabel.Text = "Current: $(Get-BreadcrumbText)"
    $backButton.Enabled = ($script:NavigationStack.Count -gt 0)
    $homeButton.Enabled = ($script:PathSegments.Count -gt 0)

    if ($listBox.Items.Count -gt 0) {
        $listBox.SelectedIndex = 0
        if ($script:PathSegments.Count -eq 0) {
            $statusLabel.Text = "Root items: $($listBox.Items.Count)"
        }
        else {
            $statusLabel.Text = "Child items: $($listBox.Items.Count)"
        }
    }
    else {
        $statusLabel.Text = 'No items to display.'
    }
}

function Go-Back {
    if ($script:NavigationStack.Count -eq 0) {
        $statusLabel.Text = 'Already at Home.'
        return
    }

    $state = $script:NavigationStack.Pop()
    $script:CurrentItems = @($state.Items)
    $script:PathSegments = @($state.PathSegments)

    Render-CurrentView
}

function Go-Home {
    if ($script:PathSegments.Count -eq 0) {
        $statusLabel.Text = 'Already at Home.'
        return
    }

    $script:NavigationStack.Clear()
    $script:CurrentItems = @($script:RootItems)
    $script:PathSegments = @()

    Render-CurrentView
}

function Invoke-ItemAtIndex {
    param([int]$Index)

    if ($Index -lt 0 -or $Index -ge $script:CurrentItems.Count) {
        return
    }

    $item = $script:CurrentItems[$Index]

    if ($item.type -ieq 'group') {
        $state = [pscustomobject]@{
            Items = @($script:CurrentItems)
            PathSegments = @($script:PathSegments)
        }

        $script:NavigationStack.Push($state)
        $script:CurrentItems = @($item.children)
        $script:PathSegments = @($script:PathSegments + @($item.name))

        Render-CurrentView
        $statusLabel.Text = "Opened: $($item.name)"
        return
    }

    Open-Target -Name $item.name -Target $item.target -StatusLabel $statusLabel
}

$listBox.Add_MouseClick({
    param($sender, $e)

    $index = $sender.IndexFromPoint($e.Location)
    if ($index -ge 0) {
        $sender.SelectedIndex = $index
        Invoke-ItemAtIndex -Index $index
    }
})

$listBox.Add_KeyDown({
    param($sender, $e)

    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) {
        Invoke-ItemAtIndex -Index $sender.SelectedIndex
        $e.SuppressKeyPress = $true
        $e.Handled = $true
    }
    elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::Back) {
        Go-Back
        $e.SuppressKeyPress = $true
        $e.Handled = $true
    }
})

$backButton.Add_Click({ Go-Back })
$homeButton.Add_Click({ Go-Home })
$closeButton.Add_Click({ $form.Close() })

$form.Add_KeyDown({
    param($sender, $e)

    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        $form.Close()
        $e.Handled = $true
    }
    elseif ($e.KeyCode -eq [System.Windows.Forms.Keys]::Back) {
        Go-Back
        $e.Handled = $true
    }
})

$form.Controls.Add($titleLabel)
$form.Controls.Add($breadcrumbLabel)
$form.Controls.Add($hintLabel)
$form.Controls.Add($listBox)
$form.Controls.Add($statusLabel)
$form.Controls.Add($backButton)
$form.Controls.Add($homeButton)
$form.Controls.Add($closeButton)

$form.Add_Shown({
    Render-CurrentView
    $form.Activate()
})

[void]$form.ShowDialog()
