import * as wsClass from "ws-class";

import * as Jimp from "jimp";

let jimpAny = Jimp as any;

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
async function createSimulateFrame(time: number, width: number, height: number): Promise<Buffer> {
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
    setStreamFormat(fps: number, format: v4l2camera.Format): void {
        let delay = format.interval.numerator / format.interval.denominator * 1000;
        console.log("Set", format, delay);

        // Start the frame loop, and send the results to the server

        setInterval(async () => {
            //todonext
            // Create and send a real jpeg, with timestamped info, so we can test everything downstream
            //  locally, without having to actually use the camera on the raspberry pi.

            console.log("Sending frame");

            let time = +new Date();
            let frame = await createSimulateFrame(time, format.width, format.height);

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
                width: 1280,
                height: 720,
                interval: { numerator: 1, denominator: 15 }
            },
            {
                formatName: 'MJPG',
                format: 1196444237,
                width: 1280,
                height: 720,
                interval: { numerator: 1, denominator: 30 }
            }
        ];
    }
}

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