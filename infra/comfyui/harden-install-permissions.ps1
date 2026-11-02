param(
    [string]$Root = ([IO.Directory]::GetParent($PSScriptRoot).FullName),
    [string]$RollbackSnapshot,
    [ValidateRange(1, 600)][int]$TimeoutSeconds = 540,
    [ValidateRange(1, 65535)][int]$Port = 7860
)

$ErrorActionPreference = 'Stop'
# SSH may pass PowerShell 7's module path to Windows PowerShell 5.1. Keep
# module discovery native to this process; never write user or registry config.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules') + [IO.Path]::PathSeparator +
    [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')
Set-StrictMode -Version Latest
$clock = [Diagnostics.Stopwatch]::StartNew()
$phase = 'preflight'
$scanned = 0
$locks = [Collections.Generic.List[IO.FileStream]]::new()
$metadataPath = $null
$applied = $false
$rootRestored = $false
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Group -bor
    [Security.AccessControl.AccessControlSections]::Access
# Include generic write/all, in case an ACE has not been mapped to file rights.
$mutationRights = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor
    524288 -bor 0x10000000 -bor 0x40000000
$ancestorRights = 64 -bor 262144 -bor 524288 -bor 0x10000000

function Assert-Deadline {
    if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Deadline reached.' }
}

function Assert-NoReparse([string]$Path) {
    Assert-Deadline
    $attributes = [IO.File]::GetAttributes($Path)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
}

function Get-ExplicitRules($Acl) {
    return (@($Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) |
        ForEach-Object {
            '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, $_.AccessControlType,
                [long]$_.FileSystemRights, $_.InheritanceFlags, $_.PropagationFlags
        } | Sort-Object) -join [Environment]::NewLine)
}

function Read-AclRecord([string]$Path) {
    Assert-NoReparse $Path
    $acl = Get-Acl -LiteralPath $Path
    return [pscustomobject]@{
        Acl = $acl
        Owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        Group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value
        Protected = $acl.AreAccessRulesProtected
        Sddl = $acl.GetSecurityDescriptorSddlForm($sections)
        Explicit = Get-ExplicitRules $acl
        Rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    }
}

function Test-PrivatePath([string]$Path) {
    return ($Path.Equals($private, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($private + '\', [StringComparison]::OrdinalIgnoreCase))
}

function Assert-SubtreeAcl($Record, [bool]$AllowInheritedWrites, [bool]$CredentialPath) {
    if ($trusted -notcontains $Record.Owner) { throw 'Unexpected subtree owner.' }
    foreach ($rule in $Record.Rules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $sid = $rule.IdentityReference.Value
        if ($CredentialPath -and $sid -ne $operatorSid -and $sid -ne 'S-1-5-18') {
            throw 'Credential directory must remain account/SYSTEM only.'
        }
        if ($trusted -notcontains $sid -and ([long]$rule.FileSystemRights -band $mutationRights)) {
            if (-not ($AllowInheritedWrites -and $rule.IsInherited)) { throw 'Untrusted mutation grant.' }
        }
    }
}

function Get-TreePaths {
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($rootPath)
    while ($pending.Count) {
        $directory = $pending.Pop()
        Assert-NoReparse $directory
        foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            Assert-NoReparse $path
            $path
            if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) {
                $pending.Push($path)
            }
        }
    }
}

function Assert-NoListener {
    Assert-Deadline
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if (@($listeners | Where-Object { $_.Port -eq $Port }).Count) { throw 'Worker port is active.' }
}

function Assert-NoRunningMain {
    Assert-Deadline
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name LIKE 'python%.exe'" -Property ExecutablePath, CommandLine -OperationTimeoutSec 10
    foreach ($process in $processes) {
        if ([string]::IsNullOrWhiteSpace($process.CommandLine)) {
            throw 'Python process metadata unavailable.'
        }
        # Metadata only: never print command lines or include them in exceptions.
        $command = $process.CommandLine.Replace('/', '\')
        $main = $command -match '(?i)(?:^|[\s"\\])main\.py(?=$|[\s"])'
        $installed = (-not [string]::IsNullOrWhiteSpace($process.ExecutablePath) -and
            $process.ExecutablePath.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase))
        $installed = $installed -or $command.IndexOf($rootPath + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0
        if ($main -and $installed) { throw 'Installation main.py is still running.' }
    }
}

function Assert-ApplyBudget {
    Assert-Deadline
    if ($TimeoutSeconds - $clock.Elapsed.TotalSeconds -lt $requiredApplySeconds) {
        throw 'Insufficient remaining verification budget.'
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'Windows required.' }
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($rootPath)
    if ($driveRoot.StartsWith('\\') -or $rootPath -eq $driveRoot.TrimEnd('\')) {
        throw 'A local installation directory is required.'
    }
    if (-not [IO.Directory]::Exists($rootPath)) { throw 'Installation directory missing.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $operatorSid = $identity.User.Value } finally { $identity.Dispose() }
    $trusted = @($operatorSid, 'S-1-5-18', 'S-1-5-32-544')
    $private = Join-Path $rootPath 'atelier-private-secrets'
    $ancestor = [IO.Directory]::GetParent($rootPath)
    while ($null -ne $ancestor) {
        $record = Read-AclRecord $ancestor.FullName
        if ($trusted -notcontains $record.Owner) { throw 'Unexpected ancestor owner.' }
        $effectiveRights = $ancestorRights
        if ($ancestor.FullName.TrimEnd('\') -ne $driveRoot.TrimEnd('\')) {
            # DELETE on a nested ancestor permits renaming/replacing that branch.
            $effectiveRights = $effectiveRights -bor 65536
        }
        foreach ($rule in $record.Rules) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
                $trusted -notcontains $rule.IdentityReference.Value -and
                ([long]$rule.FileSystemRights -band $effectiveRights)) {
                throw 'Ancestor permits untrusted deletion or ACL replacement.'
            }
        }
        $ancestor = $ancestor.Parent
    }
    Assert-NoReparse $rootPath
    $privateRecord = Read-AclRecord $private
    if (-not $privateRecord.Protected) { throw 'Credential ACL must already be protected.' }
    Assert-SubtreeAcl $privateRecord $false $true
    # Hold both native launcher locks until verification or rollback completes.
    foreach ($name in @('atelier-private.launch.lock', 'atelier-private.instance.lock')) {
        $path = Join-Path $rootPath $name
        if ([IO.File]::Exists($path)) { Assert-NoReparse $path }
        $locks.Add([IO.File]::Open($path, [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite, [IO.FileShare]::None))
    }
    Assert-NoListener
    Assert-NoRunningMain
    $rootRecord = Read-AclRecord $rootPath
    if ($trusted -notcontains $rootRecord.Owner) { throw 'Unexpected root owner.' }

    if ($RollbackSnapshot) {
        $phase = 'rollback'
        $snapshotPath = [IO.Path]::GetFullPath($RollbackSnapshot)
        if (-not $snapshotPath.StartsWith($private + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Rollback snapshot must be inside the protected credential directory.'
        }
        Assert-NoReparse $snapshotPath
        $snapshot = [IO.File]::ReadAllText($snapshotPath) | ConvertFrom-Json
        if ($snapshot.Schema -ne 1 -or $snapshot.Root -ne $rootPath -or
            $snapshot.OperatorSid -ne $operatorSid -or $snapshot.Owner -ne $rootRecord.Owner -or
            $snapshot.Group -ne $rootRecord.Group) { throw 'Rollback identity mismatch.' }
        # Restore D only; saved O/G are checked, never reassigned.
        $rootRecord.Acl.SetSecurityDescriptorSddlForm($snapshot.RootSddl,
            [Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $rootPath -AclObject $rootRecord.Acl
        $rootRestored = $true
        if ((Read-AclRecord $rootPath).Sddl -ne $snapshot.RootSddl) { throw 'Root rollback incomplete.' }
        foreach ($item in $snapshot.Critical) {
            if ($item.Protected -or $item.Credential) {
                $path = Join-Path $rootPath $item.RelativePath
                if ((Read-AclRecord $path).Sddl -ne $item.Sddl) { throw 'Protected ACL changed during rollback.' }
            }
        }
        Write-Host 'Installation root ACL restored; protected ACLs preserved.'
    } else {
        $before = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
        $critical = [Collections.Generic.List[object]]::new()
        $prescanStarted = $clock.Elapsed.TotalSeconds
        $paths = @($rootPath) + @(Get-TreePaths)
        foreach ($path in $paths) {
            $record = Read-AclRecord $path
            $credential = Test-PrivatePath $path
            Assert-SubtreeAcl $record $true $credential
            $before.Add($path, $record.Owner)
            $scanned++
            if ($path -ne $rootPath -and ($record.Protected -or $record.Explicit -or $credential)) {
                $critical.Add([pscustomobject]@{
                    RelativePath = $path.Substring($rootPath.Length + 1)
                    Owner = $record.Owner
                    Group = $record.Group
                    Protected = $record.Protected
                    Credential = $credential
                    Sddl = $record.Sddl
                    Explicit = $record.Explicit
                })
            }
        }
        # One full verification scan plus critical-ACL rechecks, with a native
        # propagation margin. This estimate does not replace the hard deadline.
        $prescanSeconds = $clock.Elapsed.TotalSeconds - $prescanStarted
        $requiredApplySeconds = [Math]::Max(5.0, 2.0 * $prescanSeconds) + 60.0
        $phase = 'snapshot'
        Assert-NoListener
        Assert-NoRunningMain
        Assert-ApplyBudget
        $metadataPath = Join-Path $private ('install-acl-before-{0}-{1}.json' -f
            [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ'), [Guid]::NewGuid().ToString('N'))
        $snapshot = [ordered]@{
            Schema = 1
            Root = $rootPath
            OperatorSid = $operatorSid
            Owner = $rootRecord.Owner
            Group = $rootRecord.Group
            RootSddl = $rootRecord.Sddl
            Critical = $critical.ToArray()
        }
        $stream = [IO.File]::Open($metadataPath, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
            try { $writer.Write(($snapshot | ConvertTo-Json -Depth 6)) } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
        $phase = 'apply'
        Assert-NoListener
        Assert-NoRunningMain
        Assert-ApplyBudget
        $acl = $rootRecord.Acl
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
            $acl.RemoveAccessRuleSpecific($rule)
        }
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
        foreach ($sid in $trusted) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
                [Security.Principal.SecurityIdentifier]::new($sid),
                [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        }
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),
            [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance,
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
        $expectedRules = Get-ExplicitRules $acl
        Assert-ApplyBudget
        $applied = $true
        Set-Acl -LiteralPath $rootPath -AclObject $acl
        $phase = 'verify'
        Assert-NoListener
        $afterRoot = Read-AclRecord $rootPath
        if (-not $afterRoot.Protected -or $afterRoot.Explicit -ne $expectedRules -or
            $afterRoot.Owner -ne $rootRecord.Owner -or $afterRoot.Group -ne $rootRecord.Group) {
            throw 'Root policy incomplete.'
        }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($path in (@($rootPath) + @(Get-TreePaths))) {
            $record = Read-AclRecord $path
            Assert-SubtreeAcl $record $false (Test-PrivatePath $path)
            if ($before.ContainsKey($path)) {
                if ($before[$path] -ne $record.Owner) { throw 'Owner changed.' }
                [void]$seen.Add($path)
            } elseif ($path -ne $metadataPath) { throw 'Unexpected item appeared during hardening.' }
        }
        if ($seen.Count -ne $before.Count) { throw 'An installation item disappeared.' }
        foreach ($item in $critical) {
            $record = Read-AclRecord (Join-Path $rootPath $item.RelativePath)
            if ($record.Owner -ne $item.Owner -or $record.Group -ne $item.Group -or
                $record.Protected -ne $item.Protected -or $record.Explicit -ne $item.Explicit -or
                (($item.Protected -or $item.Credential) -and $record.Sddl -ne $item.Sddl)) {
                throw 'Protected or explicit ACL changed.'
            }
        }
        Write-Host ('Installation ACL verified: {0} existing items; {1} critical ACLs preserved; one private snapshot.' -f
            $scanned, $critical.Count)
    }
} catch {
    # No account names, paths, ACL contents or raw native exceptions in output.
    Write-Host ('Installation ACL operation failed during {0}; scanned {1} items.' -f $phase, $scanned)
    if ($rootRestored) {
        Write-Host 'Root restore was applied, but verification failed. Keep the worker stopped and inspect the private snapshot before retrying.'
    } elseif ($applied) {
        Write-Host 'Propagation may be partial. Keep the worker stopped and use the private snapshot with -RollbackSnapshot before retrying.'
    }
    exit 1
} finally {
    foreach ($lock in $locks) { $lock.Dispose() }
}
