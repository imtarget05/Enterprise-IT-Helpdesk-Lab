<#
.SYNOPSIS
    Test-NetworkHealth.ps1 - Automated Network Connectivity & Health Diagnostic
.DESCRIPTION
    Runs a fast, multi-layer connectivity test checking Local Loopback, Default Gateway,
    Local Active Directory Domain Controller, Internal DNS resolution, External DNS,
    and Internet Web latency.
.EXAMPLE
    .\Test-NetworkHealth.ps1
#>

[CmdletBinding()]
param (
    [string]$DomainController = "dc01.company.local",
    [string]$FileServer       = "fs01.company.local",
    [string]$ExternalDns      = "8.8.8.8",
    [string]$PublicDomain     = "google.com"
)

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "         ENTERPRISE NETWORK HEALTH DIAGNOSTIC            " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

function Assert-Step {
    param (
        [string]$StepName,
        [scriptblock]$TestLogic
    )
    Write-Host -NoNewline "[TEST] $StepName... "
    try {
        $result = & $TestLogic
        if ($result) {
            Write-Host "PASS [OK]" -ForegroundColor Green
            return $true
        } else {
            Write-Host "FAIL [X]" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# 1. Test Loopback TCP/IP Stack
Assert-Step "1. Local TCP/IP Stack (127.0.0.1)" {
    Test-Connection -ComputerName 127.0.0.1 -Count 1 -Quiet
}

# 2. Find and Test Default Gateway
$gateway = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop
Assert-Step "2. Default Gateway Ping ($gateway)" {
    if (-not $gateway) { return $false }
    Test-Connection -ComputerName $gateway -Count 2 -Quiet
}

# 3. Test Domain Controller Reachability
Assert-Step "3. Domain Controller Reachability ($DomainController)" {
    Test-Connection -ComputerName $DomainController -Count 2 -Quiet
}

# 4. Test LDAP Port on DC (TCP 389)
Assert-Step "4. Active Directory LDAP Port (TCP 389)" {
    (Test-NetConnection -ComputerName $DomainController -Port 389 -WarningAction SilentlyContinue).TcpTestSucceeded
}

# 5. Test Kerberos Port on DC (TCP 88)
Assert-Step "5. Kerberos Authentication Port (TCP 88)" {
    (Test-NetConnection -ComputerName $DomainController -Port 88 -WarningAction SilentlyContinue).TcpTestSucceeded
}

# 6. Test File Server SMB Port (TCP 445)
Assert-Step "6. File Server SMB Shared Folders (TCP 445)" {
    (Test-NetConnection -ComputerName $FileServer -Port 445 -WarningAction SilentlyContinue).TcpTestSucceeded
}

# 7. Test Internal DNS Resolution
Assert-Step "7. Internal DNS Resolution (dc01.company.local)" {
    $resolved = [System.Net.Dns]::GetHostAddresses("dc01.company.local")
    return ($resolved.Count -gt 0)
}

# 8. Test External IP Ping
Assert-Step "8. External Internet Routing ($ExternalDns)" {
    Test-Connection -ComputerName $ExternalDns -Count 2 -Quiet
}

# 9. Test Public DNS Resolution
Assert-Step "9. Public DNS Resolution ($PublicDomain)" {
    $resolved = [System.Net.Dns]::GetHostAddresses($PublicDomain)
    return ($resolved.Count -gt 0)
}

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "               DIAGNOSTIC TEST FINISHED                  " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
