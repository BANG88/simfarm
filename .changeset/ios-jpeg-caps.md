---
"simfarm": minor
---

The iOS JPEG path now has the same discipline as the Android one. serve-sim encodes the whole framebuffer — 1206x2622 on an iPhone 17 Pro, 100-700 KB a picture, at whatever rate the guest redraws — and a phone viewer drawing it at 402x874 points paid for every byte. Each attached JPEG stream now runs through ffmpeg (`mjpeg -> scale -> mjpeg`) with three new flags: `--ios-max-size` (default 1024, longest side, aspect kept, even dimensions; `0` disables scaling), `--ios-jpeg-max-fps` (default 20, drop-never-queue, applied before ffmpeg so a dropped picture costs nothing; `0` uncaps) and `--ios-jpeg-quality` (default 70). `screen.scale` shrinks in step with the picture so `width / scale` is still the device's point size; `stats` on an iOS stream reports `frameSize` beside `videoSize`, and the attach log line says the delivered size. Without a usable ffmpeg the pictures still arrive, at full size, and the log says so. The iOS H.264 path is unchanged.
