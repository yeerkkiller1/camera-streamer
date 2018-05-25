var v4l2camera = require("v4l2camera");

var cam = new v4l2camera.Camera("/dev/video0");
let format = cam.formats.filter(x => x.formatName === "MJPG")[0];
console.log(format);
cam.configSet(format);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}
cam.start();
cam.capture(function (success) {
  var frame = cam.frameRaw();
  let buffer = Buffer.from(frame);
  require("fs").createWriteStream("result.jpg").end(buffer);
  cam.stop();
});