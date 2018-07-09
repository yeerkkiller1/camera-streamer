import * as wsClass from "ws-class";



// Okay... there is a solution for low bit rates. We CAN encode at a 5 to 1 ratio at a rate of about 230KB/s in. So for very slow
//  connections encoding first is viable. So if the connection maximum drops below 230KB/s, encoding is worth it. But... if the
//  connection is around 40KB/s, nothing is really worth it, because then even with encoding we won't get even 1 FPS.
// But... that is so niche, so screw it, let's just but ethernet cables and wire it in.

class Receiver implements IReceiver, IHost {
    client!: ISender;

    lastFrame: Buffer|null = null;
    acceptFrame(frame: {
        buffer: Buffer;
        format: v4l2camera.Format;
        eventTime: number;
    }): void {
        //todonext
        // Host a server ourself, to hack in streaming of these pictures, and then create a client so
        //  we can view the pictures.
        //todonext
        // Dynamically set stream format (only fps), to keep the frames from getting behind (because the connection is overwhelmed.)
        console.log(`Recieved frame ${frame.buffer.length}`);
        this.lastFrame = frame.buffer;
    }

    async testGetLastFrame(): Promise<Buffer|null> {
        return this.lastFrame;
    }

    async cameraPing() {
        let client = this.client;
        let formats = await client.getStreamFormats();
        console.log(formats);

        client.setStreamFormat(10, formats[0]);
    }
}

wsClass.HostServer(7060, new Receiver());


function clock() {
    var time = process.hrtime();
    return time[0]*1000 + time[1] / 1000 / 1000;
}

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