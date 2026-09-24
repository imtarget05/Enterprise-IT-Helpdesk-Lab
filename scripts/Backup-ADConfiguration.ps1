<#
.SYNOPSIS
    Backup-ADConfiguration.ps1 - export lab recovery artifacts.
.DESCRIPTION
    Creates timestamped GPO, DHCP and DNS configuration evidence where the
    corresponding Windows Server role/cmdlet is available. Missing optional
    components are reported and do not fabricate a successful backup.
.EXAMPLE
    .\Backup-ADConfiguration.ps1 -OutputPath .\_evidence\ad-backup
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [string]$OutputPath = '.\_evidence\ad-backup',
    [string]$DnsServers = 'dc01.company.local'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssZ')
$root = Join-Path $OutputPath $stamp
New-Item -ItemType Directory -Path $root -Force | Out-Null
$results = [ordered]@{ createdAt=(Get-Date).ToUniversalTime().ToString('o'); path=$root; gpo=$false; dhcp=$false; dns=$false; notes=@() }
$gpoPath = Join-Path $root 'gpo'
if (Get-Command Backup-GPO -ErrorAction SilentlyContinue) {
    Backup-GPO -All -Path $gpoPath | Out-Null
    $results.gpo = $true
} else { $results.notes += 'Backup-GPO unavailable on this host.' }
$dhcpFile = Join-Path $root 'dhcp.xml'
if (Get-Command Export-DhcpServer -ErrorAction SilentlyContinue) {
    Export-DhcpServer -File $dhcpFile | Out-Null
    $results.dhcp = $true
} else { $results.notes += 'Export-DhcpServer unavailable on this host.' }
$dnsFile = Join-Path $root 'dns.txt'
try { Resolve-DnsName -Server $DnsServers -Type A -ErrorAction Stop | Out-File $dnsFile -Encoding UTF8; $results.dns = $true } catch { $results.notes += "DNS export failed: $($_.Exception.Message)" }
$results | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $root 'manifest.json') -Encoding UTF8
$results | ConvertTo-Json -Depth 5
