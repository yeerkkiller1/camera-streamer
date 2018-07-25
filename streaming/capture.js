var v4l2camera = require("v4l2camera");
var fs = require("fs");
var crypto = require('crypto');

function clock() {
    var time = process.hrtime();
    return time[0]*1000 + time[1] / 1000 / 1000;
}

//import * as ws from "ws";

//var ws = require("ws");

//var websocket = new ws();

//*
var cam = new v4l2camera.Camera("/dev/video0");
console.log(cam.formats);
var format = cam.formats.filter(x => x.formatName === "MJPG")[0];
format = cam.formats[cam.formats.length - 1];
console.log(format);
cam.configSet(format);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}



var rollingFrameCount = 5;
var rollingFrames = [];
function addFrameTime() {
    
    rollingFrames.push(clock());
    if(rollingFrames.length > rollingFrameCount) {
        rollingFrames.shift();
        var FPmS = (rollingFrameCount - 1) / (rollingFrames[rollingFrameCount - 1] - rollingFrames[0]);
        //console.log("FPS", .toFixed(3));
        return (FPmS * 1000);
    }
    return 0;
}

var max = 0;

var lastDigest = "";

var i = 0;

var targetFrameTime = 1000 * format.interval.numerator / format.interval.denominator;
targetFrameTime = 0;
// Okay... so, sometimes the camera dynamically changes the frame rate.

console.log({targetFrameTime});

cam.start();

var capturePending = null;
setInterval(() => {
    var curCapture = Date.now();
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
        
        var frame = cam.frameRaw();
        var buffer = Buffer.from(frame);

        var fps = addFrameTime();

        var hash = crypto.createHash("sha256");
        hash.update(buffer);
        var digest = hash.digest("base64");
        if(digest === lastDigest) {
            console.log(`repeated frame ${i}, fps ${fps}, ${digest}`);
        }
        lastDigest = digest;

        if(i % 1000 < 60) {
            console.log(`Writing ${i}, fps ${fps.toFixed(3)}`);
            var count = i % 1000;
            fs.writeFileSync(`./result${count}.jpeg`, buffer);
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
//*/