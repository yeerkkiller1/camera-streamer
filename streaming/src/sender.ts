import * as wsClass from "ws-class";

import * as Jimp from "jimp";
import { readFileSync, writeFileSync } from "fs";
import { execFileSync, spawn, execSync } from "child_process";
import { makeProcessSingle } from "./util/singleton";

let jimpAny = Jimp as any;

// Make sure we kill any previous instances
console.log("pid", process.pid);
makeProcessSingle("sender");


async function createSimulateFrame(time: number, width: number, height: number): Promise<Buffer> {
    async function loadFont(type: string): Promise<any> {
        return new Promise((resolve, reject) => {
            let jimpAny = Jimp as any;    
            jimpAny.loadFont(type, (err: any, font: any) => {
                if(err) {
                    reject(err);
                } else {
                    resolve(font);
                }
            });
        });
    }

    let image: any;
    image = new jimpAny(width, height, 0xFF00FFFF, () => {});
    
    image.resize(width, height);

    let data: Buffer = image.bitmap.data;
    let frameNumber = ~~time;
    for(let i = 0; i < width * height; i++) {
        let k = i * 4;
        let seed = (frameNumber + 1) * i;
        data[k] = seed % 256;
        data[k + 1] = (seed * 67) % 256;
        data[k + 2] = (seed * 679) % 256;
        data[k + 3] = 255;
    }

    let imageColor = new jimpAny(width, 64, 0x000000AF, () => {});
    image.composite(imageColor, 0, 0);

    let path = "./node_modules/jimp/fonts/open-sans/open-sans-64-white/open-sans-64-white.fnt";
    let font = await loadFont(path);
    image.print(font, 0, 0, `frame time ${time.toFixed(2)}ms`, width);
    
    let jpegBuffer!: Buffer;
    image.quality(75).getBuffer(Jimp.MIME_JPEG, (err: any, buffer: Buffer) => {
        if(err) throw err;
        jpegBuffer = buffer;
    });

    return jpegBuffer;
}

class Sender implements ISender {
    server!: IReceiver;

    frameCount = 0;

    setStreamFormat(fps: number, format: v4l2camera.Format): void {
        let delay = format.interval.numerator / format.interval.denominator * 1000;
        console.log("Set", format, delay);

        // Start the frame loop, and send the results to the server

        setInterval(async () => {
            console.log("Camera has frame");

            let time = +new Date();
            let frame = await createSimulateFrame(this.frameCount++, format.width, format.height);

            //todonext
            // So... just get the video from gstreamer decoding (there are new box types), and then work from there,
            //  maybe eventually going back to fix the openmax issues.

            //todonext
            // Maybe see if we can get: 
            //  time gst-launch-1.0 -vv -e multifilesrc location="frame%d.jpeg" caps="image/jpeg,framerate=30/1" ! omxmjpegdec ! multifilesink location="frame%d.yuv"
            // Working on digital ocean easily. If we can, then reflash the pi, until we put an OS on it that can do that easily.
            // Ugh... no, it won't work on digital ocean, as digital ocean doesn't have hardware encoders!

            // Create something to take all the frame%d.jpeg files on the pi to frame.yuv files.
            //  Oh omxmjpegdec. But it gives me the same error my earlier openmax code gave. Which is not because the memory is too little,
            //  as I the gpu memory set to 512.

            // Actually... if we have a command to encode at 30fps from raw files on the disk, and we can write at 30fps in jpeg to the disk,
            //  we can probably find something to convert jpegs to raw at 30fps on the disk?
            //  Except... not on the disk, because the write speed isn't that fast. But definitely in memory? That's only 90MB/s

            // ffmpeg is giving problems. Maybe it lied about it's speed?
            /*
            ffmpeg -f v4l2 -list_formats all -i /dev/video0
            
            ffmpeg -y -framerate 30 -f v4l2 -input_format mjpeg -video_size 1920x1080 -i /dev/video0 -b:v 17M -c:v h264_omx -r 30 output.mp4

            avconv -y -framerate 30 -f v4l2 -input_format mjpeg -video_size 1920x1080 -i /dev/video0 -b:v 17M -c:v h264_omx -r 30 output.mp4

            -f segment -segment_time 10 -r 10 "output%d.mp4"
            
            test.mp4
            */
            // -f segment -segment_time 10 -segment_format mp4 -r 10 "output%d.mp4"

            //todonext
            // Okay, with gstreamer is looks like we can encode at 30fps. BUT, gstreamer still uses cpu jpeg decoding, which means it is the same
            //  speed as ffmpeg.
            // Oh... ffmpeg is so close. It does it, BUT, it decodes the mjpeg frames on the CPU. Which can't handle more than ~10 fps.
            //  Which... is probably fine. BUT, if I wanted to do it better, I would interface with openmax, and make the jpeg decoding and h264
            //  encoding both happen on the GPU. BUT... that will be a lot more work, so for now... But then again, learning openmax would be
            //  incredibly useful...

            // Actually... hardware encoding. I hear the raspberry pi has it, and although it is finnicky, it will be way better
            //  than spending actually money on more hardware AND power on running the beefy CPUs needed to encode 1080p 30fps.
            //  If the pi can do it at a hardware level... that will solve all the problems.

            // https://github.com/gagle/raspberrypi-openmax-h264
            //  - Throwing an error, but maybe it is because we are trying to use the library to also get camera data. Maybe we could
            //      only use it to encode?
            // http://practicalrambler.blogspot.com/2015/01/resolving-1080p-playback-errors-on.html

            // Encode servers
            //  They connect to us, and we use them to encode frames. If there are no servers, we cannot send data, and should give errors.
            //  At the very least an encode server should be launched on the same machine as us, with lower priority?

            /*
            This command works. It also encodes at a variable frame rate, which might be ideal. Still have to look at the container to see what time information it has.

                time gst-launch-1.0 -vv -e \
                v4l2src num-buffers=100 device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! \
                jpegdec ! \
                omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! h264parse ! mp4mux ! filesink location=output.mp4
            */

            this.server.acceptFrame({
                buffer: frame,
                eventTime: time,
                fps: fps,
                format: format,
            });
        }, delay);
    }
    async getStreamFormats(): Promise<v4l2camera.Format[]> {
        return [
            {
                formatName: 'MJPG',
                format: 1196444236,
                width: 1920,
                height: 1080,
                interval: { numerator: 1, denominator: 1 }
            },
            {
                formatName: 'MJPG',
                format: 1196444237,
                width: 1920,
                height: 1080,
                interval: { numerator: 1, denominator: 30 }
            }
        ];
    }
}


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
*/

setInterval(() => {
    console.log("alive");
}, 1000);

todonext
// Emit h264 chunks at a fixed fps, and get the receiver to handle it, and pass it the client.
//  - Move the code from capture.js required to get frames, and send them over Sender to receiver.
//      - Then send the frames to the browser, and display them.
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

/*
for(let i = 0; i < 30; i++) {
    process.stdin.write(readFileSync(`./result${i}.jpeg`));
}
process.stdin.end();

console.log("Sender");
*/


/*
let sender = new Sender();
let server!: IReceiver;

//wsClass.ThrottleConnections({ kbPerSecond: 200, latencyMs: 100 }, () => {
    server = wsClass.ConnectToServer<IReceiver>({
        port: 7060,
        host: "localhost",
        bidirectionController: sender
    });
//});

sender.server = server;
server.cameraPing();
*/

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