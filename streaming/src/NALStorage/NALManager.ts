import { TransformChannel, PChan, TransformChannelAsync, SetTimeoutAsync, Deferred } from "pchannel";
import { writeFile, appendFile, readFile } from "fs";
import { createFSArray } from "./FSArray";
import { insertIntoListMapped, sort, binarySearchMapped, binarySearchMap, insertIntoListMap, findAfterIndex, findAtOrBeforeOrAfterIndex, findAt, findAtIndex } from "../util/algorithms";
import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise } from "../util/fs";
import { keyBy, mapObjectValues } from "../util/misc";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { LocalNALRate } from "./LocalNALRate";
import { MuxVideo } from "mp4-typescript";
import { group, min } from "../util/math";
import { RealTimeToVideoTime, GetTimescaleSeconds, GetMinGapSize, RealDurationToVideoDuration } from "./TimeMap";
import { clock } from "../util/time";
import { reduceRanges } from "./rangeMapReduce";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";


export async function createNALManager(): Promise<NALManager> {
    let manager = new NALManager();
    await manager.Init();
    return manager;
}


export class NALManager {
    private localStorages: {
        [rate: number]: LocalNALRate
    } = {};

    private getStorage(rate: number) {
        if(!this.localStorages[rate]) {
            this.localStorages[rate] = new LocalNALRate(rate, true);
        }
        return this.localStorages[rate];
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
        for(let rate of rates) {
            let local = this.getStorage(rate);
            await local.Init();
        }
    }

    private onNewNal: Deferred<void> = new Deferred();
    public async AddNAL(info: NALHolderMin): Promise<void> {
        let local = this.getStorage(info.rate);
        await local.AddNAL(info);
        this.onNewNal.Resolve();
        this.onNewNal = new Deferred();
    }

    public GetRates(): number[] {
        let rates = Object.keys(this.localStorages).map(x => +x);
        rates.sort((a, b) => a - b);
        return rates;
    }

    public async GetNextAddSeqNum(): Promise<number> {
        let rate = min(Object.keys(this.localStorages).map(x => +x));
        if(rate === undefined) {
            console.warn(`GetNextAddSeqNum called with no storages loaded. Returning 0 for now, but we should be blocking in this case.`);
            return 0;
        }
        let nalTimes = this.localStorages[rate].GetNALTimes();
        if(nalTimes.length === 0) {
            console.warn(`GetNextAddSeqNum called with no rate 1 storage not loaded. Returning 0 for now, but we should be blocking in this case.`);
            return 0;
        }
        return nalTimes.last().addSeqNum + 1;
    }

    public GetNALRanges(rate: number): NALRange[] {
        return this.getStorage(rate).GetRanges();
    }

    // - When callback throws, we close the stream.
    public SubscribeToNALRanges(rate: number, callback: (ranges: NALRange[]) => void): () => void {
        return this.getStorage(rate).SubscribeToRanges(callback, () => {
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


    todonext
    // Convert this to a naked function that takes a NALIndexInfo[], a function to get the underlying NALMinInfo, and
    //  has an optional newNal channel that sends void, but triggers when NALIndexInfo has more data?
    // BUT, there is definitely a bug in the live loop already. Maybe the channel should send NALIndexInfo?
    //  Or we should at least do something to fix the bug.

    public async GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number|undefined|"live",
        startTimeExclusive: boolean,
        rate: number,
        onlyTimes: boolean|undefined,
        forPreview: boolean|undefined,
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
        if(!nalStorage) {
            throw new Error(`No rate ${rate}, only have ${Object.keys(this.localStorages)}`);
        }

        let nalInfos: NALIndexInfo[] = nalStorage.GetNALTimes();

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
                let startTimeIndex = index;
                while(index >= 0 && nalInfos[index].type !== NALType.NALType_keyframe) {
                    index--;
                }
                if(index >= 0 && nalInfos[index].type === NALType.NALType_keyframe) {
                    // Get more frames if we had to move back to find a keyframe.
                    minFrames += startTimeIndex - index;
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
                if(nextKeyFrameIndex > nextNalIndex) {
                    nextKeyFrameIndex = nextNalIndex;
                }
            }
        }

        if(firstNalIndex >= nextKeyFrameIndex) {
            return "VIDEO_EXCEEDS_LIVE_VIDEO";
        }

        /*
        if(forPreview && nextKeyFrameIndex >= nalInfos.length) {
            nextKeyFrameIndex = firstNalIndex + 1;
            while(nextKeyFrameIndex < nalInfos.length) {
                if(nalInfos[nextKeyFrameIndex].type === NALType.NALType_keyframe) break;
                nextKeyFrameIndex++;
            }
        }
        */

        if(!forPreview && nextKeyFrameIndex >= nalInfos.length) {
            if(!live) {
                return "VIDEO_EXCEEDS_NEXT_TIME";
            } else {
                // Wait for live data
                //  If firstNalIndex >= nalInfos.length we need to wait until the nalInfos is a keyframe, then set firstNalIndex to that
                //  Wait until we receive minFrames of data after firstNalIndex, ending just before a keyframe.
                console.log("Starting live loop");
                while(true) {
                    await this.onNewNal.Promise();
                    if(firstNalIndex >= nalInfos.length) {
                        firstNalIndex = nalInfos.length - 1;
                    }
                    let firstNal = nalInfos[firstNalIndex];
                    if(firstNal.type !== NALType.NALType_keyframe) {
                        console.log(`Waiting for firstNal index: ${firstNalIndex}, nals ${nalInfos.length}`);
                        continue;
                    }

                    nextKeyFrameIndex = firstNalIndex + minFrames;
                    let nextNal = nalInfos[nextKeyFrameIndex];
                    if(!nextNal) {
                        continue;
                    }
                    // This is a bit unfortunate, as it causes AT LEAST 1 keyframe delay, even if we have an i frame interval of 1.
                    //  It also means if the camera disconnects we won't write the last few frames out until the camera reconnects.
                    while(nextNal && nextNal.type !== NALType.NALType_keyframe) {
                        nextKeyFrameIndex++;
                        nextNal = nalInfos[nextKeyFrameIndex];
                    }
                    if(nextNal) {
                        console.log(`Waiting for ${nextKeyFrameIndex} to become valid. Have up to ${nalInfos.length}`);
                        break;
                    }
                }
                
            }
        }
        let lastNalIndex = nextKeyFrameIndex - 1;
        let nextKeyFrameTime = nextKeyFrameIndex < nalInfos.length ? nalInfos[nextKeyFrameIndex].time : undefined;

        /*
        if(nextReceivedFrameTime && nalInfos[firstNalIndex].time >= nextReceivedFrameTime) {
            console.log(`Request is after client given nextReceivedFrameTime (${nextReceivedFrameTime})`);
            return "VIDEO_EXCEEDS_NEXT_TIME";
        }
        */
        
        let nalInfosChoosen = nalInfos.slice(firstNalIndex, lastNalIndex + 1);
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
            console.log(`GetVideo rate ${rate}${startTimeExclusive ? " (exclusive)" : ""} (index ${firstNalIndex} (${nalInfos[firstNalIndex].type}) to ${lastNalIndex} (${lastNalIndex >= nalInfos.length ? "live" : nalInfos[lastNalIndex].type})) took ${profileTime.toFixed(2)}ms for ${sendCount} videos. ${(profileTime / sendCount).toFixed(1)}ms/video. Encoding time ${(efficiencyFrac * 100).toFixed(1)}%.`);
        } else {
            console.log(`(onlyTimes) GetVideo rate ${rate}${startTimeExclusive ? " (exclusive)" : ""} (index ${firstNalIndex} (${nalInfos[firstNalIndex].type}) to ${lastNalIndex} (${lastNalIndex >= nalInfos.length ? "live" : nalInfos[lastNalIndex].type})) took ${profileTime.toFixed(2)}ms for ${sendCount} videos. ${(profileTime / sendCount).toFixed(1)}ms/video. Encoding time ${(efficiencyFrac * 100).toFixed(1)}%.`);
        }

        return video;
    }
}

