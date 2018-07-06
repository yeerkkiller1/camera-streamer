import * as wsClass from "ws-class";



// Okay... there is a solution for low bit rates. We CAN encode at a 5 to 1 ratio at a rate of about 230KB/s in. So for very slow
//  connections encoding first is viable. So if the connection maximum drops below 230KB/s, encoding is worth it. But... if the
//  connection is around 20KB/s, nothing is really worth it, because that is really really bad.
// But... that is so niche, so screw it, let's just but ethernet cables and wire it in.

//todonext
// First we want to determine the characteristics of the network. Does sending a lot of data overload it?
// UDP packets? Support dynamic and fixed rates? I guess we can verify dynamic rate works by
//  setting a fixed rate, and seeing if it changes the loss rate? Or latency by a lot?
// It needs to be push, because the camera will be inside the network.

// Hmm... UDP let's us detect packet loss... at least retroactively, which is nice....
//  But really... what is wrong with our network? Is there high packet loss

class Receiver implements IReceiver {
    client!: ISender;

    acceptFrame(frame: {
        buffer: Buffer;
        format: v4l2camera.Format;
        eventTime: number;
    }): void {
        todonext
        // Dynamically set stream format (only fps), to keep the frames from getting behind (because the connection is overwhelmed.)
        console.log(`Recieved frame ${frame.buffer.length}`);
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