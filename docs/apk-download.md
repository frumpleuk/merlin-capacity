# Pulling a park's app APK (for reverse-engineering the queue/ticket API)

Each park added to this project starts by decompiling its official app to recover
app-embedded client identifiers — the Attractions.io `api-key` + slug for the
Merlin parks (`docs/attractions-io-api.md`), or the host + `x-token` for Paulton's
(`docs/paultons-api.md`). These are public client identifiers, not user
credentials; recovering them is standard app RE. This doc records how to fetch the
APK itself.

## Source: APKPure (not Google Play)

Google Play needs an authenticated account and a registered device, which isn't
possible from a headless container. **APKPure** mirrors the APKs and exposes a
predictable direct-download endpoint, so it's just `curl`.

## Steps

### 1. Resolve the package name

The parks don't share a namespace, so pin each down individually:

| Park | Package |
|---|---|
| Alton Towers | `com.thrillseeker.altontowers` |
| Thorpe Park | `io.attractions.thorpepark` |
| Chessington | `thrillseeker.app.chessington` |
| LEGOLAND Windsor | `com.merlin.legowi` |
| Paulton's Park | `thrillseeker.app.paultons` |

Find an unknown one by scraping APKPure/Play search HTML and probing candidate
ids: a **301** on `https://apkpure.com/-/<pkg>` means it exists, **404** means it
doesn't. A couple of web searches cover the ones that won't surface.

### 2. Get the download URL

APKPure exposes a direct endpoint:

```
https://d.apkpure.com/b/XAPK/<package>?versionCode=<n>&nc=arm64-v8a&sv=26
```

Scrape the actual `versionCode` off the app's `/download` page. `?version=latest`
also works as a fallback.

### 3. Download it

Needs a **mobile User-Agent** and an **apkpure.com referer**, or it rejects the
request:

```sh
curl -L -A "Mozilla/5.0 (Linux; Android 13; SM-G991B)…" \
     -e "https://apkpure.com/" \
     -o <park>.xapk "<that URL>"
```

The redirect lands on APKPure's CDN (`data.winudf.com`) and returns the file.

### 4. Unpack

What comes down is an **XAPK**, not a bare APK — it's a ZIP containing the base
APK plus split config APKs (`config.arm64_v8a.apk`, `config.xxhdpi.apk`), the
icon, and a `manifest.json`:

```sh
unzip <park>.xapk                    # → <package>.apk + config.*.apk + manifest.json
unzip <package>.apk -d apk/          # APKs are also ZIPs → classes*.dex, resources.arsc, assets/
```

From there:
- `strings classes*.dex | grep -iE '<uuid>|attractions|apiUrl|token'` — fast recovery
  of embedded ids/hosts.
- `resources.arsc` / `strings` — for values stored as Android string resources
  (some SDKs read the api-key from resources, not the dex).
- `assets/public/*.js` — for a **Capacitor** app (e.g. Paulton's) the config lives
  in the bundled web app's JS (`apiUrl`, `apiFixedToken`, the HTTP interceptor that
  sets the auth header), not in `BuildConfig`.
- `jadx` / `apktool` — full decompile when strings alone aren't enough.

## Caveats

- You're trusting APKPure's copy, not Google's signed original — fine for RE, but
  verify the signing cert if provenance matters.
- The direct endpoint and the UA/referer requirements **change from time to time**,
  so the exact URL shape isn't guaranteed stable. If `d.apkpure.com` 403s, fall
  back to the `/download` page flow or another mirror (apkcombo, though it gates
  links behind a JS `checkin` token).
