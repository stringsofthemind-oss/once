param(
  [Parameter(Mandatory = $true)]
  [string]$CustomerId,

  [string]$ApiBase = "https://api.onceexec.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }
}

function Invoke-CurlJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [hashtable]$Headers = @{},

    [string]$Body = ""
  )

  $responseTemp = [System.IO.Path]::GetTempFileName()
  $bodyTemp = $null

  try {
    $args = @(
      "-sS",
      "--max-time", "20",
      "-o", $responseTemp,
      "-w", "%{http_code}",
      "-X", $Method
    )

    foreach ($name in $Headers.Keys) {
      $args += @("-H", "$name`: $($Headers[$name])")
    }

    if ($Body -ne "") {
      $bodyTemp = [System.IO.Path]::GetTempFileName()
      [System.IO.File]::WriteAllText(
        $bodyTemp,
        $Body,
        [System.Text.UTF8Encoding]::new($false)
      )

      $args += @(
        "-H", "content-type: application/json",
        "--data-binary", "@$bodyTemp"
      )
    }

    $args += $Uri

    $statusText = & curl.exe @args

    if ($LASTEXITCODE -ne 0) {
      throw "curl failed for $Uri"
    }

    $raw = Get-Content -LiteralPath $responseTemp -Raw
    $parsed = $null

    if (-not [string]::IsNullOrWhiteSpace($raw)) {
      try {
        $parsed = $raw | ConvertFrom-Json
      }
      catch {
        $parsed = $null
      }
    }

    return [pscustomobject]@{
      Status = [int]$statusText
      Body   = $parsed
      Raw    = $raw
    }
  }
  finally {
    Remove-Item -LiteralPath $responseTemp -Force -ErrorAction SilentlyContinue
    if ($bodyTemp) {
      Remove-Item -LiteralPath $bodyTemp -Force -ErrorAction SilentlyContinue
    }
  }
}

$evaluationDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Assert-True ($CustomerId -match '^cus_[A-Za-z0-9]+$') "CustomerId does not look like a Stripe customer ID."

$npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npx) {
  $npx = Get-Command npx -ErrorAction SilentlyContinue
}
Assert-True ($null -ne $npx) "npx was not found in PATH."

$previewName = "once-e2e-" + [guid]::NewGuid().ToString("N").Substring(0, 12)
$token = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
$tempConfig = Join-Path $evaluationDir ("wrangler.preview-e2e." + [guid]::NewGuid().ToString("N") + ".json")
$previewCreated = $false

$config = [ordered]@{
  name = "once-evaluation-live-e2e"
  main = "e2e/bridge.js"
  compatibility_date = "2026-09-23"
  durable_objects = [ordered]@{
    bindings = @(
      [ordered]@{
        name = "Q18_TRUTH"
        class_name = "Q18Truth"
        script_name = "once-q18-cloud"
      },
      [ordered]@{
        name = "SANDBOX_CLAIMS"
        class_name = "SandboxClaim"
        script_name = "once-sandbox-playground"
      }
    )
  }
  previews = [ordered]@{
    vars = [ordered]@{
      E2E_TOKEN = $token
      E2E_CUSTOMER_ID = $CustomerId
    }
    durable_objects = [ordered]@{
      bindings = @(
        [ordered]@{
          name = "Q18_TRUTH"
          class_name = "Q18Truth"
          script_name = "once-q18-cloud"
        },
        [ordered]@{
          name = "SANDBOX_CLAIMS"
          class_name = "SandboxClaim"
          script_name = "once-sandbox-playground"
        }
      )
    }
  }
}

try {
  $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $tempConfig -Encoding UTF8

  Write-Host "Creating isolated Cloudflare Worker Preview..." -ForegroundColor Cyan

  $previewOutput = & $npx.Source `
    --yes `
    wrangler@4.137.0 `
    preview `
    --name $previewName `
    --config $tempConfig `
    --ignore-base-config `
    --json

  if ($LASTEXITCODE -ne 0) {
    throw "wrangler preview failed with exit code $LASTEXITCODE"
  }

  $previewResult = $previewOutput | ConvertFrom-Json
  $previewUrl = $null

  if ($previewResult.preview_urls -and $previewResult.preview_urls.Count -gt 0) {
    $previewUrl = [string]$previewResult.preview_urls[0]
  }
  elseif ($previewResult.preview -and $previewResult.preview.urls -and $previewResult.preview.urls.Count -gt 0) {
    $previewUrl = [string]$previewResult.preview.urls[0]
  }

  Assert-True (-not [string]::IsNullOrWhiteSpace($previewUrl)) "Wrangler did not return a Preview URL."
  $previewCreated = $true

  Write-Host "Preview created: $previewName" -ForegroundColor Green
  Write-Host "Waiting for Preview health..."

  $bridgeHeaders = @{ "x-once-e2e-token" = $token }
  $healthy = $false

  for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
      $health = Invoke-CurlJson -Method "GET" -Uri ($previewUrl.TrimEnd('/') + "/health") -Headers $bridgeHeaders
      if ($health.Status -eq 200 -and $health.Body.status -eq "online") {
        $healthy = $true
        break
      }
    }
    catch {
      # Preview propagation can take a few seconds.
    }

    Start-Sleep -Seconds 2
  }

  Assert-True $healthy "Preview did not become healthy within 60 seconds."
  Write-Host "Preview bridge: PASS" -ForegroundColor Green

  $claim = $null

  for ($attempt = 1; $attempt -le 15; $attempt++) {
    $candidate = Invoke-CurlJson -Method "POST" -Uri ($previewUrl.TrimEnd('/') + "/claim") -Headers $bridgeHeaders

    if ($candidate.Status -eq 200) {
      $claim = $candidate
      break
    }

    if (
      $candidate.Status -eq 409 -and
      $candidate.Body -and
      $candidate.Body.error -eq "entitlement_not_ready"
    ) {
      Write-Host "Waiting for Stripe webhook entitlement propagation..."
      Start-Sleep -Seconds 4
      continue
    }

    throw "Key claim failed with HTTP $($candidate.Status): $($candidate.Raw)"
  }

  Assert-True ($null -ne $claim) "Entitlement did not become ready in time."
  Assert-True ($claim.Body.entitlement_status -in @("trialing", "active")) "Unexpected entitlement status."
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$claim.Body.api_key)) "Claim did not return an API key."

  $apiKey = [string]$claim.Body.api_key
  $keyId = [string]$claim.Body.key_id

  Write-Host "Webhook -> Q18 entitlement -> SandboxClaim: PASS" -ForegroundColor Green

  $operationId = "evaluation-e2e-" + [guid]::NewGuid().ToString("N")
  $authHeaders = @{ Authorization = "Bearer $apiKey" }

  $payload = @{
    operation_id = $operationId
    provider = "blind_test"
    action = @{
      type = "evaluation_e2e"
      mode = "sandbox"
    }
  } | ConvertTo-Json -Depth 10 -Compress

  $first = Invoke-CurlJson -Method "POST" -Uri "$ApiBase/v1/execute" -Headers $authHeaders -Body $payload
  Assert-True ($first.Status -ge 200 -and $first.Status -lt 300) "First Once execution failed with HTTP $($first.Status): $($first.Raw)"
  Write-Host "First protected execution: PASS" -ForegroundColor Green

  $retry = Invoke-CurlJson -Method "POST" -Uri "$ApiBase/v1/execute" -Headers $authHeaders -Body $payload
  Assert-True ($retry.Status -ge 200 -and $retry.Status -lt 300) "Same-operation retry failed with HTTP $($retry.Status): $($retry.Raw)"
  Write-Host "Same-operation retry: PASS" -ForegroundColor Green

  $driftPayload = @{
    operation_id = $operationId
    provider = "blind_test"
    action = @{
      type = "evaluation_e2e_drift"
      mode = "sandbox"
    }
  } | ConvertTo-Json -Depth 10 -Compress

  $drift = Invoke-CurlJson -Method "POST" -Uri "$ApiBase/v1/execute" -Headers $authHeaders -Body $driftPayload
  Assert-True ($drift.Status -eq 409) "Semantic drift should fail closed with HTTP 409, got $($drift.Status): $($drift.Raw)"
  Write-Host "Semantic drift conflict: PASS (409)" -ForegroundColor Green

  $truth = Invoke-CurlJson -Method "GET" -Uri "$ApiBase/v1/truth/$([uri]::EscapeDataString($operationId))" -Headers $authHeaders
  Assert-True ($truth.Status -eq 200) "Truth lookup failed with HTTP $($truth.Status): $($truth.Raw)"
  Assert-True ($truth.Body.ledger_state -eq "CONFIRMED") "Truth ledger_state was not CONFIRMED: $($truth.Raw)"
  Assert-True ([int]$truth.Body.side_effects -eq 1) "Expected exactly one provider side effect: $($truth.Raw)"
  Assert-True ([bool]$truth.Body.provider_executed) "Provider execution was not confirmed: $($truth.Raw)"

  Write-Host "Durable truth: PASS (CONFIRMED, side_effects=1)" -ForegroundColor Green
  Write-Host ""
  Write-Host "=== ONCE LIVE SANDBOX E2E: PASS ===" -ForegroundColor Green
  Write-Host "Customer: $CustomerId"
  Write-Host "Entitlement: $($claim.Body.entitlement_status) / $($claim.Body.plan)"
  Write-Host "Key ID: $keyId"
  Write-Host "Operation: $operationId"
  Write-Host "Raw API key intentionally not printed."
}
catch {
  Write-Host ""
  Write-Host "=== ONCE LIVE SANDBOX E2E: FAIL ===" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
finally {
  if ($previewCreated) {
    Write-Host "Deleting temporary Cloudflare Preview..." -ForegroundColor DarkGray
    try {
      & $npx.Source `
        --yes `
        wrangler@4.137.0 `
        preview `
        delete `
        --name $previewName `
        --config $tempConfig `
        --skip-confirmation *> $null
    }
    catch {
      Write-Warning "Automatic Preview cleanup failed. Delete Preview '$previewName' manually."
    }
  }

  Remove-Item -LiteralPath $tempConfig -Force -ErrorAction SilentlyContinue
}
