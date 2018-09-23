import { Deferred, PChan } from "pchannel";
import { clock } from "../util/time";
import { findAfterIndex, findAtOrBeforeOrAfterIndex, findAtIndex } from "../util/algorithms";
import { RealTimeToVideoTime, RealDurationToVideoDuration, GetTimescaleSeconds, GetMinGapSize } from "./TimeMap";
import { MuxVideo } from "mp4-typescript";
import { UnionUndefined } from "../util/misc";


export function GetVideoTimes(
    // First time is keyframe at or before or after startTime
    startTime: number,
    frameTargetCount: number,
    // Inclusive
    maxReceivedFrameTime: number|undefined|null,
    nalInfos: NALInfoTime[],
): { times: NALInfoTime[], nextKeyFrameTime: number|undefined } {
    if(nalInfos.length === 0) {
        console.error(`Called GetVideoTimes with empty nalInfos.`);
        return {
            times: [],
            nextKeyFrameTime: undefined
        };
    }
    if(maxReceivedFrameTime && maxReceivedFrameTime <= startTime) {
        throw new Error(`Invalid maxReceivedFrameTime. startTime ${startTime}, maxReceivedFrameTime: ${maxReceivedFrameTime}`);
    }

    // Actually, we also need to impose a maxgap size in the times choosen. Because if we make a video span across
    //  two far apart videos we tie though gaps together, which is odd, AND breaks the video by making one frame
    //  stay on the screen for too long (days, which breaks our 32-bit timescale based frame duration encoding).
    //  - Well, and not to mention, we don't want to play the video gaps, we want to skip them.
    let rate = nalInfos[0].rate;
    let minGap = GetMinGapSize(rate);

    function getNextKeyFrameIndex(index: number): number {
        index++;
        while(index < nalInfos.length && nalInfos[index].type !== NALType.NALType_keyframe) {
            index++;
        }
        return index;
    }

    let firstNalIndex: number;
    {
        let index: number;
        index = findAtOrBeforeOrAfterIndex(nalInfos, startTime, x => x.time);
        
        // Go to the last key frame
        let startTimeIndex = index;
        while(index >= 0 && nalInfos[index].type !== NALType.NALType_keyframe) {
            index--;
        }
        if(index >= 0 && nalInfos[index].type === NALType.NALType_keyframe) {
            // Get more frames if we had to move back to find a keyframe.
            frameTargetCount += startTimeIndex - index;
        }
        
        // If there isn't a key frame before our index, look after
        if(index < 0 || index < nalInfos.length && nalInfos[index].type !== NALType.NALType_keyframe) {
            index = getNextKeyFrameIndex(index);
        }
        firstNalIndex = index;
    }

    let nextKeyFrameTime: number|undefined = undefined;
    let index = firstNalIndex;
    while(index < nalInfos.length) {
        let curCount = index - firstNalIndex;
        let nextNal = UnionUndefined(nalInfos[index + 1]);
        if(!nextNal) break;
        if((curCount >= frameTargetCount || (nextNal.time - nalInfos[index].time) >= minGap) && nextNal.type === NALType.NALType_keyframe) {
            nextKeyFrameTime = nextNal.time;
            break;
        }
        if(maxReceivedFrameTime && nextNal.time >= maxReceivedFrameTime) {
            nextKeyFrameTime = maxReceivedFrameTime;
            break;
        }
        index++;
    }

    return {
        times: nalInfos.slice(firstNalIndex, index + 1),
        nextKeyFrameTime,
    }
}

export async function muxVideo(nals: NALHolderMin[], rate: number, speed: number, nextKeyFrameTime: number|undefined): Promise<MP4Video> {
    let keyframe = nals[0];
    if(keyframe.type !== NALType.NALType_keyframe) {
        throw new Error(`MuxVideo called incorrectly, did not start with keyframe?`);
    }
    let frameInfos = nals.map((x, i) => {
        let nextTime = x.time;
        if(i < nals.length - 1) {
            let next = nals[i + 1];
            nextTime = next.time;
        }

        let frameDurationInSeconds = RealDurationToVideoDuration(nextTime - x.time, rate) / 1000;
        
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
