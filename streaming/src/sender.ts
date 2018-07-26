import * as wsClass from "ws-class";

import { readFileSync, writeFileSync } from "fs";
import { execFileSync, spawn, execSync } from "child_process";
import { makeProcessSingle } from "./util/singleton";

import * as v4l2camera from "v4l2camera";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { TransformChannelAsync, PChan, Range, SetTimeoutAsync, Deferred } from "pchannel";
import { splitByStartCodes } from "./receiver/startCodes";
import { encodeJpegFrames } from "./receiver/encodeNals";
import { clock, setTimeServer, getTimeSynced } from "./util/time";

import { ParseNalHeaderByte } from "mp4-typescript";
import { createSimulatedFrame } from "./util/jpeg";
import { randomUID } from "./util/rand";

// Make sure we kill any previous instances
console.log("pid", process.pid);
makeProcessSingle("sender");


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

const sourceId = randomUID("camera");

class StreamLoop {
    constructor(
        receiver: IReceiver,
        fps: number,
        format: v4l2camera.Format,
        iFrameRate: number,
        bitRateMBPS: number,
        formatId: string
    ) {
        if (format.formatName !== "MJPG") {
            throw new Error("Format must use MJPG");
        }

        try {
            console.log("Set format", {fps, format, iFrameRate, bitRateMBPS});
            camera.configSet(format);
            camera.start();
        } catch(e) {
            console.error(`Error when setting format`, e);
            this.destructDeferreds = [];
            return;
        }


        let captureLoopDestruct = new Deferred<void>();
        let cameraDestruct = new Deferred<void>();
        let encoderDestruct = new Deferred<void>();


        let rawJpegFramePipe = new PChan<{frame: Buffer; frameTime: number}>();
        
        // It appears as if the camera has a rolling buffer of frames, populated at the frequency of the format we requested.
        //  This means if we are slow to poll, we still get the correct frame rate (sort of). Which means... we want this buffer
        //  to always be empty, because if it fills up there will be an unknown delay in the time the picture was taken
        //  and the time we call capture. Then after having the maximum number of frames we can down sample to the frame rate we want.
        // Also, it looks like polling as fast as we can't won't return duplicates, it will just delay, so we always want to poll
        //  as fast as we can.

        const frameLoop = () => {
            try {
                camera.capture(async (success) => {
                    if(this.destructRequested.Value()) {
                        console.log(`Capture loop closing.`);
                        captureLoopDestruct.Resolve(undefined);
                        return;
                    }
                    let frameTime = getTimeSynced();
                    try {
                        if(!success) {
                            console.error("Failed to capture frame");
                            return;
                        }

                        let raw = camera.frameRaw() as Buffer;
                        let frame = Buffer.from(raw);

                        //console.log(`Got frame ${frame.length} at time ${frameTime}`);
                        rawJpegFramePipe.SendValue({
                            frame,
                            frameTime
                        });
                    } catch(e) {
                        console.log(`Error in capture`, e);
                    } finally {
                        frameLoop();
                    }
                });
            } catch(e) {
                console.log(`Error in frameLoop`, e);
            }
        };
        frameLoop();


        let frameDuration = 1000 / fps;
        let nextFrameTime = clock() + frameDuration;

        let outputJpegFrameTimes: number[][] = [];

        // Downsample to the requested FPS.
        let jpegFramePipe = TransformChannelAsync<{frame: Buffer; frameTime: number}, Buffer>(async ({inputChan, outputChan}) => {
            let curFrameTimes: number[] = [];
            let curLag = 0;
            while(true) {
                let frameObj = await inputChan.GetPromise();
                let frame = frameObj.frame;
                let rawFrameTime = frameObj.frameTime;
                if(rawFrameTime === undefined) {
                    console.error(`No time for frame. That should be impossible`);
                    rawFrameTime = Date.now();
                }
                curFrameTimes.push(rawFrameTime);
                
                let curTime = clock();
                if(curTime < nextFrameTime - curLag) continue;               
                let frameLag = curTime - nextFrameTime;
                curLag += frameLag;
                nextFrameTime = nextFrameTime + frameDuration;
                //console.log({frameLag, nextFrameTime, curTime});
                let frameTimes = curFrameTimes;
                curFrameTimes = [];
                outputJpegFrameTimes.push(frameTimes);
                outputChan.SendValue(frame);
            }
        })(rawJpegFramePipe);


        let nalPipe = encodeJpegFrames({
            width: format.width,
            height: format.height,
            frameNumerator: format.interval.numerator,
            frameDenominator: format.interval.denominator,
            iFrameRate: iFrameRate,
            bitRateMBPS: bitRateMBPS,
            jpegStream: jpegFramePipe,
            onProcClose: () => {
                console.log(`Encoder closed`);
                encoderDestruct.Resolve(undefined);
            }
        });

        // It is a lot easier to figure out frame times if we (the sender) splits h264 data into nals
        let nalUnits = splitByStartCodes(nalPipe);

        (async () => {
            try {
                while(true) {
                    let nalUnit = await nalUnits.GetPromise();

                    let time = getTimeSynced();
                    let curTime = Date.now();
                    let senderConfig: NALHolder["senderConfig"] = {
                        fps,
                        format,
                        cameraSendTime: time,
                        timeOffset: curTime - time,
                        serverReceiveTime: 0,
                        formatId,
                        sourceId
                    };

                    let b = nalUnit[0];
                    let type = ParseNalHeaderByte(b);
                    if(type === "slice") {
                        let frameRecordTimes = outputJpegFrameTimes.shift();
                        if(frameRecordTimes === undefined) {
                            console.error("Frames timings messed up, received more frames than frames pushed");
                        } else if(outputJpegFrameTimes.length > 100) {
                            // TODO: This likely means our encoder can't keep up. Reduce the fps!
                            console.error("Frames timings messed up, pushed way more frames than frames received");
                        }

                        frameRecordTimes = frameRecordTimes || [getTimeSynced()];
                        let frameRecordTime = frameRecordTimes[frameRecordTimes.length - 1];

                        receiver.acceptNAL({
                            nal: nalUnit,
                            type: { type: "slice", frameRecordTimes, frameRecordTime },
                            senderConfig
                        });
                    } else if(type === "sps" || type === "pps") {
                        receiver.acceptNAL({
                            nal: nalUnit,
                            type: { type: type },
                            senderConfig
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



        // We have to fill up all destructDeferreds in here, because if we dynamically add any they might be added just as we are destructing
        //  but before this.destructing is set, which will cause a resource leak.
        this.destructDeferreds = [
            captureLoopDestruct,
            cameraDestruct,
            encoderDestruct
        ];

        this.destructRequested.Promise().then(() => {
            if(!rawJpegFramePipe.IsClosed()) {
                rawJpegFramePipe.Close();
            }
            if(!jpegFramePipe.IsClosed()) {
                jpegFramePipe.Close();
            }
            if(!nalPipe.IsClosed()) {
                console.log(`Requesting encoder close`);
                nalPipe.Close();
            }
            if(!nalUnits.IsClosed()) {
                nalUnits.Close();
            }
        });

        // Don't stop the camera until everything else is closed. It is picky about stuff, and can crash if there are pending calls.
        Promise.all([captureLoopDestruct.Promise(), encoderDestruct.Promise()]).then(() => {
            console.log(`Stopping camera`);
            camera.stop(() => {
                console.log(`Camera stopped`);
                cameraDestruct.Resolve(undefined);
            });
        });
    }

    private destructDeferreds: Deferred<void>[];

    private latestDestructingId = 0;

    private destructRequested = new Deferred<void>();
    private destructFinished = new Deferred<void>();

    // Returns true if this call is the most recent Destruct call.
    public async Destruct(): Promise<boolean> {
        let ourId = ++this.latestDestructingId;
        if(this.destructRequested.Value()) {
            await this.destructFinished.Promise();
        } else {
            console.log("Starting StreamLoop Destruct");
            this.destructRequested.Resolve(undefined);

            for(let destructParts of this.destructDeferreds) {
                await destructParts.Promise();
            }

            this.destructFinished.Resolve(undefined);
            console.log("Finished StreamLoop Destruct");
        }

        return this.latestDestructingId === ourId;
    }
}

class Sender implements ISender {
    server!: IReceiver;

    frameCount = 0;

    // Uh... how do we handle waiting for the last frame loop to run, considering we could be hammered
    //  with frame loop restarts?
    curFrameLoop!: number;
    
    curFramePipe: PChanReceive<Buffer>|undefined;

    streamLoop: StreamLoop|undefined;

    curCaptureLoop = 0;
    async setStreamFormat(
        fps: number,
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format,
        formatId: string,
    ): Promise<void> {
        let server = this.server;
        if(this.streamLoop) {
            let isMostRecent = await this.streamLoop.Destruct();
            if(!isMostRecent) return;
        }

        // The previous streamLoop has been destructed (if it existed), and there is only one returned call from Destruct,
        //  that is the freshest call, and that is us. I assume all promise accepts will be called in order, at once. That way
        //  after Destruct finishes this.streamLoop is synchronously replaced with a new instance, which can then further be destructed.
        this.streamLoop = new StreamLoop(this.server, fps, format, iFrameRate, bitRateMBPS, formatId);

        console.log(`Finished set format`);
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
        host: "192.168.0.19",
        bidirectionController: sender
    });
//});

setTimeServer(server);

sender.server = server;
console.log("Calling ping");
server.cameraPing(sourceId);
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