param(
  [string]$Version = "0.1.3.0",
  [string]$Publisher = "CN=Once Test",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..")
$project = Join-Path $here "OnceSetup\OnceSetup.csproj"
$manifestSource = Join-Path $here "Packaging\AppxManifest.xml"
$work = Join-Path $here ".msix-build"
$publish = Join-Path $work "publish"
$package = Join-Path $work "package"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $here "artifacts"
}

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $publish -Force | Out-Null
New-Item -ItemType Directory -Path $package -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $package "Assets") -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

Write-Host "Publishing Once Setup..." -ForegroundColor Cyan
& dotnet publish $project `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:PublishTrimmed=false `
  -o $publish
if ($LASTEXITCODE -ne 0) {
  throw "dotnet publish failed with exit code $LASTEXITCODE"
}

$exe = Join-Path $publish "OnceSetup.exe"
if (-not (Test-Path $exe)) {
  throw "OnceSetup.exe was not produced."
}
Copy-Item $exe (Join-Path $package "OnceSetup.exe") -Force

$manifest = [System.IO.File]::ReadAllText($manifestSource)
$manifest = $manifest.Replace('Version="0.1.0.0"', ('Version="' + $Version + '"'))
$manifest = $manifest.Replace('Publisher="CN=Once Test"', ('Publisher="' + $Publisher + '"'))
[System.IO.File]::WriteAllText(
  (Join-Path $package "AppxManifest.xml"),
  $manifest,
  (New-Object System.Text.UTF8Encoding($false))
)

Add-Type -AssemblyName System.Drawing
function New-OnceAsset {
  param(
    [string]$Path,
    [int]$Width,
    [int]$Height
  )

  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(5, 9, 14))
      $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(57, 240, 160))
      try {
        $margin = [Math]::Max(2, [int]([Math]::Min($Width, $Height) * 0.18))
        $graphics.FillEllipse($brush, $margin, $margin, $Width - (2 * $margin), $Height - (2 * $margin))
      }
      finally {
        $brush.Dispose()
      }
    }
    finally {
      $graphics.Dispose()
    }
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $bitmap.Dispose()
  }
}

New-OnceAsset -Path (Join-Path $package "Assets\StoreLogo.png") -Width 50 -Height 50
New-OnceAsset -Path (Join-Path $package "Assets\Square44x44Logo.png") -Width 44 -Height 44
New-OnceAsset -Path (Join-Path $package "Assets\Square150x150Logo.png") -Width 150 -Height 150
New-OnceAsset -Path (Join-Path $package "Assets\Wide310x150Logo.png") -Width 310 -Height 150

$windowsKits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
$sdkVersions = Get-ChildItem $windowsKits -Directory -ErrorAction Stop |
  Where-Object { $_.Name -match '^10\.0\.' } |
  Sort-Object { [version]$_.Name } -Descending

$makeAppx = $null
$signTool = $null
foreach ($sdk in $sdkVersions) {
  $candidateMake = Join-Path $sdk.FullName "x64\makeappx.exe"
  $candidateSign = Join-Path $sdk.FullName "x64\signtool.exe"
  if ((Test-Path $candidateMake) -and (Test-Path $candidateSign)) {
    $makeAppx = $candidateMake
    $signTool = $candidateSign
    break
  }
}

if (-not $makeAppx -or -not $signTool) {
  throw "Windows SDK MakeAppx.exe / SignTool.exe were not found."
}

$msix = Join-Path $OutputDirectory "OnceSetup-$Version-x64-test.msix"
Remove-Item $msix -Force -ErrorAction SilentlyContinue

Write-Host "Packing MSIX..." -ForegroundColor Cyan
& $makeAppx pack /d $package /p $msix /o
if ($LASTEXITCODE -ne 0) {
  throw "MakeAppx failed with exit code $LASTEXITCODE"
}

if ($Publisher -eq "CN=Once Test") {
  Write-Host "Creating an ephemeral TEST signing certificate..." -ForegroundColor Yellow
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Publisher `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddDays(30)

  $passwordText = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
  $password = ConvertTo-SecureString $passwordText -AsPlainText -Force
  $pfx = Join-Path $work "once-test-signing.pfx"
  $cer = Join-Path $OutputDirectory "OnceSetup-Test.cer"

  try {
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null

    Write-Host "Signing test MSIX..." -ForegroundColor Cyan
    & $signTool sign /fd SHA256 /f $pfx /p $passwordText $msix
    if ($LASTEXITCODE -ne 0) {
      throw "SignTool failed with exit code $LASTEXITCODE"
    }
  }
  finally {
    Remove-Item $pfx -Force -ErrorAction SilentlyContinue
    Remove-Item $cert.PSPath -Force -ErrorAction SilentlyContinue
  }
}
else {
  Write-Host "Package created without local signing. Store/release signing must happen in the authorized release path." -ForegroundColor Yellow
}

$readme = @"
Once Setup MSIX — test artifact

This artifact is for private development testing only.

Files:
- $(Split-Path $msix -Leaf)
- OnceSetup-Test.cer (only when Publisher is CN=Once Test)

The test certificate is intentionally not embedded with a private key. For a private sideload test, trust the .cer on the test machine before opening the .msix.

Do not distribute this test-signed package to customers. Public Windows distribution should use the Microsoft Store signing path or another explicitly approved Microsoft-trusted signing route.
"@
[System.IO.File]::WriteAllText(
  (Join-Path $OutputDirectory "README-TESTING.txt"),
  $readme,
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "MSIX ready: $msix" -ForegroundColor Green
