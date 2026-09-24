<#
.SYNOPSIS
    Backup-HelpdeskData.ps1 - timestamped, checksummed portal JSON backup.
.DESCRIPTION
    Validates the portal JSON before copying it to a retention-managed backup
    directory. The script is safe to run repeatedly and does not contain secrets.
.EXAMPLE
    .\Backup-HelpdeskData.ps1 -DataDir .\data -Retention 14
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$DataDir = '.\data',
    [ValidateRange(1,365)]
    [int]$Retention = 14
)

$ErrorActionPreference = 'Stop'
$source = Join-Path $DataDir 'db.json'
if (-not (Test-Path $source)) { throw "Portal database not found: $source" }
$parsed = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
foreach ($collection in @('assets','tickets','licenses')) {
    if ($null -ne $parsed.$collection -and $parsed.$collection -isnot [System.Array]) { throw "Collection $collection is not an array." }
}
$backupDir = Join-Path $DataDir 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
$target = Join-Path $backupDir "db-$stamp.json"
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($PSCmdlet.ShouldProcess($source, "Create backup $target")) {
    Copy-Item -LiteralPath $source -Destination $target -Force
    "$hash  $(Split-Path $target -Leaf)" | Set-Content -LiteralPath "$target.sha256" -Encoding ASCII
    Get-ChildItem -LiteralPath $backupDir -Filter 'db-*.json' | Sort-Object Name -Descending | Select-Object -Skip $Retention | Remove-Item -Force
}
[pscustomobject]@{ source=$source; backup=$target; sha256=$hash; retention=$Retention } | ConvertTo-Json
