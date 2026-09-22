<#
.SYNOPSIS
    Export-ITAssetAudit.ps1 - Automated IT Hardware & Software Audit Collector
.DESCRIPTION
    Queries local or remote computer WMI / CIM endpoints to gather full
    hardware specifications (Motherboard, CPU, RAM, Disk health, Network MAC)
    and installed operating system details, exporting results to JSON / CSV.
.EXAMPLE
    .\Export-ITAssetAudit.ps1 -ExportJson -OutputPath ".\AssetAudit.json"
#>

[CmdletBinding()]
param (
    [switch]$ExportJson = $true,
    [string]$OutputPath = ".\AssetAudit.json"
)

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "       ENTERPRISE IT ASSET AUDIT & INVENTORY TOOL        " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

# 1. Computer System & BIOS Info
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$os   = Get-CimInstance Win32_OperatingSystem

# 2. Processor Info
$cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1

# 3. RAM Info
$ramSticks = Get-CimInstance Win32_PhysicalMemory
$totalRamGB = [math]::Round(($cs.TotalPhysicalMemory / 1GB), 2)

# 4. Storage & Disks
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
    [PSCustomObject]@{
        DeviceID    = $_.DeviceID
        FileSystem  = $_.FileSystem
        TotalSizeGB = [math]::Round(($_.Size / 1GB), 2)
        FreeSpaceGB = [math]::Round(($_.FreeSpace / 1GB), 2)
        PercentFree = [math]::Round(($_.FreeSpace / $_.Size * 100), 1)
    }
}

# 5. Network Adapters (Active physical cards only)
$nics = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" | ForEach-Object {
    [PSCustomObject]@{
        Description = $_.Description
        MACAddress  = $_.MACAddress
        IPAddress   = ($_.IPAddress -join ", ")
        DefaultGateway = ($_.DefaultIPGateway -join ", ")
        DNSServers  = ($_.DNSServerSearchOrder -join ", ")
        DHCPEnabled = $_.DHCPEnabled
    }
}

# Aggregate into structured Asset Object
$assetData = [PSCustomObject]@{
    AuditTimestamp   = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    ComputerName     = $cs.Name
    DomainOrWorkgroup= $cs.Domain
    Manufacturer     = $cs.Manufacturer
    Model            = $cs.Model
    SerialNumber     = $bios.SerialNumber
    OperatingSystem  = "$($os.Caption) ($($os.OSArchitecture)) - Build $($os.BuildNumber)"
    LastBootTime     = $os.LastBootUpTime.ToString("yyyy-MM-dd HH:mm:ss")
    CPU              = $cpu.Name.Trim()
    TotalRAM_GB      = $totalRamGB
    RAM_ModulesCount = $ramSticks.Count
    Disks            = $disks
    NetworkAdapters  = $nics
    CurrentUser      = $cs.UserName
}

# Display summary in console
Write-Host "Computer Name : $($assetData.ComputerName)" -ForegroundColor Green
Write-Host "Manufacturer  : $($assetData.Manufacturer) $($assetData.Model)" -ForegroundColor White
Write-Host "Serial Number : $($assetData.SerialNumber)" -ForegroundColor White
Write-Host "OS Version    : $($assetData.OperatingSystem)" -ForegroundColor White
Write-Host "CPU           : $($assetData.CPU)" -ForegroundColor White
Write-Host "RAM           : $($assetData.TotalRAM_GB) GB ($($assetData.RAM_ModulesCount) sticks)" -ForegroundColor White

Write-Host "`n--- Storage Status ---" -ForegroundColor Cyan
foreach ($d in $assetData.Disks) {
    $color = if ($d.PercentFree -lt 15) { "Red" } else { "Green" }
    Write-Host "  Drive $($d.DeviceID) -> Free: $($d.FreeSpaceGB) GB / Total: $($d.TotalSizeGB) GB ($($d.PercentFree)% Free)" -ForegroundColor $color
}

if ($ExportJson) {
    $jsonContent = $assetData | ConvertTo-Json -Depth 5
    $jsonContent | Out-File -FilePath $OutputPath -Encoding UTF8
    Write-Host "`n[SUCCESS] Audit data exported to $OutputPath" -ForegroundColor Yellow
}
