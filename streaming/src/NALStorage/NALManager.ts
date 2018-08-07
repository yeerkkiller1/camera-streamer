import { TransformChannel, PChan, TransformChannelAsync, SetTimeoutAsync, Deferred } from "pchannel";
import { writeFile, appendFile, readFile } from "fs";
import { createFSArray } from "./FSArray";
import { insertIntoListMapped, sort, binarySearchMapped, binarySearchMap, insertIntoListMap } from "../util/algorithms";
import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise } from "../util/fs";
import { keyBy, mapObjectValues } from "../util/misc";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { LocalNALRate, LocalNALStorage } from "./LocalNALRate";
import { MuxVideo } from "mp4-typescript";
import { group } from "../util/math";
import { RealTimeToVideoTime, GetTimescale } from "./TimeMap";
import { clock } from "../util/time";

// TODO:
//  S3 simulation
//  Deleting old data.
//  Real S3


export async function testAddRanges(manager: NALManager, RateMultiplier: number) {
    //console.log(`testAddRanges`);
    // Hmm... it seems better to just send all the range data to the client, and send them a message ever second about any new
    //  data received. And then bulk store the ranges data on the disk, with S3 ranges stored in a file that we append to,
    //  and other ranges stored in the same file as the data is stored in?

    // S3 chunks
    //  - Companion files per rate on disk that store a list of all chunks

    // Local chunks (the difficult chunks)
    //  - Two files, one per NALs, and another for each nal file location, and time.
    //      - Ah... two files really sucks. If we could inline the index information that would be great...
    //          THIS. This is the real question, storing the local files, and having an index to the NALs. Maybe... we just
    //          store the index in memory? Fuck. Two files would actually be okay, because we can recover missing a missing
    //          or partially missing index. So, two index files, with generation and recovery.
    //  - We load the whole chunks into memory?
    //      - If each chunk is ~10MB? then this takes 300MB per year of 30fps footage?

    // Local -> S3
    //  We need to look at the local NALs and decide a good time range to store the NALs under. Basically,
    //      we just make one range, except splitting if there are gaps larger than a threshold.

    // NAL index
    //  - In S3 prepends the file
    //  - Locally is it's own file
    //  - Loaded into index object
    //  - Has byte location/size of each NAL, a time they start at, and byte location/size of SPS and PPS for that NAL.

    // And then we can load all the S3 companion files, and the local chunk companion files (recovery is necessary),
    //  and we'll have a big list of ranges of where all the NALs are.
    // We can send this list to a client if it requests it, and give push clients updates on ranges mutating, or being deleted,
    //  every second or so.
    // And of course, we can also let a client stream video, at any rate/fps requested, where higher FPS then recorded just requires
    //  us to read data from the server on a lower rate, and rates/fps combos that don't work out require downsampling.
    //  - If the client request streaming at a point in time, we look in our S3 chunk index lookups and see if it is there.
    //      - If it is, those lookups give us a chunk to load from S3, which we then load. We can then convert the large
    //      buffer to a list of NALs with start times, and we can start slicing NALs, appending the SPS/PPS and muxing them.
    //      - If it is local, we do the same thing, but we will already have the local NALs split into Buffers, so we can just
    //          go from there.


    // Local stuff
    //  Load the local index files + NAL files for each rate (verify, and fix if needed),
    //  and then change Downsampler to be able to start at a certain count.
    //  We will have our own internal instances class, and the instance we pass to Downsampler will just be a shell,
    //      that holds the instance we have, which may be created before our shell is created, or because our shell is created.
    //  Then as data is added, we will add to the local NAL files, the local NAL index files, the local NAL index,
    //      and inform listening clients about the additions, AND give the NALs to any live listening NAL streams
    //      (but deal with the live stuff afterwards, streaming from files is the priority).

    //let db = new RangeDB(2, FSRangeInstance);
    //db.AddRange({ first: 0, last: 5 });
    //db.AddRange({ first: 6, last: 8 });


    //*

    if(!manager) {
        manager = new NALManager();
        await manager.Init();
    }

    // aka, GOP size
    let frameGroupSize = 10;

    let ranges = manager.GetNALTimes(1);

    type BeforeRate = Omit<NALHolderMin, "rate"|"type">;
    class Adder implements DownsampledInstance<BeforeRate> {
        constructor (public Rate: number) { }
        private index = 0;
        public AddValue(val: BeforeRate): void {
            let keyFrame = this.index++ % frameGroupSize === 0;
            manager.AddNAL({...val, rate: this.Rate, type: keyFrame ? NALType.NALType_keyframe : NALType.NALType_interframe});
        }
    }
    let downsample = new Downsampler(RateMultiplier, Adder, ranges.length);
    function addFrame(time: number, text: string, sps: Buffer, pps: Buffer) {
        downsample.AddValue({
            time: time,
            width: 1920,
            height: 1080,

            sps,
            pps,
    
            nal: bufferFromString(text)
        });
    }

    // Simulate sending the nals. The video won't play, but as long as we don't put it in a player we will be able to test
    //  the metadata, and storage systems.

    let fps = 1;
    let curTime = 0;

    if(ranges.length > 0) {
        let frameSize = ranges[1] - ranges[0];
        // To be beside the previous ranges we need to add at least 1 frameSize (if we start at the previous frame,
        //  then two frames will be at the same time).
        curTime = ranges[ranges.length - 1] + frameSize * 100;
        console.log(`Loaded start time of ${curTime}`);
    }

    function addFrameGroup() {
        let sps = bufferFromString("sps");
        let pps = bufferFromString("pps");
        for(let i = 0; i < frameGroupSize; i++) {
            addFrame(curTime, "frame", sps, pps);
            curTime += 1 / fps * 1000;
        }
    }
    
    for(var i = 0; i < 1; i++) {
        addFrameGroup();
    }
    //*/
}

function bufferFromString(text: string): Buffer {
    let buf = Buffer.alloc(text.length);
    for(let i = 0; i < text.length; i++) {
        let char = text.charCodeAt(i);
        buf[i] = char;
    }
    return buf;
}

export async function createNALManager(): Promise<NALManager> {
    let manager = new NALManager();
    await manager.Init();
    return manager;
}

export class NALManager {
    private localStorages: { [rate: number]: LocalNALStorage } = {};

    public async Init() {
        // Get all local nal files

        let ratesBuffer: Buffer;
        try {
            ratesBuffer = await readFilePromise(LocalNALRate.RatePath);
        } catch(e) {
            return;
        }
        let rates = ratesBuffer.toString().split("\n").slice(0, -1).map(x => +x);

        let rateObjs = rates.map(rate => new LocalNALRate(rate));

        for(let rateObj of rateObjs) {
            this.localStorages[rateObj.Rate] = rateObj;
        }

        await Promise.all(rateObjs.map(x => x.Init()));
    }

    public AddNAL(info: NALHolderMin) {
        let rate = info.rate;
        let local = this.localStorages[rate] = this.localStorages[rate] || new LocalNALRate(rate, true);

        local.AddNAL(info);
    }

    public GetRates(): number[] {
        return Object.keys(this.localStorages).map(x => +x);
    }

    public GetNALsRanges(rate: number): NALRanges {
        // TODO: S3 ranges
        // TODO: Cache these ranges, so we don't compute them on every call?
        // Remember, when creating S3 chunks, create them with 1 frame still in local storage, so we can compute the S3
        //  range index lookup (that has a range per S3 chunk, so you know where to find data) without gaps.

        let storage = this.localStorages[rate];

        return {
            rate,
            frameTimes: [],
            segmentRanges: storage &&
                group(storage.GetNALTimes().map(x => x.time), 10 * 1000)
                .map(x => ({ firstTime: x[0], lastTime: x.last() }))
            || []
        };
    }
    public GetNALTimes(rate: number): number[] {
        let storage = this.localStorages[rate];

        return storage && storage.GetNALTimes().map(x => x.time) || [];
    }

    private async muxVideo(nals: NALHolderMin[], rate: number, speedMultiplier: number) {
        let keyframe = nals[0];
        if(keyframe.type !== NALType.NALType_keyframe) {
            throw new Error(`MuxVideo called incorrectly, did not start with keyframe?`);
        }
        let frameInfos = nals.map((x, i) => {
            // The last frame having a duration of 0 seems to be okay with our player. Frame
            //  durations shouldn't even exist, only frame occurence times.
            let frameDurationInSeconds = 0;
            if(i < nals.length - 1) {
                let next = nals[i + 1];
                frameDurationInSeconds = (next.time - x.time) / 1000;
                //console.log({frameDurationInSeconds});
            }
            
            return {
                nal: x.nal,
                frameDurationInSeconds
            };
        });

        let baseMediaDecodeTimeInSeconds = nals[0].time / 1000;
        let video = await MuxVideo({
            sps: keyframe.sps,
            pps: keyframe.pps,
            frames: frameInfos,
            // Eh... I'm no so sure about this. This has to be eventually represented as an integer, with a timescale multiplier.
            //  But... if rate and speedMultiplier are high, then baseMediaDecodeTimeInSeconds should be spaced out by a lot, so it could work?
            //  Hopefully...
            baseMediaDecodeTimeInSeconds: baseMediaDecodeTimeInSeconds,
            width: keyframe.width,
            height: keyframe.height,
            /* // If we set these, we have to do it accurately, or the video won't play!
            forcedContainerInfo: {
                level_idc: 0x40,
                profile_idc: 0x40
            }
            //*/
            timescale: GetTimescale(rate, speedMultiplier)
        });

        return {
            video,
            frameInfos
        };
    }

    // - When callback throws, we close the stream.
    // - Starts the stream at the first keyframe before the requested startTime, unless there are no keyframes before it,
    //      then it starts it on the first keyframe after.

    
    public async GetVideo(
        startTime: number,
        endTime: number,
        startTimeExclusive: boolean,
        endTimeMinusOne: boolean,
        rate: number,
        speedMultiplier: number,
        callback: (video: MP4Video) => void,
        cancelToken: Deferred<void>
    ): Promise<void> {

        let sendCount = 0;
        let sendVideoTime = 0;
        let profileTime = clock();
        let firstNalIndex = 0;
        let lastNalIndex = 0;

        function finishProfile() {
            profileTime = clock() - profileTime;
            let efficiencyFrac = profileTime / sendVideoTime;

            console.log(`GetVideo${startTimeExclusive ? " (start exclusive)" : ""} (index ${firstNalIndex} (${nalInfos[firstNalIndex].type}) to ${lastNalIndex} (${nalInfos[lastNalIndex].type})) took ${profileTime.toFixed(2)}ms for ${sendCount} videos. ${(profileTime / sendCount).toFixed(1)}ms per video. Percent encoding time of video time ${(efficiencyFrac * 100).toFixed(1)}%.`);
        }


        let nalStorage = this.localStorages[rate];

        let nalInfos = nalStorage.GetNALTimes();
        if(nalInfos.length === 0) {
            return;
        }

        let index = binarySearchMap(nalInfos, startTime, x => x.time);
        if(startTimeExclusive) {
            if(index < 0) {
                index = ~index;
            } else {
                index++;
            }
        } else {
            if(index < 0) {
                // ~index is the index after the time, and we want the one before. So... go 1 before
                index = ~index - 1;
                // Unless that is negative, then we just have to start after the requested time.
                if(index < 0) {
                    index = 0;
                }
            }
        }
        
        if(!startTimeExclusive) {
            while(index >= 0 && nalInfos[index].type !== NALType.NALType_keyframe) {
                index--;
            }
        }
        
        if(index < 0 || index < nalInfos.length && nalInfos[index].type !== NALType.NALType_keyframe) {
            index++;
            while(index < nalInfos.length && nalInfos[index].type !== NALType.NALType_keyframe) {
                index++;
            }
        }

        if(index >= nalInfos.length) {
            return;
        }

        firstNalIndex = index;


        let streamRealtimeStart = Date.now();

        // Buffered nals before we find a keyframe.
        let nalsBuffer: NALHolderMin[] = [];

        const muxAndSendVideo = async (incomplete: boolean) => {
            if(nalsBuffer.length === 0) {
                return;
            }

            let videoObj = await this.muxVideo(nalsBuffer.map(x => ({ ...x, time: RealTimeToVideoTime(x.time, rate, speedMultiplier) })), rate, speedMultiplier);

            if(cancelToken.Value()) return;

            // Wait until videoCientsideBuffer time before the video starts before sending it.
            let videoCientsideBuffer = 10 * 1000;

            let videoTimeOffset = nalsBuffer[0].time - startTime;
            let realityTimeOffset = Date.now() - streamRealtimeStart;

            // Move everything to play closer to the present.
            videoTimeOffset = videoTimeOffset / rate / speedMultiplier;

            sendCount++;
            sendVideoTime += (nalsBuffer.last().time - nalsBuffer[0].time) * ((nalsBuffer.length) / (nalsBuffer.length - 1));
            callback({
                mp4Video: videoObj.video,
                rate: rate,
                incomplete,
                speedMultiplier: speedMultiplier,
                frameTimes: nalsBuffer.map(x => ({
                    rate: x.rate,
                    time: x.time,
                    type: x.type,
                }))
            });
            nalsBuffer = [];
        };


        // Start streaming from index, until we reach the end.
        while(index < nalInfos.length) {
            let nalStartIndex = index;

            let nalsRead = nalInfos.slice(index, index + 20);
            index += nalsRead.length;

            // Read in chunks, because it will probably be more efficient
            let nals = await nalStorage.ReadNALs(nalsRead.map(x => x.time));

            for(let i = 0; i < nals.length; i++) {
                let nal = nals[i];
                if(nal.type === NALType.NALType_keyframe && nalsBuffer.length > 0) {
                    // Exclusive end time
                    if(nalsBuffer[0].time > endTime || endTimeMinusOne && nal.time > endTime) {
                        finishProfile();
                        return;
                    }
                    lastNalIndex = nalStartIndex + i - 1;
                    await muxAndSendVideo(false);
                    if(cancelToken.Value()) return;
                }
                nalsBuffer.push(nal);
            }
        }

        if(nalsBuffer.length > 0 && nalsBuffer.last().time < endTime) {
            console.log(`Send last data`);
            lastNalIndex = index - 1;
            await muxAndSendVideo(true);
        }

        finishProfile();
    }

    public SubscribeToNALs(rate: number, speedMultiplier: number, callback: (nal: NALTime) => void): () => void {
        return this.localStorages[rate].SubscribeToNALTimes(callback);
    }
}



