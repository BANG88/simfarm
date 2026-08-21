# simfarm

Stream a Mac's simulators — iOS, Android, and the WeChat DevTools mini program
simulator — over a single WebSocket, and drive them from another machine.

One server, one protocol, one web client. The client runs in any browser and
draws each device at **1:1** — an iPhone 17 Pro is 402×874 CSS px on your desk,
not a picture stretched to fill a window — because the usual reason to want this
is to judge how your own UI actually looks.

- **[`docs/PROTOCOL.md`](docs/PROTOCOL.md)** — the wire protocol. Write your own
  client against this; the bundled one is its reference implementation.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pieces fit together,
  what each backend actually does, and the constraints that are not obvious.

---

## What it supports

| Backend | What it drives | Needs |
|---|---|---|
| **iOS** | Any iOS Simulator on the machine | Xcode with an iOS runtime |
| **Android** | Emulators (AVDs) and physical devices, over adb | Android SDK platform-tools; a scrcpy server jar |
| **WeChat** | The mini program simulator inside WeChat DevTools | WeChat DevTools, launched with a debugging port |
| **mock** | A synthetic device — colour bars, a clock, input echo | nothing |

Backends differ a lot, and the protocol says so rather than pretending
otherwise: every device reports a `capabilities` object and the client renders
only what a device actually has.

| | iOS | Android | WeChat |
|---|---|---|---|
| Video | H.264 + JPEG | H.264 | H.264 (via ffmpeg) + JPEG |
| Touch, keyboard, text | yes | yes | yes |
| Rotation | yes | yes | no |
| Edge gestures (swipe up for home) | yes | no | no |
| Hardware buttons | 8 | up to 7 | `back`, `home` (synthesised) |
| Light/dark switching | yes | yes | no |
| Start a shut-down device | yes | no | yes |
| Clipboard | yes | yes | no |

`mock` needs no simulator at all and is the fastest way to see whether the
protocol and the client are working.

> **iOS support is [serve-sim](https://github.com/EvanBacon/serve-sim)'s work,
> not ours.** See [Credits](#credits).

---

## Quickstart

Requires **macOS on Apple Silicon**, [bun](https://bun.sh), and Node 22+.

```bash
git clone https://github.com/BANG88/simfarm.git
cd simfarm
bun install

bun start                                     # mock device only, no simulator needed
bun start -- --providers ios,android,wechat   # whatever you actually have
```

Then open **`http://127.0.0.1:8801/`** and pick a device from the dropdown.

Or without a clone:

```bash
npx simfarm --providers ios
```

Each backend needs a little setup of its own — Xcode for iOS, adb and a scrcpy
jar for Android, three launch flags for WeChat. **[`docs/SETUP.md`](docs/SETUP.md)
covers all of it**, along with every command-line flag, running it as a service,
and what to do when something does not come up.

### ⚠️ One thing worth knowing before you connect from another machine

**H.264 does not decode from `http://<ip>:8801/`.** WebCodecs only exists in a
secure context, so `VideoDecoder` is `undefined` on a plain-HTTP page served
from an IP address — the server streams, the counters climb, and the canvas
stays black. Reach it over an SSH tunnel to `localhost`, or over HTTPS:

```bash
ssh -N -L 8801:127.0.0.1:8801 <user>@<mac-running-simfarm>
```

[`docs/SETUP.md`](docs/SETUP.md#5-connecting) has the detail. The client falls
back to JPEG rather than showing you nothing, at about seven times the
bandwidth — if the readout says `jpeg` where you expected `h264`, this is why.

---

## Documentation

| | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Installing and configuring each backend, every flag, running it persistently, troubleshooting. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the pieces fit together, what each backend does, and the constraints that are not obvious. |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | The wire protocol. Write your own client against this; the bundled one is its reference implementation. |

## Endpoints

| | |
|---|---|
| `GET /` | the web client |
| `WS /v1` | the protocol |
| `GET /devices` | device list as JSON; `?booted=1` for running ones only |
| `GET /healthz` | `{ok, uptime, devices, booted, sessions}` |

## Development

```bash
bun run dev         # node --watch, restarts on source changes
bun run test        # unit and integration tests
bun run typecheck   # tsc --noEmit
bun run build       # bun -> dist/, only needed for publishing
```

A clone has **no build step**: `bun start` is `node src/main.ts` and Node runs
the TypeScript directly. bun is the package manager and the publish build. The
tests are `node --test` against `node:test`, deliberately not `bun test`.

The publish build is `bun build --no-bundle`, so `dist/` mirrors `src/` file for
file: two modules resolve paths from `import.meta.url` at different depths
(`../web/` and `../../../vendor`), and a single-file bundle can only be right
about one of them.

---

## Credits

**iOS support is [serve-sim](https://github.com/EvanBacon/serve-sim) by
[Evan Bacon](https://evanbacon.dev), Apache-2.0.** simfarm did not reimplement
any of it and does not intend to.

Everything genuinely difficult about driving an iOS Simulator is serve-sim's:
loading Xcode's private `CoreSimulator` and `SimulatorKit` frameworks, pulling
frames out of the simulator's `IOSurface` with no copy, encoding them with
VideoToolbox, and synthesising Indigo HID messages so touches, keys and the
system edge gestures land where a real finger would. That is a large amount of
careful reverse engineering, and it is maintained against Xcode releases by
somebody else.

simfarm consumes it as a dependency through its published
`serve-sim/middleware` export — **not a fork, not vendored code** — mounts that
middleware inside its own HTTP server, and translates between serve-sim's
endpoints and the protocol in [`docs/PROTOCOL.md`](docs/PROTOCOL.md) so that iOS
looks like the other two backends to a client. If you want an iOS simulator in a
browser and nothing else, use serve-sim directly; it is the better tool for that
job.

Android support speaks the [scrcpy](https://github.com/Genymobile/scrcpy) server
protocol (Apache-2.0). The server jar is downloaded and checksum-verified at
setup rather than committed here.

## License

MIT — see [`LICENSE`](LICENSE).
