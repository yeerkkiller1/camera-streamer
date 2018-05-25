var v4l2camera = require("v4l2camera");
var crypto = require('crypto');
var fs = require("fs");

var cam = new v4l2camera.Camera("/dev/video0");
console.log(cam.formats);
let format = cam.formats.filter(x => x.formatName === "MJPG")[0];
//format = cam.formats[cam.formats.length - 1];
console.log(format);
cam.configSet(format);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}

function clock() {
    var time = process.hrtime();
    return time[0]*1000 + time[1] / 1000 / 1000;
}

let rollingFrameCount = 30;
let rollingFrames = [];
function addFrameTime() {
    
    rollingFrames.push(clock());
    if(rollingFrames.length > rollingFrameCount) {
        rollingFrames.shift();
        let FPmS = rollingFrameCount / (rollingFrames[rollingFrameCount - 1] - rollingFrames[0]);
        //console.log("FPS", .toFixed(3));
        return (FPmS * 1000);
    }
    return 0;
}

var max = 0;

let lastDigest = "";

let i = 0;

let targetFrameTime = 1000 * format.interval.numerator / format.interval.denominator;
// Okay... so, sometimes the camera dynamically changes the frame rate.

cam.start();

let capturePending = null;
setInterval(() => {
    let curCapture = clock();
    if(capturePending) {
        if((curCapture - capturePending) > 1000) {
            console.log(`Last read didn't finish, but it is taking too long. Reading despite missing frame. CurCapture ${curCapture}, pending ${capturePending}`);
        } else {
            //console.log(`Aborting read, last read at ${capturePending} still isn't finished, and it is only  ${curCapture}`);
            return;
        }
    }
    capturePending = curCapture;
    cam.capture(function onCapture(success) {
        if(curCapture !== capturePending) {
            capturePending = null;
            console.warn(`Got unexpected capture, ignoring`);
            return;
        }
        capturePending = null;
        //console.log(`Finished ${curCapture}`);
        
        /*
        if(max ++> 100) {
            cam.stop();
            return;
        }
        */
        var frame = cam.frameRaw();
        let buffer = Buffer.from(frame);

        let fps = addFrameTime();

        let hash = crypto.createHash("sha256");
        hash.update(buffer);
        let digest = hash.digest("base64");
        if(digest === lastDigest) {
            console.log(`repeated frame ${i}, fps ${fps}, ${digest}`);
        }
        lastDigest = digest;

        if(i % 1000 < 60) {
            console.log(`Writing ${i}, fps ${fps.toFixed(3)}`);
            let count = i % 1000;
            fs.writeFileSync(`./result${count}.jpg`, buffer);
        } else {
            console.log(`Frame ${i}, fps ${fps.toFixed(3)}`);
        }

        //todonext
        // Setup websocket server, and stream this image. Hmm... also, maybe timestamp the image?
        // But then, we have to decide how to do fps. It looks like our camera fps is wrong, and we can poll it faster than 31 fps
        //  (and get a)

        i++;

        //cam.capture(onCapture);
    });
}, targetFrameTime);

setInterval(() => {
    console.log("keep alive");
}, 1000 * 1000);