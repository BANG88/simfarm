# Setup

Everything needed to get simfarm running, per backend, plus what to do when one
of them does not come up. The [README](../README.md) has the two-minute version;
this is the complete one.

- [1. Prerequisites](#1-prerequisites)
- [2. Backends](#2-backends) — [iOS](#ios) · [Android](#android) · [WeChat](#wechat)
- [3. Server configuration](#3-server-configuration)
- [4. Running it persistently](#4-running-it-persistently)
- [5. Connecting](#5-connecting)
- [6. Troubleshooting](#6-troubleshooting)

---

## 1. Prerequisites

### macOS on Apple Silicon

Not a preference. The iOS backend mounts
[serve-sim](https://github.com/EvanBacon/serve-sim), which loads Xcode's private
`CoreSimulator` and `SimulatorKit` frameworks through a native addon — so it
runs where Xcode runs and nowhere else. The Android and WeChat backends have no
such constraint in principle, but the server is only built and tested on macOS.

macOS 14 or newer is a safe floor; anything that can run a current Xcode will do.

### bun

The package manager and the build tool.

```bash
curl -fsSL https://bun.sh/install | bash
```

See [bun.sh](https://bun.sh) for other install methods. The repository pins
`bun@1.4.0` in `package.json`'s `packageManager` field.

### Node

| Where | Version | Why |
|---|---|---|
| From a clone | **22 or newer** | `bun start` runs `src/main.ts` through Node, which strips the types. Unflagged type stripping needs 22.18+ / 23.6+. |
| From the npm package | **20 or newer** | The published package is compiled JavaScript, so no type stripping is involved. |

Check with `node --version`.

### ffmpeg — WeChat only, and only for H.264

```bash
brew install ffmpeg
ffmpeg -encoders | grep h264_videotoolbox    # must print a line
```

The WeChat backend captures JPEG frames and transcodes them to H.264 with
Apple's hardware encoder through ffmpeg. **Without ffmpeg it falls back to
JPEG**: everything still works, at roughly seven times the bandwidth. The
capability is probed at startup by actually pushing two frames through the real
command and requiring H.264 back — a binary that merely lists the encoder is not
enough, because a pipeline that fails at runtime looks identical to a working
one right up until the picture never moves.

The other two backends do not need ffmpeg. iOS gets H.264 from serve-sim and
Android from the device's own MediaCodec.

### Install

```bash
git clone https://github.com/BANG88/simfarm.git
cd simfarm
bun install
```

There is no build step for development.

---

## 2. Backends

Enable only the ones you have — see [`--providers`](#-providers-list). A backend
whose tooling is missing costs startup time and fills the log with complaints.

### iOS

**Needs:** Xcode with at least one iOS runtime, plus the command line tools.

```bash
xcode-select --install                       # command line tools
xcode-select -p                              # should print an Xcode path
xcrun simctl list runtimes                   # at least one iOS runtime
```

If `xcode-select -p` prints `/Library/Developer/CommandLineTools`, point it at
the full Xcode instead:

```bash
sudo xcode-select -s /Applications/Xcode.app
```

**List and boot a simulator:**

```bash
xcrun simctl list devices available          # find one, note its UDID
xcrun simctl boot <device-udid>
```

`Simulator.app` does **not** need to be open. Frames are read from
CoreSimulator's `IOSurface`, which works on a headless booted device.

simfarm lists every simulator on the machine, booted or not, and a shut-down one
can be started from the client with its **Start** button.

**Known limits.** This backend is a translation layer over serve-sim, so it
inherits serve-sim's platform constraints — Apple Silicon, and whichever Xcode
versions its private-framework paths currently match. When Xcode moves those,
the fix is `bun update serve-sim`, not a change here.

### Android

**Needs:** the Android SDK platform-tools (`adb`), and either an AVD or a
physical device.

```bash
brew install --cask android-platform-tools   # or install via Android Studio
adb version
```

simfarm looks for `adb` in this order: `$ADB_PATH`,
`$ANDROID_SDK_ROOT/platform-tools/adb`, `$ANDROID_HOME/platform-tools/adb`,
`~/Library/Android/sdk/platform-tools/adb`, then `$PATH`. Set one of those if
your SDK lives somewhere unusual:

```bash
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"
```

It also honours `$ANDROID_ADB_SERVER_ADDRESS` and `$ANDROID_ADB_SERVER_PORT` if
your adb server is not the default `127.0.0.1:5037`.

**Create and start an emulator:**

```bash
# from Android Studio: Device Manager -> Create Device
# or from the command line:
"$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/avdmanager" create avd \
  -n Pixel_Test -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_7

"$ANDROID_SDK_ROOT/emulator/emulator" -avd Pixel_Test &
adb devices                                  # should list it as "device"
```

simfarm **cannot start an AVD for you** — that is `emulator -avd`, a launcher
concern — so an Android device only appears once adb can already see it. The
client says so rather than offering a Start button that would do nothing.

The device is named after the AVD where there is one (`Pixel_Test` shows as
`Pixel Test`), otherwise after `ro.product.model`.

#### The scrcpy server jar

Video and input use the [scrcpy](https://github.com/Genymobile/scrcpy) **server**
protocol directly — simfarm speaks it itself and does not need scrcpy's desktop
client. The server jar is pushed to the device at connect time.

**You do not normally have to do anything.** The jar is fetched on first use,
with a line in the log saying so, and verified against a pinned SHA-256:

```
[android] scrcpy-server 4.1 is not present; fetching it once from
          https://github.com/.../scrcpy-server-v4.1 (~730 KB, verified ...)
[android] scrcpy-server 4.1 verified (.../vendor/scrcpy-server-v4.1.jar)
```

To fetch it ahead of time — building an image, priming a cache, or a machine
that will not have network when the server first runs:

```bash
npx simfarm download-scrcpy          # from the package
bun run scrcpy:download              # from a clone; same thing
```

The jar is **not** shipped: not in git, because a binary in git is a binary
nobody re-reads, and not in the npm package, because redistributing someone
else's release inside ours is not ours to do. Version, URL and digest live in
[`vendor/scrcpy-server.json`](../vendor/scrcpy-server.json).

The download goes through `curl` rather than Node's `fetch`, deliberately:
`fetch` ignores `HTTP_PROXY` and `HTTPS_PROXY`, so behind a proxy it does not
fail — it hangs until the TCP timeout. curl reads the same environment as the
rest of your machine, and there is a 60-second ceiling either way.

Startup verifies the digest again and **refuses to start** on a mismatch. That
is deliberate: the scrcpy server protocol is not stable across versions, and
decoding a byte stream with the wrong assumptions produces confusing failures
rather than clean ones. Upgrading is an explicit change — bump the version and
digest, then re-check the version-specific assumptions in
`src/providers/android/scrcpy-session.ts`.

#### <a id="max-size"></a>`--android-max-size`: sharpness against frame rate

**Emulators encode in software**, so throughput falls as pixel count rises. This
is the one tuning decision on this backend that actually matters. Measured on
one AVD, same interaction each time:

| `--android-max-size` | Stream | Delivered |
|---|---|---|
| 640 | 286x640 | **20.5 fps** — at the emulator's own render ceiling, and visibly soft |
| 1024 (default) | 458x1024 | **15–18 fps** |
| 1440 | 644x1440 | 11.5 fps |
| 1920 | 860x1920 | **8.5 fps** — sharp, too slow to judge motion |

The default is 1024 because a slightly soft picture is still usable and 8 fps is
not. Raise it when you are looking at static layout, lower it when you are
looking at motion.

Two things this is *not*: it is not the pipeline dropping frames (measured: zero
dropped, the emulator's own renderer is the ceiling), and it is not fixed by
lowering the device's resolution with `wm size` — that changes the display
geometry, not the encoder's workload.

**Physical devices encode in hardware and do not have this problem.** If frame
rate matters, use one.

#### Physical devices

Enable Developer options (tap *Build number* seven times in *About phone*), turn
on **USB debugging**, plug in, and accept the authorization prompt on the device.

```bash
adb devices        # "device" = ready; "unauthorized" = accept the prompt
```

An unauthorized device shows in simfarm as `error` rather than as connectable.

### WeChat

**Needs:** [WeChat DevTools](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
installed at `/Applications/wechatwebdevtools.app`, and a mini program project.

#### Launch flags — all three are required

simfarm starts the tool itself with the right flags when it is not running. If
the tool is **already** running without them, it must be restarted by hand,
because command-line flags only take effect at launch:

```bash
open -a /Applications/wechatwebdevtools.app --args \
  --remote-debugging-port=9222 \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding
```

| Flag | What it is for |
|---|---|
| `--remote-debugging-port=9222` | Opens the Chrome DevTools Protocol endpoint. Everything simfarm sees or touches goes through it. The port is fixed at 9222. |
| `--disable-backgrounding-occluded-windows` | Stops the tool treating a covered window as idle. |
| `--disable-renderer-backgrounding` | Stops it throttling background renderers. |

The last two are **not optional and not an optimisation**. Without them the tool
composites the first mini program page and then never composites another one:
navigation succeeds, the page stack moves, new render targets appear — and the
picture stays frozen on whatever was up first.

Check the endpoint is live:

```bash
curl -s http://127.0.0.1:9222/json/version
```

#### Log in and open a project

1. **Scan the QR code to sign in.** This cannot be automated and there is no way
   around it.
2. **Open the project** you want to mirror, and let it compile until the
   simulator is actually rendering a page.

Both matter, because **the render target does not exist until the mini program
has drawn something**. Before that, simfarm reports the project but has no
picture — which is a normal state, not a fault. See
[Troubleshooting](#wechat-connects-but-there-is-no-picture).

#### Ports

| Port | What |
|---|---|
| 9222 | CDP endpoint, from `--remote-debugging-port`. Fixed. |
| assigned per launch | The IDE's own HTTP server, used only for opening and closing projects through `Contents/MacOS/cli`. Found automatically. |

There is **no automation port to enable**. The devtools' automation protocol was
evaluated and is not used: it exposes no video and no coordinate-level input,
and its `Native.*` methods answer "unimplemented" on current builds.

#### What this backend cannot do

- **No rotation.** The simulator's orientation is an IDE control with no API.
- **No light/dark switching**, for the same reason.
- **Dialogs are not in the video.** `wx.showModal`, action sheets, toasts and
  the authorization and payment sheets are drawn by the IDE *over* the captured
  frame, not inside it. The server detects them and pushes a `dialog` event; the
  client draws its own stand-in that you can press. See PROTOCOL §6.

---

## 3. Server configuration

```bash
bun start                      # from a clone
npx simfarm                    # from the published package
```

Defaults: `127.0.0.1:8801`, with only the mock device.

### Command line

| Flag | Default | Meaning |
|---|---|---|
| `--host <addr>` | `127.0.0.1` | Interface to bind. A specific address exposes it on that network; `0.0.0.0` on all of them. |
| `--port <n>` | `8801` | TCP port. |
| <a id="-providers-list"></a>`--providers <list>` | `mock` | Comma-separated: `mock`, `ios`, `android`, `wechat`. |
| `--no-mock` | off | Drop the mock device from whatever `--providers` selected. |
| `--android-max-size <px>` | `1024` | Longest edge scrcpy encodes. See [the trade-off](#max-size). |
| `--wechat-max-fps <n>` | `20` | Frame cap for the WeChat **JPEG** path. `0` removes it. |
| `--wechat-h264-max-fps <n>` | uncapped | Frame cap for the WeChat **H.264** path. |
| `--wechat-quality <1-100>` | `70` | JPEG quality of the WeChat capture. |
| `--wechat-ffmpeg <path>` | found on `$PATH` | Use a specific ffmpeg binary. |
| `--wechat-no-h264` | off | Force the JPEG path even when ffmpeg is usable. |
| `--help` | | Print usage and exit. |

### Environment

| Variable | Meaning |
|---|---|
| `SIMFARM_HOST`, `SIMFARM_PORT`, `SIMFARM_PROVIDERS` | Same as the flags; flags win. |
| `SIMFARM_LOG` | `debug` \| `info` \| `warn` \| `error`. Default `info`. |
| `SIMFARM_WECHAT_SYNC_MS` | Backstop poll interval for WeChat route tracking, ms. Default 5000. Rarely worth changing. |
| `ADB_PATH`, `ANDROID_SDK_ROOT`, `ANDROID_HOME` | Where to find `adb`. |
| `ANDROID_ADB_SERVER_ADDRESS`, `ANDROID_ADB_SERVER_PORT` | A non-default adb server. |

### Enabling a subset, and why you should

```bash
bun start -- --providers ios                       # iOS only
bun start -- --providers android --no-mock         # Android only, no mock
bun start -- --providers ios,android,wechat --host 0.0.0.0
```

Each provider probes its own tooling at startup: the Android one looks for adb
and verifies the scrcpy jar, the WeChat one probes the CDP endpoint, the iOS one
enumerates simulators. Enabling a backend whose tooling is absent means a slower
start and a recurring error in the log for a device that was never going to
appear. Turn on what you have.

`mock` is always worth keeping while you are setting things up: it needs no
simulator at all and proves the server, the protocol and the client are working
before any real device is involved.

---

## 4. Running it persistently

There is no bundled service definition. To keep it running across logins, use a
LaunchAgent — save this as
`~/Library/LaunchAgents/com.example.simfarm.plist`, adjusting the paths, the
host and the provider list:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.simfarm</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/simfarm/src/main.ts</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>8801</string>
    <string>--providers</string><string>ios,android,wechat</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>SIMFARM_LOG</key><string>info</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>

  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/simfarm.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/simfarm.log</string>
</dict>
</plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.example.simfarm.plist
launchctl list | grep simfarm
launchctl unload ~/Library/LaunchAgents/com.example.simfarm.plist
```

Two things to get right:

- **Set `PATH` explicitly.** A LaunchAgent does not inherit your shell's
  environment, so `ffmpeg` and `adb` will not be found unless you say where they
  are. This is the most common reason a backend that works in a terminal fails
  as a service.
- **A LaunchAgent, not a LaunchDaemon.** Simulators belong to a logged-in user
  session; a system-level daemon cannot reach them.

### Logs

The server logs to stdout and stderr; there is no built-in file sink or
rotation. Redirect it where you want it — the LaunchAgent above writes to
`~/Library/Logs/simfarm.log`.

```bash
bun start -- --providers ios,android,wechat 2>&1 | tee -a ~/Library/Logs/simfarm.log
tail -f ~/Library/Logs/simfarm.log
SIMFARM_LOG=debug bun start -- --providers wechat     # much louder
```

Health, without opening a WebSocket:

```bash
curl -s http://127.0.0.1:8801/healthz
curl -s http://127.0.0.1:8801/devices | jq '.devices[] | {id, state}'
```

---

## 5. Connecting

Open the client at the address the server printed — `http://127.0.0.1:8801/` by
default. Pick a device from the dropdown at the top; mouse and keyboard go
straight to it.

### ⚠️ Serve it from localhost or over HTTPS, never from a bare IP

**H.264 does not decode from `http://<ip>:8801/`.** The client decodes video with
WebCodecs, and WebCodecs only exists in a [secure
context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
A plain-HTTP page served from an IP address is not one, so `VideoDecoder` is
`undefined` there.

The failure is quiet, which is why this warning is here rather than in
troubleshooting: the server streams normally, the client's frame and bitrate
counters climb, and the canvas stays black.

**Option 1 — an SSH tunnel (recommended).** The browser sees `localhost`, which
is a secure context by definition. No flags, no certificate, no warning bar.

```bash
# on the machine you are watching from:
ssh -N -L 8801:127.0.0.1:8801 <user>@<mac-running-simfarm>
# then open http://127.0.0.1:8801/
```

**Option 2 — HTTPS**, with a certificate the browser already trusts, in front of
the server as a reverse proxy.

Not recommended: Chromium's `--unsafely-treat-insecure-origin-as-secure`. It
works, and it hangs a permanent warning bar across the top of the window.

The client detects the problem and falls back to JPEG so you get a picture
rather than a black rectangle — but JPEG costs roughly seven times the
bandwidth. **If the readout says `jpeg` where you expected `h264`, the origin is
wrong.**

### From another machine

Bind to a reachable interface, then tunnel to it:

```bash
bun start -- --host 0.0.0.0 --providers ios,android,wechat
```

There is **no authentication** in v1. Bind to a private interface — a VPN or
tailnet address, or loopback plus an SSH tunnel — and not to a public one.

Be clear about what that buys. Binding privately, or tunnelling, bounds which
*machines* can reach the port. It does not bound which *pages* can. The upgrade
is accepted without an `Origin` check and without credentials, so a page in a
browser on any machine that can reach the port can open the protocol socket,
read the device list, attach to a booted device, and send input — the same
things the shipped client does. Https pages cannot: browsers refuse `ws://`
from a secure page. Plain-http pages can, and so can anything able to tamper
with one.

The same follows for the device list: `GET /devices` answers before any
decision about who is asking, and device names carry app and mini program names.

An `Origin` allowlist on the upgrade is the cheap fix and is not in v1.

### Omarchy

There is a desktop plugin for [Omarchy](https://omarchy.org) that opens the
client as an app window and keeps its theme in sync with the desktop, including
pushing light/dark down into the simulator itself. It is maintained separately;
the page-side contract it uses is `window.simfarmApplyTheme` and
`window.simfarmSetAppearance`, described in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 6. Troubleshooting

### The picture is frozen on the first frame, or black, but the stats keep counting

**Cause:** the page is not a secure origin, so `VideoDecoder` does not exist and
the H.264 stream is never decoded. Counters keep climbing because frames *are*
arriving — nothing decodes them.

**Fix:** reach the client over an SSH tunnel to `localhost`, or over HTTPS. See
[Connecting](#5-connecting). Confirm the diagnosis in the browser console:

```js
typeof VideoDecoder      // "undefined" means this is the problem
```

The readout showing `jpeg` when the device offers `h264` is the same symptom
seen from the other side.

### The device list is empty

Work down this list:

1. **Is the provider enabled?** The default is `mock` only. `--providers` is not
   optional for real devices.
2. **Is the device actually running?**
   `xcrun simctl list devices booted` · `adb devices` ·
   `curl -s http://127.0.0.1:9222/json/version`
3. **Check the log.** Each provider reports what it found at startup. Run with
   `SIMFARM_LOG=debug` if `info` is not saying enough.
4. `curl -s http://127.0.0.1:8801/devices` shows what the server believes,
   without involving the client at all — useful for telling a server problem
   apart from a client one.

For Android specifically: `adb devices` showing `unauthorized` means the
authorization prompt on the device has not been accepted, and simfarm will list
that device as `error`.

### WeChat connects but there is no picture

**Cause:** the mini program has not rendered yet. The render target does not
exist until the project has compiled and drawn a page, so "the tool is open but
nothing is rendering" is a real and normal state.

**Fix, in order:**

1. Is the tool **logged in**? A QR-code login screen renders nothing.
2. Is a **project open and compiled**? Watch the IDE simulator until it shows a
   page.
3. Was the tool started with **all three flags**? Check with
   `curl -s http://127.0.0.1:9222/json/version` — no answer means no CDP
   endpoint, and the tool needs restarting with the flags above.
4. If pages stop updating after the first one, that is the missing
   `--disable-renderer-backgrounding` exactly.

### Android frame rate is low

**Cause:** the emulator encodes in software, and its own renderer is usually the
ceiling.

**Fix:** lower `--android-max-size` (640 gets to about 20 fps, at the cost of a
soft picture), or use a physical device, which encodes in hardware. See
[the trade-off table](#max-size). This is
not the pipeline dropping frames — measured, it drops none.

### I changed the code and nothing changed

**Cause:** Node read the source at process start. Editing a file does nothing to
a process already running, and the symptom — "my fix had no effect" — looks
exactly like a wrong fix.

**Fix:** restart the server, or run `bun run dev`, which watches `src/` and
restarts on change.

To check what a running server actually has, ask it something only the new code
would answer — the capability list is usually enough:

```bash
curl -s http://127.0.0.1:8801/devices | jq '.devices[] | {id, capabilities}'
```

### Android fails to start with a scrcpy jar error

The jar is fetched automatically on first use, so this means the fetch itself
failed. The log says which:

- **A download failure** — no network, or a proxy in the way. Retry explicitly
  with `npx simfarm download-scrcpy`, which prints the underlying curl error. Or
  start without the backend: `--providers ios,wechat`.
- **A digest mismatch** is intentional and fatal, and is never fixed by
  re-downloading on your behalf: the scrcpy server protocol is not stable across
  versions, so simfarm will not push a jar it cannot identify to a device.
  Delete `vendor/*.jar` and fetch again. If the release URL has moved, update
  [`vendor/scrcpy-server.json`](../vendor/scrcpy-server.json) — and treat that as
  a real change rather than a version bump.

### The WeChat simulator stops responding to touches

Check for an open dialog: the IDE draws modals, action sheets and the
authorization and payment sheets *over* the captured frame, so one can be
blocking the app while the video still looks fine. The client draws a stand-in
for whatever is open — if it is not showing one, ask the server directly with
the `dialog` control op (PROTOCOL §4).
