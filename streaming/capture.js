var v4l2camera = require("v4l2camera");
var crypto = require('crypto');

var cam = new v4l2camera.Camera("/dev/video0");
let format = cam.formats.filter(x => x.formatName === "MJPG")[0];
format = cam.formats[cam.formats.length - 1];
//console.log(cam.formats);
cam.configSet(format);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}

function clock() {
    var time = process.hrtime();
    return time[0]*1000 + time[1]/1000000;
}

let rollingFrameCount = 30;
let rollingFrames = [];
function addFrameTime() {
    
    rollingFrames.push(clock());
    if(rollingFrames.length > rollingFrameCount) {
        rollingFrames.shift();
        let FPmS = rollingFrameCount / (rollingFrames[rollingFrameCount - 1] - rollingFrames[0]);
        //console.log("FPS", (FPmS * 1000).toFixed(3));
    }
}

let lastDigest = "";
let firstChars = 5;
let lastChars = 10;

cam.start();
cam.capture(function onCapture(success) {    
    var frame = cam.frameRaw();
    let buffer = Buffer.from(frame);
    let hash = crypto.createHash("sha256");
    hash.write(buffer);
    hash.end();
    let digest = hash.digest("base64");
    lastDigest = lastDigest || digest;

    let startPart = lastDigest.slice(0, firstChars);
    let endPart = lastDigest.slice(-lastChars);
    let mutableDigestPart = digest.slice(firstChars, -lastChars);

    if(!digest.startsWith(startPart)) {
        console.log("start changed");
        console.log(digest, mutableDigestPart);
        lastDigest = digest;
    }

    if(!digest.endsWith(endPart)) {
        console.log("end changed");
        console.log(digest);
        lastDigest = digest;
    }
    
  
    addFrameTime();
    cam.capture(onCapture);
});

setInterval(() => {
    console.log("keep alive");
}, 1000 * 1000);