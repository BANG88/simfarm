# simfarm

## 0.3.0

### Minor Changes

- [#4](https://github.com/BANG88/simfarm/pull/4) [`afe02f8`](https://github.com/BANG88/simfarm/commit/afe02f81d70b488a4ea6a7c2a3af72f0ec29c786) Thanks [@BANG88](https://github.com/BANG88)! - The iOS JPEG path now has the same discipline as the Android one. serve-sim encodes the whole framebuffer — 1206x2622 on an iPhone 17 Pro, 100-700 KB a picture, at whatever rate the guest redraws — and a phone viewer drawing it at 402x874 points paid for every byte. Each attached JPEG stream now runs through ffmpeg (`mjpeg -> scale -> mjpeg`) with three new flags: `--ios-max-size` (default 1024, longest side, aspect kept, even dimensions; `0` disables scaling), `--ios-jpeg-max-fps` (default 20, drop-never-queue, applied before ffmpeg so a dropped picture costs nothing; `0` uncaps) and `--ios-jpeg-quality` (default 70). `screen.scale` shrinks in step with the picture so `width / scale` is still the device's point size; `stats` on an iOS stream reports `frameSize` beside `videoSize`, and the attach log line says the delivered size. Without a usable ffmpeg the pictures still arrive, at full size, and the log says so. The iOS H.264 path is unchanged.

## 0.2.0

### Minor Changes

- [#2](https://github.com/BANG88/simfarm/pull/2) [`7047f70`](https://github.com/BANG88/simfarm/commit/7047f7087a42b0f9248d49e7bcc32d0ed35c80e6) Thanks [@BANG88](https://github.com/BANG88)! - Android devices now offer JPEG as well as H.264: the H.264 stream scrcpy sends is transcoded through ffmpeg (`h264 -> mjpeg`) and each picture is delivered as a key frame, so a client with no video decoder — a native app that can only draw JPEG, or a browser on a plain-http IP origin where `VideoDecoder` is undefined — can show an Android device at all. The capability is probed at startup: with a usable ffmpeg the device declares `["h264", "jpeg"]`, without one it stays `["h264"]`, and H.264 stays the default for clients that can decode it. The transcoder runs only while a JPEG stream is attached. New flags: `--android-jpeg-max-fps` (default 20, `0` uncaps), `--android-jpeg-quality` (default 70), `--android-ffmpeg PATH`, `--android-no-jpeg`.
