var v4l2camera = require("v4l2camera");
var crypto = require('crypto');
var fs = require("fs");

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
        console.log("FPS", (FPmS * 1000).toFixed(3));
    }
}

var max = 0;

let lastDigest = "";

cam.start();
cam.capture(function onCapture(success) {    
    /*
    if(max ++> 100) {
        cam.stop();
        return;
    }
    */
    var frame = cam.frameRaw();
    let buffer = Buffer.from(frame);

    crypto.createHash("sha256");
    hash.write(buffer);
    hash.end();
    let digest = hash.digest("base64");
    if(digest === lastDigest) {
        console.log("repeated frame");
    }
    lastDigest = digest;

    //todonext
    // Setup websocket server, and stream this image. Hmm... also, maybe timestamp the image?
    // But then, we have to decide how to do fps. It looks like our camera fps is wrong, and we can poll it faster than 31 fps
    //  (and get a)

    //fs.writeFileSync("./result.jpg", buffer);
    //addFrameTime();
    cam.capture(onCapture);
});

setInterval(() => {
    console.log("keep alive");
}, 1000 * 1000);