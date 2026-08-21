# Architecture

How simfarm is put together, and why the awkward parts are the way they are.
Read this before changing anything; the wire format itself is specified
separately in [`docs/PROTOCOL.md`](PROTOCOL.md), which is the contract and takes
precedence over this document wherever they overlap.

---

## 1. Shape of the system

One Node process on macOS holds every simulator on the machine and exposes them
through a single binary WebSocket. A browser client draws the picture and sends
input back. There is no agent on the device side of anything, no second daemon,
and no per-backend port.

```
                      browser client  (web/)
                              │
                              │  one WebSocket:  ws://<host>:<port>/v1
                              │  four multiplexed channels
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  SimfarmServer            HTTP + WS, static client, /healthz     │  src/server.ts
├─────────────────────────────────────────────────────────────────┤
│  Session                  one per socket: stream ids, control    │  src/session.ts
│                           request/response, input routing,       │
│                           backpressure                           │
├─────────────────────────────────────────────────────────────────┤
│  DeviceRegistry           every provider's device list, and      │  src/registry.ts
│                           "<kind>:<native id>" → provider        │
├─────────────────────────────────────────────────────────────────┤
│  Provider / DeviceHandle  the only interface a backend must      │  src/types.ts
│                           satisfy                                │
├───────────────┬───────────────┬─────────────────┬───────────────┤
│  IosProvider  │ AndroidProvider│ WechatProvider  │ MockProvider  │
│  serve-sim    │ scrcpy server  │ CDP + IDE CLI   │ synthetic     │
│  middleware   │ protocol       │ + ffmpeg        │ frames        │
└───────────────┴───────────────┴─────────────────┴───────────────┘
        │               │                │
   iOS Simulator     adb / AVD      WeChat DevTools
```

### Repository map

| Path | What lives there |
|---|---|
| `src/main.ts` | Entry point. Argument parsing and the provider table — the only place a backend is named. |
| `src/server.ts` | HTTP server, static client, `/healthz`, `/devices`, the `/v1` upgrade. |
| `src/session.ts` | Per-connection state. Transport-agnostic, so it is tested without a socket. |
| `src/registry.ts` | Aggregates provider device lists; routes a device id to its owner. |
| `src/protocol.ts` | Wire encode/decode. Mirrored byte-for-byte by `web/protocol.js`. |
| `src/types.ts` | `Provider`, `DeviceHandle`, `Capabilities`, `Screen`. Read this first. |
| `src/util/h264.ts` | Annex-B ↔ avcC conversion, parameter-set extraction, shared by two backends. |
| `src/providers/*` | One directory per backend. |
| `web/` | The client. Plain ESM, no framework, no build step. |
| `vendor/scrcpy-server.json` | Pinned scrcpy server version and its SHA-256. |
| `test/` | Unit tests for the pure parts; `protocol-mirror.test.ts` pins server and client encoders together. |

### Startup order

`src/main.ts` constructs the requested providers, mounts every
`provider.middleware()` **before** `listen()` — so no request can arrive before a
provider's guard is in place — and only then calls `provider.init(ctx)` with the
base URL of the server's own socket. A provider that throws during `init` is
logged and skipped; the rest of the server comes up regardless.

Adding a backend should mean adding a directory under `src/providers/` and one
line to the `PROVIDERS` table in `main.ts`. If it needs more than that, the seam
is in the wrong place.

### The protocol, in one paragraph

One binary WebSocket at `/v1`. The first byte of every frame is a channel:
`0x01` video (server→client), `0x02` input (client→server), `0x03` control
(JSON, request/response paired by `id`), `0x04` events (JSON, server-pushed).
A one-byte `streamId` lets a single connection watch several devices at once.
Input coordinates are always normalized to `[0,1]` against the *upright,
displayed* picture, so a client never does coordinate arithmetic — the server
converts to device pixels and undoes any frame rotation. Everything else is in
[`docs/PROTOCOL.md`](PROTOCOL.md).

### Session behaviour worth knowing

- **Stream ids are reused.** `attach` allocates the lowest free id in `0..255`;
  after a `detach` that id comes back. Clients must use the id in the attach
  response and never predict it.
- **The server picks the codec.** With no `codec` in the attach request it takes
  `h264` when the device declares it, else the first entry of
  `capabilities.video`.
- **Move events are coalesced** using the 16-bit `seq` counter, with wraparound
  handled. `begin` and `end` are never dropped, so a gesture cannot be truncated.
- **Backpressure drops pictures, not state.** Above 4 MiB queued on the socket,
  `KEY` / `DELTA` / `SEED` frames are discarded; `CONFIG` never is, because a
  client that misses it can decode nothing at all.
- **Out-of-band device news travels through `HandleEvents`** (`onScreen`,
  `onLog`, `onForeground`, `onDialog`, `onError`, `onClosed`), which the session
  turns into EVENT-channel messages.

### Capabilities are declared, not assumed

The three backends genuinely have nothing in common: iOS has real HID and system
edge gestures, Android has a clipboard and a keycode table, WeChat has whatever
the Chrome DevTools Protocol reaches. Rather than flatten them to an
intersection, every device reports a `Capabilities` object
(`src/types.ts`) and the client renders from it. `capabilities.boot` is
per-device rather than per-provider for the same reason: an emulator image can be
started, a phone on the end of a cable cannot.

---

## 2. The backends

### 2.1 iOS — mounted middleware, not a fork

Everything hard about driving an iOS Simulator (loading Xcode's private
frameworks, pulling frames out of the simulator's `IOSurface`, encoding with
VideoToolbox, synthesising HID messages) belongs to
[serve-sim](https://github.com/EvanBacon/serve-sim), which simfarm consumes as a
dependency through its published `serve-sim/middleware` export. There is no fork
and no vendored copy, so a Xcode release that moves a private framework is
somebody else's maintenance.

`IosProvider.middleware()` returns `[simGuard(), simMiddleware({basePath: "/_ios"})]`
— guard first — and the handle then translates:

| serve-sim route | simfarm |
|---|---|
| `GET /_ios/grid/api`, `/start`, `/shutdown` | device list, `boot`, `shutdown` |
| `GET /_ios/helper/<udid>/stream.avcc` | VIDEO frames, h264 |
| `GET /_ios/helper/<udid>/stream.mjpeg` | VIDEO frames, jpeg |
| `GET /_ios/helper/<udid>/config` | `screen` events |
| `GET /_ios/helper/<udid>/foreground` | `foreground` events |
| `GET /_ios/helper/<udid>/ax` | `control("ax")` |
| `WS  /_ios/helper/<udid>/ws` | INPUT messages, via the private bridge below |

**The guard is an allowlist, and that is the point.**
`src/providers/ios/sim-paths.ts` holds the policy;
`src/providers/ios/sim-guard.ts` is twenty lines that apply it. serve-sim's
middleware exposes considerably more than the routes above — among them a
**shell-exec endpoint and its WebSocket twin**, guarded only by a bearer token
printed to a log. simfarm binds to a network interface and must never proxy that.
A denylist of the two known-dangerous paths would still leave the preview UI, an
app-state SSE tail and an outbound asset proxy reachable, and would rot the
moment serve-sim adds a route — so exactly the consumed routes pass and
everything else under `/_ios` is a 404 before serve-sim sees it.

The rule is deliberately blunt: a request is forwarded only when its **raw path
is already in canonical form** *and* matches the allowlist exactly. Any case
variant, percent-encoding (decoded repeatedly, so a double-encoded `exec` cannot
hide), `..` segment, duplicated slash or trailing slash fails the comparison and
is blocked, which means nobody has to reason about how serve-sim's own string
comparison would treat a mutated path. `/_ios` itself is blocked: that is
serve-sim's preview UI.

**HID input goes over a private Unix socket.** serve-sim serves its input
WebSocket from its own `handleUpgrade`, not from the connect-style middleware
chain, and simfarm's HTTP server destroys any upgrade whose path is not `/v1`.
`src/providers/ios/hid-bridge.ts` therefore runs a tiny `http.Server` bound to a
Unix domain socket inside a `0700` temp directory whose only job is to hand that
one upgrade to serve-sim: no TCP port, no new network surface, and the
filesystem permissions are the access control.

**Rotation is the one place iOS differs from everything else.** CoreSimulator's
framebuffer does not change shape when the guest rotates — the guest draws the
landscape UI lying on its side inside the portrait frame. So the provider reports
`screen.width/height` as the picture a human sees (swapped when landscape) plus a
`frameRotation` of 90 or 270, and does the inverse transform on incoming
coordinates itself (`src/providers/ios/rotation.ts`). The forward transform in
`web/app.js`'s `paint()` and the inverse here must stay exact mirrors; a test
pins them.

### 2.2 Android — the scrcpy *server* protocol, spoken directly

The provider speaks to [scrcpy](https://github.com/Genymobile/scrcpy)'s server
jar over adb. The scrcpy desktop client is not involved and is not required.
Video is encoded **on the device** by MediaCodec and arrives as H.264; input goes
out as scrcpy control messages, which is why dragging is smooth (`adb shell
input` forks a process per event and cannot be).

Sequence, in `tunnel_forward` mode, transcribed from the pinned sources in
`src/providers/android/scrcpy-session.ts`:

1. push the jar, `adb forward tcp:0 → localabstract:scrcpy_<scid>`;
2. `adb shell CLASSPATH=… app_process / com.genymobile.scrcpy.Server <version> …`;
3. connect the video socket, retrying until it yields the single **dummy byte** —
   adb accepts a connection eagerly and only then hangs up, so connecting proves
   nothing and the dummy byte is what proves the server is listening;
4. connect the control socket (order is video, then optional audio, then control);
5. read the 64-byte device-name field, which goes to the *first* socket only and
   only after all sockets are accepted — hence after step 4, not between 3 and 4;
6. video: a 4-byte codec id, a session packet, then 12-byte-header media packets.

Annex-B from the device is converted to avcC in `src/util/h264.ts`: parameter
sets become the `CONFIG` frame, IDRs become `KEY`, the rest `DELTA`.

**The version is pinned and verified.** The scrcpy server protocol is neither
documented nor stable across releases, so `vendor/scrcpy-server.json` records the
version, tag, URL and SHA-256 while the jar itself stays out of git.
`src/providers/android/scrcpy-release.ts` verifies the digest at startup and
**refuses to run on a mismatch** rather than pushing an unknown binary to a
device. Upgrading is an explicit change: bump the manifest, re-read the
version-specific assumptions in `scrcpy-session.ts` (socket order, packet header,
control message ids), and re-measure.

Device discovery uses `adb track-devices` (a long-lived connection) rather than
polling `adb devices`. Light/dark switching is `cmd uimode night`; there is no
accessibility tree, which would need a separate uiautomator channel, and no edge
gestures, which Android does not have.

### 2.3 WeChat — two legs, because the simulator is not one surface

The mini program simulator inside WeChat DevTools is a Chromium (NW.js) window,
so the Chrome DevTools Protocol reaches it — but only part of it.

**Leg one, the picture and in-page input: CDP against the `__pageframe__`
target.** The render layer of one mini program page is a `type: "webview"` target
whose URL contains `__pageframe__`. Its DOM is ordinary mini program DOM, and
`Page.startScreencast` on it yields the mini program with none of the IDE around
it. Input is `Input.dispatchTouchEvent` (mini program components bind
`bindtap`/`bindtouchstart`, and a real handset only ever produces touches),
`mouseWheel` for scrolling — there is no touch equivalent that does not mean
synthesising a whole drag — and `Input.insertText` for whole strings, which
handles non-Latin input in one call. **CDP input is in CSS pixels** while the
frames are the device pixels of the same viewport, so
`src/providers/wechat/wechat-input.ts` divides the scale factor out; using frame
coordinates puts every touch off-screen.

Three target kinds matter, parsed in `wechat-targets.ts`:

| Target | URL shape | Role |
|---|---|---|
| `page` | `…/html/index.html?projectpath=…&appid=…` | one per open project; source of the device id and name |
| `webview` | `…/__pageframe__/<route>` | render layer — one per mini program page |
| `webview` | `…/appservice/mainframe` | logic layer — where the page stack is read |

**Leg two, everything drawn outside that frame:
`src/providers/wechat/wechat-shell.ts`.** `wx.showModal`, action sheets, toasts
and the authorization and payment sheets are drawn by the IDE in the project
window's own DOM, not in the captured page frame. They are therefore invisible in
the video *and* unreachable by touches dispatched into the page frame. The shell
watcher inspects the project window's DOM inside its `.simulator` subtree only,
describes what is up (kind, title, content, buttons, normalized rect, whether it
is on top), and the provider pushes it as a `dialog` event; the client draws its
own stand-in and presses back through `dialogPress`. Presses are dispatched as
real `Input.dispatchMouseEvent` at the button's own rect — calling
`element.click()` runs the mini program's callback but not the IDE's close path,
which leaves an undismissable dialog on screen and queues every later one behind
it.

The **control plane is the tool's own CLI** (`wechat-cli.ts`): open, close, quit,
and the launch flags. Its HTTP surface has no screenshot, stream, display or
input endpoint anywhere, so it is exactly and only a control plane.

**H.264 is produced here, not by the source.** CDP hands over whole JPEGs with no
interframe compression, which is expensive enough to matter on a remote link.
`src/providers/wechat/h264-encoder.ts` pipes them through `ffmpeg` with
`h264_videotoolbox` — the same Apple encoder serve-sim reaches natively, behind a
process boundary that is genuinely useful: a wedged encoder cannot take the
server down and can be respawned in milliseconds. Encoder parameters mirror
serve-sim's (realtime, no frame reordering, high profile) because those are what
make an encoder behave like a live stream rather than a file. The capability is
**probed at `init()`**: without a usable ffmpeg the device declares `["jpeg"]`
only, because declaring a codec that cannot be produced would fail every attach —
the server prefers h264 when it is offered.

Two hardware buttons are synthesised (`back`, `home`) because the simulator's own
navigation bar is part of the IDE chrome and deliberately outside the captured
picture; without them a client that navigates into a second-level page has no way
out. They are `wx.navigateBack()` and a `wx.reLaunch()` to the app's declared
entry page.

---

## 3. Known limitations, and why

These are constraints of the underlying systems, not bugs waiting to be fixed.
They are listed because each one is expensive to rediscover.

**Android emulators encode in software, so sharpness and frame rate are in direct
tension.** Throughput falls off with pixel count, and there is a second ceiling
underneath it — the app itself only renders so fast. Measured back to back on one
AVD: `--android-max-size 640` gave ~20 fps and a visibly soft picture, `1024`
~15 fps, `1920` ~8.5 fps and sharp but too choppy to judge motion. The default is
1024 because a soft picture is still usable and 8 fps is not; anyone judging
static type should raise it and anyone judging animation should lower it. A
physical handset encodes in hardware and has neither ceiling. Input stays
normalized, so the setting is invisible to clients.

**Which mini program page is on screen must be read from the logic layer's page
stack.** One page equals one `__pageframe__` target; navigating creates a new one
and leaves the old alive, and the target list does not say which is visible. Two
plausible answers are both wrong: `document.visibilityState` is `"visible"` in
every page frame regardless, and "whoever painted most recently" survives casual
testing before failing on a real app — a page that has left the screen keeps
finishing its animations, so an auto-playing carousel on a previous page
out-paints the page just navigated to, wins on recency, then goes quiet, leaving
the stream stuck there permanently with every subsequent touch delivered to the
wrong frame. `getCurrentPages()` in the appservice target is the app's own idea of
where it is and changes exactly when the user navigates.

**A page frame's URL changes in place after the target is created.** It appears as
an empty shell (`__pageframe__/instanceframe.html`) and only later becomes
`__pageframe__/<route>`. Recording the route at attach time freezes it at the
shell name, the page stack can never match it, and the picture sticks on the
previous page. Routes must be re-read on every sync.

**A `__pageframe__` target only exists once the mini program has actually
rendered.** "Tool open, nothing rendered yet" is a normal state, not an error.

**The WeChat simulator's dialogs cannot appear in the video** — see §2.3. The
picture keeps arriving and does not even dim while the device is in fact blocked,
so without the `dialog` event a client can only present as "it suddenly stopped
responding" with no clue why.

**Restarting a screencast on a live CDP connection wedges it.** A
`Page.stopScreencast` followed by a `startScreencast` on the same connection never
delivers another frame if a frame was still unacknowledged. Leaving a page is
therefore implemented by dropping its connection entirely, which costs a few
milliseconds to re-establish on the way back.

**WebCodecs only exists in a secure context.** Served from a plain-HTTP IP
address, `VideoDecoder` is `undefined` and H.264 does not decode — and it fails
silently: the server streams, the client's frame and bitrate counters climb, and
the canvas stays black. The same build over `http://127.0.0.1` is fine, which is
why it is easy to measure everything on loopback and never see it. Reach the
server through an SSH tunnel so the browser sees `localhost`, or serve it over
HTTPS. The client detects the missing decoder and falls back to JPEG so there is
a picture rather than a black rectangle, but JPEG costs roughly seven times the
bandwidth — a readout saying `jpeg` where `h264` was expected means the origin is
wrong.

**WeChat DevTools needs `--disable-backgrounding-occluded-windows` and
`--disable-renderer-backgrounding`.** Without them the tool composites the first
mini program page and then never composites another one: navigation succeeds, the
page stack moves, new page frames appear in the target list, and the picture
stays frozen on whatever came up first. Command-line flags only take effect at
launch, so a tool that is already running without them has to be restarted by
hand — the provider starts it correctly when it is not running, and can do
nothing when it is.

**WeChat cannot be rotated or switched between light and dark** from here.
Orientation is an IDE control with no API, and the appearance switch has no
reachable equivalent — which is exactly why both are declared `false` rather than
attempted and silently failing.

---

## 4. Client rules

`web/` is the client, and also the reference implementation of the protocol. It
has two halves and the line between them matters: the **engine** (connection,
control requests, frame decode, input encoding) is verified against every backend
and should not be rewritten for the sake of the UI; the **instrument** (layout,
sizing, the floating clusters) is presentation.

**The picture is drawn at 1:1 device point size.** The canvas CSS size is
`screen.width / screen.scale` × `screen.height / screen.scale`, so a device with a
1206×2622 @3x screen occupies 402×874 CSS px on the desk. This is the rule the
whole layout is built around, because the usual reason to watch a simulator
remotely is to judge one's own UI — 17pt type has to look like 17pt type, and a
scaled picture hides exactly the things being looked for (soft glyphs, hairline
rules). The canvas *backing store* stays the full frame size, so on a HiDPI
display the picture downsamples and stays sharp rather than blurring up.

**Scaling happens only when the window genuinely cannot fit the device, and the
readout says so.** Whether it fits is judged against `screen.availWidth` /
`availHeight`, never `innerWidth` — the window is the thing being sized, so using
it as the input is circular. This is not an edge case: a large desktop fits a
tablet at 1:1, an ordinary laptop does not, and a HiDPI laptop with ~900 logical
points cannot fit a phone. When the scale is not 100% the readout states it
prominently rather than as a parenthetical, because judging rendering without
knowing you are looking at a shrunken image is worse than not looking at all. The
zoom control is a continuous slider that snaps to 50 / 75 / 100%, plus a `fit`
option, and a manual choice is remembered and never silently overridden by a
device change.

**The UI is rendered from each device's declared `capabilities`, not from a
common feature set.** `renderControls()` in `web/app.js` builds the side rail from
`capabilities.buttons` (hardware keys), then a hairline, then this client's own
tools — rotate only if `capabilities.rotate`, the text field only if
`capabilities.text`, and so on. Hardware keys and client tools are visually
separated because mixing them reads as though the phone had a "100%" key. A
button that is declared but not pressable is worse than an absent one: it reads as
a broken panel rather than a missing feature.

Related client rules that follow from the same reasoning:

- **The client never picks a codec.** The server chooses from what the device
  offers. The single exception is a browser without WebCodecs, which is a fact
  about the client rather than a preference; it then asks for `jpeg`, or reports
  an explicit error when the device has no JPEG path at all.
- **Waiting states say what they are waiting for.** A black rectangle is
  indistinguishable from a fault, and the protocol guarantees a SEED frame at
  attach — so "the seed arrived and then nothing" and "not even a seed" are
  different messages.
- **Zero external requests, and no saturated colour except the status dot.**
  Icons are inline SVG using `currentColor` and fonts are a local stack, so
  nothing can fail to load; and the instrument sits centimetres from the
  interface being judged, where a brand colour beside it corrupts the judgement.

---

## 5. If you are changing something

| Change | Where, and what it drags with it |
|---|---|
| Wire format | `src/protocol.ts` **and** `web/protocol.js`; `test/protocol-mirror.test.ts` fails if they drift. Incompatible changes get a new endpoint path, not a silent edit. |
| A new backend | A directory under `src/providers/`, one row in the `PROVIDERS` table in `src/main.ts`. Declare capabilities honestly; the client believes them. |
| serve-sim routes | `src/providers/ios/sim-paths.ts`. Adding to the allowlist is a security decision — check what else that route reaches. |
| scrcpy version | `vendor/scrcpy-server.json`, then re-read the version-specific assumptions in `src/providers/android/scrcpy-session.ts`. |
| Client layout | `web/app.js` (the instrument half) and `web/style.css`. Leave the engine half alone unless the protocol changed. |

Pure logic — protocol codecs, coordinate maths, rotation inverses, path policy,
target parsing — is unit-tested and should stay that way; those are the parts
where a mistake is silent.
