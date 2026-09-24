<#
.SYNOPSIS
    Restore-HelpdeskData.ps1 - validate and restore a portal backup safely.
.DESCRIPTION
    Validates JSON and checksum, refuses to overwrite the live database unless
    -Force is supplied, and writes an evidence record beside the target.
.EXAMPLE
    .\Restore-HelpdeskData.ps1 -BackupFile .\data\backups\db-demo.json -TargetFile .\data\db.restore-test.json
#>
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupFile,
    [Parameter(Mandatory=$true)]
    [string]$TargetFile,
    [string]$EvidencePath = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $BackupFile)) { throw "Backup not found: $BackupFile" }
$raw = Get-Content -LiteralPath $BackupFile -Raw
$parsed = $raw | ConvertFrom-Json
foreach ($collection in @('assets','tickets','licenses')) {
    if ($null -ne $parsed.$collection -and $parsed.$collection -isnot [System.Array]) { throw "Backup collection $collection is invalid." }
}
$checksumFile = "$BackupFile.sha256"
if (Test-Path $checksumFile) {
    $expected = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $BackupFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'Backup checksum mismatch.' }
}
if ((Test-Path $TargetFile) -and -not $Force) { throw 'Target exists; use -Force only after approval.' }
if ([string]::IsNullOrWhiteSpace($EvidencePath)) { $EvidencePath = "$TargetFile.restore.json" }
$parent = Split-Path -Parent $TargetFile
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$restored = $false
if ($PSCmdlet.ShouldProcess($BackupFile, "Restore to $TargetFile")) {
    Copy-Item -LiteralPath $BackupFile -Destination $TargetFile -Force
    $restored = $true
}
$evidenceParent = Split-Path -Parent $EvidencePath
if ($evidenceParent) { New-Item -ItemType Directory -Path $evidenceParent -Force | Out-Null }
$record = [ordered]@{ backup=$BackupFile; target=$TargetFile; valid=$true; restored=$restored; restoredAt=(Get-Date).ToUniversalTime().ToString('o') }
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
$record | ConvertTo-Json -Depth 5
