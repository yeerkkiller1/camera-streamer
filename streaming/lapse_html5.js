const fs = require("fs");
const child_process = require("child_process");

const speeds = [1, 64, 64 * 64];

// TODO: Start ffmpeg downloader, and add a watchdog to it.

transcodeFinishedFiles();

nextRun();
function nextRun() {
    try {
        transcodeFinishedFiles();
    } catch(e) {
        console.error(e);
    }
    setTimeout(nextRun, 10000);
}

function getFinishedFiles() {
    let files = fs.readdirSync("./raw/").filter(x => x.startsWith("video") && x.endsWith(".mp4"));
    let filesStats = files.map(file => {
        let stats = fs.statSync("./raw/" + file);
        console.log(file, stats.mtimeMs);
        return {file, stats};
    });

    let maxMTime = filesStats.reduce((m, x) => Math.max(x.stats.mtimeMs, m), 0);

    let finishedFiles = filesStats.filter(x => x.stats.mtimeMs < maxMTime);

    finishedFiles.sort((a, b) => {
        return a.stats.mtimeMs - b.stats.mtimeMs;
    });

    return finishedFiles;
}

function transcodeFinishedFiles() {
    let finishedFiles = getFinishedFiles();
    for(let finishedFile of finishedFiles) {
        let fileName = finishedFile.file;
        let stats = finishedFile.stats;

        // Eh... we can use the filetime, as seconds are accurate enough. And then assume we are in the same timezone as it.

        // video%Y-%m-%d_%H-%M-%S_%d.mp4
        let matches = /video(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_\d+.mp4/g.exec(fileName);
        if(!matches) {
            console.error(`Could not parse filename ${fileName}`);
            continue;
        }
        let date = new Date(matches[1] + " " + matches[2].replace(/-/g, ":"));
        let utcTimeStamp = +date;

        try {
            retry(() => transcodeFile(fileName, utcTimeStamp));
        } catch(e) {
            debugger;
            if(!fs.existsSync("./failed")) {
                fs.mkdirSync("./failed");
            }

            fs.renameSync(`./raw/${fileName}`, `./failed/${fileName}`);

            throw e;
        }
    }
}

function retry(code) {
    try {
        code();
    } catch(e) {
        code();
    }
}

function getBucketName(timeStamp) {
    // (3am some time in the past. Ignore daylight savings, as splitting between days doesn't have to be exact)
    let exampleDaySwitchTime = 946713600000;

    let bucketSize = 1000 * 60 * 60 * 24;

    let bucketNumber = ~~((timeStamp - exampleDaySwitchTime) / bucketSize);

    let bucketStart = exampleDaySwitchTime + bucketNumber * bucketSize;

    let bucketDate = new Date(bucketStart);

    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

    let d = bucketDate;
    return `bucket_${d.getFullYear()}_${months[d.getMonth()]}_${d.getDate()}_${days[d.getDay() - 1]}_${+d}`.toLowerCase();
}

function transcodeFile(fileName, utcTimeStamp) {
    let filePath = `./raw/${fileName}`;
    console.log(`Starting transcode of ${filePath}`);
    let destDirectory = "./processed/";
    let archiveDirectory = "./archive/";

    function addToDigest(obj) {
        fs.appendFileSync(destDirectory + "digest.txt", JSON.stringify(obj) + "\n");
    }

    if(!fs.existsSync(archiveDirectory)) {
        fs.mkdirSync(archiveDirectory);
    }

    if(!fs.existsSync(destDirectory)) {
        fs.mkdirSync(destDirectory);
    }

    // Figure out the destination
    let bucketName = getBucketName(utcTimeStamp);

    let subDestDirectory = destDirectory + bucketName + "/";
    if(!fs.existsSync(subDestDirectory)) {
        addToDigest({bucketName, firstVideoStartTimeStamp: utcTimeStamp});
        fs.mkdirSync(subDestDirectory);
    }
    destDirectory = subDestDirectory;

    // Add the fact that we are going to try to add this file to a digest file
    addToDigest({event: "startEncode", filePath: filePath});

    // We want to make intermediate files for each speed
    for(let speed of speeds) {
        let destPath = `./raw/x${speed}.mp4`;
        
        // Always transcode, as we might need to change the fps, or whatever

        console.log(`Starting transcode at speed ${speed}`);
        let time = +new Date();
        child_process.execFileSync("ffmpeg", [`-y`, `-i`, `${filePath}`, `-filter:v`, `setpts=PTS/${speed}`, `-r`, `40`, `-b:v`, `1M`, `-c`, `libx264`, destPath]);
        console.log(`Finished transcode at speed ${speed}, took ${+new Date() - time}ms`);
    }

    // Add to full video
    for(let speed of speeds) {
        let curFileChunk = `./raw/x${speed}.mp4`;
        let fullVideoPath = destDirectory + `x${speed}.mp4`; 

        // If it doesn't exist, we are now the full file.
        if(!fs.existsSync(fullVideoPath)) {
            fs.renameSync(curFileChunk, fullVideoPath);
            continue;
        }

        function abs(filename) {
            return "../" + filename.slice(1);
        }

        fs.writeFileSync("./raw/files.txt", `file ${abs(fullVideoPath)}\nfile ${abs(curFileChunk)}`);

        const tempDest = `./raw/tempx${speed}.mp4`;

        console.log(`Starting concat at speed ${speed}`);
        let time = +new Date();
        // Eh... as the factor increases don't fall upon frame boundaries either we lose or gain time every time we concat.
        //  And we can't do it right unless we get rid of the rolling concat, which would be slow, and might not even fix it.
        child_process.execFileSync("ffmpeg", [`-y`, `-f`, `concat`, `-safe`, `0`, `-i`, `./raw/files.txt`, `-c`, `copy`, tempDest]);
        console.log(`Finished concat at speed ${speed}, took ${+new Date() - time}ms`);

        retry(() => fs.unlinkSync(`./raw/files.txt`));

        fs.renameSync(tempDest, fullVideoPath);
    }

    // Clean up old files, and then move raw file into the archive directory
    for(let speed of speeds) {
        let file = `./raw/x${speed}.mp4`;
        if(fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }

    let rawFormatText = child_process.execFileSync("ffprobe", [`-i`, filePath, `-show_format`, `-show_streams`]).toString();
    rawFormatText = rawFormatText.replace(/\r\n/g, "\n");
    rawFormatText = rawFormatText.replace(/\r/g, "\n");

    function getText(startText, endText) {
        let startIndex = rawFormatText.indexOf(startText);
        if(startIndex < 0) {
            throw new Error(`Invalid result from ffprobe. Could not find ${startText} in ${rawFormatText}`);
        }
        startIndex += startText.length;

        let endIndex = rawFormatText.indexOf(endText);
        if(endIndex < 0) {
            throw new Error(`Invalid result from ffprobe. Could not find ${endText} in ${rawFormatText}`);
        }

        return rawFormatText.slice(startIndex, endIndex);
    }

    let streamText = getText("[STREAM]\n", "\n[/STREAM]");
    let formatText = getText("[FORMAT]\n", "\n[/FORMAT]");

    function formatLinesAsObj(text) {
        let lines = text.split("\n");
        let obj = {};
        for(let line of lines) {
            let equalIndex = line.indexOf("=");
            let key = line.slice(0, equalIndex);
            let value = line.slice(equalIndex + 1);
            obj[key] = value;
        }
        return obj;
    }

    let streamInfo = formatLinesAsObj(streamText);
    let formatInfo = formatLinesAsObj(formatText);

    fs.renameSync(filePath, `./archive/${fileName}`);

    addToDigest({event: "encoded", filePath, utcTimeStamp, speeds, streamInfo, formatInfo});

    console.log(`Finished transcode of ${filePath}`);
}