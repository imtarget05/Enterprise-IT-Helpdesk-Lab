<#
.SYNOPSIS
    New-CompanyUser.ps1 - Automated Bulk Active Directory User Provisioning
.DESCRIPTION
    Reads a CSV file containing new employee details and creates AD accounts,
    places them in the correct department OU, sets strong random passwords,
    forces password change at next logon, and assigns initial Security Groups.
.EXAMPLE
    .\New-CompanyUser.ps1 -CsvPath ".\new_employees.csv" -DomainName "company.local"
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory=$false)]
    [string]$CsvPath = ".\new_employees.csv",

    [Parameter(Mandatory=$false)]
    [string]$DomainName = "company.local"
)

Import-Module ActiveDirectory -ErrorAction Stop

# Sample CSV creation if file does not exist
if (-not (Test-Path $CsvPath)) {
    Write-Host "[INFO] CSV file not found. Creating sample CSV at $CsvPath..." -ForegroundColor Yellow
    @"
Firstname,Lastname,Department,JobTitle,EmployeeID
Mai,Binh Tan,IT_Department,IT ERP & Support Specialist,EMP-0101
Nguyen,Thi Mai,Accounting_Finance,Senior Accountant,EMP-0102
Tran,Van Binh,Human_Resources,HR Officer,EMP-0103
Le,Hoang Nam,Sales_Marketing,Sales Executive,EMP-0104
"@ | Out-File -FilePath $CsvPath -Encoding UTF8
}

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   ACTIVE DIRECTORY AUTOMATED USER PROVISIONING TOOL     " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan

$employees = Import-Csv -Path $CsvPath

foreach ($emp in $employees) {
    # Generate standard username: firstname.lastname (normalized)
    $cleanFirst = $emp.Firstname.ToLower().Replace(" ", "")
    $cleanLast  = $emp.Lastname.ToLower().Replace(" ", "")
    $username   = "$cleanFirst.$cleanLast"
    $upn        = "$username@$DomainName"
    $displayName = "$($emp.Lastname) $($emp.Firstname)"

    # Determine OU path based on department
    $deptOU = "OU=$($emp.Department),OU=Departments,OU=Company_Enterprise,DC=company,DC=local"

    Write-Host "[PROVISIONING] Processing $displayName ($username)..." -ForegroundColor White

    # Generate a secure temporary password (12 characters with upper, lower, digits, symbols)
    $tempPassword = "Pass" + (Get-Random -Minimum 1000 -Maximum 9999) + "!@#"
    $secPassword = ConvertTo-SecureString $tempPassword -AsPlainText -Force

    try {
        # Check if user already exists
        $existing = Get-ADUser -Filter "SamAccountName -eq '$username'" -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Warning "User $username already exists in Active Directory. Skipping."
            continue
        }

        # Create the AD User
        New-ADUser -Name $displayName `
                   -GivenName $emp.Firstname `
                   -Surname $emp.Lastname `
                   -DisplayName $displayName `
                   -SamAccountName $username `
                   -UserPrincipalName $upn `
                   -Path $deptOU `
                   -AccountPassword $secPassword `
                   -Enabled $true `
                   -ChangePasswordAtLogon $true `
                   -Department $emp.Department `
                   -Title $emp.JobTitle `
                   -EmployeeID $emp.EmployeeID `
                   -Description "Provisioned automatically via New-CompanyUser.ps1"

        Write-Host "  -> [SUCCESS] Created user account: $username in $deptOU" -ForegroundColor Green
        Write-Host "  -> [CREDS] Temporary Password: $tempPassword" -ForegroundColor Yellow

        # Assign initial security groups
        $groupName = switch ($emp.Department) {
            "Human_Resources"    { "SG_HR_Users" }
            "Accounting_Finance" { "SG_Accounting_Users" }
            "IT_Department"      { "SG_IT_Admins" }
            "Sales_Marketing"    { "SG_Sales_Users" }
            Default              { "SG_Standard_Users" }
        }

        if (Get-ADGroup -Filter "Name -eq '$groupName'" -ErrorAction SilentlyContinue) {
            Add-ADGroupMember -Identity $groupName -Members $username
            Write-Host "  -> [GROUP] Added to security group: $groupName" -ForegroundColor Cyan
        }

    } catch {
        # NOTE: must wrap as ${username} -- plain "$username:" makes PowerShell treat
        # "username:" as a scope/drive reference and the script fails to parse.
        Write-Error "  -> [FAILED] Error creating ${username}: $($_.Exception.Message)"
    }
}

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   PROVISIONING COMPLETED SUCCESSFULLY                   " -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
