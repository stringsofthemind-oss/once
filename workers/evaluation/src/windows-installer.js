const POWERSHELL_MARKER = "#__ONCE_POWERSHELL__#";

const POWERSHELL = String.raw`
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Show-OnceMessage {
  param(
    [string]$Text,
    [string]$Caption = "Once Setup",
    [System.Windows.Forms.MessageBoxButtons]$Buttons = [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]$Icon = [System.Windows.Forms.MessageBoxIcon]::Information
  )

  return [System.Windows.Forms.MessageBox]::Show($Text, $Caption, $Buttons, $Icon)
}

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Text
  )

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-ValidOnceKeyFromClipboard {
  $value = [System.Windows.Forms.Clipboard]::GetText().Trim()

  if ($value -notmatch '^once_test_[A-Za-z0-9_-]{32,128}$') {
    Show-OnceMessage -Text "Once could not find a valid evaluation API key on your clipboard.`r`n`r`nGo back to the Once evaluation page, click Copy API key, then run OnceSetup again." -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    exit 2
  }

  return $value
}

function Test-OnceKey {
  param([string]$ApiKey)

  $probe = "windows-installer-" + ([guid]::NewGuid().ToString("N"))
  $headers = @{ Authorization = "Bearer " + $ApiKey }

  try {
    $truth = Invoke-RestMethod -Uri ("https://api.onceexec.com/v1/truth/" + $probe) -Method GET -Headers $headers
  }
  catch {
    throw "The Once API key could not be verified. Return to the evaluation page and create a fresh evaluation key."
  }

  if ($truth.ledger_state -ne "ABSENT" -or [int]$truth.side_effects -ne 0) {
    throw "Once returned an unexpected safety-check result. Setup stopped without installing anything."
  }
}

function Get-NodeTools {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    $node = Get-Command node -ErrorAction SilentlyContinue
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
  }

  if (-not $node -or -not $npm) {
    $answer = Show-OnceMessage -Text "Once automatic setup currently needs Node.js 18 or newer.`r`n`r`nNode.js was not found on this computer.`r`n`r`nOpen the Node.js download page now?" -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNo) -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-Process "https://nodejs.org/en/download"
    }
    exit 3
  }

  $version = & $node.Source -p "process.versions.node"
  $major = 0
  if ($version -match '^(\d+)\.') {
    $major = [int]$Matches[1]
  }

  if ($major -lt 18) {
    Show-OnceMessage -Text ("Once needs Node.js 18 or newer. This computer has Node.js " + $version + ".") -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    exit 4
  }

  return @{
    Node = $node.Source
    Npm = $npm.Source
    Version = $version
  }
}

function New-DemoProject {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = $env:USERPROFILE
  }

  $base = Join-Path $documents "Once Evaluation Demo"
  $root = $base
  $suffix = 2

  while (Test-Path $root) {
    $root = $base + " " + $suffix
    $suffix += 1
  }

  New-Item -ItemType Directory -Path $root -Force | Out-Null

  $packageJson = @'
{
  "name": "once-evaluation-demo",
  "private": true,
  "type": "module"
}
'@

  Write-Utf8NoBom -Path (Join-Path $root "package.json") -Text $packageJson
  return $root
}

function Choose-ExistingProject {
  while ($true) {
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Choose the project folder that contains package.json"
    $dialog.ShowNewFolderButton = $false

    $result = $dialog.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
      return $null
    }

    $root = $dialog.SelectedPath
    if (Test-Path (Join-Path $root "package.json")) {
      return $root
    }

    $choice = Show-OnceMessage -Text "That folder does not contain package.json, so Once cannot safely identify it as a Node.js project.`r`n`r`nChoose another folder?" -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNo) -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) {
      return $null
    }
  }
}

function Confirm-KeyPersistence {
  param(
    [string]$Root,
    [string]$ApiKey
  )

  $envPath = Join-Path $Root ".env"
  if (-not (Test-Path $envPath)) {
    return $true
  }

  $text = [System.IO.File]::ReadAllText($envPath)
  $match = [regex]::Match($text, '(?m)^ONCE_API_KEY=(.*)$')

  if (-not $match.Success) {
    return $true
  }

  $existing = $match.Groups[1].Value.Trim()
  if ($existing -eq $ApiKey) {
    return $true
  }

  $choice = Show-OnceMessage -Text "This project already has a different Once API key in .env.`r`n`r`nReplace it with this evaluation key?" -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNo) -Icon ([System.Windows.Forms.MessageBoxIcon]::Warning)
  return $choice -eq [System.Windows.Forms.DialogResult]::Yes
}

function Save-OnceKey {
  param(
    [string]$Root,
    [string]$ApiKey
  )

  $envPath = Join-Path $Root ".env"
  $envText = ""
  if (Test-Path $envPath) {
    $envText = [System.IO.File]::ReadAllText($envPath)
  }

  if ($envText -match '(?m)^ONCE_API_KEY=.*$') {
    $envText = [regex]::Replace($envText, '(?m)^ONCE_API_KEY=.*$', ("ONCE_API_KEY=" + $ApiKey))
  }
  else {
    if ($envText.Length -gt 0 -and -not $envText.EndsWith("`n")) {
      $envText += "`r`n"
    }
    $envText += "ONCE_API_KEY=" + $ApiKey + "`r`n"
  }

  Write-Utf8NoBom -Path $envPath -Text $envText

  $ignorePath = Join-Path $Root ".gitignore"
  $ignoreText = ""
  if (Test-Path $ignorePath) {
    $ignoreText = [System.IO.File]::ReadAllText($ignorePath)
  }

  $hasEnvIgnore = $false
  foreach ($line in ($ignoreText -split '\r?\n')) {
    if ($line.Trim() -eq ".env") {
      $hasEnvIgnore = $true
      break
    }
  }

  if (-not $hasEnvIgnore) {
    if ($ignoreText.Length -gt 0 -and -not $ignoreText.EndsWith("`n")) {
      $ignoreText += "`r`n"
    }
    $ignoreText += ".env`r`n"
    Write-Utf8NoBom -Path $ignorePath -Text $ignoreText
  }
}

function Install-OnceSdk {
  param(
    [string]$Root,
    [string]$Npm
  )

  Write-Host ""
  Write-Host "Installing Once into:" -ForegroundColor Cyan
  Write-Host $Root
  Write-Host ""

  Push-Location $Root
  try {
    & $Npm install @once-agent/sdk
    if ($LASTEXITCODE -ne 0) {
      throw "npm install failed with exit code " + $LASTEXITCODE
    }
  }
  finally {
    Pop-Location
  }
}

function Run-OnceDemo {
  param(
    [string]$Root,
    [string]$Node,
    [string]$ApiKey
  )

  $demoPath = Join-Path $Root "once-demo.mjs"
  $demo = @'
import { randomUUID } from "node:crypto";
import { Once } from "@once-agent/sdk";

const once = new Once({
  baseUrl: "https://api.onceexec.com"
});

const operationId = "installer-demo-" + randomUUID().replaceAll("-", "");
const action = {
  type: "once_evaluation_demo",
  source: "windows_installer"
};

const first = await once.execute({
  operationId,
  provider: "blind_test",
  action
});

const retry = await once.execute({
  operationId,
  provider: "blind_test",
  action
});

if (first.state !== "CONFIRMED" || Number(first.side_effects) !== 1) {
  throw new Error("first_execution_check_failed");
}

if (retry.result !== "already_executed" || Number(retry.side_effects) !== 1) {
  throw new Error("retry_suppression_check_failed");
}

console.log("ONCE_DEMO_PASS");
'@

  Write-Utf8NoBom -Path $demoPath -Text $demo

  $previousKey = $env:ONCE_API_KEY
  $env:ONCE_API_KEY = $ApiKey

  Push-Location $Root
  try {
    $output = & $Node $demoPath 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
    if ($null -eq $previousKey) {
      Remove-Item Env:ONCE_API_KEY -ErrorAction SilentlyContinue
    }
    else {
      $env:ONCE_API_KEY = $previousKey
    }
  }

  if ($exitCode -ne 0 -or ($output -notcontains "ONCE_DEMO_PASS")) {
    throw "The Once demo could not complete its retry-suppression check."
  }
}

try {
  $apiKey = Get-ValidOnceKeyFromClipboard
  Test-OnceKey -ApiKey $apiKey

  $tools = Get-NodeTools

  $mode = Show-OnceMessage -Text "Where should Once be installed?`r`n`r`nYES — Create a safe Once demo project for me (recommended for first-time evaluation).`r`n`r`nNO — Let me choose an existing Node.js project.`r`n`r`nCANCEL — Exit without changing anything." -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNoCancel) -Icon ([System.Windows.Forms.MessageBoxIcon]::Question)

  $isDemo = $false
  $root = $null

  if ($mode -eq [System.Windows.Forms.DialogResult]::Yes) {
    $isDemo = $true
    $root = New-DemoProject
  }
  elseif ($mode -eq [System.Windows.Forms.DialogResult]::No) {
    $root = Choose-ExistingProject
    if (-not $root) {
      exit 0
    }
  }
  else {
    exit 0
  }

  if (-not (Confirm-KeyPersistence -Root $root -ApiKey $apiKey)) {
    Show-OnceMessage -Text "Setup cancelled. No Once API key was changed." | Out-Null
    exit 0
  }

  $confirmText = "Once is ready to set up this folder:`r`n`r`n" + $root + "`r`n`r`nIt will:`r`n• install @once-agent/sdk`r`n• save your evaluation key to .env`r`n• add .env to .gitignore`r`n• verify the Once connection`r`n`r`nIt will not modify your application source code.`r`n`r`nContinue?"
  $confirm = Show-OnceMessage -Text $confirmText -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNo) -Icon ([System.Windows.Forms.MessageBoxIcon]::Question)
  if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) {
    exit 0
  }

  Install-OnceSdk -Root $root -Npm $tools.Npm
  Save-OnceKey -Root $root -ApiKey $apiKey
  Test-OnceKey -ApiKey $apiKey

  if ($isDemo) {
    Run-OnceDemo -Root $root -Node $tools.Node -ApiKey $apiKey
    $doneText = "Once is installed and connected.`r`n`r`nThe demo also proved the safety behavior:`r`n✓ first action executed`r`n✓ retry was suppressed`r`n✓ side effects stayed at 1`r`n`r`nDemo folder:`r`n" + $root + "`r`n`r`nOpen the demo folder now?"
    $open = Show-OnceMessage -Text $doneText -Buttons ([System.Windows.Forms.MessageBoxButtons]::YesNo) -Icon ([System.Windows.Forms.MessageBoxIcon]::Information)
    if ($open -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-Process explorer.exe $root
    }
  }
  else {
    $doneText = "Once is installed and connected to this project.`r`n`r`n✓ SDK installed`r`n✓ API key saved securely in .env`r`n✓ .env added to .gitignore`r`n✓ Once API connection verified`r`n`r`nNo application source files were changed.`r`n`r`nProject:`r`n" + $root
    Show-OnceMessage -Text $doneText -Icon ([System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  }

  $apiKey = $null
  [System.Windows.Forms.Clipboard]::Clear()
  exit 0
}
catch {
  $message = "Once setup stopped safely.`r`n`r`n" + $_.Exception.Message + "`r`n`r`nNo retry or hidden recovery action will be attempted automatically."
  Show-OnceMessage -Text $message -Icon ([System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  exit 1
}
`;

const BATCH = [
  "@echo off",
  "setlocal",
  'set "ONCE_INSTALLER=%~f0"',
  'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$text=[System.IO.File]::ReadAllText($env:ONCE_INSTALLER);$marker=\'#__ONCE_POWERSHELL__#\';$index=$text.IndexOf($marker);if($index -lt 0){throw \'Installer payload missing.\'};Invoke-Expression $text.Substring($index+$marker.Length)"',
  'set "ONCE_EXIT=%ERRORLEVEL%"',
  "endlocal & exit /b %ONCE_EXIT%",
  POWERSHELL_MARKER,
].join("\r\n");

export const WINDOWS_INSTALLER = `${BATCH}\r\n${POWERSHELL.trimStart()}\r\n`;
