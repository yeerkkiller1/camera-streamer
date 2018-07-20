import { readFileSync } from "fs";
import { execSync, execFileSync } from "child_process";
import { tmpdir } from "os";

function getParentId(pid: number) {
    return execSync(`ps -a | grep ${pid}`).toString().split(" ").filter(x => x)[2];
}

export function makeProcessSingle(name: string) {
    if(process.platform === "win32") {
        try {
            (() => {
                console.log(tmpdir());
                let prevPid;
                try {
                    prevPid = +readFileSync(`${tmpdir()}/${name}_pid.txt`).toString();
                } catch(e) {
                    return;
                }

                try {
                    let prevParentId = getParentId(prevPid);
                    let curParentId = getParentId(process.pid);

                    let prevPos = execFileSync("./src/deploy/window_move.exe", ["get", String(prevParentId)]).toString().slice(0, -2);
                    console.log({prevPos});

                    execFileSync("./src/deploy/window_move.exe", ["set", String(curParentId), prevPos]);
                } catch(e) {
                    console.error(e);   
                }

                execSync(`taskkill /F /pid ${prevPid}`, { stdio: "inherit" });
            })();
        } catch(e) {
            console.error(e);
        }
        execSync(`echo ${process.pid} > ${tmpdir()}/${name}_pid.txt`, { stdio: "inherit" });
    } else {
        try {
            execSync(`kill -9 $(cat ${tmpdir()}/${name}_pid.txt)`, { stdio: "inherit" });
        } catch(e) {
            console.log("error", e);
        }
        execSync(`echo ${process.pid} > ${tmpdir()}/${name}_pid.txt`, { stdio: "inherit" });
    }
}