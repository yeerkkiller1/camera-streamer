// Change the epoch... otherwise slowed down video will run into the year 2038 problem with the chrome player...
let newEpoch = +new Date(2016, 0, 1);
export function RealTimeToVideoTime(realTime: number, rate: number) {
    let timescale = 1 / rate;
    return (realTime - newEpoch) * timescale;
}
export function VideoTimeToRealTime(videoTime: number, rate: number) {
    let timescale = 1 / rate;
    return videoTime / timescale + newEpoch;
}

export function RealDurationToVideoDuration(realDuration: number, rate: number) {
    let timescale = 1 / rate;
    return realDuration * timescale;
}
export function VideoDurationToRealDuration(videoDuration: number, rate: number) {
    let timescale = 1 / rate;
    return videoDuration / timescale;
}

export function GetTimescaleSeconds(rate: number): number {
    let max = Math.pow(2, 31);
    // Timescale has 1000 units per video second, which should be adequate for our uses (at maximum pack that is 1000fps
    //  video time, but as complete packing require adjustment of frame times to not alias it is probably more like 300-500,
    //  which is definitely as much as we will capture and store in any rate).
    //let value = 1000 * rate;

    // We need a large timescale to prevent errors from building up in sample_durations
    let value = 1000 * 1000;
    return Math.min(max, value);
}

export function RoundRecordTime(time: number): number {
    return Math.floor(time);
}

export function GetMinGapSize(rate: number): number {
    // 10 seconds of disconnect time, and then minimum of 1/3FPS
    let minGapSize = Math.max(10 * 1000, 3000 * rate);
    return minGapSize;
}

export function GetVideoFPSEstimate(curVideo: MP4Video): number {
    return GetRangeFPSEstimate({ firstTime: curVideo.frameTimes[0].time, lastTime: curVideo.frameTimes.last().time, frameCount: curVideo.frameTimes.length });
}
export function GetRangeFPSEstimate(range: NALRange): number {
    if(range.frameCount <= 1) {
        // Eh...
        return 10;
    }
    return 1000 / ((range.lastTime - range.firstTime) / (range.frameCount - 1) * range.frameCount) * range.frameCount;
}