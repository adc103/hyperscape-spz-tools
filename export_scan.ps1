<#
.SYNOPSIS
  Export a Hyperscape scan from a Quest 3 as one portable ZIP.
  Use PowerShell 7 on Windows, macOS, or Linux.

.DESCRIPTION
  Reads the access token from logcat, asks Meta's API for your scans, then packs
  everything for the scan you pick into <scan id>_<name>.zip:

    <id>.spz                       splat model (gsplat_model_od_spz)
    scene_mesh.glb                 scene mesh
    camera_poses.json              capture camera path
    cluster_centroids.json         visibility centroids
    cluster_masks.bin              visibility masks
    spawn_points_2d.json           spawn points from the API response, if present
    thumbnail.<ext>                scan thumbnail, if present
    capture_info.json              scan metadata (no links or token)
    manifest.json                  file sizes, SHA-256 hashes and consistency checks

  The exporter uses the API visibility pair when valid, with the headset pair
  as a fallback. The SPZ, mesh and visibility pair are required. Missing
  optional files are listed in the manifest. The token is never written to disk.

.EXAMPLE
  pwsh -File ./export_scan.ps1
.EXAMPLE
  pwsh -File ./export_scan.ps1 -CaptureId YOUR_CAPTURE_ID -IncludeVideos
#>
[CmdletBinding()]
param(
    [string]$CaptureId,
    [switch]$All,
    [string]$OutDir = ".",
    [string]$Adb,
    [string]$Token,
    [string]$DocId = "26355098974169409",
    [switch]$IncludeVideos
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.IO.Compression
$Package = "com.meta.HyperscapeHmdCapture"
$DeviceFiles = "/sdcard/Android/data/$Package/files"
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Say($text, $color = "Gray") { Write-Host $text -ForegroundColor $color }

# Windows PowerShell turns redirected native stderr into errors under "Stop".
function Invoke-Native([scriptblock]$Block) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Block } finally { $ErrorActionPreference = $previous }
}
function Fail($text) { Write-Host "Error: $text" -ForegroundColor Red; exit 1 }

function Write-Json($path, $object) {
    $json = ConvertTo-Json -InputObject $object -Depth 20
    [IO.File]::WriteAllText($path, $json, $Utf8)
}

function Find-Adb {
    if ($Adb) {
        $explicit = Get-Command $Adb -CommandType Application -ErrorAction SilentlyContinue
        if (-not $explicit) { Fail "Could not run the ADB executable supplied with -Adb." }
        return $explicit.Source
    }
    foreach ($directory in @((Get-Location).Path, $PSScriptRoot)) {
        foreach ($binary in @("adb", "adb.exe")) {
            $candidate = Join-Path $directory $binary
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    $command = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
}

function Get-FileFromUrl($url, $path) {
    if (-not $url) { return $false }
    try {
        Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing
        if ((Get-Item -LiteralPath $path).Length -gt 0) { return $true }
    } catch {
        # The signed URL is intentionally omitted from error output.
    }
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $false
}

function Get-UrlExtension($url, $fallback) {
    try {
        $extension = [IO.Path]::GetExtension(([Uri]$url).AbsolutePath)
        if ($extension) { return $extension }
    } catch { }
    return $fallback
}

function Read-Spz($path) {
    $stream = [IO.File]::OpenRead($path)
    try {
        $gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress)
        try {
            $reader = [IO.BinaryReader]::new($gzip)
            $header = $reader.ReadBytes(16)
            if ($header.Length -ne 16 -or [Text.Encoding]::ASCII.GetString($header, 0, 4) -ne "NGSP" -or
                [BitConverter]::ToUInt32($header, 4) -ne 2 -or $header[14] -ne 12 -or $header[15] -ne 0) {
                throw "Expected Hyperscape SPZ v2 with flags 0x0C."
            }
            $splats = [int64][BitConverter]::ToUInt32($header, 8)
            $degree = [int]$header[12]
            if ($splats -lt 1 -or $degree -gt 3 -or $header[13] -gt 24) { throw "Invalid SPZ dimensions." }
            $attributes = 19 + 3 * (($degree + 1) * ($degree + 1) - 1)
            $remaining = $splats * $attributes
            $buffer = New-Object byte[] (1024 * 1024)
            while ($remaining -gt 0) {
                $n = $gzip.Read($buffer, 0, [int][Math]::Min($buffer.Length, $remaining))
                if ($n -eq 0) { throw "SPZ attribute data is truncated." }
                $remaining -= $n
            }
            if ($gzip.ReadByte() -ne -1) { throw "SPZ contains extra attribute data." }
            return [ordered]@{ magic = "NGSP"; version = 2; splats = $splats; sh_degree = $degree; flags = "0x0C" }
        } finally { $gzip.Dispose() }
    } finally { $stream.Dispose() }
}

function Read-Glb($path) {
    $stream = [IO.File]::OpenRead($path)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        $magic = [Text.Encoding]::ASCII.GetString($reader.ReadBytes(4))
        $version = $reader.ReadUInt32()
        $length = $reader.ReadUInt32()
        if ($magic -cne "glTF" -or $version -ne 2 -or $length -ne $stream.Length) {
            throw "The scene mesh is not a complete GLB v2 file."
        }
        $jsonSize = $reader.ReadUInt32()
        if ($reader.ReadUInt32() -ne 0x4E4F534A -or $jsonSize -gt $stream.Length - 20) {
            throw "Invalid GLB JSON chunk."
        }
        $mesh = [Text.Encoding]::UTF8.GetString($reader.ReadBytes([int]$jsonSize)) | ConvertFrom-Json
        if (-not $mesh.meshes) { throw "The GLB has no meshes." }
        foreach ($buffer in @($mesh.buffers)) {
            if ($buffer.uri -and -not $buffer.uri.StartsWith("data:")) { throw "The GLB references an external buffer." }
        }
        return [ordered]@{ magic = $magic; version = $version; length_matches = $true }
    } finally { $stream.Dispose() }
}

function Read-Visibility($centroids, $masks, $splats) {
    $data = Get-Content -LiteralPath $centroids -Raw | ConvertFrom-Json
    if ($data.splat_count -ne $splats -or -not $data.views) { throw "The cluster centroids do not match the SPZ." }
    foreach ($view in $data.views) {
        if ($view -isnot [array] -or $view.Count -ne 3) { throw "Invalid centroid coordinates." }
        foreach ($coordinate in $view) {
            if ($null -eq $coordinate -or $coordinate -is [string] -or $coordinate -is [bool] -or
                [double]::IsNaN([double]$coordinate) -or [double]::IsInfinity([double]$coordinate)) {
                throw "Invalid centroid coordinates."
            }
        }
    }
    $count = @($data.views).Count
    $bytes = [int64][Math]::Ceiling($splats * [double]$count / 32) * 4
    if ((Get-Item -LiteralPath $masks).Length -ne $bytes) { throw "Visibility mask length does not match the centroids." }
    return [ordered]@{ splat_count = $splats; views = $count; mask_bytes = $bytes }
}

function Write-Archive($directory, $name, $destination, $entries) {
    $temporary = "$destination.$([guid]::NewGuid().ToString('N')).tmp"
    $backup = "$temporary.backup"
    try {
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
        try {
            $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
            try {
                foreach ($path in $entries) {
                    $entry = $archive.CreateEntry("$name/$path", [IO.Compression.CompressionLevel]::Fastest)
                    $target = $entry.Open()
                    try {
                        $source = [IO.File]::OpenRead((Join-Path $directory $path))
                        try { $source.CopyTo($target) } finally { $source.Dispose() }
                    } finally { $target.Dispose() }
                }
            } finally { $archive.Dispose() }
        } finally { $stream.Dispose() }
        if ([IO.File]::Exists($destination)) {
            [IO.File]::Replace($temporary, $destination, $backup)
            Remove-Item -LiteralPath $backup -ErrorAction SilentlyContinue
        } else {
            [IO.File]::Move($temporary, $destination)
        }
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

# 1. Headset and token -------------------------------------------------------
$adbPath = Find-Adb
$devices = @()
if ($adbPath) { $devices = @(& $adbPath devices | Where-Object { $_ -match "\sdevice$" }) }
$headset = $devices.Count -eq 1
if (-not $Token -and -not $headset) {
    Fail "Connect exactly one authorized Quest with ADB, or supply an existing token with -Token."
}
if ($headset) { Say "Headset connected." Green }

if (-not $Token) {
    & $adbPath logcat -c
    Say ""
    Say "In the headset, open the Hyperscape app and open any scan." Cyan
    [void](Read-Host "Press Enter once the scan has loaded")
    $log = (& $adbPath logcat -d) -join "`n"
    $found = [regex]::Matches($log, "Access token:\s*(FRL[A-Za-z0-9_\-]+)")
    if ($found.Count -eq 0) { Fail "No access token in the log. Make sure the scan fully loaded, then run the script again." }
    $Token = $found[$found.Count - 1].Groups[1].Value
    Say "Got an access token." Green
}

# 2. Ask the API for your scans ----------------------------------------------
$body = @{ doc_id = $DocId; variables = "{}"; method = "post"; format = "json" }
try {
    $response = Invoke-RestMethod -Uri "https://graph.oculus.com/graphql/" -Method Post -Body $body `
        -Headers @{ Authorization = "OAuth $Token" }
} catch {
    Fail "The API call failed: $($_.Exception.Message). If it mentions an invalid token, open a scan again and rerun."
}
if ($response.error) { Fail "API error: $($response.error.message)" }
if ($response.errors) { Fail "API error: $(@($response.errors)[0].message)" }
$captures = @($response.data.xr_hyperreal_my_captures_list.captures)
if ($captures.Count -eq 0 -or -not $captures[0]) {
    Fail "No scans in the response. If the app was updated, the doc_id may have changed. See docs/extract.md."
}

# 3. Pick scans --------------------------------------------------------------
if ($CaptureId) {
    $selected = @($captures | Where-Object { $_.id -eq $CaptureId })
    if ($selected.Count -eq 0) { Fail "Scan $CaptureId is not on this account." }
} elseif ($All -or $captures.Count -eq 1) {
    $selected = $captures
} else {
    Say ""
    Say "Your scans:" Cyan
    for ($i = 0; $i -lt $captures.Count; $i++) {
        $c = $captures[$i]
        $when = [DateTimeOffset]::FromUnixTimeSeconds([int64]$c.creation_time).LocalDateTime
        Say ("  [{0}] {1}  {2}  ({3:g})" -f ($i + 1), $c.id, $c.name, $when)
    }
    $choice = Read-Host "Pick a number, or type all"
    if ($choice -eq "all") { $selected = $captures }
    else {
        $index = 0
        if (-not [int]::TryParse($choice, [ref]$index) -or $index -lt 1 -or $index -gt $captures.Count) { Fail "Not a valid choice." }
        $selected = @($captures[$index - 1])
    }
}

# 4. Export ------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$failed = @()
$stage = Join-Path ([IO.Path]::GetTempPath()) ("hyperscape_export_" + [guid]::NewGuid().ToString("N"))

try {
    foreach ($capture in $selected) {
        $id = [string]$capture.id
        try {
            if ($id -notmatch '^[0-9]+$') { throw "Invalid capture ID." }
            $r = $capture.default_reconstruction
            $folderName = (("{0}_{1}" -f $id, $capture.name) -replace '[\\/:*?"<>|\x00-\x1f]', '_').TrimEnd(".", " ")
            if ($folderName.Length -gt 120) { $folderName = $folderName.Substring(0, 120).TrimEnd(".", " ") }
            $dir = Join-Path $stage $id
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            Say "Exporting $id ($($capture.name))" Cyan

            $spz = Join-Path $dir "$id.spz"
            $glb = Join-Path $dir "scene_mesh.glb"
            if (-not (Get-FileFromUrl $r.gsplat_model_od_spz.cdn_url $spz)) { throw "Could not download the SPZ." }
            $header = Read-Spz $spz
            if (-not (Get-FileFromUrl $r.scene_mesh.cdn_url $glb)) { throw "Could not download the scene mesh." }
            $mesh = Read-Glb $glb

            $centroids = Join-Path $dir "cluster_centroids.json"
            $masks = Join-Path $dir "cluster_masks.bin"
            $visibility = $null
            $visibilitySource = "api"
            if ((Get-FileFromUrl $r.od_cluster_centroids.cdn_url $centroids) -and
                (Get-FileFromUrl $r.od_cluster_masks.cdn_url $masks)) {
                try { $visibility = Read-Visibility $centroids $masks $header.splats }
                catch { Say "  API visibility pair was invalid. Trying the headset copy." Yellow }
            }
            if (-not $visibility -and $headset) {
                $visibilitySource = "headset"
                Remove-Item -LiteralPath $centroids, $masks -Force -ErrorAction SilentlyContinue
                $remote = "$DeviceFiles/${id}_visibility_clusters"
                Invoke-Native { & $adbPath pull "$remote/cluster_centroids.json" $centroids 2>&1 | Out-Null }
                Invoke-Native { & $adbPath pull "$remote/cluster_masks.bin" $masks 2>&1 | Out-Null }
                if ((Test-Path -LiteralPath $centroids) -and (Test-Path -LiteralPath $masks)) {
                    $visibility = Read-Visibility $centroids $masks $header.splats
                }
            }
            if (-not $visibility) { throw "Missing a valid visibility pair. Open this scan on the headset and retry." }

            $missing = [System.Collections.Generic.List[string]]::new()
            $optional = [ordered]@{ "camera_poses.json" = $r.camera_poses.cdn_url }
            if ($capture.thumbnail.cdn_url) {
                $optional["thumbnail" + (Get-UrlExtension $capture.thumbnail.cdn_url ".jpg")] = $capture.thumbnail.cdn_url
            }
            $videos = @($r.flyby_videos | Where-Object { $_ })
            if ($IncludeVideos) {
                for ($i = 0; $i -lt $videos.Count; $i++) {
                    $optional[("flyby_{0}{1}" -f ($i + 1), (Get-UrlExtension $videos[$i].cdn_url ".mp4"))] = $videos[$i].cdn_url
                }
            }
            foreach ($name in $optional.Keys) {
                if (-not (Get-FileFromUrl $optional[$name] (Join-Path $dir $name))) { $missing.Add($name) }
            }

            $poses = Join-Path $dir "camera_poses.json"
            if (Test-Path -LiteralPath $poses) {
                try { $null = Get-Content -LiteralPath $poses -Raw | ConvertFrom-Json }
                catch { $missing.Add("camera_poses.json"); Remove-Item -LiteralPath $poses -Force }
            }
            if ($r.spawn_points_2d) {
                Write-Json (Join-Path $dir "spawn_points_2d.json") @($r.spawn_points_2d)
            } else {
                $missing.Add("spawn_points_2d.json")
            }

            $flybys = @($videos | ForEach-Object { [ordered]@{ id = $_.id; tags = $_.tags } })
            Write-Json (Join-Path $dir "capture_info.json") ([ordered]@{
                capture_id = $id
                name = $capture.name
                created = [DateTimeOffset]::FromUnixTimeSeconds([int64]$capture.creation_time).ToString("o")
                image_count = $capture.image_count
                vrs_file_size_in_mb = $capture.vrs_file_size_in_mb
                processing_status = $capture.processing_status
                reconstruction_id = $r.id
                reconstruction_updated = [DateTimeOffset]::FromUnixTimeSeconds([int64]$r.update_time).ToString("o")
                spz_model_id = $r.gsplat_model_od_spz.id
                flyby_videos = $flybys
            })

            $files = @(Get-ChildItem -LiteralPath $dir -File | Sort-Object Name | ForEach-Object {
                [ordered]@{
                    path = $_.Name
                    bytes = $_.Length
                    sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                }
            })
            Write-Json (Join-Path $dir "manifest.json") ([ordered]@{
                format_version = 1
                exported = (Get-Date).ToString("o")
                capture_id = $id
                files = $files
                missing_optional = $missing.ToArray()
                visibility_source = $visibilitySource
                checks = [ordered]@{ spz = $header; scene_mesh = $mesh; visibility = $visibility }
            })

            $zip = Join-Path $OutDir "$folderName.zip"
            Write-Archive $dir $folderName $zip (@($files | ForEach-Object { $_.path }) + "manifest.json")
            Say "Saved $zip" Green
            if ($missing.Count) { Say "  Optional files missing: $($missing -join ', ')" Yellow }
        } catch {
            $failed += $id
            Say "  Export failed for ${id}: $($_.Exception.Message)" Red
        }
    }
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
if ($failed.Count) { Fail "Failed captures: $($failed -join ', ')." }
