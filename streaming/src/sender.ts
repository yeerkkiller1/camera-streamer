import * as wsClass from "ws-class";

import { readFileSync, writeFileSync } from "fs";
import { execFileSync, spawn, execSync } from "child_process";
import { makeProcessSingle } from "./util/singleton";

import * as v4l2camera from "v4l2camera";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { TransformChannelAsync, PChan, Range } from "pchannel";
import { splitByStartCodes } from "./receiver/startCodes";
import { encodeJpegFrames } from "./receiver/encodeNals";
import { clock } from "./util/time";

import { ParseNalHeaderByte } from "mp4-typescript";

// Make sure we kill any previous instances
console.log("pid", process.pid);
makeProcessSingle("sender");


/*
let time = +new Date();

// cat frame*.jpeg | gst-launch-1.0 -vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264,profile=high ! filesink location=/dev/stdout | cat > frames.nal

let proc = spawn(
    "gst-launch-1.0",
    `-vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264,profile=high ! fdsink fd=1`.split(" "),{ stdio: "pipe" }
);

proc.stdout.on("close", () => {
    time = +new Date() - time;
    console.log(`out closed after ${time}`);
});
proc.stdout.on("error", () => {
    console.log("error");
});
proc.stdout.on("data", (data: Buffer) => {
    //console.log(data.toString());
    console.log(data.length);
});

for(let i = 0; i < 10; i++) {
    let frame = readFileSync(`./result${i}.jpeg`);
    console.log(`Sending ${frame.length}`);
    proc.stdin.write(frame);
}
//proc.stdin.end();
//*/


/*
let jpegStream = new PChan<Buffer>();

let encodeChan = encodeJpegFrames({
    width: 1920,
    height: 1080,
    frameNumerator: 30,
    frameDenominator: 1,
    fps: 1,
    iFrameRate: 10,
    jpegStream: jpegStream
});

for(let i = 0; i < 10; i++) {
    let frame = readFileSync(`./result${i}.jpeg`);
    console.log(`Sending ${frame.length}`);
    jpegStream.SendValue(frame);
}

(async () => {
    console.log(`Starting loop`);
    try {
        while(true) {
            let input = await encodeChan.GetPromise();
            console.log(`Got nals ${input.length}`);
        }
    } catch(e) {
        console.log(`Closing pipe because ${String(e)}`);
    }
})();
*/


function pipeChannel<T>(inputChan: PChanReceive<T>, output: PChanSend<T>): void {
    (async () => {
        try {
            while(true) {
                let input = await inputChan.GetPromise();
                output.SendValue(input);
            }
        } catch(e) {
            if(!output.IsClosedError(e)) {
                output.SendError(e);
            }
            console.log(`Closing pipe because ${String(e)}`);
        }

        if(!output.IsClosed()) {
            output.Close();
        }
    })();
}

// https://unix.stackexchange.com/questions/113893/how-do-i-find-out-which-process-is-using-my-v4l2-webcam
// Kill anyone using /dev/video0
try {
    let pidsToKill = execFileSync("fuser", ["/dev/video0"]).toString().split(" ").filter(x => x).filter(x => String(parseInt(x)) === x);
    console.log({pidsToKill});
    for(let pid of pidsToKill) {
        execSync(`kill -9 ${pid}`);
    }
} catch(e) { }

let camera!: v4l2camera.Camera;
try {
    camera = new v4l2camera.Camera("/dev/video0");
} catch(e) {
    console.error(e);
    console.error(`Could not create v4l2camera.Camera on /dev/video0, closing process`);
    process.exit();
}

class Sender implements ISender {
    server!: IReceiver;

    frameCount = 0;

    curFrameLoop!: number;
    curFramePipe: PChanReceive<Buffer>|undefined;

    setStreamFormat(fps: number, format: v4l2camera.Format): void {
        if (format.formatName !== "MJPG") {
            throw new Error("Format must use MJPG");
        }

        let delay = 1000 / fps;
        console.log("Set format", {fps, format, delay});
        camera.configSet(format);
        camera.start();

        if(this.curFramePipe !== undefined) {
            this.curFramePipe.Close();
        }
        clearInterval(this.curFrameLoop);

        let frameTimes: number[] = [];

        let jpegFramePipe = this.curFramePipe = new PChan<Buffer>();
        // TODO: This timer is broken. Set a 1 second timer, and see the small bits (sort of) slowly drift. This should not drift, or at least not drift based on the local time!
        this.curFrameLoop = setInterval(async () => {
            camera.capture((success) => {
                if(!success) {
                    console.error("Failed to capture frame");
                    return;
                }
                if(jpegFramePipe !== this.curFramePipe) {
                    console.log(`Received capture on dead pipe, ignore capture.`);
                    return;
                }
                let frame = camera.frameRaw() as Buffer;
                console.log(`Got frame ${frame.length}`);
                frameTimes.push(+new Date());
                jpegFramePipe.SendValue(frame);
            });
        }, delay) as any;

        
        let nalPipe = encodeJpegFrames({
            width: format.width,
            height: format.height,
            frameNumerator: format.interval.numerator,
            frameDenominator: format.interval.denominator,
            fps: fps,
            iFrameRate: 10,
            jpegStream: jpegFramePipe
        });

        // It is a lot easier to figure out frame times if we (the sender splits h264 data into nals)
        let nalUnits = splitByStartCodes(nalPipe);

        /*
        bitHeader0: bitMapping({
            forbidden_zero_bit: 1,
            nal_ref_idc: 2,
            nal_unit_type: 5,
        }),

        if(bitHeader0.nal_unit_type === 7) {
            return {type: CodeOnlyValue("sps" as "sps"), nal: RawData(payloadLength)};
        } else if(bitHeader0.nal_unit_type === 8) {
            return {type: CodeOnlyValue("pps" as "pps"), nal: RawData(payloadLength)};
        } else if(bitHeader0.nal_unit_type === 6) {
            return {type: CodeOnlyValue("sei" as "sei"), nal: RawData(payloadLength)};
        } else if(bitHeader0.nal_unit_type === 1 || bitHeader0.nal_unit_type === 5) {
            return {type: CodeOnlyValue("slice" as "slice"), nal: RawData(payloadLength)};
        }
        */

        (async () => {
            try {
                while(true) {
                    let nalUnit = await nalUnits.GetPromise();

                    let b = nalUnit[0];
                    let type = ParseNalHeaderByte(b);
                    if(type === "slice") {
                        let frameTime = frameTimes.shift();
                        if(frameTime === undefined) {
                            console.error("Frames timings messed up, received more frames than frames pushed");
                        } else if(frameTimes.length > 100) {
                            // TODO: This likely means our encoder can't keep up. Reduce the fps!
                            console.error("Frames timings messed up, pushed way more frames than frames received");
                        }

                        frameTime = frameTime || +new Date();

                        this.server.acceptNAL({
                            nal: nalUnit,
                            type: { type: "slice", frameTime },
                            senderConfig: {
                                fps,
                                format
                            },
                        });
                    } else if(type === "sps" || type === "pps") {
                        this.server.acceptNAL({
                            nal: nalUnit,
                            type: { type: type },
                            senderConfig: {
                                fps,
                                format
                            },
                        });
                    } else {
                        console.log(`Unknown NAL of size ${nalUnit.length}, type ${type}. Not sending to receiver, as unknown types will probably break it.`);
                    }
                }
            } catch(e) {
                if(!nalPipe.IsClosedError(e)) {
                    console.error(e);
                }
            }

            console.log(`Finished nal pipe (this should never happen)`);
        })();

        /*
        this.server.acceptFrame({
            buffer: frame,
            eventTime: +new Date(),
            fps: fps,
            format: format,
        });
        */
    }

    async getStreamFormats(): Promise<v4l2camera.Format[]> {
        return camera.formats;
    }
}


//*
let sender = new Sender();
let server!: IReceiver;

//wsClass.ThrottleConnections({ kbPerSecond: 200, latencyMs: 100 }, () => {
    server = wsClass.ConnectToServer<IReceiver>({
        port: 7060,
        host: "192.168.0.202",
        bidirectionController: sender
    });
//});

sender.server = server;
console.log("Calling ping");
server.cameraPing();
//*/


/*
console.log("start");

let time = +new Date();

let process = spawn(
    "gst-launch-1.0",
    `-vv -e fdsrc fd=0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264,profile=high ! filesink location="frames.nal"`.split(" "),{ stdio: "pipe" }
);

process.stdout.on("close", () => {
    time = +new Date() - time;
    console.log(`out closed after ${time}`);
});
process.stdout.on("error", () => {
    console.log("error");
});
process.stdout.on("data", (data: Buffer) => {
    console.log(data.length);
});
//*/

//*
setInterval(() => {
    console.log("alive");
}, 60000);

//*/






//console.log(wsClass.test() - 10);

//var cam = new v4l2camera.Camera("/dev/video0");
//console.log(cam.formats);
/*
   interval: { numerator: 1, denominator: 30 } },
  { formatName: 'MJPG',
    format: 1196444237,
    width: 1280,
    height: 720,
    interval: { numerator: 1, denominator: 30 } }
*/
/*
let format = cam.formats.filter(x => x.formatName === "MJPG")[0];
//format = cam.formats[cam.formats.length - 1];
console.log(format);
cam.configSet(format);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}
cam.start();
cam.capture(function onCapture(success) {
    if(curCapture !== capturePending) {
        capturePending = null;
        console.warn(`Got unexpected capture, ignoring`);
        return;
    }
    capturePending = null;
    //console.log(`Finished ${curCapture}`);
    
    // Uint8Array
    var frame = cam.frameRaw();
    let buffer = Buffer.from(frame);
});
*/

/*

connectLoop();

// Promise resolve when connection closes
function connect() {
    return new Promise((resolve) => {
        let conn = new ws("ws://192.168.0.202:6070");
        conn.on("open", () => {
            console.log("opened");
        });
        conn.on("close", () => {
            console.log("closed");
            resolve();
        });
        conn.on("error", () => {
            console.log("error");
            resolve();
        });
        conn.on("message", data => {
            var obj = JSON.parse(data);
            var size = obj.size;

            var buffer = new Buffer(size);
            for(var i = 0; i < size; i++) {
                buffer[i] = i % 256;
            }

            conn.send(buffer);
        });
    });
}

function delay(time) {
    return new Promise(resolve => {
        setTimeout(resolve, time);
    });
}

async function connectLoop() {
    while(true) {
        await connect();
        await delay(1000);
    }
}
*/