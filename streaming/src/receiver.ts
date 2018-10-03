import * as wsClass from "ws-class";

import { PChan, pchan, TransformChannel, TransformChannelAsync, Deferred, g } from "pchannel";

import { mkdir, writeFile, writeFileSync, readFileSync } from "fs";

import { clock, TimeServer, setTimeServer } from "./util/time";
import { randomUID } from "./util/rand";

// For polyfills
import "./util/math";
import { keyBy, mapObjectValues, profile } from "./util/misc";
import { binarySearchMap, findAtOrBefore, findAtOrBeforeOrAfter, findAt, findAfterIndex, findAtIndex, sort } from "./util/algorithms";
import { sum } from "./util/math";
import { GetRangeFPSEstimate, RoundRecordTime } from "./NALStorage/TimeMap";
import { GetMP4NALs, ParseNalInfo } from "mp4-typescript";
import { Downsampler, DownsampledInstance } from "./NALStorage/Downsampler";
import { createServer } from "http";
import { readFilePromise, mkdirPromise, writeFilePromise } from "./util/fs";
import { CreateTempFolderPath } from "temp-folder";
import { exec } from "child_process";
import { parseParams } from "./util/url";
import { SizedCache } from "./Video/SizedCache";
import { NALStorageManagerImpl } from "./NALStorage/RemoteStorage/StorageCombined";
import { LocalRemoteStorage } from "./NALStorage/LocalNALRate";
import { DiskStorageBase } from "./NALStorage/RemoteStorage/DiskStorageBase";
import { newPromise } from "./util/promise";

//makeProcessSingle("receiver");

/*
pi setup code:
// Looks like there is no frame reordering... so this will work! And I think if we assume no reordering, certain
//  pps, pps, and frame orders and rates (and we specify the rate with periodicty-idr), we don't need any mp4-typescript parsing
//  in the main streamer/receiver code (besides start code checking, which is probably all [0,0,0,1] anyway) (so it will be fast).
//  /etc/ssh/sshd_config, PasswordAuthentication no
//  cat >> ~/.ssh/authorized_keys (put public key here)
//  2017-11-29-raspbian-stretch.img
//  gst-launch-1.0 version 1.10.4
//  GStreamer 1.10.4
//  http://packages.qa.debian.org/gstreamer1.0
// sudo apt install gstreamer-1.0
// sudo apt install gstreamer1.0-tools
// sudo apt-get install libav-tools
// gst-inspect-1.0 avenc_h264_omx


// gst-inspect-1.0 omxh264enc
// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable periodicty-idr=10 ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

// time gst-launch-1.0 -vv -e v4l2src device=/dev/video0 num-buffers=90 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"

// time gst-launch-1.0 -vv -e multifilesrc location="frame%d.jpeg" ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=15000000 control-rate=variable ! video/x-h264, profile=high ! filesink location="test.mp4"
*/



async function getFinalStorageFolder() {
    let finalStorageFolder = "./dist/videos/";
    try {
        await mkdirPromise(finalStorageFolder);
    } catch(e) { }
    return finalStorageFolder;
}

//let info = GetInfo(process.pid);
/*
(async () => {
    console.log("before");
    await info;
    console.log("after");
})();
//*/
/*
(async () => {
    let ps = new shell({ debugMsg: false });
    ps.addCommand(`get-process -Id ${process.pid} | Select-Object -Property Name,Id,PriorityClass,FileVersion,HandleCount,WorkingSet,PagedMemorySize,PrivateMemorySize,VirtualMemorySize,TotalProcessorTime,SI,Handles,VM,WS,PM,NPM,Path,Company,CPU,ProductVersion,Description,Product,__NounName,BasePriority,ExitCode,HasExited,ExitTime,Handle,MachineName,MainWindowHandle,MainWindowTitle,MaxWorkingSet,MinWorkingSet,NonpagedSystemMemorySize,NonpagedSystemMemorySize64,PagedMemorySize64,PagedSystemMemorySize,PagedSystemMemorySize64,PeakPagedMemorySize,PeakPagedMemorySize64,PeakWorkingSet,PeakWorkingSet64,PeakVirtualMemorySize,PeakVirtualMemorySize64,PriorityBoostEnabled,PrivateMemorySize64,PrivilegedProcessorTime,ProcessName,ProcessorAffinity,Responding,SessionId,StartTime,SynchronizingObject,UserProcessorTime,VirtualMemorySize64,EnableRaisingEvents,StandardInput,StandardOutput,StandardError,WorkingSet64,Site,Container | ConvertTo-Json`);
    //ps.addCommand(`sleep(10)`);
    console.log("before");
    
    (async () => {
        //let indexContents = await readFilePromise(`C:/Users/quent/Dropbox/camera/streaming/dist/1x.index`);

        console.log("start blocking loop");
        let x = 1;
        for(let i = 0; i < 1000 * 1000 * 1000 * 4; i++) {
            x = x * 31 + 5;
        }
        console.log("end blocking loop");
    })();
    await ps.invoke();
    console.log("after");
})();
//*/

//todonext
// - Make LocalRemoteStorage that gives S3 simulated MaxGB and CostPerGBDownload functions, and use it to simulate what we planning on using in S3
// - Setup actual S3

// Let's dual store in wasabi and backblaze, and not bother with S3, as request costs get absurb in S3.

//todonext
// Crap... we may need to split chunks. High rate storage is running into problems with exceeding its budget and
//  not being able to store the minimum number of chunks. But then again... there is a absolute minimum, and
//  at most we can split chunks down to the iframe rate, and then we can't store it. And if a storage system
//  can only store 2 frames of data, it isn't really useful.
//  - BUT, the problem isn't really that, it's that we might want to use larger chunks to reduce uploader request rates,
//      but then split the large chunks for high rates, as even after splitting high rates won't cause high uploader request rates.
//  - ALSO, if chunks are too small, the metadata for them will be too large and we will run out of memory on the server.

// Should be small, to reduce seek times, as we can only load a chunk at a time.
const secondPerRate1Chunk = 2;
// Eh... more than the real cost, because localStorage is digital ocean so sort of free.
const totalCostPerMonth = 20;
const averageFrameBytes = 1024 * 10;
const framesPerSecond = 10;
const baseRate = 4;

let maxTotalDiskUsage = 1024 * 1024 * 160;
//maxTotalDiskUsage = 1024 * 1024 * 160;

let localStorage = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, totalCostPerMonth, maxTotalDiskUsage);

const secondsPerMonth = 60 * 60 * 24 * 30;

let s3Standard = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, 0, 0, "./dist/s3standard/", {
    debugName: "s3_standard",
    maxGB(bytesPerSecond: number, secondPerChunk: number, maxCost: number) {
        // No duration restrictions

        let costPerGBPerMonth = 0.023;

        // PUT request
        let costPerUploadRequest = 0.005 / 1000;

        let requestCostPerMonth = secondsPerMonth / secondPerChunk * costPerUploadRequest;

        return (maxCost - requestCostPerMonth) / costPerGBPerMonth;
    },
    costPerGB(bytes: number) {
        // Get request
        let requestCost = 0.0004 / 1000;
        // Data returned by S3 select. Is this what we shoudl use?
        let costPerGBDownload = 0.0007;
        return costPerGBDownload * bytes / 1024 / 1024 / 1024 + requestCost;
    },
});

let s3Infrequent = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, 0, 0, "./dist/s3infrequent/", {
    debugName: "s3_infrequent",
    maxGB(bytesPerSecond: number, secondPerChunk: number, maxCost: number) {
        // No duration restrictions
        
        let costPerGBPerMonth = 0.0125;

        // PUT request
        let costPerUploadRequest = 0.01 / 1000;

        let requestCostPerMonth = secondsPerMonth / secondPerChunk * costPerUploadRequest;

        return (maxCost - requestCostPerMonth) / costPerGBPerMonth;
    },
    costPerGB(bytes: number) {
        let requestCost = 0.001 / 1000;
        let costPerGBDownload = 0.01;
        return costPerGBDownload * bytes / 1024 / 1024 / 1024 + requestCost;
    },
});

// Expedited. Anything else takes too long to request the data, which could be worth it for reduces fees, but...
//  if we can store in backblaze for just a little more with no restrictions and much cheaper fees, or
//  other S3 alternatives, then anything other than expedited is not worth it.
let s3Glacier = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, 0, 0, "./dist/s3glacier/", {
    debugName: "s3_glacier",
    maxGB(bytesPerSecond: number, secondPerChunk: number, maxCost: number) {
       
        let costPerGBPerMonth = 0.004;

        // Transition request cost?
        let costPerUploadRequest = 0.05 / 1000;

        let requestCostPerMonth = secondsPerMonth / secondPerChunk * costPerUploadRequest;

        let maxGB = (maxCost - requestCostPerMonth) / costPerGBPerMonth;
        
        // Duration restrictions of 90 days
        let minGB = bytesPerSecond * secondsPerMonth / 1024 / 1024 / 1024;
        if(maxGB < minGB) {
            return 0;
        }

        return maxGB;
    },
    costPerGB(bytes: number) {
        let requestCost = 0.001;
        let costPerGBDownload = 0.03;
        return costPerGBDownload * bytes / 1024 / 1024 / 1024 + requestCost;
    },
});


let wasabi = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, 0, 0, "./dist/wasabi/", {
    debugName: "wasabi",
    maxGB(bytesPerSecond: number, secondPerChunk: number, maxCost: number) {
        let costPerGBPerMonth = 0.0049;
        let maxGB = maxCost / costPerGBPerMonth;
        return maxGB;
    },
    costPerGB(bytes: number) {
        // This doesn't seem like a sustainable business practice
        return 0;
    },
});

let backblaze = (rate: number) => new LocalRemoteStorage(new DiskStorageBase(), rate, 0, 0, "./dist/backblaze/", {
    debugName: "backblaze",
    maxGB(bytesPerSecond: number, secondPerChunk: number, maxCost: number) {       
        let costPerGBPerMonth = 0.005;
        let maxGB = maxCost * costPerGBPerMonth;
        return maxGB;
    },
    costPerGB(bytes: number) {
        let costPerGB
        // This doesn't seem like a sustainable business practice
        return 0;
    },
});

let nalManager = new NALStorageManagerImpl({
    storageSystemsCtors: [
        localStorage,
        backblaze,
        //wasabi,
        //s3Standard,
        //s3Infrequent,
        //s3Glacier
    ],
    maxCostPerMonthStorage: totalCostPerMonth,
    averageFrameBytes,
    framesPerSecond,
    baseRate,
    secondPerRate1Chunk,
});


/*
(async () => {
    let nalManager = await nalManagerPromise;

    console.log("start");

    let startTime = +new Date(2018, 7, 10);
    let nalRanges = nalManager.GetNALRanges(1);
    if(nalRanges.length > 0) {
        let fps = GetRangeFPSEstimate(nalRanges.last());
        startTime = nalRanges.last().lastTime + 1000 / fps;
    }

    // Import video from disk
    let paths = [
        //"C:/Users/quent/Downloads/Norsk SlowTV Hurtigruten Minutt for Minutt BowCam Part 01 of 35 Bergen til Florø_all_key_frames.mp4",
        //"C:/Users/quent/Downloads/Norsk SlowTV Hurtigruten Minutt for Minutt BowCam Part 09 of 35 Kristiansund til Trondheim_all_key_frames.mp4",
        //"C:/Users/quent/Downloads/Norsk SlowTV Hurtigruten Minutt for Minutt BowCam Part 10 of 35 Trondheim til Rørvik_all_key_frames.mp4"
        //"C:/Users/quent/Downloads/Fog Fjord Key Door Skip Dead Cells.mp4"
    ];

    for(let path of paths) {
        console.log(`Start ${path}`);
        let nals = GetMP4NALs(path);

        console.log(`after nals ${path}`);

        for(let nal of nals) {
            nal.time = startTime + nal.time;
        }
        //ParseNalHeaderByte
        //nalsObj.timescale
        //nalsObj.nals

        type NAL = typeof nals[0];
        class NALAdder implements DownsampledInstance<NAL> {
            constructor(public Rate: number) { }
            public AddValue(nal: NAL): void {
                nalManager.AddNAL({
                    rate: this.Rate,

                    width: nal.width,
                    height: nal.height,

                    time: nal.time,
                    type: nal.isKeyFrame ? NALType.NALType_keyframe : NALType.NALType_interframe,
                    sps: nal.sps,
                    pps: nal.pps,


                    nal: nal.nal
                });
            }
        }

        let downsampler = new Downsampler(4, NALAdder, 0);
        for(let nal of nals) {
            downsampler.AddValue(nal);
        }
        console.log(`Wrote all nals.`);

        console.log(`Finished ${path}`);
    }
})();
//*/




// We store nal units (1 nal = 1 Buffer form, sps and pps easily available per buffer, with info on slice type),
//  and then dynamically mux depending on what the client requests.

// 200KB/s source, looking like 40KB per frame.

// Storage size
//  rate = 1, count = size / 2 / rate per nal
//  rate = 4, count = prev_count * 2
// This fills up the size, and is easily maintainable by making every frame buffer be a rolling buffer
//  (or really we should just delete old videos).
// We should have segments stored remotely, and some stored locally.
// There should be a local sql lite server for keeping track of segments stored remotely
// We should write locally in a rolling buffer, keep track of what we have in memory, and then read
//  back local files on boot.
// Locally we should write nal lookups in two files, one for nals, one for nal times.
// Remotely every file should have the lookup as a file prefix.
//  Lookup should be a list of nal times and byte locations.


// 5.7 days at 200KB/s (100GB) from glacier (or infrequent access) costs about $3 for 1-5 minutes access time,
//  $1 for 3-5 hours to access, and $0.25 for 5-12 hours to access.

// Expedited retrievals cost $0.03 per GB and $0.01 per request. Standard retrievals cost $0.01 per GB and $0.05 per
//  1,000 requests. Bulk retrievals cost $0.0025 per GB and $0.025 per 1,000 requests.

// Okay, so... we probably want data older than a month to require explicitly requesting a time period and rate, saying expedited or not
//  and then getting a notification when it finishes transferring the data to regular S3 (or just the digital ocean server?)

// 1 hour at 60fps is 216000, at 40KB per frame that is around 8GB

// Use cases.
//  - Living streaming. Likely going to be on 24/7, and should forcefully not use S3, as going to S3 or back will cost a lot of money.
//  - Watching historical video. Always at 60fps (if the data is avilable), because if the user is watching it, they will see all the frames.
//      - There will probably be 3 tiers of video. Super high rate, high rate, and then realtime, but I'm not sure the rates of these.


/*
Data Returned by S3 Select	$0.0007 per GB
Data Scanned by S3 Select	$0.002 per GB
PUT, COPY, POST, or LIST Requests	$0.005 per 1,000 requests
GET, SELECT and all other Requests	$0.0004 per 1,000 requests
Lifecycle Transition Requests into Standard – Infrequent Access or One Zone - Infrequent Access	$0.01 per 1,000 requests
*/

/*
S3 Standard Storage
First 50 TB / Month	$0.023 per GB
Next 450 TB / Month	$0.022 per GB
Over 500 TB / Month	$0.021 per GB

$5 digital ocean instance has a 25GB HDD, and 25GB S3 standard would cost $0.115 per month.

S3 Standard-Infrequent Access (S3 Standard-IA) Storage
All storage	$0.0125 per GB

S3 One Zone-Infrequent Access (S3 One Zone-IA) Storage
All storage	$0.01 per GB

Amazon Glacier Storage
All storage	$0.004 per GB
*/

// Storage sources, with ranges of NALs and the sample rates of them. Random access 

// The server needs to remux, because we don't want to send the client weird videos.
//  This means usually the server should stream video the client at the exact fps and speed the client
//  wants it. If the client changes the speed and then seeks, the client can just change the fps to get it
//  to work (via video.playbackRate), or just request all new video. The server will always be muxing
//  on demand, so for new video you should always request the speed you want, as it should take the server
//  no effort to switch the video rate (it should literally just require changing 1 variable).

// TODO: Allow live streaming on the local network, at variable (max) fps.
// TODO: Store the last 10GB or so on the camera, to allow viewing of short term video at a high fps.
// TODO: We actually want to be able to turn up the live fps dynamically, so we can have good video
//  for a short period of time (but not too long, or our internet will start to get throttled, and we'll use
//  5TB a month, at only 10fps).

// Parts:
//  NAL acceptor
//      - stores nals
//      - creates emitters which read from it's storage
//  NAL emitter
//  NAL muxers
//      - takers emitter, and muxers it to a client

// There should probably be a "get single live jpeg image" test function, so you can see the quality
//  degradation from encoding, and the maximum theoretical video quality.



// S3
//  Has to have SQL lite server to keep track of what S3 objects exist
//  Has to have a local disk buffer when buffer isn't large enough to put in S3

// One per video rate?
interface NALStorage {
    AcceptNAL(nal: NALHolder): void;
    
    // We need to be able to query to find what data exists.
    //  There will be chunks that are immutable.
    //  But also some data that is constantly changing in size.

    // Maybe, a constant number of ranges, with the possibility of time being "live", and ranges have the possibility of
    //  having a flag holes=true.

    
}

const RateMultiplier = 4;

class Receiver extends TimeServer implements IReceiver, IHost {
    // Eh... might as well use &, because we can't narrow the type anyway, as this property
    //  will be a proxy, and I haven't implemented the in operator yet!
    client!: ISender&IBrowserReceiver&ConnExtraProperties;


    cameraClient = new Deferred<ISender>();

    /*
    x = (() => {
        setInterval(async () => {
            testAddRanges(await this.nalManager, RateMultiplier);
        }, 1000 * 1);
    })();
    //*/

    public async getFormats(): Promise<v4l2camera.Format[]> {
        let client = await this.cameraClient.Promise();
        let formats = await client.getStreamFormats();
        return formats.filter(x => x.formatName === "MJPG");
    }
    public async setFormat(
        fps: number,
        /** Frequency of i frames. */
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format
    ): Promise<void> {
        let curFormatId = randomUID("format");
        await (await this.cameraClient.Promise()).setStreamFormat(fps, iFrameRate, bitRateMBPS, format, curFormatId, RateMultiplier);
    }

    public async SyncRates(): Promise<number[]> {
        let client = this.client;
        return nalManager.SyncRates(newRate => {
            client.onNewRate(newRate);
        });
    }

    public async GetNextAddSeqNum(): Promise<number> {
        return nalManager.GetNextAddSeqNum();
    }

    syncRateUnsubs: {
        client: Receiver["client"];
        rate: number;
        unsub: () => void;
    }[] = [];
    public async syncTimeRanges(rate: number): Promise<NALRange[]> {
        let client = this.client;
        let manager = await nalManager.GetStorage(rate);

        for(let i = this.syncRateUnsubs.length - 1; i >= 0; i--) {
            let unsubObj = this.syncRateUnsubs[i];
            if(unsubObj.client === client && unsubObj.rate === rate) {
                unsubObj.unsub();
                this.syncRateUnsubs.splice(i, 1);
            }
        }

        let unsub = manager.SubscribeToRanges(ranges => {
            client.acceptNewTimeRanges_VOID(
                rate,
                ranges
            );
        },
        deleteTime => {
            client.onDeleteTime(rate, deleteTime);
        });

        this.syncRateUnsubs.push({
            client,
            rate,
            unsub
        });

        return manager.GetRanges();
    }

    private pendingGetVideoCalls: {
        client: Receiver["client"];
        cancelTokens: Deferred<void>[];
        onCallComplete: Deferred<void>[];
    }[] = [];
    public async GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number|undefined|null|"live",
        rate: number,
        onlyTimes?: boolean|null,
        forPreview?: boolean|null
    ): Promise<MP4Video | "CANCELLED"> {
        let client = this.client;
        let cancelToken = new Deferred<void>();
        let onCallComplete = new Deferred<void>();
        let index = this.pendingGetVideoCalls.findIndex(x => x.client === client);
        if(index < 0) {
            index = this.pendingGetVideoCalls.length;
            this.pendingGetVideoCalls.push({
                client,
                cancelTokens: [],
                onCallComplete: []
            });
        }
        let obj = this.pendingGetVideoCalls[index];
        obj.cancelTokens.push(cancelToken);
        try {
            let manager = await nalManager.GetStorage(rate);

            return await manager.GetVideo(startTime, minFrames, nextReceivedFrameTime, onlyTimes, forPreview, cancelToken);
        } finally {
            onCallComplete.Resolve(undefined);
            {
                let index = obj.cancelTokens.indexOf(cancelToken);
                if(index >= 0) {
                    obj.cancelTokens.splice(index, 1);
                }
            }
            {
                let index = obj.onCallComplete.indexOf(onCallComplete);
                if(index >= 0) {
                    obj.onCallComplete.splice(index, 1);
                }
            }
        }
    }
    public async CancelVideo(): Promise<void> {
        let client = this.client;
        let index = this.pendingGetVideoCalls.findIndex(x => x.client === client);
        if(index < 0) {
            return;
        }
        let obj = this.pendingGetVideoCalls[index];
        for(let cancelToken of obj.cancelTokens) {
            cancelToken.Resolve(undefined);
        }
        for(let callComplete of obj.onCallComplete) {
            await callComplete.Promise();
        }
    }

    public async cameraPing(sourceId: string) {
        console.log("Camera connected call");
        
        let client = this.client;
        this.cameraClient.ForceResolve(client);

        let promise = client.ClosePromise;
        promise.then(() => {
            console.log("Camera closed");
        });
    }

    public acceptNAL_VOID(info: NALHolder): void {
        nalManager.AddNAL(info);
    }
}

var receiver = new Receiver();
wsClass.HostServer(7060, receiver);

//updateNals();


// Image preview stuff. Browsers are amazing at showing jpeg images from urls, so let's just do that.
//  It will save so many memory management and loading considerations, so it is really worth the slight extra initial work.

// TODO: Use the same port as the websocket server, because that is just better, and will make everything easier.
//  But... fragmenting SSL over multiple ports from the beginning would be nice, as it would make management of services a million times easier
//      (because it would require no management framework, and allow new services to popup without any additional configuration).

// http://localhost:7061/frame?rate=16384&time=1533874693325

/*
(async () => {
    console.log("k");
    (async () => {
        let time = clock();
        let x = 1;
        for(let i = 0; i < 1000 * 1000 * 1000 * 10; i++) {
            x = x * 31 + 5;
        }
        time = clock() - time;
        console.log(`Took ${time.toFixed(1)}ms`);
    })();
    let info = await GetInfo(process.pid);
    console.log("j");
    //let x = await CreateTempFolderPath();
})();
//*/

//*

let frameCache = new SizedCache<{time: number; rate: number}, Buffer>(
    1024 * 1024 * 128,
    (key, value) => value.length,
    obj => JSON.stringify(obj)
);

let server = createServer(async (request, response) => {
    let { url } = request;

    url = url || "";

    if(url.endsWith("favicon.ico")) {
        response.statusCode = 404;
        response.end("No favicon.");
        return;
    }

    let urlParams = parseParams(url.slice(url.indexOf("?") + 1));  
    let rate = +urlParams.rate;
    let time = +urlParams.time;

    let frame: Buffer;
    
    // TODO: Blocking cache, so we don't have pending requests that satisify the same thing.
    let cachedFrame = frameCache.Get({time, rate});
    if(cachedFrame) {
        frame = cachedFrame.v;
    } else {
        let manager = await nalManager.GetStorage(rate);
        let video = await manager.GetVideo(
            time,
            1,
            undefined,
            false,
            true,
            new Deferred<void>()
        );

        if(typeof video === "string") {
            response.statusCode = 404;
            response.end(`Cannot find time ${time}, ${video}`);
            return;
        }
        
        let timeIndex = findAtIndex(video.frameTimes, time, x => x.time);
        if(timeIndex < 0) {
            response.statusCode = 404;
            response.end(`Cannot find time ${time}, found times ${video.frameTimes.map(x => x.time).join(", ")}`);
            return;
        }
        
        let frames = await getFrames(video as any);
        frame = frames[timeIndex];
    }

    response.setHeader("content-type", "image/jpeg");
    response.end(frame);
});
server.listen(7061, (err: any) => {
    if(err) {
        console.error(`Could not start server on 7061, ${err}`);
        return;
    }

    console.log(`Listening on port 7061`);
});
//*/


function execPromise(command: string) {
    return newPromise<string>((resolve, reject) => {
        exec(command, (err, stdout, stderr) => {
            if(err) {
                reject(err);
                return;
            }
            if(stderr) {
                reject(stderr);
                return;
            }
            resolve(stdout);
        });
    });
}

async function getFrames(video: MP4Video): Promise<Buffer[]> {
    let times = video.frameTimes.map(x => x.time);
    let cachedValues = times.map(x => frameCache.Get({ time: x, rate: video.rate }));
    if(!cachedValues.some(x => !x)) {
        return cachedValues.map(x => x ? x.v : null as any);
    }

    let frames = await getFramesInternal(video);
    for(let i = 0; i < frames.length; i++) {
        frameCache.Add({
            time: times[i],
            rate: video.rate
        }, frames[i]);
    }

    return frames;
}

async function getFramesInternal(video: MP4Video): Promise<Buffer[]> {
    let folder = await CreateTempFolderPath();
    
    let videoPath = `${folder}${randomUID("video")}.mp4`;
    await writeFilePromise(videoPath, video.mp4Video);
    
    let imagePath = `${folder}${randomUID("image")}_%d.jpeg`;
    // Screw it, I'll just implicitly depend on ffmpeg
    let command = `ffmpeg -i ${videoPath} ${imagePath} -loglevel panic`;
    //console.log(command);
    await execPromise(command);

    let frames: Buffer[] = [];
    for(let i = 0; i < video.frameTimes.length; i++) {
        let frame = await readFilePromise(imagePath.replace(/%d/g, (i + 1).toString()));
        frames.push(frame);
    }

    return frames;
}



/*
setInterval(() => {
    console.log("alive2");
}, 60000);
*/



//todonext
/*
Get streaming data from:
    time gst-launch-1.0 -vv -e v4l2src num-buffers=10 device=/dev/video0 ! capsfilter caps="image/jpeg,width=1920,height=1080,framerate=30/1" ! jpegdec ! omxh264enc target-bitrate=17000000 control-rate=variable ! video/x-h264, profile=high ! tcpclientsink port=3000 host=192.168.0.202

https://gist.github.com/mitsuhito/ad3ae3e341726687457c

Locally, decode the NALs? and see if there is reordering. If there is, then disable that? Or maybe just order to
*/




/*
var server = net.createServer(socket => {
    var time = +new Date();

    let buffers: Buffer[] = [];

    console.log("Got client");
    socket.on("close", () => {
        console.log("Closed");

        time = +new Date() - time;

        console.log(`Took ${time}ms`);

        let fullBuffer = Buffer.concat(buffers);
        writeFileSync("./dist/rawNals.nal", fullBuffer);
    });
    socket.on("error", () => {
        console.log("error");
    });
    socket.on("data", (data) => {
        // Start codes
        //  0, 0, 1 or 0, 0, 0, 1.

        // Parsing NALs. How long does it take? Even if it seems fast on our machine, maybe it's way too slow on remote machines?

        buffers.push(data);
        console.log(`Read ${data.length}`);
    });
});
server.listen(3000, "0.0.0.0");
//*/



//todonext
/*
// - Converting a tcp connection to a PChannel is obvious. Eventually I should do it with websockets too,
//  the second I even remotely touch websocket code again.

function tcpReceiveChannel(port: number, host: string): PChanReceive<Buffer> {

}

// - Then I need to expose something that gets nal_unit_type quickly (in mp4-typescript)
//  (which is in the nal header, so it doesn't require escaping start codes),
//  so I can split the stream into actual videos.
// - Then... I can finally have a while(true) loop that takes NALs, keep track of information on NALs
//  received (and frame rates, byte rates, latency, etc), and emits videos to clients
//      - and then I can put this code in receiver.ts, and display the information (and video), in the browser.
//*/




/*
let dataSize = 200 * 1024;

let wsServer = new ws.Server({ port: 6070 });
wsServer.on("connection", connRaw => {

    console.log("conn opened");
   
    var curCallback = null;
    async function requestData(size) {
        if(curCallback !== null) {
            throw new Error(`Already waiting for data`);
        }
        return newPromise(x => {
            curCallback = x;
            connRaw.send(JSON.stringify({
                size: size
            }));
        });
    }

    connRaw.on("message", data => {
        var callback = curCallback;
        curCallback = null;
        receiveData(data.length);
        callback();
    });;
    connRaw.on("error", (err) => {
        console.error(err);
    });

    run();
    async function run() {
        
        while(true) {
            await requestData(dataSize);
        }
    }
});
wsServer.on("error", (err) => {
    console.error(err);
});

var lastPrintTime = 0;
var printInterval = 1000;
function printTime(bytePerMillisecond) {
    var curTime = clock();
    var diff = curTime - lastPrintTime;
    if(diff < printInterval) return;
    lastPrintTime = curTime;
    
    var KBpS = bytePerMillisecond / 1024 * 1000;

    console.log(`${KBpS} KB/s, ${dataSize} bytes`);
}

var rollingTimes = [];
var minTimeCount = 3;
var maxTimeDuration = 3000;
function addTime(duration, size) {
    rollingTimes.push({duration, size});
    while (
        rollingTimes.length > 0
        && rollingTimes.reduce((a, b) => a + b.duration, 0) - rollingTimes[0].duration > maxTimeDuration
        && rollingTimes.length > minTimeCount
    ) {
        rollingTimes.shift();
    }

    var sum = rollingTimes.reduce((a, b) => a + b.duration, 0);
    var bytes = rollingTimes.reduce((a, b) => a + b.size, 0);

    printTime(bytes / sum);
}

var lastStart = clock();
function receiveData(size) {
    var time = clock();
    var curDuration = time - lastStart;
    lastStart = time;

    addTime(curDuration, size);
}

console.log("started");
*/