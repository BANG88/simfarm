---
"simfarm": patch
---

serve-sim 0.1.45 -> 0.1.46 (upstream PR #140, "restore Xcode 27 Device Hub streaming and input"). On Xcode 27 the native capture now picks the simulator's own framebuffer instead of the larger Device Hub presentation surface that made VideoToolbox fail with `encodingFailed`, browser keyboard events reach iOS 27 through a guarded Device Hub route (opt out with `SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD=1`; Xcode 26 and older keep the HID path simfarm's input uses), and `simctl bootstatus` is no longer called with a redundant `-b` that could block after boot. serve-sim's in-process session also awaits its native capture start now, answers a stream route 503 and evicts the failed session instead of dropping the promise; simfarm's own capture guard stays in front of that so a failed capture still ends the affected stream with the reason, re-lists the device and drops the dead session. No simfarm behaviour changes on Xcode 26.
