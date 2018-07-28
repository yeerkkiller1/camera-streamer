import { TransformChannelAsync, PChan } from "pchannel";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { spawn } from "child_process";


 //type ThirdArgument<T> = T extends (a: any, b: any, c: infer X) => any ? X : never;
//type SpawnOptions = ThirdArgument<typeof spawn>;
function spawnChannel(command: string, args: string[], onProcClose: () => void): (jpegStream: PChanReceive<Buffer>) => PChanReceive<Buffer> {
    return TransformChannelAsync<Buffer, Buffer>(async ({inputChan, outputChan}) => {
        let proc = spawn(command, args, { stdio: "pipe" });
        proc.on("error", (err) => {
            console.log(`Proc error ${String(err)}`);
            outputChan.SendError(err);
        });
        proc.on("exit", () => {
            console.log(`Proc exit`);

            onProcClose();
        });
        proc.on("close", () => {
            console.log(`Proc close`);

            onProcClose();
        });

        proc.stdout.on("close", () => {
            console.log("Calling close because stdout called close");
            if(!outputChan.IsClosed()) {
                outputChan.Close();
            }
        });
        proc.stdout.on("error", (err: any) => {
            console.log(`Proc error ${String(err)}`);
            outputChan.SendError(err);
        });
        proc.stdout.on("data", (data: Buffer) => {
            //console.log(`Proc got data ${data.toString()}`);
            if(outputChan.IsClosed()) {
                console.warn(`Got data on closed channel, ignoring. ${data.length} bytes`);
                return;
            }
            outputChan.SendValue(data);
        });

        try {
            while(true) {
                let input = await inputChan.GetPromise();
                proc.stdin.write(input);
            }
        } finally {
            proc.stdin.end();
        }
    });
}

/*
    Sometimes gstreamer breaks... and won't work unti we restart the pi.

    You can test if it is broken by running:

    gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=30 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! multifilesink location="frame%d.jpeg"

    time cat frame*.jpeg | gst-launch-1.0 -vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=1/1" ! jpegdec ! omxh264enc target-bitrate=50000 periodicty-idr=2 ! video/x-h264,profile=high ! fdsink fd=1 | cat > frames.nal && stat frames.nal

    time cat frame*.jpeg | gst-launch-1.0 -vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! avenc_h264_omx bitrate=10000 gop-size=2 ! video/x-h264,profile=high ! fdsink fd=1 | cat > frames.nal && stat frames.nal

    time cat frame*.jpeg | gst-launch-1.0 -vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=1/1" ! jpegdec ! omxh264enc target-bitrate=10000 control-rate=variable ! video/x-h264,profile=high ! fdsink fd=1 | cat > frames.nal && stat frames.nal


*/

/** The input Buffers should be raw jpeg frames */
export function encodeJpegFrames(info: {
    width: number;
    height: number;
    frameNumerator: number;
    frameDenominator: number;
    /** The rate of i frames. sps and pps are also spit out at this rate. */
    iFrameRate: number;
    bitRateMBPS: number;
    jpegStream: PChanReceive<Buffer>;

    /** I have noticed that gst-launch can use resources and cause problems if not closed properly. This happened
     *      after process exit, but in theory it could happen in the same process, so we have this callback so you can
     *      wait until the process actually exits.
     */
    onProcClose: () => void;
}): PChanReceive<Buffer> {
    let { width, height, frameNumerator, frameDenominator, iFrameRate, jpegStream, bitRateMBPS } = info;

    let args = `-q fdsrc fd=0 ! capsfilter caps="image/jpeg,width=${width},height=${height},framerate=${frameNumerator}/${frameDenominator}" ! jpegdec ! avenc_h264_omx bitrate=${Math.round(bitRateMBPS * 1000 * 1000)} gop-size=${iFrameRate} ! video/x-h264,profile=high ! fdsink fd=1`;
    return spawnChannel("gst-launch-1.0", args.split(" "), info.onProcClose)(jpegStream);
}

/*
pi@raspberrypi:~ $ gst-inspect-1.0 omxh264enc
Factory Details:
  Rank                     primary + 1 (257)
  Long-name                OpenMAX H.264 Video Encoder
  Klass                    Codec/Encoder/Video
  Description              Encode H.264 video streams
  Author                   Sebastian Dröge <sebastian.droege@collabora.co.uk>

Plugin Details:
  Name                     omx
  Description              GStreamer OpenMAX Plug-ins
  Filename                 /usr/lib/arm-linux-gnueabihf/gstreamer-1.0/libgstomx-rpi.so
  Version                  1.10.4
  License                  LGPL
  Source module            gst-omx
  Source release date      2017-02-23
  Binary package           GStreamer OpenMAX Plug-ins source release
  Origin URL               Unknown package origin

GObject
 +----GInitiallyUnowned
       +----GstObject
             +----GstElement
                   +----GstVideoEncoder
                         +----GstOMXVideoEnc
                               +----GstOMXH264Enc
                                     +----GstOMXH264Enc-omxh264enc

Implemented Interfaces:
  GstPreset

Pad Templates:
  SRC template: 'src'
    Availability: Always
    Capabilities:
      video/x-h264
                  width: [ 16, 4096 ]
                 height: [ 16, 4096 ]

  SINK template: 'sink'
    Availability: Always
    Capabilities:
      video/x-raw
                  width: [ 1, 2147483647 ]
                 height: [ 1, 2147483647 ]
              framerate: [ 0/1, 2147483647/1 ]


Element Flags:
  no flags set

Element Implementation:
  Has change_state() function: gst_omx_video_enc_change_state

Element has no clocking capabilities.
Element has no URI handling capabilities.

Pads:
  SINK: 'sink'
    Pad Template: 'sink'
  SRC: 'src'
    Pad Template: 'src'

Element Properties:
  name                : The name of the object
                        flags: readable, writable
                        String. Default: "omxh264enc-omxh264enc0"
  parent              : The parent of the object
                        flags: readable, writable
                        Object of type "GstObject"
  control-rate        : Bitrate control method
                        flags: readable, writable, changeable only in NULL or READY state
                        Enum "GstOMXVideoEncControlRate" Default: -1, "default"
                           (0): disable          - Disable
                           (1): variable         - Variable
                           (2): constant         - Constant
                           (3): variable-skip-frames - Variable Skip Frames
                           (4): constant-skip-frames - Constant Skip Frames
                           (-1): default          - Component Default
  target-bitrate      : Target bitrate (0xffffffff=component default)
                        flags: readable, writable, changeable in NULL, READY, PAUSED or PLAYING state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
  quant-i-frames      : Quantization parameter for I-frames (0xffffffff=component default)
                        flags: readable, writable, changeable only in NULL or READY state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
  quant-p-frames      : Quantization parameter for P-frames (0xffffffff=component default)
                        flags: readable, writable, changeable only in NULL or READY state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
  quant-b-frames      : Quantization parameter for B-frames (0xffffffff=component default)
                        flags: readable, writable, changeable only in NULL or READY state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
  inline-header       : Inline SPS/PPS header before IDR
                        flags: readable, writable, changeable only in NULL or READY state
                        Boolean. Default: true
  periodicty-idr      : Periodicity of IDR frames (0xffffffff=component default)
                        flags: readable, writable, changeable only in NULL or READY state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
  interval-intraframes: Interval of coding Intra frames (0xffffffff=component default)
                        flags: readable, writable, changeable only in NULL or READY state
                        Unsigned Integer. Range: 0 - 4294967295 Default: 4294967295
*/
