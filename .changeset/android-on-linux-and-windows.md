---
"simfarm": minor
---

Install and run on Linux and Windows. `package.json` no longer pins `os: darwin` / `cpu: arm64`, which made `npx simfarm` fail with `EBADPLATFORM` everywhere but Apple Silicon Macs — even for the Android backend, which has never needed macOS. Each backend now declares where it can run and `--providers` refuses an impossible one up front with a message saying why: iOS is macOS-only (serve-sim's native addon), WeChat is macOS or Windows (the two builds Tencent ships), Android and mock run anywhere. The Android backend looks for the SDK in Android Studio's default location on each OS (`~/Android/Sdk` on Linux, `%LOCALAPPDATA%\Android\Sdk` and `adb.exe` on Windows) and its hints no longer assume `brew` or `~/Library`. The WeChat control plane knows the Windows install (`cli.bat`, the IDE exe, `tasklist` instead of `pgrep`), and `WECHAT_DEVTOOLS_PATH` overrides the install location on either OS.
