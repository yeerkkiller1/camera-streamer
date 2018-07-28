import * as wsClass from "ws-class";

import { PChan, pchan, TransformChannel, TransformChannelAsync, Deferred, g } from "pchannel";

import { CreateVideo, MuxVideo, ParseNalInfo } from "mp4-typescript";
import { mkdir, writeFile, writeFileSync, readFileSync } from "fs";

import * as net from "net";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { makeProcessSingle } from "./util/singleton";
import { clock, TimeServer, setTimeServer } from "./util/time";
import { randomUID } from "./util/rand";

import { CreateTempFolderPath } from "temp-folder";

// For polyfills
import "./util/math";
import { binarySearchMapped } from "./util/algorithms";

console.log("pid", process.pid);
makeProcessSingle("receiver");

setInterval(() => {
    console.log("alive2");
}, 60000);

/*
pi setup code:
// Looks like there is no frame reordering... so this will work! And I think if we assume no reordering, certain
//  pps, pps, and frame orders and rates (and we specify the rate with periodicty-idr), we don't need any mp4-typescript parsing
//  in the main streamer/receiver code (besides start code checking, which is probably all [0,0,0,1] anyway) (so it will be fast).
//  /etc/ssh/sshd_config, PasswordAuthentication no
//  cat >> ~/.ssh/authorized_keys (put public key here)
//  2017-11-29-raspbian-stretch.img
//  gst-launch-1.0 version 1.10.4
//  GStreamer 1.10.4
//  http://packages.qa.debian.org/gstreamer1.0
// sudo apt install gstreamer-1.0
// sudo apt install gstreamer1.0-tools
// sudo apt-get install libav-tools
// gst-inspect-1.0 avenc_h264_omx


// gst-inspect-1.0 omxh264enc
// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable periodicty-idr=10 ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=90 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"

// time gst-launch-1.0 -vv -e multifilesrc location="frame%d.jpeg" ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"
*/

//todonext
// Bundle these and pass them to the client.
//  - Then add metadata on things such a nal rates (maybe do start code parsing on output?), bit rate, fps, etc
//  - Then make the sender have dynamic fps, with the limiting factor being encoding speed (and capped a certain fps).
//  - We also want to measure bandwidth restrictions, and possibly restrict fps based on that. We should receive callbacks
//      when a frame is received (or when every nth frame is received) so we can roughly estimate display lag. If display
//      lag gets over a certain amount for a certain number of frames in a row, we should reduce the FPS.
//      - We should also add limits on the number of unacknowledged frames we will send, and make sure we noticed
//          lag on more frames then that. This will let us maintain the fps even if the network is flakey, as
//          lowering the fps won't help at all if the network is flakey (and instead result in very low FPS,
//          with no benefit). Eventually the buffer will get really big if our FPS is higher than the average bandwidth,
//          causing the lag to continue even when the network is back up, which will allow our FPS to still be correct,
//          just not to wildly drop every time the network goes down.
//      It is impossible to passively tell the difference between very high latency and bandwidth limitations.
//      If there is simply 10 second latency, irregardless of how much we send, it will make it look like we and bandwidth
//      limited, unless we actively send less and find no difference in latency. So we should have a configurable max
//      latency limit, to make it possible for very slow connections to still work.
//  - We need to figure out time drift. Usually for long videos (like a few hours), you can just encode at a certain fps,
//      and the video may play a few seconds? faster or slower. But... for video that plays continously, easily for
//      weeks, we need a way to recover from time drift on the server being different than on the client.
//      - Start by displaying the amount of lag. HOPEFULLY the client's clock is faster than the camera's, meaning
//          sometimes the realtime video will pause and wait for the camera to give more data. Otherwise we will
//          at least see the lag slowly build up over time, at which point we can add corrective measures.


function mkdirPromise(path: string) {
    return new Promise<void>((resolve, reject) => {
        mkdir(path, (err => {
            err ? reject(err) : resolve();
        }));
    });
}
function writeFilePromise(path: string, buf: Buffer) {
    return new Promise<void>((resolve, reject) => {
        writeFile(path, buf, (err => {
            err ? reject(err) : resolve();
        }));
    });
}
async function getFinalStorageFolder() {
    let finalStorageFolder = "./dist/videos/";
    try {
        await mkdirPromise(finalStorageFolder);
    } catch(e) { }
    return finalStorageFolder;
}


class PChannelMultiListen<T> implements PChanSend<T> {
    callbacks: ((value: T) => void)[] = [];

    /** Returns a close callback. And if callback throughs, we close the connection. */
    public Subscribe(callback: (value: T) => void): () => void {
        this.callbacks.push(callback);
        return () => {
            this.removeCallback(callback);
        };
    }

    private removeCallback(callback: (value: T) => void) {
        let index = this.callbacks.indexOf(callback);
        if(index < 0) {
            console.warn(`Could not callback on PChannelMultiListen. Maybe we are searching for it incorrectly?, in which case we will leak memory here, and probably throw lots of errors.`);
        } else {
            this.callbacks.splice(index, 1);
        }
    }

    private closeDeferred = new Deferred<void>();
    OnClosed: Promise<void> = this.closeDeferred.Promise();
    IsClosed(): boolean { return !!this.closeDeferred.Value; }

    SendValue(value: T): void {
        let callbacks = this.callbacks.slice();
        for(let callback of callbacks) {
            try {
                callback(value);    
            } catch(e) {
                console.error(`Error on calling callback. Assuming requested no longer wants data, and are removing it from callback list. Error ${String(e)}`);
                this.removeCallback(callback);
            }
        }
    }
    SendError(err: any): void {
        console.error(`Error on PChannelMultiListen. There isn't really anything to do with this (the clients don't want it), so just swallowing it?`, err);
    }
    
    Close(): void {
        this.closeDeferred.Resolve(undefined);
    }
    IsClosedError(err: any): boolean {
        return false;
    }
}

// We store nal units (1 nal = 1 Buffer form, sps and pps easily available per buffer, with info on slice type),
//  and then dynamically mux depending on what the client requests.

// 200KB/s source, looking like 40KB per frame.
//  (this should be configurable, because I definitely might change it.)
//  Live, source rate
//      - Short term storage, 30 days. Regular S3. 200KB/s will use 500GB a month, so ~$11.5 per month.
//  1/10 source
//      - Long term storage, 180 days, glacier S3. So 300GB at once, which is ~$1.2 per month.
//  1/100
//      - Forever. Glacier S3. +60GB a year, so $0.24 per month after 1 year, $2.4 per month after 10 years.

// 5.7 days at 200KB/s (100GB) from glacier (or infrequent access) costs about $3 for 1-5 minutes access time,
//  $1 for 3-5 hours to access, and $0.25 for 5-12 hours to access.

// Expedited retrievals cost $0.03 per GB and $0.01 per request. Standard retrievals cost $0.01 per GB and $0.05 per
//  1,000 requests. Bulk retrievals cost $0.0025 per GB and $0.025 per 1,000 requests.

// Okay, so... we probably want data older than a month to require explicitly requesting a time period and rate, saying expedited or not
//  and then getting a notification when it finishes transferring the data to regular S3 (or just the digital ocean server?)

// 1 hour at 60fps is 216000, at 40KB per frame that is around 8GB

// Use cases.
//  - Living streaming. Likely going to be on 24/7, and should forcefully not use S3, as going to S3 or back will cost a lot of money.
//  - Watching historical video. Always at 60fps (if the data is avilable), because if the user is watching it, they will see all the frames.
//      - There will probably be 3 tiers of video. Super high rate, high rate, and then realtime, but I'm not sure the rates of these.


/*
Data Returned by S3 Select	$0.0007 per GB
Data Scanned by S3 Select	$0.002 per GB
PUT, COPY, POST, or LIST Requests	$0.005 per 1,000 requests
GET, SELECT and all other Requests	$0.0004 per 1,000 requests
Lifecycle Transition Requests into Standard – Infrequent Access or One Zone - Infrequent Access	$0.01 per 1,000 requests
*/

/*
S3 Standard Storage
First 50 TB / Month	$0.023 per GB
Next 450 TB / Month	$0.022 per GB
Over 500 TB / Month	$0.021 per GB

$5 digital ocean instance has a 25GB HDD, and 25GB S3 standard would cost $0.115 per month.

S3 Standard-Infrequent Access (S3 Standard-IA) Storage
All storage	$0.0125 per GB

S3 One Zone-Infrequent Access (S3 One Zone-IA) Storage
All storage	$0.01 per GB

Amazon Glacier Storage
All storage	$0.004 per GB
*/

// Storage sources, with ranges of NALs and the sample rates of them. Random access 

// The server needs to remux, because we don't want to send the client weird videos.
//  This means usually the server should stream video the client at the exact fps and speed the client
//  wants it. If the client changes the speed and then seeks, the client can just change the fps to get it
//  to work (via video.playbackRate), or just request all new video. The server will always be muxing
//  on demand, so for new video you should always request the speed you want, as it should take the server
//  no effort to switch the video rate (it should literally just require changing 1 variable).

// TODO: Allow live streaming on the local network, at variable (max) fps.
// TODO: Store the last 10GB or so on the camera, to allow viewing of short term video at a high fps.
// TODO: We actually want to be able to turn up the live fps dynamically, so we can have good video
//  for a short period of time (but not too long, or our internet will start to get throttled, and we'll use
//  5TB a month, at only 10fps).

// Parts:
//  NAL acceptor
//      - stores nals
//      - creates emitters which read from it's storage
//  NAL emitter
//  NAL muxers
//      - takers emitter, and muxers it to a client

// There should probably be a "get single live jpeg image" test function, so you can see the quality
//  degradation from encoding, and the maximum theoretical video quality.

class Muxer {
    constructor(public readonly rate: number) { }

    public AcceptNAL(nal: NALHolder) {

    }

    public async Subscribe(args: {
        time: VideoTime;
        rate: number;
        client: IVideoAcceptor
    }): Promise<void> {

    }
}

class Receiver extends TimeServer implements IReceiver, IHost {
    // Eh... might as well use &, because we can't narrow the type anyway, as this property
    //  will be a proxy, and I haven't implemented the in operator yet!
    client!: ISender&IBrowserReceiver&ConnExtraProperties;
    clientVideoSegment = new PChannelMultiListen<LiveVideoSegment>();

    cameraClient = new Deferred<ISender>();
    curFormatId = randomUID("format");

    // If it is a string it is the sourceId of a camera that closed.
    liveDataChan = new PChan<LiveVideoSegment|string>();

    constructor() {
        super();
    
        TransformChannelAsync<LiveVideoSegment|string, void>(x => this.storeLiveData(x.inputChan))(this.liveDataChan).GetPromise().catch(e => {
            console.error(`storeLiveData loop crashed`, e)
        });
        this.clientVideoSegment.Subscribe(segment => {
            try {
                this.liveDataChan.SendValue(segment);
            } catch(e) {
                console.log(`liveDataChan err`);
            }
        });
    }

    public async getFormats(): Promise<v4l2camera.Format[]> {
        let client = await this.cameraClient.Promise();
        let formats = await client.getStreamFormats();
        return formats.filter(x => x.formatName === "MJPG");
    }
    public async setFormat(
        fps: number,
        /** Frequency of i frames. */
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format
    ): Promise<void> {
        this.curFormatId = randomUID("format");
        await (await this.cameraClient.Promise()).setStreamFormat(fps, iFrameRate, bitRateMBPS, format, this.curFormatId);
    }

    public async cameraPing(sourceId: string) {
        console.log("Camera connected call");
        
        let client = this.client;
        this.cameraClient.ForceResolve(client);

        let promise = client.ClosePromise;
        promise.then(() => {
            console.log("Camera closed");
            this.liveDataChan.SendValue(sourceId);
        });
    }

    /** Sorted by startTime */
    private timeRanges: {
        time: TimeRange;
        segments: RecordedVideoSegment[];
    }[] = [];
    private async storeLiveData(segmentsChan: PChanReceive<LiveVideoSegment|string>) {
        while(true) {
            //todonext
            // Sped up video. We can combine videos with the same sps and pps

            let lastSourceId: string|undefined;

            const finishSegment = () => {
                if(this.timeRanges.length === 0 || this.timeRanges.last().time.lastFrameTime !== "live") return;
                console.log("Segment finished");
                let liveSegments = this.timeRanges.last();
                liveSegments.time.lastFrameTime = liveSegments.segments.last().cameraRecordTimes.last();
            };
            
            while(true) {
                let segment = await segmentsChan.GetPromise();
                if(typeof segment === "string") {
                    console.log(`Closed ${segment}, current ${lastSourceId}`);
                    if(segment === lastSourceId) {
                        finishSegment();
                    }
                    continue;
                }

                if(segment.sourceId !== lastSourceId) {
                    finishSegment();

                    // Start segment
                    console.log("Segment started");
                    
                    this.timeRanges.push({
                        time: {
                            firstFrameTime: segment.cameraRecordTimes[0],
                            lastFrameTime: "live"
                        },
                        segments: []
                    });
                }

                console.log(`Segment loop ${segment.sourceId}`);
                this.timeRanges.last().segments.push({
                    type: "recorded",
                    mp4Video: segment.mp4Video,
                    baseMediaDecodeTimeInSeconds: segment.baseMediaDecodeTimeInSeconds,
                    cameraRecordTimes: segment.cameraRecordTimes,
                    rate: 1
                });

                lastSourceId = segment.sourceId;
            }
        }
    }
    public async getTimeRanges(info: {
        /** We return one range before this time (if possible), and then up to 100 ranges after it. */
        startTime: number;
    }): Promise<{
        ranges: TimeRange[]
    }> {
        let index = binarySearchMapped(this.timeRanges, info.startTime, x => x.time.firstFrameTime, (a, b) => a - b);
        if(index < 0) {
            index = ~index - 1;
            if(index < 0) {
                index = 0;
            }
        }
        let ranges: TimeRange[] = this.timeRanges.slice(index, index + 2).map(x => x.time);
        return { ranges: ranges };
    }

    private streamLoops: {
        client: Receiver["client"];
        close: () => Promise<void>;
    }[] = [];

    private async closeStreams(client: Receiver["client"]) {
        let prevStreams = this.streamLoops.filter(x => x.client === client);
        for(let prevStream of prevStreams) {
            console.log(`Closing previous stream to same client`);
            await prevStream.close();
            console.log(`Closed previous stream to same client`);
        }
        let streamLoops = this.streamLoops;
        for(let i = streamLoops.length - 1; i >= 0; i--) {
            if(streamLoops[i].client === client) {
                streamLoops.splice(i, 1);
            }
        }
    }

    public async subscribeToCamera(info: {
        time: VideoTime;
        rate: number;
    }) {
        let client = this.client;

        await this.closeStreams(client);

        let cancelId: number|undefined;
        let close = false;
        let closedDeferred = new Deferred<void>();
        this.streamLoops.push({
            client,
            close() {
                clearTimeout(cancelId);
                close = true;
                closedDeferred.Resolve(undefined);
                return closedDeferred.Promise();
            }
        });

        if(info.time === "live") {
            if(info.rate !== 1) {
                throw new Error(`Live and rate !== 1 is invalid. Rate was ${info.rate}`);
            }
            return this.subscribeToCameraLive(client);
        }


        // Okay... using time we can find the start range to play at. And then... we should
        //  just start playing. We might play at a faster than 1 rate, so we should handle
        //  catching up to live and then switching to a live stream. Otherwise (when we
        //  are not live), we don't need a channel, we can just iterate over the array of videos?
        // Until we add s3 handling, then we will basically be streaming from s3?
        // And actually... if we are streaming from s3, do we even want to have the server in the middle?
        //  (yes, for caching, to reduce s3 bandwidth).

        console.log("Starting video stream");

        let index = binarySearchMapped(this.timeRanges, info.time, x => x.time.firstFrameTime, (a, b) => a - b);
        if(index < 0) {
            index = ~index - 1;
            if(index < 0) {
                index = 0;
            }
        }
        let segObj = this.timeRanges[index];
        if(!segObj) {
            throw new Error(`No video at or after time ${info.time}`);
        }
        let segIndex = binarySearchMapped(segObj.segments, info.time, x => x.cameraRecordTimes[0], (a, b) => a - b);
        if(segIndex < 0) {
            segIndex = ~segIndex - 1;
            if(segIndex < 0) {
                throw new Error(`Impossible`);
            }
        }

        let firstSegment = true;
        let time = info.time;

        let nextSegmentTime = clock();
        let curLag = 0;

        const sendSegment = () => {
            if(close) return;
            try {
                let now = clock();
                let setTimeoutLag = now - nextSegmentTime;
                curLag += setTimeoutLag;

                let ranges = this.timeRanges;
                let segmentObj = ranges[index];
                let segments = segmentObj.segments;
                let segment = segments[segIndex];

                //console.log(`Sending segment`);
                client.acceptVideoSegment_VOID(segment);

                segIndex++;
                if(segIndex >= segments.length) {
                    if(segmentObj.time.lastFrameTime === "live") {
                        // TODO: Switch to live streaming it.
                        console.log(`Reached the end of the live stream. Ending stream`);    
                        return;
                    }
                    segIndex = 0;
                    index++;
                }
                if(index >= ranges.length) {
                    console.log(`Sent all video, ending stream`);
                    return;
                }

                let nextSegmentStart = segIndex < segments.length ? segments[segIndex].cameraRecordTimes[0] : segment.cameraRecordTimes.last();
                // TODO: The first iteration should use info.time for this instead
                let segStart = segment.cameraRecordTimes[0];
                if(firstSegment) {
                    firstSegment = false;
                    segStart = time;
                }
                let segmentDuration = nextSegmentStart - segStart - curLag;

                nextSegmentTime = clock() + segmentDuration;
                cancelId = setTimeout(sendSegment, segmentDuration) as any;
            } catch(e) {
                console.error(`Segment loop died`, e);
            }
        };
        sendSegment();

        return {
            streamRate: 1
        };
    }


    private async subscribeToCameraLive(client: Receiver["client"]) {
        await this.closeStreams(client);

        let close = false;
        let closedDeferred = new Deferred<void>();
        this.streamLoops.push({
            client,
            close() {
                close = true;
                return closedDeferred.Promise();
            }
        });
        
        this.clientVideoSegment.Subscribe(video => {
            if(close) {
                closedDeferred.Resolve(undefined);
                throw new Error(`Client requested stop`);
            }
            if(video.sourceInfo.formatId !== this.curFormatId) {
                console.log(`Ignoring encoded data because it was generated using a stale format id.`);
                return;
            }

            client.acceptVideoSegment_VOID(video);
        });

        return {
            streamRate: 1
        };
    }

    
    nalStream = new PChan<NALHolder>();
    public acceptNAL(info: NALHolder): void {
        //console.log(`Received nal size ${info.nal.length}, type ${info.type.type} at ${+new Date()}, from time ${info.type.type === "slice" ? info.type.frameRecordTime : 0}`);
        info.senderConfig.serverReceiveTime = +new Date();

        this.nalStream.SendValue(info);
    }
    muxLoop = (async () => {
        let stream = this.nalStream;
        try {
            
            // Okay... we want to get frame durations from frame times. So... 

            let nextSps: NALHolder|undefined;
            while(true) {
                // TODO: Write either the NALs, or the muxed video to disk, and then to s3, so we have it forever.
                //  And then expose function to allow seeking of the video.
                //  - We also want to write some higher fps videos
                //      - The issue here is that in theory the spses may change from video to video?
                //          - We should check that, and if they seem to not change, we can just take the nals and 
                //              make the videos ourselfs (verifying the spses don't change),
                //          - If they do change often, we have to encode larger chunks, or perhaps re-encode on the remote server?
                //              (as the frame rate will be so much lower, so encoding speeds can be fairly low.)
                //  - And we want a low FPS video, for super long term storage. 
                //      - We can just remux a high fps video to slow it down to get this, or just mux a high fps video twice...

                let sps = nextSps || await stream.GetPromise();
                if(sps.type.type !== "sps") {
                    throw new Error(`Expected sps, got ${sps.type.type}`);
                }

                let pps = await stream.GetPromise();
                if(pps.type.type !== "pps") {
                    throw new Error(`Expected pps, got ${pps.type.type}`);
                }

                let startTime: number|undefined;
                let frames: NALHolder[] = [];
                while(true) {
                    let frame = await stream.GetPromise();
                    if(frame.type.type === "sps") {
                        nextSps = frame;
                        break;
                    }

                    if(frame.type.type !== "slice") {
                        throw new Error(`Expected slice, got ${frame.type.type}`);
                    }
                    frames.push(frame);
                    if(!startTime) {
                        //console.log(`Using frame record time ${frame.type.frameRecordTime}`);
                        startTime = frame.type.frameRecordTime;
                    }
                }
                startTime = startTime || +new Date();


                if(sps.senderConfig.formatId !== this.curFormatId) {
                    console.log(`Ignoring encoded data in muxer because it was generated using a stale format id.`);
                    continue;
                }


                //todonext
                // Oh yeah, the last frame. Frame timings are going to be hard here. We need to guess an fps? We could also just give
                //  every frame its own time, but... We don't know how long the last frame should last for? We might have to add a one
                //  nal delay here...
                let fps = sps.senderConfig.fps;

                let baseMediaDecodeTimeInSeconds = startTime / 1000;

                let frameInfos = frames.map((x, i) => {
                    if(x.type.type !== "slice") {
                        throw new Error(`Not possible`);
                    }

                    let frameDurationInSeconds = 0;
                    if(i < frames.length - 1) {
                        let next = frames[i + 1];
                        if(next.type.type !== "slice") {
                            throw new Error(`Not possible`);
                        }
                        frameDurationInSeconds = (next.type.frameRecordTime - x.type.frameRecordTime) / 1000;
                        console.log({frameDurationInSeconds});
                    }
                    
                    return {
                        buf: x.nal,
                        frameDurationInSeconds
                    };
                });
                frameInfos[frameInfos.length - 1].frameDurationInSeconds = 0;

                //todonext mux video into videos of different speeds. This will mean there less videos at a faster speed
                //  (as you can't play faster video live, and the only reason we have small increments is for live video).

                //console.log(`Muxing video from ${JSON.stringify(sps.senderConfig)}`);
                let video = await MuxVideo({
                    sps: sps.nal,
                    pps: pps.nal,
                    frames: frameInfos,
                    // TODO: This is multiplied by timescale and then rounded. Which means we only have second precision
                    //  (and this is used for seeking). So, find a way to fix this, because we want frame level seeking precision?
                    //  And we have to / fps, or else the number becomes too large for 32 bits, which is annoying.
                    //  Actually... maybe we should just support 64 bits in the box where this is used?
                    baseMediaDecodeTimeInSeconds: baseMediaDecodeTimeInSeconds,
                    width: sps.senderConfig.format.width,
                    height: sps.senderConfig.format.height,
                });

                this.clientVideoSegment.SendValue({
                    type: "live",
                    mp4Video: video,
                    baseMediaDecodeTimeInSeconds,
                    cameraRecordTimes: frames.map(x => x.type.type === "slice" ? x.type.frameRecordTime : -1),
                    frameSizes: frameInfos.map(x => x.buf.length),
                    cameraRecordTimesLists: frames.map(x => x.type.type === "slice" ? x.type.frameRecordTimes : []),
                    cameraSendTimes: frames.map(x => x.senderConfig.cameraSendTime),
                    serverReceiveTime: frames.map(x => x.senderConfig.serverReceiveTime),
                    serverSendTime: +new Date(),
                    clientReceiveTime: 0,
                    cameraTimeOffset: sps.senderConfig.timeOffset,
                    sourceInfo: {
                        fps: sps.senderConfig.fps,
                        formatId: sps.senderConfig.formatId
                    },
                    sourceId: sps.senderConfig.sourceId
                });

                //console.log(`Send muxed video`);
            }
        } catch(e) {
            console.error(e);
            console.error(`Mux loop died. This is bad... killing server in 30 seconds.`);
            setTimeout(() => {
                process.exit();
            }, 30 * 1000);
        }
    })();
}

wsClass.HostServer(7060, new Receiver());


//todonext
/*
Get streaming data from:
    time gst-launch-1.0 -vv -e v4l2src num-buffers=10 device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=17000000 control-rate=variable ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

https://gist.github.com/mitsuhito/ad3ae3e341726687457c

Locally, decode the NALs? and see if there is reordering. If there is, then disable that? Or maybe just order to
*/




/*
var server = net.createServer(socket => {
    var time = +new Date();

    let buffers: Buffer[] = [];

    console.log("Got client");
    socket.on("close", () => {
        console.log("Closed");

        time = +new Date() - time;

        console.log(`Took ${time}ms`);

        let fullBuffer = Buffer.concat(buffers);
        writeFileSync("./dist/rawNals.nal", fullBuffer);
    });
    socket.on("error", () => {
        console.log("error");
    });
    socket.on("data", (data) => {
        // Start codes
        //  0, 0, 1 or 0, 0, 0, 1.

        // Parsing NALs. How long does it take? Even if it seems fast on our machine, maybe it's way too slow on remote machines?

        buffers.push(data);
        console.log(`Read ${data.length}`);
    });
});
server.listen(3000, "0.0.0.0");
//*/



//todonext
/*
// - Converting a tcp connection to a PChannel is obvious. Eventually I should do it with websockets too,
//  the second I even remotely touch websocket code again.

function tcpReceiveChannel(port: number, host: string): PChanReceive<Buffer> {

}

// - Then I need to expose something that gets nal_unit_type quickly (in mp4-typescript)
//  (which is in the nal header, so it doesn't require escaping start codes),
//  so I can split the stream into actual videos.
// - Then... I can finally have a while(true) loop that takes NALs, keep track of information on NALs
//  received (and frame rates, byte rates, latency, etc), and emits videos to clients
//      - and then I can put this code in receiver.ts, and display the information (and video), in the browser.
//*/




/*
let dataSize = 200 * 1024;

let wsServer = new ws.Server({ port: 6070 });
wsServer.on("connection", connRaw => {

    console.log("conn opened");
   
    var curCallback = null;
    async function requestData(size) {
        if(curCallback !== null) {
            throw new Error(`Already waiting for data`);
        }
        return new Promise(x => {
            curCallback = x;
            connRaw.send(JSON.stringify({
                size: size
            }));
        });
    }

    connRaw.on("message", data => {
        var callback = curCallback;
        curCallback = null;
        receiveData(data.length);
        callback();
    });;
    connRaw.on("error", (err) => {
        console.error(err);
    });

    run();
    async function run() {
        
        while(true) {
            await requestData(dataSize);
        }
    }
});
wsServer.on("error", (err) => {
    console.error(err);
});

var lastPrintTime = 0;
var printInterval = 1000;
function printTime(bytePerMillisecond) {
    var curTime = clock();
    var diff = curTime - lastPrintTime;
    if(diff < printInterval) return;
    lastPrintTime = curTime;
    
    var KBpS = bytePerMillisecond / 1024 * 1000;

    console.log(`${KBpS} KB/s, ${dataSize} bytes`);
}

var rollingTimes = [];
var minTimeCount = 3;
var maxTimeDuration = 3000;
function addTime(duration, size) {
    rollingTimes.push({duration, size});
    while (
        rollingTimes.length > 0
        && rollingTimes.reduce((a, b) => a + b.duration, 0) - rollingTimes[0].duration > maxTimeDuration
        && rollingTimes.length > minTimeCount
    ) {
        rollingTimes.shift();
    }

    var sum = rollingTimes.reduce((a, b) => a + b.duration, 0);
    var bytes = rollingTimes.reduce((a, b) => a + b.size, 0);

    printTime(bytes / sum);
}

var lastStart = clock();
function receiveData(size) {
    var time = clock();
    var curDuration = time - lastStart;
    lastStart = time;

    addTime(curDuration, size);
}

console.log("started");
*/