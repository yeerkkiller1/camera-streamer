import { TransformChannelAsync, PChan } from "pchannel";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { spawn } from "child_process";


//type ThirdArgument<T> = T extends (a: any, b: any, c: infer X) => any ? X : never;
//type SpawnOptions = ThirdArgument<typeof spawn>;
function spawnChannel(command: string, args: string[]): (jpegStream: PChanReceive<Buffer>) => PChanReceive<Buffer> {
    return TransformChannelAsync<Buffer, Buffer>(async ({inputChan, outputChan}) => {
        let proc = spawn(command, args, { stdio: "pipe" });
        proc.on("error", (err) => {
            console.log(`Proc error ${String(err)}`);
            outputChan.SendError(err);
        });
        proc.on("exit", () => {
            console.log(`Proc exit`);
        });
        proc.on("close", () => {
            console.log(`Proc close`);
        });

        proc.stdout.on("close", () => {
            console.log("Calling close because stdout called close");
            outputChan.Close();
        });
        proc.stdout.on("error", (err: any) => {
            console.log(`Proc error ${String(err)}`);
            outputChan.SendError(err);
        });
        proc.stdout.on("data", (data: Buffer) => {
            //console.log(`Proc got data ${data.toString()}`);
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

    cat frame*.jpeg | gst-launch-1.0 -vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264,profile=high ! fdsink fd=1 | cat > frames.nal

*/

/** The input Buffers should be raw jpeg frames */
export function encodeJpegFrames(info: {
    width: number;
    height: number;
    frameNumerator: number;
    frameDenominator: number;
    /** We only use this to calculate bitrate */
    fps: number;
    /** The rate of i frames. sps and pps are also spit out at this rate. */
    iFrameRate: number;
    jpegStream: PChanReceive<Buffer>;
}): PChanReceive<Buffer> {
    let { width, height, frameNumerator, frameDenominator, fps, iFrameRate, jpegStream } = info;

    // https://support.google.com/youtube/answer/1722171?hl=en (youtube recommend upload bitrates)
    let lowFps = fps <= 30;
    let bitRateMBPS: number;
    if(height <= 360) {
        bitRateMBPS = lowFps ? 1 : 1.5;
    } else if(height <= 480) {
        bitRateMBPS = lowFps ? 2.5 : 4;
    } else if(height <= 720) {
        bitRateMBPS = lowFps ? 5 : 7.5;
    } else if(height <= 1080) {
        bitRateMBPS = lowFps ? 8 : 12;
    } else if(height <= 1440) {
        bitRateMBPS = lowFps ? 16 : 24;
    } else if(height <= 2160) {
        bitRateMBPS = lowFps ? 40 : 60;
    } else {
        bitRateMBPS = lowFps ? 60 : 80;
    }

    let args = `-q fdsrc fd=0 ! capsfilter caps="image/jpeg,width=${width},height=${height},framerate=${frameNumerator}/${frameDenominator}" ! jpegdec ! omxh264enc target-bitrate=${bitRateMBPS * 1000 * 1000} control-rate=variable periodicty-idr=${iFrameRate} ! video/x-h264,profile=high ! fdsink fd=1`;
    return spawnChannel("gst-launch-1.0", args.split(" "))(jpegStream);
}