var v4l2camera = require("v4l2camera");

var cam = new v4l2camera.Camera("/dev/video0");
cam.configSet(cam.formats.filter(x => x.formatName === "MJPG")[0]);
if (cam.configGet().formatName !== "MJPG") {
  console.log("NOTICE: MJPG camera required");
  process.exit(1);
}
cam.start();
cam.capture(function (success) {
  var frame = cam.frameRaw();
  require("fs").createWriteStream("result.jpg").end(new Buffer(frame));
  cam.stop();
});