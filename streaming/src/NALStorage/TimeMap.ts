// Change the epoch... otherwise slowed down video will run into the year 2038 problem with the chrome player...
let newEpoch = +new Date(2016, 0, 1);
export function RealTimeToVideoTime(realTime: number, rate: number) {
    let timescale = 1 / rate;
    // * 1000 to prevent decimal places from appearing during the subtraction, and because realTimes should only
    //  have millisecond accuracy anyway
    return Math.round(realTime * 1000 - newEpoch * 1000) / 1000 * timescale;
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
    // 3 digits of ms precision (as timescale is in seconds)
    let max = Math.pow(2, 32) - 1;
    let value = Math.floor(1000 * rate * 1000);
    return Math.min(max, value);
}

export function RoundRecordTime(time: number): number {
    return Math.floor(time * 1000) / 1000;
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