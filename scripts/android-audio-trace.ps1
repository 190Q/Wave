param(
    [string]$Serial,
    [string]$OutputFile,
    [switch]$Snapshot
)

$ErrorActionPreference = 'Stop'

$adb = Get-Command adb.exe -ErrorAction SilentlyContinue
if ($adb) {
    $adb = $adb.Source
} else {
    $sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") |
        Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools\adb.exe')) } |
        Select-Object -First 1
    if (-not $sdk) {
        throw 'adb was not found. Add it to PATH or set ANDROID_HOME.'
    }
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
}

$device = @()
if ($Serial) {
    $device = @('-s', $Serial)
}
if ((& $adb @device get-state) -ne 'device') {
    throw 'No Android device is ready. Connect one and authorize USB debugging.'
}

if (-not $OutputFile) {
    $directory = Join-Path $env:TEMP 'wave-audio-traces'
    [void](New-Item -ItemType Directory -Force -Path $directory)
    $name = 'audio-{0}-{1}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $PID
    $OutputFile = Join-Path $directory $name
}

$stream = [System.IO.File]::Open($OutputFile, 'CreateNew', 'Write', 'Read')
$writer = New-Object System.IO.StreamWriter($stream, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true

function Write-Trace([string]$Message) {
    $writer.WriteLine($Message)
    Write-Host $Message
}

function Write-AudioCounters([string]$Label) {
    Write-Trace "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] $Label system-wide audio counters"
    & $adb @device shell dumpsys media.audio_flinger | ForEach-Object {
        if ($_ -match 'numTracks=\d+ writeErrors=\d+ underruns=\d+ overruns=\d+|Normal mixer raw underrun counters: partial=\d+ empty=\d+' -and
            $Matches[0] -notmatch 'numTracks=0 writeErrors=0 underruns=0 overruns=0|partial=0 empty=0') {
            Write-Trace "  $($Matches[0])"
        }
    }
}

function Write-WaveMetrics([string]$Label) {
    Write-Trace "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] $Label Wave audio-stream metrics"
    & $adb @device shell dumpsys media.metrics | Where-Object {
        $_ -match 'audio\.(?:stream|track)\.\d+.*com\.wave\.app'
    } | Select-Object -Last 100 | ForEach-Object {
        if ($_ -match '(?<stream>audio\.(?:stream|track)\.\d+), \((?<time>\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\)') {
            $streamId = $Matches.stream
            $time = $Matches.time
            $metrics = [regex]::Matches($_, '\b(?:event#|bufferSizeFrames|bufferCapacityFrames|frameCount|burstFrames|performanceModeActual|performanceMode|underrun)=[^, )]+')
            if ($metrics.Count -gt 0) {
                $values = ($metrics | ForEach-Object { $_.Value }) -join ' '
                Write-Trace "  [$time] $streamId $values"
            }
        }
    }
}

try {
    $wavePid = (& $adb @device shell pidof com.wave.app) -join ' '
    Write-Trace "Wave Android audio trace started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')"
    Write-Trace "Wave process: $(if ($wavePid) { $wavePid.Trim() } else { 'not running yet' })"
    Write-Trace "Saving to: $OutputFile"
    Write-Trace 'Play audio, lock and unlock the phone, then press Ctrl+C to stop.'
    Write-AudioCounters 'Initial'
    Write-WaveMetrics 'Initial'

    $mode = if ($Snapshot) { @('-d', '-t', '50000') } else { @('-T', '1') }
    $tags = @(
        'Wave:I', 'chromium:W', 'AudioManager:I', 'MediaFocusControl:I',
        'PowerManagerService:I', 'AudioTrack:W', 'AudioFlinger:W',
        'MediaCodec:W', 'CCodec:W', 'BluetoothA2dp:I', 'bt_stack:W', '*:S'
    )
    & $adb @device logcat -v threadtime @mode -s @tags | ForEach-Object {
        $line = $_
        if ($line -notmatch '^(?<time>\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+)\s+(?<pid>\d+)\s+\d+\s+\w\s+(?<tag>[^:]+):\s*(?<message>.*)$') {
            return
        }
        $time = $Matches.time
        $logPid = $Matches.pid
        $tag = $Matches.tag.Trim()
        $message = $Matches.message
        $event = $null

        if ($tag -eq 'PowerManagerService' -and $message -match 'Going to sleep|Waking up from') {
            $event = $Matches[0]
        } elseif ($tag -eq 'AudioManager' -and $message -match 'dispatching onAudioFocusChange\((-?\d+)\)') {
            $event = "audio focus change $($Matches[1])"
        } elseif ($tag -eq 'MediaFocusControl' -and $message -match 'requestAudioFocus|abandonAudioFocus|handleLoss|handleGain') {
            $event = $Matches[0]
            if ($message -match '(?:calling )?pack(?:age)?[=:]\s*([A-Za-z0-9_.]+)') {
                $event += " package=$($Matches[1])"
            }
            if ($message -match '\buid[=:]\s*(\d+)') {
                $event += " uid=$($Matches[1])"
            }
        } elseif ($tag -eq 'Wave' -and $message -match '^(playback keep-alive|the playback service|audio focus is managed|invalid playback update|the media control could not be delivered|the playback notification could not be shown|the playback bridge could not be registered)[^:]*') {
            $event = $Matches[0]
        } elseif ($tag -eq 'chromium' -and $message -match 'Audio buffering lasted \d+ms\. Ready \d+, network \d+, hidden (true|false)\.') {
            $event = $Matches[0]
        } elseif ($tag -eq 'chromium' -and $message -match 'SyncReader::Read timed out, audio glitch count=\d+') {
            $event = $Matches[0]
        } elseif ($tag -eq 'chromium' -and $message -match 'The sound (stopped, so the song was asked for again|was taken away by the system)\.') {
            $event = $Matches[0]
        } elseif ($tag -in @('AudioTrack', 'AudioFlinger', 'MediaCodec', 'CCodec', 'BluetoothA2dp', 'bt_stack') -and
                  $message -match '(?i)\b(underruns?|underflows?|overruns?|starvation|stalls?|timed? ?out|errors?|fail(?:ed|ure)?|disconnect(?:ed)?|suspend(?:ed)?|resum(?:e|ed)|dead|xrun)\b') {
            $event = $Matches[0]
            foreach ($metric in [regex]::Matches($message, '(?i)\b(?:underruns?|overruns?|frames?|count|error|status)\s*[=:]\s*-?\d+')) {
                $event += " $($metric.Value)"
            }
        }

        if ($event) {
            Write-Trace "[$time] $tag pid=$logPid $event"
        }
    }
} finally {
    try {
        Write-AudioCounters 'Final'
        Write-WaveMetrics 'Final'
    } finally {
        $writer.Dispose()
        Write-Host "Trace saved to: $OutputFile"
    }
}
