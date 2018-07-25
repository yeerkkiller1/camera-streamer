import { execSync } from "child_process";
import { makeProcessSingle } from "../util/singleton";

console.log("senderWrap");

makeProcessSingle("senderWrap");

// sender.js kills previous sender.js, which means the previous start bach ssh command will close,
//  as the previous command will have finished. So... that's convenient
execSync(`ssh pi@192.168.0.205 "node ./sender.js"`, { stdio: "inherit" });