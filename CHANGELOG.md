# simfarm

## 0.2.0

### Minor Changes

- [#2](https://github.com/BANG88/simfarm/pull/2) [`7047f70`](https://github.com/BANG88/simfarm/commit/7047f7087a42b0f9248d49e7bcc32d0ed35c80e6) Thanks [@BANG88](https://github.com/BANG88)! - Android devices now offer JPEG as well as H.264: the H.264 stream scrcpy sends is transcoded through ffmpeg (`h264 -> mjpeg`) and each picture is delivered as a key frame, so a client with no video decoder — a native app that can only draw JPEG, or a browser on a plain-http IP origin where `VideoDecoder` is undefined — can show an Android device at all. The capability is probed at startup: with a usable ffmpeg the device declares `["h264", "jpeg"]`, without one it stays `["h264"]`, and H.264 stays the default for clients that can decode it. The transcoder runs only while a JPEG stream is attached. New flags: `--android-jpeg-max-fps` (default 20, `0` uncaps), `--android-jpeg-quality` (default 70), `--android-ffmpeg PATH`, `--android-no-jpeg`.
