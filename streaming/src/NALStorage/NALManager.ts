import { TransformChannel, PChan, TransformChannelAsync, SetTimeoutAsync, Deferred } from "pchannel";
import { writeFile, appendFile, readFile } from "fs";
import { createFSArray } from "./FSArray";
import { insertIntoListMapped, sort, binarySearchMapped, binarySearchMap, insertIntoListMap, findAfterIndex, findAtOrBeforeOrAfterIndex, findAt, findAtIndex } from "../util/algorithms";
import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise } from "../util/fs";
import { keyBy, mapObjectValues } from "../util/misc";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { LocalNALRate, NALStorage, readNalLoop } from "./LocalNALRate";
import { MuxVideo } from "mp4-typescript";
import { group, min } from "../util/math";
import { RealTimeToVideoTime, GetTimescaleSeconds, GetMinGapSize, RealDurationToVideoDuration } from "./TimeMap";
import { clock } from "../util/time";
import { reduceRanges } from "./rangeMapReduce";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";


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

class NALRangeSummary {
    private ranges: NALRange[] = [];
    private lastTime?: number;

    /** Changed changes should be emit into this */
    private rangesListener = new PChannelMultiListen<NALRange[]>();

    constructor(private rate: number) { }

    public AddLiveNAL(time: number): void {
        let { lastTime } = this;
        let diff = lastTime ? time - lastTime : 0;
        if(!lastTime || diff >= GetMinGapSize(this.rate) || diff <= 0) {
            lastTime = time;
        }
        let newRange = { firstTime: lastTime, lastTime: time, frameCount: 1 };
        //console.log("rate", this.rate, "newRange", newRange, "ranges", this.ranges);
        this.rangesListener.SendValue(reduceRanges([newRange], this.ranges, true));
        this.lastTime = time;
    }
    public AddRange(range: NALRange): void {
        this.rangesListener.SendValue(reduceRanges([range], this.ranges, true));
        this.lastTime = Math.max(this.lastTime || 0, range.lastTime);
    }
    
    public GetRanges(): NALRange[] {
        return this.ranges;
    }
    public SubscribeToRanges(
        rangesChanged: (changedRanges: NALRange[]) => void,
        rangesDeleted: (deleteTime: number) => void,
    ) {
        return this.rangesListener.Subscribe(rangesChanged);
    }
}

export class NALManager {
    private localStorages: {
        [rate: number]: NALStorage
    } = {};
    private summaries: {
        [rate: number]: NALRangeSummary
    } = {};

    private getSummary(rate: number) {
        this.summaries[rate] = this.summaries[rate] || new NALRangeSummary(rate);
        return this.summaries[rate];
    }


    public async Init() {
        // Get all local nal files

        let ratesBuffer: Buffer;
        try {
            ratesBuffer = await readFilePromise(LocalNALRate.RatePath);
        } catch(e) {
            return;
        }
        let rates = ratesBuffer.toString().split("\n").slice(0, -1).map(x => +x);
        sort(rates, x => x);
        rates.reverse();

        let localRates: { [rate: number]: LocalNALRate } = {};
        for(let rate of rates) {
            let local = new LocalNALRate(rate);
            localRates[rate] = local;
            local.SubscribeToNALTimes(time => {
                this.onNewTime(rate, time);
            });
            this.localStorages[rate] = local;
            await local.Init();
        }

        rates.reverse();


        for(let rate of rates) {
            let summaryObj = this.getSummary(rate);
            let times = localRates[rate].GetNALTimes();
            let ranges = group(times.map(x => x.time), GetMinGapSize(rate));
            
            for(let range of ranges) {
                summaryObj.AddRange({ firstTime: range[0], lastTime: range.last(), frameCount: range.length });
            }
        }
    }

    public async AddNAL(info: NALHolderMin): Promise<void> {
        let rate = info.rate;
        if(!this.localStorages[rate]) {
            this.localStorages[rate] = new LocalNALRate(rate, true);
            this.localStorages[rate].SubscribeToNALTimes(time => {
                this.onNewTime(rate, time);
                try {
                    
                } catch(e) {
                    if(!String(e).includes("Overlapping ranges while counting frames")) {
                        throw e;
                    } else {
                        console.error(e);
                    }
                }
            });
        }
        let local = this.localStorages[rate];

        await local.AddNAL(info);
    }

    public GetRates(): number[] {
        let rates = Object.keys(this.localStorages).map(x => +x);
        rates.sort((a, b) => a - b);
        return rates;
    }

    public async GetNextAddSeqNum(): Promise<number> {
        let rate = min(Object.keys(this.localStorages).map(x => +x));
        if(rate === undefined) {
            return 0;
        }
        let nalTimes = this.localStorages[rate].GetNALTimes();
        if(nalTimes.length === 0) {
            return 0;
        }
        return nalTimes[0].addSeqNum + 1;
    }

    public GetNALRanges(rate: number): NALRange[] {
        return this.getSummary(rate).GetRanges();
    }

    // - When callback throws, we close the stream.
    public SubscribeToNALRanges(rate: number, callback: (ranges: NALRange[]) => void): () => void {
        return this.getSummary(rate).SubscribeToRanges(callback, () => {
            throw new Error(`Not implemented`);
        });
    }

    // - Starts the stream at the first keyframe before the requested startTime, unless there are no keyframes before it,
    //      then it starts it on the first keyframe after.

    private async muxVideo(nals: NALHolderMin[], speed: number) {
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
            timescale: GetTimescaleSeconds(speed)
        });

        return {
            video,
            frameInfos
        };
    }
    

    private onNewTime(rate: number, time: NALInfoTime) {
        this.getSummary(rate).AddLiveNAL(time.time);
    }

    public async GetVideo(
        startTime: number,
        minFrames: number,
        /** If live then we have no end (except determined by minFrames), and will block until we exceed the minFrames limit. */
        nextReceivedFrameTime: number|undefined|"live",
        startTimeExclusive: boolean,
        rate: number,
        onlyTimes: boolean|undefined,
        cancelToken: Deferred<void>,
    ): Promise<MP4Video | "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" | "CANCELLED"> {
        let sendCount = 0;
        let sendVideoTime = 0;
        let profileTime = clock();

        let live = nextReceivedFrameTime === "live";
        if(nextReceivedFrameTime === "live") {
            nextReceivedFrameTime = undefined;
        }


        let nalStorage = this.localStorages[rate];

        let nalInfos = nalStorage.GetNALTimes();
        if(nalInfos.length === 0) {
            console.log(`No video for rate ${rate}`);
            return "VIDEO_EXCEEDS_LIVE_VIDEO";
        }

        function getNextKeyFrameIndex(index: number): number {
            index++;
            while(index < nalInfos.length) {
                if(nalInfos[index].type === NALType.NALType_keyframe) {
                    break;
                }
                index++;
            }
            return index;
        }

        let firstNalIndex: number;
        {
            let index: number;
            if(startTimeExclusive) {
                index = findAfterIndex(nalInfos, startTime, x => x.time);
            } else {
                index = findAtOrBeforeOrAfterIndex(nalInfos, startTime, x => x.time);
            }
            
            // Go to the last key frame
            if(!startTimeExclusive) {
                while(index >= 0 && nalInfos[index].type !== NALType.NALType_keyframe) {
                    index--;
                }
            }
            
            // If there isn't a key frame before our index, look after
            if(index < 0 || index < nalInfos.length && nalInfos[index].type !== NALType.NALType_keyframe) {
                index = getNextKeyFrameIndex(index);
            }
            firstNalIndex = index;
        }

        // End before the next keyframe
        let nextKeyFrameIndex = getNextKeyFrameIndex(firstNalIndex + minFrames);
        if(nextReceivedFrameTime) {
            let nextNalIndex = findAtIndex(nalInfos, nextReceivedFrameTime, x => x.time);
            let nextNal = nalInfos[nextNalIndex];
            if(!nextNal) {
                console.error(`Cannot find nal for ${nextReceivedFrameTime}. That shouldn't be possible... So we are ignoring it.`);
            } if(nextNal.type !== NALType.NALType_keyframe) {
                console.error(`Nal at next time is not a keyframe. Time: ${nextReceivedFrameTime}. That shouldn't be possible... So we are ignoring it.`);
            } else {
                if(nextKeyFrameIndex > nextReceivedFrameTime) {
                    nextKeyFrameIndex = nextReceivedFrameTime;
                }
            }
        }

        if(firstNalIndex >= nextKeyFrameIndex) {
            return "VIDEO_EXCEEDS_NEXT_TIME";
        }

        if(nextKeyFrameIndex >= nalInfos.length) {
            if(!live) {
                return "VIDEO_EXCEEDS_NEXT_TIME";
            } else {
                //todonext
                // Wait for live data
                //  If firstNalIndex >= nalInfos.length we need to wait until the nalInfos is a keyframe, then set firstNalIndex to that
                //  Wait until we receive minFrames of data after firstNalIndex, ending just before a keyframe.

                // We probably just want a waitUntilNextFrame thing?
            }
        }
        let lastNalIndex = nextKeyFrameIndex - 1;
        let nextKeyFrameTime = nalInfos[nextKeyFrameIndex].time;

        /*
        if(nextReceivedFrameTime && nalInfos[firstNalIndex].time >= nextReceivedFrameTime) {
            console.log(`Request is after client given nextReceivedFrameTime (${nextReceivedFrameTime})`);
            return "VIDEO_EXCEEDS_NEXT_TIME";
        }
        */
        
        let nalInfosChoosen = nalInfos.slice(firstNalIndex, lastNalIndex);
        let times = nalInfosChoosen.map(x => x.time);
        
        if(times.length === 0) {
            return "VIDEO_EXCEEDS_NEXT_TIME";
        }
        let nalsBuffer: NALHolderMin[];
        let videoBuffer: Buffer;
        
        if(onlyTimes) {
            nalsBuffer = nalInfosChoosen.map(time => ({
                nal: Buffer.alloc(0),
                sps: Buffer.alloc(0),
                pps: Buffer.alloc(0),
                width: 0,
                height: 0,
                ...time
            }));
            videoBuffer = Buffer.alloc(0);
        } else {
            nalsBuffer = await nalStorage.ReadNALs(times);
            if(cancelToken.Value()) return "CANCELLED";

            let nalsTimeCorrected = nalsBuffer.map(x => ({ ...x, time: RealTimeToVideoTime(x.time, rate) }));
            let videoObj = await this.muxVideo(nalsTimeCorrected, rate);
            //console.log(`Encoding ${nalsBuffer.map((x, i) => `${x.time} to ${nalsTimeCorrected[i].time}`)}`);

            if(cancelToken.Value()) return "CANCELLED";
            videoBuffer = videoObj.video;
        }

        sendCount++;
        sendVideoTime += (nalsBuffer.last().time - nalsBuffer[0].time) * ((nalsBuffer.length) / (nalsBuffer.length - 1));

        let video: MP4Video = {
            rate,

            width: nalsBuffer[0].width,
            height: nalsBuffer[0].height,

            mp4Video: videoBuffer,
            nextKeyFrameTime,
            frameTimes: nalsBuffer.map(x => ({
                rate: x.rate,
                time: x.time,
                type: x.type,
                width: x.width,
                height: x.height,
                addSeqNum: x.addSeqNum,
            }))
        };

        profileTime = clock() - profileTime;
        let efficiencyFrac = profileTime / RealDurationToVideoDuration(sendVideoTime, rate);
        if(!onlyTimes) {
            console.log(`GetVideo${startTimeExclusive ? " (exclusive)" : ""} (index ${firstNalIndex} (${nalInfos[firstNalIndex].type}) to ${lastNalIndex} (exclusive) (${nalInfos[lastNalIndex - 1].type})) took ${profileTime.toFixed(2)}ms for ${sendCount} videos. ${(profileTime / sendCount).toFixed(1)}ms/video. Encoding time ${(efficiencyFrac * 100).toFixed(1)}%.`);
        }

        return video;
    }
}

