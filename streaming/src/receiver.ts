import * as wsClass from "ws-class";

import { PChan, pchan, TransformChannel, TransformChannelAsync } from "pchannel";
import { clock } from "./misc";

import { CreateVideo } from "mp4-typescript";
import { mkdir, writeFile, writeFileSync, readFileSync } from "fs";

import * as net from "net";
import { PChanReceive, PChanSend } from "controlFlow/pChan";
import { makeProcessSingle } from "./util/singleton";

console.log("pid", process.pid);
makeProcessSingle("receiver");

setInterval(() => {
    console.log("alive2");
}, 1000);

// Okay... there is a solution for low bit rates. We CAN encode at a 5 to 1 ratio at a rate of about 230KB/s in. So for very slow
//  connections encoding first is viable. So if the connection maximum drops below 230KB/s, encoding is worth it. But... if the
//  connection is around 40KB/s, nothing is really worth it, because then even with encoding we won't get even 1 FPS.
// But... that is so niche, so screw it, let's just but ethernet cables and wire it in.

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


class Receiver implements IReceiver, IHost {
    // Eh... might as well use &, because we can't narrow the type anyway, as this property
    //  will be a proxy, and I haven't implemented the in operator yet!
    client!: ISender&IBrowserReceiver;

    webcamFrameInfoRequesters: PChan<WebcamFrameInfo>[] = [];


    async cameraPing() {
        let client = this.client;
        let formats = await client.getStreamFormats();
        console.log(formats);

        client.setStreamFormat(10, formats[0]);
    }
    acceptFrame(frame: {
        buffer: Buffer;
        format: v4l2camera.Format;
        eventTime: number;
    }): void {
        let receivedTime = clock();

        //console.log(`Recieved frame ${frame.buffer.length}`);

        this.frameReceived.SendValue(frame.buffer);

        let chans = this.webcamFrameInfoRequesters;
        for(let i = chans.length - 1; i >= 0; i--) {
            chans[i].SendValue({
                webcamSourceTime: frame.eventTime,
                serverReceivedTime: receivedTime,
            });
        }
    }


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



    async subscribeToWebcamFrameInfo() {
        let client = this.client;

        let frameInfoChan = new PChan<WebcamFrameInfo>();
        this.webcamFrameInfoRequesters.push(frameInfoChan);

        (async () => {
            while(!frameInfoChan.IsClosed()) {
                let info = await frameInfoChan.GetPromise();
                try {
                    client.acceptWebcamFrameInfo_VOID(info);
                } catch(e) {
                    console.error(`Error on sending acceptWebcamFrameInfo_VOID. Assuming the connection is down, so no longer sending frame info to this client.`);
                    let index = this.webcamFrameInfoRequesters.indexOf(frameInfoChan);
                    if(index < 0) {
                        console.warn(`Could not remove channel from webcamFrameInfoRequesters, as we could not find it. Maybe we are searching for it incorrectly?, in which case we will leak memory here, and probably throw lots of errors.`);
                    } else {
                        this.webcamFrameInfoRequesters.splice(index, 1);
                    }
                }
            }
        })();
    }
}

//wsClass.HostServer(7060, new Receiver());

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