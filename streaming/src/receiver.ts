import * as wsClass from "ws-class";

import { PChan, pchan, TransformChannel, TransformChannelAsync, Deferred } from "pchannel";

import { CreateVideo, MuxVideo } from "mp4-typescript";
import { mkdir, writeFile, writeFileSync, readFileSync } from "fs";

import * as net from "net";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { makeProcessSingle } from "./util/singleton";
import { clock } from "./util/time";

console.log("pid", process.pid);
makeProcessSingle("receiver");

setInterval(() => {
    console.log("alive2");
}, 60000);


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

class Receiver implements IReceiver, IHost {
    // Eh... might as well use &, because we can't narrow the type anyway, as this property
    //  will be a proxy, and I haven't implemented the in operator yet!
    client!: ISender&IBrowserReceiver;

    clientVideoSegment = new PChannelMultiListen<VideoSegment>();


    public async cameraPing() {
        console.log("setStreamFormat call");

        let client = this.client;
        let formats = await client.getStreamFormats();
        //console.log(formats);

        //console.log("setStreamFormat call");
        client.setStreamFormat(3, formats[formats.length - 1]);
    }

    public async subscribeToCamera() {
        let client = this.client;

        this.clientVideoSegment.Subscribe(video => {
            client.acceptVideoSegment_VOID(video);
        });
    }

    
    nalStream = new PChan<NALHolder>();
    public acceptNAL(info: NALHolder): void {
        console.log(`Recieved nal size ${info.nal.length}, type ${info.type.type} at ${+new Date()}`);

        this.nalStream.SendValue(info);
    }
    muxLoop = (async () => {
        let stream = this.nalStream;
        try {
            
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

                let startTime: number = +new Date();
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
                    startTime = frame.type.frameTime;
                }

                let buffers = [sps, pps].concat(frames).map(x => x.nal);

                console.log(`Muxing video`);
                //todonext
                // Oh yeah, the last frame. Frame timings are going to be hard here. We need to guess an fps? We could also just give
                //  every frame its own time, but... We don't know how long the last frame should last for? We might have to add a one
                //  nal delay here...
                let fps = sps.senderConfig.fps;
                let video = await MuxVideo({
                    nals: buffers,
                    // TODO: This is multiplied by timescale and then rounded. Which means we only have second precision
                    //  (and this is used for seeking). So, find a way to fix this, because we want frame level seeking precision?
                    //  And we have to / fps, or else the number becomes too large for 32 bits, which is annoying.
                    //  Actually... maybe we should just support 64 bits in the box where this is used?
                    //baseMediaDecodeTimeInSeconds: startTime / 1000 / fps,
                    baseMediaDecodeTimeInSeconds: 0,
                    fps: fps,
                    width: sps.senderConfig.format.width,
                    height: sps.senderConfig.format.height,
                });

                writeFileSync("C:/scratch/test.mp4", video);

                this.clientVideoSegment.SendValue({
                    durationSeconds: frames.length * 1 / 10,
                    mp4Video: video,
                    startTime: startTime / fps
                });

                console.log(`Send muxed video`);
            }
        } catch(e) {
            console.error(e);
            console.error(`Mux loop died. This is bad... killing server in 30 seconds.`);
            setTimeout(() => {
                process.exit();
            }, 30 * 1000);
        }
    })();


    /*
    frameReceived = new PChan<Buffer>();
    frameLoop = (async () => {
        try {
            while(true) {

                //todonext
                // Create frame and video file name format that gives information on them. Also store them in folders so we can seek easily.
                //  Also, maybe write additional adjacent metadata files with all the frame info?

                // So... it seems like the connection to the server is always going to be the bottleneck. In jpeg format you need
                //  something like 45MB/s for 30fps 1080p video. So we are always going to be sending compressed video to the remote server.

                const framesPerChunk = 10;

                let finalFolder = await getFinalStorageFolder();
                let jpegPattern = finalFolder + "frame%d.jpeg";

                for(let i = 0; i < framesPerChunk; i++) {
                    let frame = await this.frameReceived.GetPromise();
                    await writeFilePromise(jpegPattern.replace(/%d/g, i.toString()), frame);
                }              

                let video = await CreateVideo({
                    fps: 10,
                    baseMediaDecodeTimeInSeconds: 0,
                    jpegPattern: jpegPattern
                });

                await writeFilePromise(finalFolder + "video.mp4", video);


                //todonext
                // Write frames to files. This will be the final location for the files, used as storage. Eventually we need
                //  to back up the frame jpeg storage with s3 so we have infinite storage space.
                // Then create the video, and I guess store that on disk too?
                // And then push that to some channel?
                // Expose video encode quality settings, and video resolution settings.

                //CreateVideo
                console.log(`Finished chunk`)
            }
        } catch(e) {
            console.error(e);
            console.error(`Frame loop died. This is bad...`);
            process.exit();
        }
    })();
    */

    //todonext
    // Actually encode the video, that way when we test throttling we can tell
    //  if our throttling code is working properly by seeing if the video looks good.
    // Also send differences in last frame received in current time (lag) to the client
    //  - And then graph this, so we can see lag over time
    //      - Have the client run an animation loop to update this continously
    //  - Maybe also do something like this with video data, even though that will be chunked so it is forcefully have lag, but at least
    //      we could verify the video encoding isn't adding more lag than we expected
    // And display current requested FPS.
    // Add storing and retrieveing on S3
    // Add throttling
    //  - We need to throttle based on bandwidth to camera AND encoding speed of server.
    //      - And... if we could encode on multiple servers, and dynamically add more servers to encode
    //          at more FPS... that would be nice.
    //      - I should make something called "local encoders", which have a high bandwidth connection to the webcam,
    //          and if they exist they by the sender to encode before it sends frames.
    //          - Then the server has to accept both frames and just already encoded video? Then we can force the browser to generate thumbnails
    //              when seeking? (as the server won't have thumbnails)
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
// gst-inspect-1.0 omxh264enc
// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable periodicty-idr=10 ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=90 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"

// time gst-launch-1.0 -vv -e multifilesrc location="frame%d.jpeg" ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"
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