// Change the epoch... otherwise slowed down video will run into the year 2038 problem with the chrome player...
let newEpoch = +new Date(2016, 0, 1);
export function RealTimeToVideoTime(realTime: number, rate: number, speedMultiplier: number) {
    let timescale = 1 / rate / speedMultiplier;
    return (realTime - newEpoch) * timescale;
}
export function VideoTimeToRealTime(videoTime: number, rate: number, speedMultiplier: number) {
    let timescale = 1 / rate / speedMultiplier;
    return videoTime / timescale + newEpoch;
}

export function RealDurationToVideoDuration(realDuration: number, rate: number, speedMultiplier: number) {
    let timescale = 1 / rate / speedMultiplier;
    return realDuration * timescale;
}
export function VideoDurationToRealDuration(videoDuration: number, rate: number, speedMultiplier: number) {
    let timescale = 1 / rate / speedMultiplier;
    return videoDuration / timescale
}

export function GetTimescale(rate: number, speedMultiplier: number): number {
    // 3 digits of ms precision (as timescale is in seconds)
    return Math.floor(1000 * rate * speedMultiplier * 1000);
}

export function RoundRecordTime(time: number): number {
    return Math.floor(time * 1000) / 1000;
}

export function GetMinGapSize(rate: number): number {
    // 10 seconds of disconnect time, and then minimum of 1/3FPS
    let minGapSize = Math.min(10 * 1000, 3000 * rate);
    return minGapSize;
}