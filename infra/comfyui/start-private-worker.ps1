$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root 'python_embeded\python.exe'
$supervisor = Join-Path $root 'private-worker.py'
$stopMarker = Join-Path $root 'atelier-private.stop'
$endpointFile = Join-Path $root 'worker.json'
$launchLock = $null

try {
    # Empty kernel-locked files work across desktop/SSH integrity levels and
    # release automatically on process death. Never infer ownership from PID
    # metadata that a normal desktop token may be unable to read.
    $lockDeadline = [DateTime]::UtcNow.AddSeconds(150)
    while ($null -eq $launchLock) {
        try {
            $launchLock = [IO.File]::Open((Join-Path $root 'atelier-private.launch.lock'),
                [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if (($_.Exception.GetBaseException().HResult -band 65535) -ne 32) { throw }
            if ([DateTime]::UtcNow -ge $lockDeadline) { throw 'Another launch is still in progress. Retry when its window finishes.' }
            Start-Sleep -Seconds 1
        }
    }
    foreach ($path in @($python, $supervisor, $endpointFile,
        (Join-Path $root 'atelier-private-secrets\token'),
        (Join-Path $root 'atelier-private-secrets\cert.pem'),
        (Join-Path $root 'atelier-private-secrets\key.pem'))) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'Private worker installation is incomplete. Run its provisioning procedure first.'
        }
    }
    # worker.json (written by provisioning) is the one source of the listen
    # address and port, shared with the supervisor.
    $endpoint = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
    $address = [string]$endpoint.address
    $port = 7860
    if ($null -ne $endpoint.port) { $port = $endpoint.port }
    if ([string]::IsNullOrWhiteSpace($address) -or ($port -isnot [int] -and $port -isnot [long]) -or $port -lt 1 -or $port -gt 65535) {
        throw 'worker.json must name the listen address (and an optional port). Run its provisioning procedure first.'
    }
    $instanceActive = $false
    try {
        $instanceProbe = [IO.File]::Open((Join-Path $root 'atelier-private.instance.lock'),
            [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $instanceProbe.Dispose()
    } catch [IO.IOException] {
        if (($_.Exception.GetBaseException().HResult -band 65535) -ne 32) { throw }
        $instanceActive = $true
    }
    if ($instanceActive) {
        if (Test-Path -LiteralPath $stopMarker) {
            throw 'The private worker is stopping. Wait for it to stop, then launch again.'
        }
        Write-Host 'Private ComfyUI is already started; checking readiness...'
    } else {
        $listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq $port })
        if ($listeners.Count -ne 0) {
            throw ('Port {0} is occupied by another process. Stop that ComfyUI instance first.' -f $port)
        }
        # A deliberate manual launch clears a previous deliberate stop.
        if (Test-Path -LiteralPath $stopMarker) {
            Remove-Item -LiteralPath $stopMarker -Force
        }
        $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
            ShowWindow = [uint16]0
            # DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB
            CreateFlags = [uint32]16777224
        }
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -OperationTimeoutSec 20 -Arguments @{
            CommandLine = ('"{0}" -B "{1}"' -f $python, $supervisor)
            CurrentDirectory = $root
            ProcessStartupInformation = $startup
        }
        if ($created.ReturnValue -ne 0) {
            throw ('Windows refused the detached launch (code {0}).' -f $created.ReturnValue)
        }
        Write-Host 'Starting private ComfyUI in the background...'
    }
    # Verified TLS; credentials never enter arguments, output or log files.
    $probe = @'
import json, ssl, sys, urllib.request
from pathlib import Path
try:
    p = Path(sys.argv[1]) / 'atelier-private-secrets'
    context = ssl.create_default_context(cafile=str(p / 'cert.pem'))
    host = sys.argv[2] if ':' not in sys.argv[2] else '[' + sys.argv[2] + ']'
    request = urllib.request.Request('https://' + host + ':' + sys.argv[3] + '/atelier/v1/privacy',
        headers={'Authorization': 'Bearer ' + (p / 'token').read_text().strip()})
    with urllib.request.urlopen(request, context=context, timeout=2) as response:
        data = json.load(response)
        caps = data.get('capabilities', {})
        limits = data.get('limits', {})
        import re
        ready = (data.get('protocol') == 2 and data.get('ready') is True
                 and all(caps.get(key) is True for key in (
                     'job_status', 'image_outputs', 'preview_control', 'lease_renewal',
                     'job_admission', 'video_outputs', 'execution_budget', 'residency_tracking'))
                 and isinstance(data.get('worker_build'), str)
                 and re.fullmatch('[a-f0-9]{64}', data['worker_build']) is not None
                 and isinstance(data.get('allowed_nodes'), list) and bool(data['allowed_nodes'])
                 and all(isinstance(node, str) and node for node in data['allowed_nodes'])
                 and all(type(limits.get(key)) is int and limits[key] > 0 for key in (
                     'max_jobs', 'max_payload_bytes', 'max_image_bytes', 'max_images',
                     'pre_submit_seconds', 'terminal_idle_seconds', 'terminal_max_seconds',
                     'max_execution_seconds')))
        sys.exit(0 if ready else 1)
except Exception:
    sys.exit(1)
'@
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        $probeStatus = & {
            # Windows PowerShell 5.1 promotes native stderr under Stop. Probe
            # warnings must not bypass the bounded readiness retry.
            $ErrorActionPreference = 'Continue'
            & $python -B -c $probe $root $address $port 2>$null
            $LASTEXITCODE
        }
        if ($probeStatus -eq 0) {
            Write-Host 'Private ComfyUI is ready. This window can close; generation stays in the background.'
            exit 0
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Private ComfyUI was not ready within two minutes. The background supervisor may still be starting; retry this launcher to check it.'
} catch {
    Write-Host ('Start failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
