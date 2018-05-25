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

let rollingFrameCount = 30;
let rollingFrames = [];
function addFrameTime() {
    
    rollingFrames.push(performance.now());
    if(rollingFrames.length > rollingFrameCount) {
        rollingFrames.shift();
        let FPmS = rollingFrameCount / (rollingFrames[rollingFrameCount - 1] - rollingFrames[0]);
        console.log("FPS", (FPmS * 1000).toFixed(3));
    }
}

cam.start();
cam.capture(function onCapture(success) {    
    var frame = cam.frameRaw();
    let buffer = Buffer.from(frame);
    let hash = crypto.createHash("sha256");
    hash.write(buffer);
    hash.end();
    console.log(hash.digest("base64"));
  
    addFrameTime();
    cam.capture(onCapture);
});

setInterval(() => {
    console.log("keep alive");
}, 1000 * 1000);