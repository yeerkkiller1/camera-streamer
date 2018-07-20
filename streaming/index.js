var child_process = require("child_process");

child_process.execFileSync("bash", ["./src/deploy/test.sh"], { stdio: "inherit" });