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

import { ParseNalHeaderByte, ParseNalInfo } from "mp4-typescript";
import { createSimulatedFrame } from "./util/jpeg";
import { randomUID } from "./util/rand";
import { DownsampledInstance, Downsampler } from "./NALStorage/Downsampler";
import { RoundRecordTime } from "./NALStorage/TimeMap";
import { Fragment } from "../node_modules/@types/react";

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

type Frame = {frame: Buffer; frameTime: number, frameTimes: number[]};
function createEncodeLoop(
    rawJpegFramePipe: PChanReceive<Frame>,
    receiver: IReceiver,
    fps: number,
    format: v4l2camera.Format,
    iFrameRate: number,
    bitRateMBPS: number,
    formatId: string,
    rate: number,
    encoderDestruct: Deferred<void>
) {
    let outputJpegFrameTimes: number[][] = [];

    // Downsample to the requested FPS.
    let jpegFramePipe = TransformChannelAsync<Frame, Buffer>(async ({inputChan, outputChan}) => {
        while(true) {
            let frameObj = await inputChan.GetPromise();
            outputJpegFrameTimes.push(frameObj.frameTimes);
            outputChan.SendValue(frameObj.frame);
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
            let currentSps: Buffer|undefined;
            let currentPps: Buffer|undefined;

            let index = 0;

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
                    let nalDetailedInfo = ParseNalInfo(nalUnit);
                    if(nalDetailedInfo.type !== "slice") {
                        throw new Error(`ParseNalHeaderByte and ParseNalInfo give different types. ParseNalHeaderByte gave slice, ParseNalInfo gave ${nalDetailedInfo.type}`);
                    }

                    let frameRecordTimes = outputJpegFrameTimes.shift();
                    if(frameRecordTimes === undefined) {
                        console.error("Frames timings messed up, received more frames than frames pushed");
                    } else if(outputJpegFrameTimes.length > 100) {
                        // TODO: This likely means our encoder can't keep up. Reduce the fps!
                        console.error("Frames timings messed up, pushed way more frames than frames received");
                    }

                    //todonext
                    // The frame times where are off. It becomes really obvious with 256x video, which is clearly about ~6 seconds
                    //  off from reality. Faster rates should be more off, they should have more view latency, but the frame times
                    //  should still be accurate!
                    frameRecordTimes = frameRecordTimes || [getTimeSynced()];
                    let frameRecordTime = frameRecordTimes[frameRecordTimes.length - 1];

                    let type: NALType;
                    if(nalDetailedInfo.sliceType === "I") {
                        type = NALType.NALType_keyframe;
                    } else if(nalDetailedInfo.sliceType === "P") {
                        type = NALType.NALType_interframe;
                    } else {
                        throw new Error(`Unhandled sliceType ${nalDetailedInfo.sliceType}`);
                    }

                    if(currentSps === undefined) {
                        throw new Error(`Received I frame without first receiving an SPS. How do we interpret this?`);
                    }
                    if(currentPps === undefined) {
                        throw new Error(`Received I frame without first receiving a PPS. How do we interpret this?`);
                    }
                    let delay = getTimeSynced() - frameRecordTime;
                    // TODO: For some reason high rate video appears to be delayed by too much. It should be delayed by
                    //  rate (before it gets any frames) plus maybe rate * key_frame_rate ? (for the first video to finish?).
                    //  But rate 16 seems to take 64 frames to start, but I don't know why...
                    console.log(`Send NAL slice, delayed ${delay}ms, rate ${rate}, index ${index++}, times ${JSON.stringify(frameRecordTimes)}`);
                    receiver.acceptNAL_VOID({
                        nal: nalUnit,
                        recordInfo: { type: "slice", frameRecordTimes, frameRecordTime },
                        senderConfig,
                        time: frameRecordTime,
                        type: type,
                        width: senderConfig.format.width,
                        height: senderConfig.format.height,
                        sps: currentSps,
                        pps: currentPps,
                        rate
                    });
                } else if(type === "sps" || type === "pps") {
                    if(type === "sps") {
                        currentSps = nalUnit;
                    }
                    if(type === "pps") {
                        currentPps = nalUnit;
                    }
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

    return {
        jpegFramePipe,
        nalPipe,
        nalUnits
    };
}

class StreamLoop {
    constructor(
        receiver: IReceiver,
        fps: number,
        format: v4l2camera.Format,
        iFrameRate: number,
        bitRateMBPS: number,
        formatId: string,
        downsampleRate: number,
        ratePrevCounts: { [rate: number]: number }
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

        
        // It appears as if the camera has a rolling buffer of frames, populated at the frequency of the format we requested.
        //  This means if we are slow to poll, we still get the correct frame rate (sort of). Which means... we want this buffer
        //  to always be empty, because if it fills up there will be an unknown delay in the time the picture was taken
        //  and the time we call capture. Then after having the maximum number of frames we can down sample to the frame rate we want.
        // Also, it looks like polling as fast as we can't won't return duplicates, it will just delay, so we always want to poll
        //  as fast as we can.

        
        let jpegEncoders: {
            encode: JpegEncoder;
            rawJpegFramePipe: PChan<Frame>;
            jpegFramePipe: PChanReceive<Buffer>;
            nalPipe: PChanReceive<Buffer>;
            nalUnits: PChanReceive<Buffer>;
            encoderDestruct: Deferred<void>;
        }[] = [];

        class JpegEncoder implements DownsampledInstance<Frame> {
            public rawJpegFramePipe = new PChan<Frame>();
            public encoderDestruct = new Deferred<void>();
            constructor(public Rate: number) {
                console.log(`New jpeg encoder for rate ${Rate}`);

                let dtors = createEncodeLoop(
                    this.rawJpegFramePipe,
                    receiver,
                    fps / this.Rate,
                    format,
                    iFrameRate,
                    bitRateMBPS,
                    formatId,
                    Rate,
                    this.encoderDestruct
                );

                jpegEncoders.push({
                    ...dtors,
                    rawJpegFramePipe: this.rawJpegFramePipe,
                    encoderDestruct: this.encoderDestruct,
                    encode: this
                });
            }
            public AddValue(val: Frame): void {
                this.rawJpegFramePipe.SendValue(val);
            }
        }

        let downsampler = new Downsampler(downsampleRate, JpegEncoder, ratePrevCounts[1]);

        let curFrameTimes: number[] = [];
        let frameDuration = 1000 / fps;
        let nextFrameTime = clock() + frameDuration;
        let curLag = 0;
        const frameLoop = () => {
            try {
                camera.capture(async (success) => {
                    if(this.destructRequested.Value()) {
                        console.log(`Capture loop closing.`);
                        captureLoopDestruct.Resolve(undefined);
                        return;
                    }
                    // Code to test frame delay and timing accuracy: http://output.jsbin.com/yewodox/4
                    let c = clock();
                    let now = Date.now();
                    let rawFrameTime = getTimeSynced();
                    let frameTime = RoundRecordTime(rawFrameTime);

                    curFrameTimes.push(frameTime);

                    try {
                        let curTime = clock();
                        if(curTime < nextFrameTime - curLag) return;
                        let frameLag = curTime - nextFrameTime;
                        curLag += frameLag;
                        nextFrameTime = nextFrameTime + frameDuration;
                        let frameTimes = curFrameTimes;
                        curFrameTimes = [];

                        if(!success) {
                            console.error("Failed to capture frame");
                            return;
                        }

                        let raw = camera.frameRaw() as Buffer;
                        let frame = Buffer.from(raw);

                        //console.log(`Got frame ${frame.length} at time ${frameTime}`);
                        downsampler.AddValue({
                            frame,
                            frameTime,
                            frameTimes,
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




        // We have to fill up all destructDeferreds in here, because if we dynamically add any they might be added just as we are destructing
        //  but before this.destructing is set, which will cause a resource leak.
        this.destructDeferreds = [
            captureLoopDestruct,
            cameraDestruct
        ];

        captureLoopDestruct.Promise().then(() => {
            for(let dtors of jpegEncoders) {
                if(!dtors.rawJpegFramePipe.IsClosed()) {
                    dtors.rawJpegFramePipe.Close();
                }
                if(!dtors.jpegFramePipe.IsClosed()) {
                    dtors.jpegFramePipe.Close();
                }
                if(!dtors.nalPipe.IsClosed()) {
                    console.log(`Requesting encoder close`);
                    dtors.nalPipe.Close();
                }
                if(!dtors.nalUnits.IsClosed()) {
                    dtors.nalUnits.Close();
                }
            }
        });

        // Don't stop the camera until everything else is closed. It is picky about stuff, and can crash if there are pending calls.
        Promise.all([captureLoopDestruct.Promise()]).then(async () => {
            // Eh... there is a race condition here. But oh well...
            await Promise.all(jpegEncoders.map(x => x.encoderDestruct.Promise()));

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
        downsampleRate: number,
        ratePrevCounts: { [rate: number]: number }
    ): Promise<void> {
        let server = this.server;
        if(this.streamLoop) {
            let isMostRecent = await this.streamLoop.Destruct();
            if(!isMostRecent) return;
        }

        // The previous streamLoop has been destructed (if it existed), and there is only one returned call from Destruct,
        //  that is the freshest call, and that is us. I assume all promise accepts will be called in order, at once. That way
        //  after Destruct finishes this.streamLoop is synchronously replaced with a new instance, which can then further be destructed.
        this.streamLoop = new StreamLoop(this.server, fps, format, iFrameRate, bitRateMBPS, formatId, downsampleRate, ratePrevCounts);

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
        host: "192.168.0.202",
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
