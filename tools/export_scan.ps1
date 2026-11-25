<#
.SYNOPSIS
  Export a Hyperscape scan from a Quest 3 into one folder and zip.

.DESCRIPTION
  Reads the access token from logcat, asks Meta's API for your scans, then downloads
  everything for the scan you pick:

    <id>.spz                       splat model (gsplat_model_od_spz)
    scene_mesh.glb                 scene mesh
    camera_poses.json              capture camera path
    od_cluster_centroids.json      visibility centroids (API copy)
    od_cluster_masks.bin           visibility masks (API copy)
    spawn_points_2d.json           the five spawn points, written from the API response
    thumbnail.<ext>                scan thumbnail
    device_visibility_clusters\    cluster_centroids.json and cluster_masks.bin from the headset
    capture_info.json              scan metadata (no links or token)
    manifest.json                  file sizes, SHA-256 hashes and consistency checks

  The token is never written to disk.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\export_scan.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\export_scan.ps1 -CaptureId 1704809597926317 -IncludeVideos
#>
[CmdletBinding()]
param(
    [string]$CaptureId,
    [switch]$All,
    [string]$OutDir = ".\hyperscape_exports",
    [string]$Adb,
    [string]$Token,
    [string]$DocId = "26355098974169409",
    [switch]$IncludeVideos,
    [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
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
    if ($Adb) { return $Adb }
    foreach ($candidate in @(".\adb.exe", (Join-Path $PSScriptRoot "adb.exe"))) {
        if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }
    $command = Get-Command adb -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    Fail "Could not find adb. Run this from the platform-tools folder or pass -Adb C:\path\to\adb.exe"
}

function Get-FileFromUrl($url, $path) {
    if (-not $url) { return $false }
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L -f -sS -o $path $url
        $ok = ($LASTEXITCODE -eq 0)
    } else {
        try { Invoke-WebRequest -Uri $url -OutFile $path -UseBasicParsing; $ok = $true } catch { $ok = $false }
    }
    if (-not $ok -and (Test-Path $path)) { Remove-Item $path -Force }
    return $ok
}

function Get-UrlExtension($url, $fallback) {
    try {
        $extension = [IO.Path]::GetExtension(([Uri]$url).AbsolutePath)
        if ($extension) { return $extension }
    } catch { }
    return $fallback
}

function Read-SpzHeader($path) {
    $stream = [IO.File]::OpenRead($path)
    try {
        $gzip = New-Object IO.Compression.GZipStream($stream, [IO.Compression.CompressionMode]::Decompress)
        $buffer = New-Object byte[] 16
        $read = 0
        while ($read -lt 16) {
            $n = $gzip.Read($buffer, $read, 16 - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        if ($read -lt 16) { return $null }
        return [ordered]@{
            magic     = [Text.Encoding]::ASCII.GetString($buffer, 0, 4)
            version   = [BitConverter]::ToUInt32($buffer, 4)
            splats    = [BitConverter]::ToUInt32($buffer, 8)
            sh_degree = $buffer[12]
            flags     = ("0x{0:X2}" -f $buffer[14])
        }
    } finally { $stream.Dispose() }
}

function Read-GlbHeader($path) {
    $bytes = New-Object byte[] 12
    $stream = [IO.File]::OpenRead($path)
    try { [void]$stream.Read($bytes, 0, 12) } finally { $stream.Dispose() }
    return [ordered]@{
        magic          = [Text.Encoding]::ASCII.GetString($bytes, 0, 4)
        version        = [BitConverter]::ToUInt32($bytes, 4)
        length_matches = ([BitConverter]::ToUInt32($bytes, 8) -eq (Get-Item $path).Length)
    }
}

function Read-Centroids($path) {
    $data = Get-Content $path -Raw | ConvertFrom-Json
    return [ordered]@{ splat_count = [int64]$data.splat_count; views = @($data.views).Count }
}

# 1. Headset and token -------------------------------------------------------
$adbPath = Find-Adb
$devices = & $adbPath devices | Select-String "\tdevice$"
if (-not $devices) { Fail "No headset found. Plug in the Quest, accept the USB debugging prompt, and try again." }
Say "Headset connected." Green

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
$deviceListing = (Invoke-Native { & $adbPath shell ls $DeviceFiles 2>$null }) -join "`n"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($capture in $selected) {
    $id = $capture.id
    $r = $capture.default_reconstruction
    $folderName = ("{0}_{1}" -f $id, $capture.name) -replace '[\\/:*?"<>|]', '_'
    $dir = Join-Path $OutDir $folderName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Say ""
    Say "Exporting $id ($($capture.name))" Cyan

    $missing = New-Object System.Collections.ArrayList
    $downloads = [ordered]@{
        "$id.spz"                   = $r.gsplat_model_od_spz.cdn_url
        "scene_mesh.glb"            = $r.scene_mesh.cdn_url
        "camera_poses.json"         = $r.camera_poses.cdn_url
        "od_cluster_centroids.json" = $r.od_cluster_centroids.cdn_url
        "od_cluster_masks.bin"      = $r.od_cluster_masks.cdn_url
    }
    if ($capture.thumbnail.cdn_url) {
        $downloads["thumbnail" + (Get-UrlExtension $capture.thumbnail.cdn_url ".jpg")] = $capture.thumbnail.cdn_url
    }
    if ($IncludeVideos) {
        $videos = @($r.flyby_videos)
        for ($i = 0; $i -lt $videos.Count; $i++) {
            $downloads[("flyby_{0}{1}" -f ($i + 1), (Get-UrlExtension $videos[$i].cdn_url ".mp4"))] = $videos[$i].cdn_url
        }
    }
    foreach ($name in $downloads.Keys) {
        if (Get-FileFromUrl $downloads[$name] (Join-Path $dir $name)) { Say "  downloaded $name" }
        else { [void]$missing.Add($name); Say "  missing    $name" Yellow }
    }

    Write-Json (Join-Path $dir "spawn_points_2d.json") @($r.spawn_points_2d)
    Say "  wrote      spawn_points_2d.json ($(@($r.spawn_points_2d).Count) points)"

    # Visibility files the app saved on the headset.
    $clusterFolder = "${id}_visibility_clusters"
    if ($deviceListing -match [regex]::Escape($clusterFolder)) {
        $local = Join-Path $dir "device_visibility_clusters"
        New-Item -ItemType Directory -Force -Path $local | Out-Null
        foreach ($name in @("cluster_centroids.json", "cluster_masks.bin")) {
            $target = Join-Path $local $name
            Invoke-Native { & $adbPath pull "$DeviceFiles/$clusterFolder/$name" $target 2>&1 | Out-Null }
            if ($LASTEXITCODE -eq 0) { Say "  pulled     device_visibility_clusters\$name" }
            else { [void]$missing.Add("device_visibility_clusters\$name"); Say "  missing    device_visibility_clusters\$name" Yellow }
        }
    } else {
        [void]$missing.Add("device_visibility_clusters")
        Say "  skipped    device visibility files (open this scan in the app first)" Yellow
    }

    $flybys = @()
    foreach ($video in @($r.flyby_videos)) { $flybys += [ordered]@{ id = $video.id; tags = $video.tags } }
    Write-Json (Join-Path $dir "capture_info.json") ([ordered]@{
        capture_id          = $id
        name                = $capture.name
        created             = [DateTimeOffset]::FromUnixTimeSeconds([int64]$capture.creation_time).ToString("o")
        image_count         = $capture.image_count
        vrs_file_size_in_mb = $capture.vrs_file_size_in_mb
        processing_status   = $capture.processing_status
        reconstruction_id   = $r.id
        reconstruction_updated = [DateTimeOffset]::FromUnixTimeSeconds([int64]$r.update_time).ToString("o")
        spz_model_id        = $r.gsplat_model_od_spz.id
        flyby_videos        = $flybys
    })

    # 5. Check that the files belong together --------------------------------
    $checks = [ordered]@{}
    $spzPath = Join-Path $dir "$id.spz"
    $splats = $null
    if (Test-Path $spzPath) {
        $header = Read-SpzHeader $spzPath
        $checks["spz"] = $header
        if ($header) { $splats = [int64]$header.splats }
    }
    foreach ($pair in @(@("od_cluster_centroids.json", "od_cluster_masks.bin"),
                        @("device_visibility_clusters\cluster_centroids.json", "device_visibility_clusters\cluster_masks.bin"))) {
        $centroidPath = Join-Path $dir $pair[0]
        $maskPath = Join-Path $dir $pair[1]
        if (Test-Path $centroidPath) {
            try { $info = Read-Centroids $centroidPath }
            catch { $checks[$pair[0]] = [ordered]@{ readable = $false }; continue }
            $result = [ordered]@{ splat_count = $info.splat_count; views = $info.views }
            if ($splats) { $result["matches_spz"] = ($info.splat_count -eq $splats) }
            if (Test-Path $maskPath) {
                $result["mask_size_matches"] = ((Get-Item $maskPath).Length * 8 -eq $info.views * $info.splat_count)
            }
            $checks[$pair[0]] = $result
        }
    }
    $meshPath = Join-Path $dir "scene_mesh.glb"
    if (Test-Path $meshPath) { $checks["scene_mesh.glb"] = Read-GlbHeader $meshPath }
    $posesPath = Join-Path $dir "camera_poses.json"
    if (Test-Path $posesPath) {
        try { $null = Get-Content $posesPath -Raw | ConvertFrom-Json; $checks["camera_poses.json"] = [ordered]@{ valid_json = $true } }
        catch { $checks["camera_poses.json"] = [ordered]@{ valid_json = $false } }
    }
    $apiMasks = Join-Path $dir "od_cluster_masks.bin"
    $deviceMasks = Join-Path $dir "device_visibility_clusters\cluster_masks.bin"
    if ((Test-Path $apiMasks) -and (Test-Path $deviceMasks)) {
        $checks["api_and_device_masks_identical"] = ((Get-FileHash $apiMasks).Hash -eq (Get-FileHash $deviceMasks).Hash)
    }

    $files = @()
    foreach ($file in Get-ChildItem $dir -Recurse -File | Where-Object { $_.Name -ne "manifest.json" }) {
        $files += [ordered]@{
            path   = $file.FullName.Substring((Resolve-Path $dir).Path.Length + 1)
            bytes  = $file.Length
            sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
        }
    }
    Write-Json (Join-Path $dir "manifest.json") ([ordered]@{
        exported = (Get-Date).ToString("o")
        capture_id = $id
        files = $files
        missing = @($missing)
        checks = $checks
    })

    $bad = @()
    foreach ($key in $checks.Keys) {
        $value = $checks[$key]
        if ($value -is [bool]) { if (-not $value) { $bad += $key } }
        elseif ($value) {
            foreach ($inner in @($value.Keys)) { if ($value[$inner] -is [bool] -and -not $value[$inner]) { $bad += "$key $inner" } }
        }
    }
    if ($bad.Count) { Say "  check failed: $($bad -join ', ')" Yellow } else { Say "  all checks passed" Green }

    if (-not $NoZip) {
        $zip = Join-Path $OutDir "$folderName.zip"
        Compress-Archive -Path (Join-Path $dir "*") -DestinationPath $zip -Force
        Say "  packaged   $zip" Green
    }
}
Say ""
Say "Done. Files are in $((Resolve-Path $OutDir).Path)" Green
