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