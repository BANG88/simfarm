# simfarm protocol v1

> This document describes the wire protocol **as the server actually implements it**, and it is the contract a client integrates against.
> [`ARCHITECTURE.md`](ARCHITECTURE.md) explains how the pieces behind it fit together; where the two overlap, this document wins.
> The server implementation is in `src/protocol.ts`, the browser-side mirror in `web/protocol.js`
> (`test/protocol-mirror.test.ts` guarantees the two are byte-for-byte identical, so you can copy it directly).

Version: **v1** (endpoint `/v1`). Any incompatible change gets a new endpoint path; nothing changes silently.

---

## 1. Connection

| Endpoint | Description |
|---|---|
| `ws://<host>:<port>/v1` | The only data channel; everything is multiplexed over it |
| `http://<host>:<port>/` | The web client shipped with the server |
| `http://<host>:<port>/healthz` | `{ok, uptime, devices, booted, sessions}` |
| `http://<host>:<port>/devices` | `{devices: Device[]}` — the device list, without opening a WebSocket |

**`/devices`** exists for callers that cannot open a WebSocket (Omarchy's bar widget).
Its content is exactly the same as the `devices` event; it reads the registry's watch cache, so it neither costs anything nor
blocks on some provider. `?booted=1` returns only those with `state:"booted"`.

**`devices` and `booted` in `/healthz` are not the same thing**: `devices` is everything the providers know about
(on the iOS side, every simulator ever created on this machine — 28 of them), while `booted` is the ones **actually running**.
The meaning of `devices` has not changed, so that anything already reading it does not get silently broken.

- **Binary WebSocket frames only.** Text frames are ignored by the server, which logs a warn.
- One connection can view several devices at once, distinguished by `streamId` (see §4 attach).
- v1 has no authentication (ARCHITECTURE.md); it listens only on Tailscale / loopback interfaces.
- Once the connection is established the server **pushes one** `devices` event on its own; you do not need to send `list` first.

---

## 2. Frame structure

```
[1B channel][payload...]
```

| channel | Name | Direction | payload |
|---|---|---|---|
| `0x01` | VIDEO | S→C | `[1B streamId][1B tag][data...]` |
| `0x02` | INPUT | C→S | `[1B streamId][1B kind][...]` |
| `0x03` | CONTROL | C↔S | UTF-8 JSON (request and response share the channel, paired by `id`) |
| `0x04` | EVENT | S→C | UTF-8 JSON (pushed by the server) |

**All multi-byte integers and floats are big-endian, without exception.** The choice
follows the 4-byte big-endian length prefix of the serve-sim avcc stream the iOS
backend already has to interoperate with.

Floats are **float32**; normalized coordinates get about 7 significant digits — far finer than one pixel on any screen.
When a client does a round-trip comparison it must compare as float32, not against a float64 literal.

Frames with an unknown channel, an unknown input kind, or insufficient length are rejected; the server replies with
`{"ev":"error","message":"bad frame: ..."}` and **does not close the connection**.

---

## 3. VIDEO (server → client)

```
[0x01][1B streamId][1B tag][data...]
```

| tag | Name | Meaning |
|---|---|---|
| `0x01` | CONFIG | Codec configuration. h264 = avcC parameter sets (SPS/PPS). This frame never appears for jpeg |
| `0x02` | KEY | h264 IDR key frame, or a whole jpeg image |
| `0x03` | DELTA | h264 P frame. This frame never appears for jpeg |
| `0x04` | SEED | One JPEG delivered **immediately** after attach, so the client has a picture instantly |

**A SEED is always JPEG, even when that stream's codec is h264.** On receiving a SEED, draw it directly as an image;
do not feed it to the H.264 decoder. After that, handle CONFIG/KEY/DELTA according to the codec.
(`onFrame()` in the test page `web/app.js` dispatches exactly this way.)

**h264 decode order**: the decoder cannot be configured until CONFIG has arrived; KEY/DELTA frames that arrive
before CONFIG should be discarded. The WebCodecs `codec` string can be assembled from bytes 1–3 of the avcC:
`avc1.` + `profile/compat/level`, two hex digits each.

**Backpressure**: when a client's backlog exceeds 4 MiB the server **drops KEY/DELTA/SEED frames** (CONFIG is never dropped)
and logs a warn. A client may therefore see the picture skip frames — this is deliberate: better to drop frames than to pile up latency.
Once an h264 stream has had DELTA frames dropped, the picture is corrupted until the next IDR.

---

## 4. CONTROL (JSON, request-response)

Requests are initiated by the client and must carry a **monotonically increasing `id`**:

```jsonc
{"id":1,"op":"list"}
```

The response always carries the same `id`, and always carries `ok`:

```jsonc
{"id":1,"ok":true,"devices":[ ... ]}
{"id":1,"ok":false,"error":"no such mock device: mock:nope"}
```

> `ok` / `error` are not written down in ARCHITECTURE.md but are indispensable: a client has to be able to tell "succeeded but the result is empty"
> from "failed". **Every response has `ok`**; on failure, `error` is a human-readable string.

The server never sends a message without an `id` on the CONTROL channel on its own — everything it pushes goes over EVENT.

### Supported ops

| op | Parameters | Response |
|---|---|---|
| `list` | — | `{devices: Device[]}` |
| `attach` | `deviceId`, optional `codec` | `{streamId, codec, device}` |
| `detach` | `streamId` | `{}` |
| `rotate` | `streamId`, `orientation` | `{}`, plus a `screen` event is pushed |
| `launch` | `streamId`, `target` | `{result}` — deeplink / bundleId / mini program page path |
| `dialog` | `streamId` | `{result:{open, overlays}}` — see the `dialog` event in §6 |
| `dialogPress` | `streamId`, `which` | `{result:{pressed}}` — press one of the buttons on the dialog |
| `appearance` | `streamId`, `mode` | `{result:{mode}}` — the device's own light/dark mode, see below |
| `boot` | `deviceId` | `{result}` — requires provider support |
| `shutdown` | `deviceId` | `{result}` |

- When `attach` omits `codec`, the server picks according to the device's capabilities: **h264 if h264 is available**, otherwise the first one.
  Requesting a codec the device does not support fails (`ok:false`).
- `streamId` is **0–255**, assigned by the server at attach time as the lowest currently free value — so
  **the same id is reused after a detach**. The client must take the attach response as authoritative and not guess.
- Any other op name is forwarded to that stream's provider for handling (a `streamId` is required);
  if the provider does not recognize it, it returns `ok:false`. This is the hole left open for future platform-specific capabilities.
- **For provider-specific ops, the answer goes inside `result`** (`{"id":3,"ok":true,"result":{...}}`),
  not flattened into the top level.

### `appearance` — make the device follow the desktop theme's light/dark mode

```jsonc
{"id":7,"op":"appearance","streamId":0,"mode":"dark"}   // → {"result":{"mode":"dark"}}
```

`mode` **has only two values, `"light"` and `"dark"`**; anything else is `ok:false`.
This is not nitpicking: both backends interpolate it into a command line
(`simctl ui <udid> appearance <mode>`, `cmd uimode night <yes|no>`),
and v1 of the protocol has no authentication (ARCHITECTURE.md).

What it changes is **the guest's own system setting**; it has nothing to do with video or rendering — it is the very switch a person
would flip in Settings. The `mode` in the response is **read back**, not the request copied back verbatim: if the device says yes
but nothing actually changed, the client has to have a way to know.

**Check `capabilities.appearance` first.** The three backends have nothing whatsoever in common here:

| Backend | How it is done | Declared |
|---|---|---|
| iOS | `xcrun simctl ui <udid> appearance light\|dark` | `true` |
| Android | `adb shell cmd uimode night yes\|no` (the same as "Dark theme" in Settings) | `true` |
| WeChat | **Cannot be done** | `false` |

The WeChat row was investigated, not taken as the easy way out: the IDE window's DOM contains no simulator appearance switch at all
(only the editor's own theme), and automator's `Native.*` all answer "unimplemented" in this version; and even if there were a switch,
the target project's `app.json` does not declare `darkmode`, `wx.getSystemInfoSync().theme` is undefined, and the mini program
would never receive it.

**For devices that declare `false`, the client should silently skip**, not report an error on every theme change.

### `dialog` / `dialogPress` (WeChat only for now)

`which` in `dialogPress` can be:

| which | Meaning |
|---|---|
| `"confirm"` | The confirm button (the "确定" of `wx.showModal`) |
| `"cancel"` | The cancel button; falls back to the dialog's close button when it has no cancel button |
| `"close"` | The close button (the payment dialog has only a ✕, no text button at all) |
| A number | The index into that dialog's `buttons` — **the only way to choose an action sheet option** |

`{"pressed": null}` means there was no dialog at all at that moment (someone may have closed it by hand in the IDE);
it is not a failure. Aliases for compatibility with automator's vocabulary: `confirmModal` / `cancelModal` /
`authorizeAllow` / `authorizeCancel` / `closePaymentDialog`, behaving the same as the three roles above.

---

## 5. INPUT (client → server)

```
[0x02][1B streamId][1B kind][...]
```

Coordinates are always normalized to `[0,1]`, relative to **the currently displayed (already rotated) picture**, and the server converts
them into device pixels. A client therefore does not need to know the device resolution, and rotation requires no coordinate transform on the client.
Values outside `[0,1]` are clamped by the server.

| kind | Layout | Total length |
|---|---|---|
| `0x10` TOUCH | `[1B phase][f32 x][f32 y][u16 seq][1B edge]` | 15 |
| `0x11` MULTITOUCH | `[1B phase][f32 x1][f32 y1][f32 x2][f32 y2][u16 seq]` | 22 |
| `0x12` KEY | `[1B phase][u32 usage]` | 8 |
| `0x13` BUTTON | `[1B phase][1B buttonId]` | 5 |
| `0x14` SCROLL | `[f32 dx][f32 dy][f32 anchorX][f32 anchorY]` | 19 |
| `0x15` TEXT | UTF-8 string, running to the end of the frame (no length prefix) | 3+n |

- **phase**: TOUCH / MULTITOUCH use `0=begin 1=move 2=end`; KEY / BUTTON use `0=down 1=up`.
  An invalid phase is rejected.
- **seq**: a 16-bit monotonic counter; **increasing within each gesture is enough, and wrap-around on overflow is legal**.
  The server uses it to discard late / duplicate moves (the comparison handles wrap-around).
  `begin` and `end` are never dropped, so a gesture is never truncated.
- **edge** (the core capability of ARCHITECTURE.md): `0=none 1=top 2=bottom 3=left 4=right`.
  **Decided at `begin` and held at the same value for the whole gesture** — iOS only recognizes gestures that "start at the edge".
  When a device has `capabilities.edgeGesture=false`, always send 0.
- **SCROLL's dx/dy** are normalized displacements (a fraction of the screen size); the positive direction = the content moves right/down.
- Input sent to a `streamId` that is not attached is silently dropped (no error, to avoid a detach race flooding the log).

### buttonId table

`capabilities.buttons` is an array of strings, while on the wire a button is 1 byte. The mapping table is part of the protocol:

| name | id | | name | id |
|---|---|---|---|---|
| `home` | `0x01` | | `power` | `0x07` |
| `lock` | `0x02` | | `siri` | `0x08` |
| `volume_up` | `0x03` | | `menu` | `0x09` |
| `volume_down` | `0x04` | | `camera` | `0x0a` |
| `back` | `0x05` | | `ringer_mute` | `0x0b` |
| `app_switch` | `0x06` | | `action` | `0x0c` |

A client should only show the buttons declared in `capabilities.buttons`.

### KEY usage

USB HID Usage Page 0x07. `hidUsage()` in `web/app.js` has a
`KeyboardEvent.code → usage` table you can copy directly.

---

## 6. EVENT (server → client)

```jsonc
{"ev":"devices","devices":[ ... ]}                  // Device list changed (pushed once right after connecting)
{"ev":"screen","streamId":0,"width":390,"height":844,"scale":2,"orientation":"portrait","frameRotation":0}
{"ev":"log","streamId":0,"level":"info","text":"..."}
{"ev":"foreground","streamId":0,"bundleId":"...","pid":123}
{"ev":"error","streamId":0,"message":"..."}         // streamId may be absent (connection-level error)
{"ev":"dialog","streamId":0,"open":true,"overlays":[ ... ]}   // see below
```

- `screen` is pushed after attach, after a rotation, and when the device itself reports a size change.
  **The client should size its canvas from `screen`**, rather than waiting for the first frame to decode before it learns the size.
- `error` **does not mean the connection is gone**, only that this operation failed.

### ⚠️ `dialog` — what the device is showing that is not in the video

```jsonc
{"ev":"dialog","streamId":0,"open":true,"overlays":[{
  "kind":"modal",                       // modal|actionsheet|toast|loading|payment|dialog
  "title":"清理缓存",
  "content":"确定要清理缓存吗?",
  "buttons":[{"label":"取消","role":"cancel","index":0},
             {"label":"确定","role":"confirm","index":1}],
  "rect":{"x":0.1008,"y":0.3875,"width":0.8011,"height":0.225},   // normalized to the screen
  "onTop":true                          // when several are stacked, which one a press lands on
}]}
```

**The WeChat simulator draws `wx.showModal` / action sheets / toasts / authorization dialogs / payment dialogs in the IDE's own
window, not in the `__pageframe__` we capture.** That is, the dialog **is not in the video at all**: frames keep arriving as usual
and do not even dim, while the device is in fact blocked and no touch does anything. Without this event, a client can only behave
as if "taps suddenly stopped working", with no clue whatsoever.

- **`open:false` + an empty `overlays` = the last dialog is gone.**
- The current state is **pushed once immediately** after attach (it may be empty).
- `rect` is normalized to the **screen** (the same space as input coordinates), so the client can draw it where the simulator draws it.
- Dialogs **stack** (a payment dialog can open underneath an authorization dialog), so `overlays` is a stack;
  the one whose `onTop` is true is the one a press will hit.
- **Do not redraw it as a copy of weui's look.** These are pixels the client draws, not the device's;
  the `.sheet` layer in `web/app.js` uses the page's own grey and labels the `kind`, precisely so the two are not confused.
- Other platforms do not send this event. System dialogs on iOS / Android are in the real picture and are visible anyway.

### ⚠️ WebCodecs only exists in a secure context

When the browser client is opened from `http://<ip>:<port>/` (which is exactly what Omarchy over Tailscale does),
**`VideoDecoder` is undefined** and not one h264 frame decodes — and it fails very quietly:
the server keeps streaming, frame count and bitrate both climb, and the canvas stays black. The same code opened from `http://127.0.0.1`
works fine, so every measurement taken on this machine misses it.

The client side already handles this: if `VideoDecoder` is not detected it **attaches `jpeg`** instead
(when the device does not offer jpeg — Android, for instance — it reports a clear error rather than a black screen).
**The real fix is to put the server behind TLS** (`tailscale cert` can sign a real certificate for a MagicDNS
name), after which h264 works. If you are writing your own client, take note of this one:
without the detection you get a black canvas and a set of statistics that look perfectly normal.

### ⚠️ `frameRotation` — the frames you receive are not necessarily upright

```
frameRotation: 0 | 90 | 180 | 270    // defaults to 0
```

**Meaning: how many degrees clockwise the client has to rotate the decoded frame for it to be drawn upright.**

Why this field is needed: the rotation behavior of the three backends is **not the same at all**.

| Backend | What happens on rotation | frameRotation |
|---|---|---|
| Android | scrcpy rotates the picture upright on the device; the frame's width and height really do swap | always `0` |
| mock | Same as above | always `0` |
| **iOS** | **CoreSimulator's framebuffer size does not change** (e.g. it stays 1206x2622); the guest draws the landscape UI **lying on its side inside the portrait frame** | `90` / `270` in landscape |

Without this field a client either shows a sideways screen (the viewer has to tilt their head) or has to guess from `orientation`
— and guessing is wrong, because Android's landscape frames are already upright.

Accompanying rules:

- **`width` / `height` describe "the image a person sees"**, i.e. the size **after being rotated upright by `frameRotation`**.
  In landscape, iOS reports the swapped size (2622x1206), not the framebuffer's size.
- **The semantics of input coordinates do not change at all**: they are always normalized to `[0,1]` relative to "the upright image you see".
  It is the **server** that needs the inverse transform (inside the provider the coordinates are converted back to framebuffer space); clients never do coordinate math.
- Take the canvas size as `width` x `height`, and apply one canvas transform for `frameRotation` when drawing.
  `paint()` in `web/app.js` is a complete reference implementation (all four angles, about 20 lines).

---

## 7. Device / Capabilities

```ts
type DeviceKind = "ios" | "android" | "wechat" | "mock";
type Orientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";
type Codec = "h264" | "jpeg";

interface Device {
  id: string;        // "<kind>:<native id>", stable and unique
  kind: DeviceKind;
  name: string;      // human-readable
  state: "booted" | "shutdown" | "connecting" | "error";
  screen?: Screen;
  capabilities: Capabilities;
}

interface Screen {
  width: number;       // width of the displayed picture (already rotated upright per frameRotation)
  height: number;      // height of the displayed picture
  scale: number;       // points = pixels / scale
  orientation: Orientation;
  frameRotation?: 0 | 90 | 180 | 270;   // see §6, defaults to 0
}

interface Capabilities {
  video: Codec[];        // attachable codecs, in preference order
  touch: boolean;
  multitouch: boolean;
  keyboard: boolean;     // key-by-key HID
  text: boolean;         // whole-string text injection
  scroll: boolean;
  buttons: string[];     // see the buttonId table in §5
  rotate: boolean;
  edgeGesture: boolean;
  clipboard: boolean;
  ax: boolean;
  deeplink: boolean;
  mediaDrop: boolean;
  /** Whether the guest's own light/dark setting can be driven; see `appearance` in §4 */
  appearance: boolean;
}
```

`screen.width/height` are **pixels** and describe **the image a person sees** (already rotated upright per `frameRotation`),
so width/height swap after a rotation — but **the frames themselves have not necessarily been rotated**; see `frameRotation` in §6.
`scale` is the scale factor, points = pixels / scale.

**Capabilities are declarative; the client degrades its UI according to them** — the three platforms differ a lot, do not assume.
The values each platform actually declares are in ARCHITECTURE.md / §5.2 / §6.4; the runtime `devices` event is authoritative.

---

## 8. Minimal client flow

1. Connect to `ws://host:port/v1`, `binaryType = arraybuffer`
2. Receive `{"ev":"devices"}` → render the device list
3. Send `{"id":1,"op":"attach","deviceId":"...","codec":"h264"}`
4. Take `streamId` from the response; receive `{"ev":"screen"}` and set the canvas size
5. Receive VIDEO: draw SEED as a JPEG; configure the decoder from CONFIG; feed KEY/DELTA to the decoder
6. Mouse events → normalized coordinates → `encodeInput(streamId, {kind:"touch",...})`
7. On disconnect (or when switching devices) send `{"op":"detach","streamId":N}`

`web/app.js` is a complete, runnable reference implementation of this flow (about 400 lines, no dependencies).
