import { createCancelPending } from "../algs/cancel";
import { ConnectToServer } from "ws-class";
import { findAtOrBefore, findAfter, insertIntoList, insertIntoListMap, insertIntoListMapped } from "../util/algorithms";
import { UnionUndefined } from "../util/misc";
import { GetVideoFPSEstimate, GetMinGapSize, GetRangeFPSEstimate } from "../NALStorage/TimeMap";
import { reduceRanges } from "../NALStorage/rangeMapReduce";
import { Deferred } from "pchannel";

export class VideoDownloader {
    private data: {
        [rate: number]: {
            ReceivedRanges: NALRange[];
            Videos: MP4Video[];
            VideoFrames: NALInfoTime[];
        }
    } = {};

    constructor(
        private onVideoReceived: (video: MP4Video) => void,
        private onReceivedChanged: (rate: number, receivedRanges: NALRange[]) => void,
        private onlyTimes?: boolean
    ) { }

    private server = ConnectToServer<IHost>({
        port: 7060,
        host: "localhost",
        bidirectionController: this
    });

    public Rates = this.server.GetRates();


    public DownloadVideo = createCancelPending(
        () => this.server.CancelVideo(),
        (doAsyncCall, isCancelError) =>
    async (rate: number, startTime: number, minFrames: number): Promise<{video?: MP4Video; nextTime: number|undefined}|"FINISHED"> => {

        let nextReceiverRange: NALRange|undefined;
        let startTimeExclusive = false;

        let summaryObj = this.GetInfo(rate);
        {
            let range = findAtOrBefore(summaryObj.ReceivedRanges, startTime, x => x.firstTime);
            if(range && range.lastTime >= startTime) {
                let fpsEstimate = GetRangeFPSEstimate(range);
                if((range.lastTime - startTime) / fpsEstimate >= minFrames) {
                    return { nextTime: range.lastTime };
                }
                startTime = range.lastTime;
            }
        }
        {
            let range = findAfter(summaryObj.ReceivedRanges, startTime, x => x.firstTime);
            if(range) {
                nextReceiverRange = range;
            }
        }
        {
            let range = findAtOrBefore(summaryObj.ReceivedRanges, startTime, x => x.firstTime);
            if(range && range.lastTime > startTime) {
                startTimeExclusive = true;
            }
        }

        // We always have to make a request, as we don't know what rate we will end up using
        console.log(`Requesting video starting at ${startTime}`);

        let video = await doAsyncCall(this.server.GetVideo,
            startTime,
            minFrames,
            nextReceiverRange && nextReceiverRange.firstTime,
            rate,
            startTimeExclusive,
            this.onlyTimes
        );

        if(video === "CANCELLED" || video === "VIDEO_EXCEEDS_LIVE_VIDEO") {
            console.log(`Video returned ${video}`);
            return "FINISHED";
        }

        let nextTime: number|undefined;
        if(video === "VIDEO_EXCEEDS_NEXT_TIME") {
            if(!nextReceiverRange) {
                throw new Error(`Impossible, the nextRangeLookup must have mutated, as the server says it used the next time and found there was no video before that time.`);
            }

            /*
            reduceRanges(
                [{ firstTime: startTime, lastTime: nextReceiverRange.firstTime, frameCount: nextReceiverRange.frameCount }],
                summaryObj.ReceivedRanges,
                false,
                GetMinGapSize(rate)
            );
            */
            this.onReceivedChanged(rate, summaryObj.ReceivedRanges);

            return "FINISHED";
        }

        if(video) {
            nextTime = video.nextKeyFrameTime;
        }

        let times = video.frameTimes;
        reduceRanges(
            [{ firstTime: times[0].time, lastTime: nextTime || times.last().time, frameCount: times.length }],
            summaryObj.ReceivedRanges,
            false,
            GetMinGapSize(rate)
        );

        for(let frame of video.frameTimes) {
            insertIntoListMap(summaryObj.VideoFrames, frame, x => x.time, "warn");
        }
        insertIntoListMap(summaryObj.Videos, video, x => x.frameTimes[0].time, "warn");

        this.onVideoReceived(video);
        this.onReceivedChanged(rate, summaryObj.ReceivedRanges);

        return {video, nextTime};
    });

    public GetInfo(rate: number) {
        let summaryObj = this.data[rate];
        if(!summaryObj) {
            summaryObj = this.data[rate] = { ReceivedRanges: [], Videos: [], VideoFrames: [] };
        }
        return summaryObj;
    }
}