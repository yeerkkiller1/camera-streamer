import * as wsClass from "ws-class";


class Sender implements ISender {
    server!: IReceiver;
    setStreamFormat(fps: number, format: v4l2camera.Format): void {
        let delay = format.interval.numerator / format.interval.denominator * 1000;
        console.log("Set", format, delay);

        // Start the frame loop, and send the results to the server

        setInterval(() => {
            todonext
            // Create and send a real jpeg, with timestamped info, so we can test everything downstream
            //  locally, without having to actually use the camera on the raspberry pi.

            console.log("Sending frame");
            this.server.acceptFrame({
                buffer: new Buffer(200 * 1000),
                eventTime: +new Date(),
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

wsClass.ThrottleConnections({ kbPerSecond: 200, latencyMs: 100 }, () => {
    server = wsClass.ConnectToServer<IReceiver>({
        port: 7060,
        host: "localhost",
        bidirectionController: sender
    });
});

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