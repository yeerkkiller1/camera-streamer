import { TransformChannel, PChan, TransformChannelAsync, SetTimeoutAsync, Deferred } from "pchannel";
import { writeFile, appendFile, readFile } from "fs";
import { createFSArray } from "./FSArray";
import { insertIntoListMapped, sort, binarySearchMapped, binarySearchMap, insertIntoListMap, findAfterIndex, findAtOrBeforeOrAfterIndex } from "../util/algorithms";
import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise } from "../util/fs";
import { keyBy, mapObjectValues } from "../util/misc";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { LocalNALRate, NALStorage } from "./LocalNALRate";
import { MuxVideo } from "mp4-typescript";
import { group } from "../util/math";
import { RealTimeToVideoTime, GetTimescaleSeconds, GetMinGapSize } from "./TimeMap";
import { clock } from "../util/time";
import { reduceRanges } from "./rangeMapReduce";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";

// TODO:
//  S3 simulation
//  Deleting old data.
//  Real S3



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
        this.rangesListener.SendValue(reduceRanges([{ firstTime: lastTime, lastTime: time, frameCount: 1 }], this.ranges, true));
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

        let rateObjs = rates.map(rate => {
            let local = new LocalNALRate(rate);
            local.SubscribeToNALTimes(time => {
                this.getSummary(rate).AddLiveNAL(time.time);
            });

            return local;
        });

        for(let rateObj of rateObjs) {
            this.localStorages[rateObj.Rate] = rateObj;
        }

        await Promise.all(rateObjs.map(x => x.Init()));

        for(let rateObj of rateObjs) {
            let summaryObj = this.getSummary(rateObj.Rate);
            let times = rateObj.GetNALTimes();
            let ranges = group(times.map(x => x.time), GetMinGapSize(rateObj.Rate));
            
            for(let range of ranges) {
                summaryObj.AddRange({ firstTime: range[0], lastTime: range.last(), frameCount: range.length });
            }
        }
    }

    public AddNAL(info: NALHolderMin) {
        let rate = info.rate;
        if(!this.localStorages[rate]) {
            this.localStorages[rate] = new LocalNALRate(rate, true);
            this.localStorages[rate].SubscribeToNALTimes(time => {
                this.getSummary(rate).AddLiveNAL(time.time);
            });
        }
        let local = this.localStorages[rate];

        local.AddNAL(info);
    }

    public GetRates(): number[] {
        let rates = Object.keys(this.localStorages).map(x => +x);
        rates.sort((a, b) => a - b);
        return rates;
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
    
    public async GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number|undefined,
        startTimeExclusive: boolean,

        rate: number,

        cancelToken: Deferred<void>
    ): Promise<MP4Video | "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" | "CANCELLED"> {
        let sendCount = 0;
        let sendVideoTime = 0;
        let profileTime = clock();


        let nalStorage = this.localStorages[rate];

        let nalInfos = nalStorage.GetNALTimes();
        if(nalInfos.length === 0) {
            console.log(`No video for rate ${rate}`);
            return "VIDEO_EXCEEDS_LIVE_VIDEO";
        }

        let firstNalIndex: number;
        {
            let index: number;
            if(startTimeExclusive) {
                index = findAfterIndex(nalInfos, startTime, x => x.time);
            } else {
                index = findAtOrBeforeOrAfterIndex(nalInfos, startTime, x => x.time);
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
                console.log(`Request is for live data not capped with keyframe`);
                return "VIDEO_EXCEEDS_LIVE_VIDEO";
            }
            firstNalIndex = index;
        }

        if(nextReceivedFrameTime && nalInfos[firstNalIndex].time >= nextReceivedFrameTime) {
            console.log(`Request is after client given nextReceivedFrameTime (${nextReceivedFrameTime})`);
            return "VIDEO_EXCEEDS_NEXT_TIME";
        }

        let lastNalIndex: number;
        let nextKeyFrameTime: number|undefined;
        {
            let index = firstNalIndex;
            while(
                index < nalInfos.length
            ) {
                if(index + 1 < nalInfos.length && nalInfos[index + 1].type === NALType.NALType_keyframe) {
                    if(nextReceivedFrameTime && nalInfos[index + 1].time >= nextReceivedFrameTime
                    || (index + 1 - firstNalIndex) >= (minFrames)) {
                        nextKeyFrameTime = nalInfos[index + 1].time;
                        break;
                    }
                }

                index++;
            }
            if(index === nalInfos.length) {
                index--;
            }
            lastNalIndex = index;
        }

        let times = nalInfos.slice(firstNalIndex, lastNalIndex + 1).map(x => x.time);
        let nalsBuffer = await nalStorage.ReadNALs(times);

        if(cancelToken.Value()) return "CANCELLED";

        let nalsTimeCorrected = nalsBuffer.map(x => ({ ...x, time: RealTimeToVideoTime(x.time, rate) }));
        let videoObj = await this.muxVideo(nalsTimeCorrected, rate);
        console.log(`Encoding ${nalsBuffer.map((x, i) => `${x.time} to ${nalsTimeCorrected[i].time}`)}`);

        if(cancelToken.Value()) return "CANCELLED";

        sendCount++;
        sendVideoTime += (nalsBuffer.last().time - nalsBuffer[0].time) * ((nalsBuffer.length) / (nalsBuffer.length - 1));
        let video: MP4Video = {
            rate,
            mp4Video: videoObj.video,
            nextKeyFrameTime,
            frameTimes: nalsBuffer.map(x => ({
                rate: x.rate,
                time: x.time,
                type: x.type,
            }))
        };

        profileTime = clock() - profileTime;
        let efficiencyFrac = profileTime / sendVideoTime;
        console.log(`GetVideo${startTimeExclusive ? " (start exclusive)" : ""} (index ${firstNalIndex} (${nalInfos[firstNalIndex].type}) to ${lastNalIndex} (${nalInfos[lastNalIndex].type})) took ${profileTime.toFixed(2)}ms for ${sendCount} videos. ${(profileTime / sendCount).toFixed(1)}ms per video. Percent encoding time of video time ${(efficiencyFrac * 100).toFixed(1)}%.`);

        return video;
    }
}



