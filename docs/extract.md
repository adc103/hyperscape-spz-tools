# Export a Hyperscape capture from Quest 3

Install PowerShell 7 and ADB on Windows, macOS, or Linux. Enable Developer Mode, connect the Quest over USB, and accept the debugging prompt. Put ADB on your PATH or pass its location with `-Adb`.

```sh
pwsh -File ./export_scan.ps1
```

Open a scan on the headset when prompted, then choose a capture. The ZIP contains the SPZ, scene mesh, centroids, and visibility masks. Camera poses and spawn points are included when available. Use `-OutDir` to choose where to save it.

## Manual SPZ extraction

No root needed. The app downloads your scan as an SPZ, loads it, then deletes it. You grab it by asking Meta's API for the download link.

### Setup

1. Turn on Developer Mode in the Meta Horizon phone app, under your headset's settings.
2. Download [ADB / Platform Tools](https://developer.android.com/tools/releases/platform-tools) and unzip it.
3. Plug the Quest into your PC by USB and accept the debugging prompt in the headset.
4. Open PowerShell in the platform-tools folder and confirm it connects:
   ```powershell
   .\adb devices
   ```

### 1. Log while you open the scan

```powershell
.\adb logcat -c
.\adb logcat > hs.log
```

Leave that running. Open the Hyperscape app and open your scan. Once it loads, press Ctrl+C.

### 2. Get your token

```powershell
Select-String -Path hs.log -Pattern "Access token:"
```

Copy the `FRL...` token and set it:

```powershell
$T = "PASTE_TOKEN_HERE"
```

### 3. Ask the API for your scans

```powershell
$body = @{ doc_id = "26355098974169409"; variables = "{}"; method = "post"; format = "json" }
Invoke-RestMethod -Uri "https://graph.oculus.com/graphql/" -Method Post -Body $body -Headers @{ Authorization = "OAuth $T" } | ConvertTo-Json -Depth 20 > captures.json
```

Open `captures.json`, find your scan, and copy the `cdn_url` under its `gsplat_model_od_spz`. The plain `gsplat_model` entry only has an `id` and no download link.

The `doc_id` above is the app's "list my captures" query. It is the same for everyone on a given app version, so it is safe to reuse. If Meta updates the app it can change, in which case find the current one yourself:

```powershell
Select-String -Path hs.log -Pattern "doc_id|doc id"
```

Several show up. The one you want is paired with the captures response, the request whose reply lists your scans and their `cdn_url`s.

### 4. Download it

```powershell
curl.exe -L "PASTE_CDN_URL_HERE" -o scan.spz
```

Open `scan.spz` in either viewer.

### 5. Get the cluster file (for converting)

The app saves the spots it places you in. The converter uses them to fit a closer PLY. Once you have opened the scan in step 1, list the app's files:

```powershell
.\adb shell ls /sdcard/Android/data/com.meta.HyperscapeHmdCapture/files/
```

Find the folder named `<scan id>_visibility_clusters` and pull its centroids:

```powershell
.\adb pull /sdcard/Android/data/com.meta.HyperscapeHmdCapture/files/SCAN_ID_visibility_clusters/cluster_centroids.json
```

Pass it to the converter with `--clusters cluster_centroids.json`. See [conversion](conversion.md).

### Notes

- The token expires. If downloads fail, redo steps 1 and 2 for a fresh one.
- The CDN links also expire, so download soon after step 3.
