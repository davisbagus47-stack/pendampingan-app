param(
  [string]$VercelProject = 'pendampingan-app-mvbo',
  [switch]$SyncVercel
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Split-Path -Parent $scriptDir
$envPath = Join-Path $backendDir '.env'

function Read-SecretValue {
  param([string]$Prompt)

  $secureValue = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Set-DotEnvValue {
  param(
    [string]$Content,
    [string]$Name,
    [string]$Value
  )

  $pattern = '(?m)^[ \t]*' + [regex]::Escape($Name) + '[ \t]*=.*(?:\r?\n|$)'
  $replacement = "$Name=$Value`n"
  if ([regex]::IsMatch($Content, $pattern)) {
    return [regex]::Replace($Content, $pattern, $replacement, 1)
  }
  if ($Content.Length -gt 0 -and -not $Content.EndsWith("`n")) { $Content += "`n" }
  return $Content + $replacement
}

Write-Host 'Konfigurasi pendanaan wallet TPK' -ForegroundColor Cyan
Write-Host 'Private key hanya dibaca tersembunyi dan tidak pernah ditampilkan.'

$privateKey = Read-SecretValue 'Private key treasury Sepolia'
$privateKey = $privateKey -replace '\s', ''
if ($privateKey -notmatch '^(0x)?[0-9a-fA-F]{64}$') {
  throw 'Private key harus berupa 64 karakter hexadecimal.'
}
if (-not $privateKey.StartsWith('0x')) { $privateKey = "0x$privateKey" }

$amount = Read-Host 'Jumlah ETH per wallet [0.1]'
if ([string]::IsNullOrWhiteSpace($amount)) { $amount = '0.1' }
if ($amount -notmatch '^\d+(\.\d+)?$' -or [decimal]$amount -le 0) {
  throw 'Jumlah ETH tidak valid.'
}

$rpcUrl = Read-Host 'RPC URL Sepolia [https://ethereum-sepolia-rpc.publicnode.com]'
if ([string]::IsNullOrWhiteSpace($rpcUrl)) { $rpcUrl = 'https://ethereum-sepolia-rpc.publicnode.com' }
if ($rpcUrl -notmatch '^https?://') { throw 'RPC URL harus diawali http:// atau https://.' }

$values = [ordered]@{
  TPK_AUTO_FUND_ENABLED = 'true'
  TPK_FUNDING_PRIVATE_KEY = $privateKey
  TPK_FUNDING_AMOUNT_ETH = $amount
  TPK_FUNDING_RPC_URL = $rpcUrl
}

$content = if (Test-Path -LiteralPath $envPath) {
  [IO.File]::ReadAllText($envPath)
} else {
  ''
}
foreach ($entry in $values.GetEnumerator()) {
  $content = Set-DotEnvValue -Content $content -Name $entry.Key -Value $entry.Value
}
[IO.File]::WriteAllText($envPath, $content, [Text.UTF8Encoding]::new($false))
Write-Host "backend/.env diperbarui: $($values.Keys -join ', ')" -ForegroundColor Green

if (-not $SyncVercel) {
  Write-Host 'Vercel belum disentuh. Jalankan ulang dengan -SyncVercel setelah vercel login.' -ForegroundColor Yellow
  exit 0
}

$vercel = Get-Command vercel -ErrorAction SilentlyContinue
if (-not $vercel) {
  throw 'Vercel CLI belum terpasang. Jalankan: npm install --global vercel, lalu vercel login.'
}

Write-Host "Menyinkronkan variable ke project Vercel: $VercelProject" -ForegroundColor Cyan
Push-Location $backendDir
try {
  foreach ($entry in $values.GetEnumerator()) {
    Write-Host "Menambahkan $($entry.Key) ke Production..."
    $entry.Value | & $vercel.Source env add $entry.Key production
    if ($LASTEXITCODE -ne 0) {
      throw "Gagal menambahkan $($entry.Key). Jika variable sudah ada, perbarui dari dashboard Vercel atau hapus lalu jalankan ulang."
    }
  }
} finally {
  Pop-Location
}

Write-Host 'Variable Vercel berhasil dikirim. Redeploy project backend agar aktif.' -ForegroundColor Green
