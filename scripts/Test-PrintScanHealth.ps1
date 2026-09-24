<#
.SYNOPSIS
    Test-PrintScanHealth.ps1 - layered factory device diagnostic.
.DESCRIPTION
    Checks network reachability, print queue, label printer, scanner path and
    MiniERP reachability. USB keyboard-wedge scanners are reported separately
    from network scanners so the runbook does not assume every scanner has an IP.
.EXAMPLE
    .\Test-PrintScanHealth.ps1 -PrintServer fs01.company.local -LabelPrinter 192.168.40.30
#>
[CmdletBinding()]
param(
    [string]$PrintServer = 'fs01.company.local',
    [string]$LabelPrinter = '192.168.40.30',
    [int]$LabelPort = 9100,
    [string]$MiniErpHealthUrl = 'http://minierp.company.local/health',
    [switch]$IncludeUsbWedge
)

$ErrorActionPreference = 'Continue'
function Check([string]$name, [scriptblock]$body) {
    try { $ok = & $body; [pscustomobject]@{name=$name; ok=[bool]$ok; at=(Get-Date).ToUniversalTime().ToString('o')} }
    catch { [pscustomobject]@{name=$name; ok=$false; error=$_.Exception.Message; at=(Get-Date).ToUniversalTime().ToString('o')} }
}
$results = @(
    Check 'Print server SMB 445' { (Test-NetConnection $PrintServer -Port 445 -WarningAction SilentlyContinue).TcpTestSucceeded }
    Check 'Label printer TCP 9100' { (Test-NetConnection $LabelPrinter -Port $LabelPort -WarningAction SilentlyContinue).TcpTestSucceeded }
    Check 'MiniERP health' { (Invoke-WebRequest $MiniErpHealthUrl -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
)
if ($IncludeUsbWedge) {
    $results += Check 'USB keyboard-wedge scanner' {
        Get-PnpDevice -Class HIDClass -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'scanner|barcode' } | Select-Object -First 1
    }
}
$results | ConvertTo-Json -Depth 5
if ($results | Where-Object { -not $_.ok }) { exit 1 }
