import { Deferred, PChan } from "pchannel";
import { clock } from "../util/time";
import { findAfterIndex, findAtOrBeforeOrAfterIndex, findAtIndex } from "../util/algorithms";
import { RealTimeToVideoTime, RealDurationToVideoDuration, GetTimescaleSeconds, GetMinGapSize } from "./TimeMap";
import { MuxVideo } from "mp4-typescript";
import { UnionUndefined } from "../util/misc";

export function GetVideoTimes(
    startTime: number,
    minFrames: number,
    nextReceivedFrameTime: number|undefined,
    startTimeExclusive: boolean,
    allowMissingEndKeyframe: boolean|undefined,
    nalInfos: NALInfoTime[],
): { times: NALInfoTime[]; nextKeyFrameTime: number|undefined } | "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" {
    if(nalInfos.length === 0) {
        return "VIDEO_EXCEEDS_LIVE_VIDEO";
    }

    // Actually, we also need to impose a maxgap size in the times choosen. Because if we make a video span across
    //  two far apart videos we tie though gaps together, which is odd, AND breaks the video by making one frame
    //  stay on the screen for too long (days, which breaks our 32-bit timescale based frame duration encoding).
    //  - Well, and not to mention, we don't want to play the video gaps, we want to skip them.
    let rate = nalInfos[0].rate;
    let minGap = GetMinGapSize(rate);

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
    let nextKeyFrameIndex = nalInfos.length;
    {
        let validNextKeyFrameIndex = firstNalIndex;
        let index = firstNalIndex + 1;
        while(index < nalInfos.length) {
            let lastKeyFrame = UnionUndefined(nalInfos[validNextKeyFrameIndex]);

            if(nalInfos[index].type === NALType.NALType_keyframe) {
                validNextKeyFrameIndex = nextKeyFrameIndex = index;

                if(index >= firstNalIndex + minFrames) {
                    break;
                }
            }

            if(lastKeyFrame && (nalInfos[index].time - lastKeyFrame.time >= minGap)) {
                let lastTime = lastKeyFrame.time;
                let curTime = nalInfos[index].time;
                if(nalInfos[index].type !== NALType.NALType_keyframe) {
                    console.warn(`Gap exceeding min gap size in video found, BUT, the frame is an intraframe and so DEPENDS on the previous frame. So we are stitching it with the last frame, even though there should be a video gap here. Time: ${lastTime} to ${curTime}, min gap size ${minGap}`);
                } else {
                    break;
                }
            }

            index++;
        }
    }

    if(nextReceivedFrameTime) {
        let nextNalIndex = findAtIndex(nalInfos, nextReceivedFrameTime, x => x.time);
        let nextNal = nalInfos[nextNalIndex];
        if(!nextNal) {
            // If the next frame is in another chunk, don't worry about it.
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

    if(!allowMissingEndKeyframe && nextKeyFrameIndex >= nalInfos.length) {
        return "VIDEO_EXCEEDS_NEXT_TIME";
    }

    let lastNalIndex = nextKeyFrameIndex - 1;
    let nextKeyFrameTime = nextKeyFrameIndex < nalInfos.length ? nalInfos[nextKeyFrameIndex].time : undefined;
    
    let nalInfosChoosen = nalInfos.slice(firstNalIndex, lastNalIndex + 1);
    let times = nalInfosChoosen.map(x => x.time);
    
    if(times.length === 0) {
        return "VIDEO_EXCEEDS_NEXT_TIME";
    }

    return { times: nalInfosChoosen, nextKeyFrameTime };
}

export async function muxVideo(nals: NALHolderMin[], rate: number, speed: number, nextKeyFrameTime: number|undefined): Promise<MP4Video> {
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
            frameDurationInSeconds = RealDurationToVideoDuration(next.time - x.time, rate) / 1000;
        }
        
        return {
            nal: x.nal,
            frameDurationInSeconds
        };
    });

    let baseMediaDecodeTimeInSeconds = RealTimeToVideoTime(nals[0].time, rate) / 1000;
    let mp4Video = await MuxVideo({
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

    let video: MP4Video = {
        rate,
    
        width: nals[0].width,
        height: nals[0].height,
    
        mp4Video: mp4Video,
        nextKeyFrameTime,
        frameTimes: nals.map(x => ({
            rate: x.rate,
            time: x.time,
            type: x.type,
            width: x.width,
            height: x.height,
            addSeqNum: x.addSeqNum,
        }))
    };

    return video;
}

/*
export async function GetVideoTimes(
    startTime: number,
    minFrames: number,
    nextReceivedFrameTime: number|undefined|"live",
    startTimeExclusive: boolean,
    rate: number,
    onlyTimes: boolean|undefined,
    forPreview: boolean|undefined,
    cancelToken: Deferred<void>,
    nalInfos: NALIndexInfo[]
): Promise<NALIndexInfo[] | "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" | "CANCELLED"> {
    let sendCount = 0;
    let sendVideoTime = 0;
    let profileTime = clock();

    let live = nextReceivedFrameTime === "live";
    if(nextReceivedFrameTime === "live") {
        nextReceivedFrameTime = undefined;
    }

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

   if(!forPreview && nextKeyFrameIndex >= nalInfos.length) {
    if(!live || !onNewNal) {
        return "VIDEO_EXCEEDS_NEXT_TIME";
    } else {
        // Wait for live data
        //  If firstNalIndex >= nalInfos.length we need to wait until the nalInfos is a keyframe, then set firstNalIndex to that
        //  Wait until we receive minFrames of data after firstNalIndex, ending just before a keyframe.
        console.log("Starting live loop");
        while(true) {
            
            await onNewNal.GetPromise();
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
    nalsBuffer = await readNALs(times);
    if(cancelToken.Value()) return "CANCELLED";

    let nalsTimeCorrected = nalsBuffer.map(x => ({ ...x, time: RealTimeToVideoTime(x.time, rate) }));
    let videoObj = await muxVideo(nalsTimeCorrected, rate);
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
*/