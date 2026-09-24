<#
.SYNOPSIS
    Disable-CompanyUser.ps1 - idempotent, auditable AD offboarding.
.DESCRIPTION
    Disables an exact AD account, records current group membership, removes approved
    access groups, and optionally moves the account to a disabled-users OU.
    The account is never deleted. Passwords and credentials are never emitted.
.EXAMPLE
    .\Disable-CompanyUser.ps1 -SamAccountName jdoe -WhatIf
#>
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$SamAccountName,
    [string]$DomainName = 'company.local',
    [string]$DisabledUsersOU = 'OU=Disabled Users,OU=Company_Enterprise,DC=company,DC=local',
    [string[]]$RemoveGroups = @('SG_VPN_RemoteAccess','SG_IT_Admins'),
    [string]$EvidencePath = '.\_evidence\offboarding.json'
)

$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace($SamAccountName)) { throw 'SamAccountName is required.' }

$user = Get-ADUser -Identity $SamAccountName -Properties MemberOf,Enabled,DistinguishedName -ErrorAction Stop
$before = [ordered]@{
    samAccountName = $user.SamAccountName
    distinguishedName = $user.DistinguishedName
    enabled = [bool]$user.Enabled
    memberOf = @($user.MemberOf | ForEach-Object { $_.ToString() })
    removedGroups = @()
    movedTo = $null
    at = (Get-Date).ToUniversalTime().ToString('o')
}

foreach ($groupName in $RemoveGroups) {
    if ($user.MemberOf.DistinguishedName -contains (Get-ADGroup -Identity $groupName -ErrorAction SilentlyContinue).DistinguishedName) {
        if ($PSCmdlet.ShouldProcess($user.DistinguishedName, "Remove from $groupName")) {
            Remove-ADGroupMember -Identity $groupName -Members $user -Confirm:$false
            $before.removedGroups += $groupName
        }
    }
}
if ($user.Enabled -and $PSCmdlet.ShouldProcess($user.DistinguishedName, 'Disable AD account')) {
    Disable-ADAccount -Identity $user.DistinguishedName
}
$alreadyAtTarget = $false
if (-not [string]::IsNullOrWhiteSpace($DisabledUsersOU)) {
    $alreadyAtTarget = ([string]$user.DistinguishedName).EndsWith($DisabledUsersOU, [System.StringComparison]::OrdinalIgnoreCase)
}
if (-not [string]::IsNullOrWhiteSpace($DisabledUsersOU) -and -not $alreadyAtTarget -and $PSCmdlet.ShouldProcess($user.DistinguishedName, "Move to $DisabledUsersOU")) {
    Move-ADObject -Identity $user.DistinguishedName -TargetPath $DisabledUsersOU
    $before.movedTo = $DisabledUsersOU
} elseif ($alreadyAtTarget) {
    $before.movedTo = $DisabledUsersOU
}

$parent = Split-Path -Parent $EvidencePath
if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$before | ConvertTo-Json -Depth 5 | Set-Content -Path $EvidencePath -Encoding UTF8
[pscustomobject]$before | ConvertTo-Json -Depth 5
