import { createCancelPending } from "../algs/cancel";
import { ConnectToServer } from "ws-class";
import { findAtOrBefore, findAfter, insertIntoList, insertIntoListMap, insertIntoListMapped, removeFromListMap, findAtOrBeforeIndex, findAt, findAtIndex, sort } from "../util/algorithms";
import { UnionUndefined } from "../util/misc";
import { GetVideoFPSEstimate, GetMinGapSize, GetRangeFPSEstimate } from "../NALStorage/TimeMap";
import { reduceRanges, removeRange } from "../NALStorage/rangeMapReduce";
import { Deferred } from "pchannel";
import { sum } from "../util/math";

export class VideoDownloader implements IBrowserReceiver {
    public data: {
        [rate: number]: {
            ReceivedRanges: NALRange[];
            Videos: MP4Video[];
            VideoFrames: NALInfoTime[];

            addTimes: { addTime: number; video: MP4Video; range: NALRange; }[];
            addTimesSortedByFirstTime: { addTime: number; firstTime: number; }[];
            // Only includes videos that have fixed times
            fixedReceivedRanges: NALRange[];
        }
    } = {};
    
    public Rates: number[] = [];
    private server = ConnectToServer<IHost>({
        port: 7060,
        host: "localhost",
        bidirectionController: this
    });

    constructor(
        private onVideoReceived: (video: MP4Video) => void,
        private onVideoRemoved: (video: MP4Video) => void,
        private onReceivedChanged: (rate: number, receivedRanges: NALRange[]) => void,
        private onlyTimes?: boolean,
        private forPreview?: boolean,
        // TODO: If this isn't enough to fill up the play buffer, the play buffer will basically break.
        private videoStorageSize = 1024 * 1024 * 10
    ) {
        (async () => {
            try {
                let initialRates = await this.server.SyncRates();
                for(let rate of initialRates) {
                    this.Rates.push(rate);
                }
                sort(this.Rates, x => x);
            } catch(e) {
                console.error(`Error when syncing rates. This is really bad. ${e}`);
            }
        })();
        
        //(window as any)["videos"] = this.GetInfo(1).Videos;
    }

    
    public acceptNewTimeRanges_VOID(rate: number, ranges: NALRange[]): void {
        // Not used
    }
    public onDeleteTime(rate: number, deleteTime: number): void {
        // Not used
    }
    public onNewRate(rate: number): void {
        if(this.Rates.indexOf(rate) >= 0) return;
        this.Rates.push(rate);
        sort(this.Rates, x => x);
    }

    public DownloadVideo = createCancelPending(
        () => this.server.CancelVideo(),
        (doAsyncCall, isCancelError) =>
    async (rate: number, startTime: number, minFrames: number, live = false): Promise<{video?: MP4Video; nextTime: number|undefined}|"FINISHED"> => {

        if(rate === undefined) {
            console.log("download video", {rate}, new Error().stack);
        }

        let nextReceiverRange: NALRange|undefined;
        let startTimeExclusive = false;

        let summaryObj = this.GetInfo(rate);
        {
            // If we have a video at startTime return it, and it's end as the nextTime.
            let videoIndex = findAtOrBeforeIndex(summaryObj.Videos, startTime, x => x.frameTimes[0].time);
            let video = summaryObj.Videos[videoIndex];
            // Only return it if it covers the requested time, and never return it if it has no nextKeyFrameTime (and so
            //  us unfinished). This forces preview logic to keep requesting data, instead of getting stuck of incomplete data.
            if(video && video.frameTimes.last().time >= startTime && video.nextKeyFrameTime) {
                let nextTime: number|undefined;
                let nextVideo = summaryObj.Videos[videoIndex + 1];
                if(nextVideo) {
                    nextTime = nextVideo.frameTimes[0].time;
                } else {
                    nextTime = video.nextKeyFrameTime;
                }

                return { video: video, nextTime };
            }
        }
        {
            let range = findAfter(summaryObj.fixedReceivedRanges, startTime, x => x.firstTime);
            if(range) {
                nextReceiverRange = range;
            }
        }
        {
            let range = findAtOrBefore(summaryObj.fixedReceivedRanges, startTime, x => x.firstTime);
            if(range && range.lastTime > startTime) {
                startTimeExclusive = true;
            }
        }


        let video = await doAsyncCall(this.server.GetVideo,
            startTime,
            minFrames,
            live ? "live" : nextReceiverRange && nextReceiverRange.firstTime,
            rate,
            startTimeExclusive,
            this.onlyTimes,
            this.forPreview
        );

        if(video === "CANCELLED" || video === "VIDEO_EXCEEDS_LIVE_VIDEO") {
            console.log(`Video returned ${video}`);
            return "FINISHED";
        }

        let nextTime: number|undefined;
        if(video === "VIDEO_EXCEEDS_NEXT_TIME") {
            if(!nextReceiverRange) {
                //throw new Error(`Impossible, the server has no data after time. startTime: ${startTime}`);
            }

            return "FINISHED";
        }

        if(video) {
            nextTime = video.nextKeyFrameTime;

            if(!this.forPreview) {
                console.log(`downloaded rate ${rate}, next time ${nextTime}, ${video.frameTimes[0].addSeqNum}`, video.frameTimes.map(x => x.time));
            }
        }

        let times = video.frameTimes;

        let nextRangeTime = times.last().time;
        if(nextTime && (nextTime - nextRangeTime < GetMinGapSize(rate))) {
            // Maybe set nextTime to undefined so we don't jump to the next segment, as the chances of wanting to play skipping
            //  large segments gaps is low. But then again... downloading the data doesn't hurt.
            nextRangeTime = nextTime;
        }

        let range: NALRange = { firstTime: times[0].time, lastTime: nextRangeTime, frameCount: 0 };

        //if(this.forPreview) {
            let previousIndex = findAtIndex(summaryObj.addTimesSortedByFirstTime, range.firstTime, x => x.firstTime);
            if(previousIndex >= 0) {
                let addTime = summaryObj.addTimesSortedByFirstTime[previousIndex].addTime;
                this.removeVideo(rate, addTime);
            }
        //}

        range = reduceRanges(
            [range],
            summaryObj.ReceivedRanges,
            false,
            GetMinGapSize(rate)
        )[0];
        if(video.nextKeyFrameTime) {
            reduceRanges(
                [range],
                summaryObj.fixedReceivedRanges,
                false,
                GetMinGapSize(rate)
            );
        }

        for(let frame of video.frameTimes) {
            insertIntoListMap(summaryObj.VideoFrames, frame, x => x.time, "warn");
        }
        insertIntoListMap(summaryObj.Videos, video, x => x.frameTimes[0].time, "warn");
        this.addVideo(rate, Date.now(), video, range);

        // If the video storage exceeds a certain amount, start evicting old videos.
        let curBytes = sum(summaryObj.Videos.map(x => x.mp4Video.length));

        while(curBytes > this.videoStorageSize && summaryObj.addTimes.length > 0) {
            this.removeVideo(rate, summaryObj.addTimes[0].addTime);
            curBytes = sum(summaryObj.Videos.map(x => x.mp4Video.length));
        }

        this.onVideoReceived(video);
        this.onReceivedChanged(rate, summaryObj.ReceivedRanges);

        return {video, nextTime};
    });

    private addVideo(rate: number, addTime: number, video: MP4Video, range: NALRange): void {
        let summaryObj = this.GetInfo(rate);

        while(findAt(summaryObj.addTimes, addTime, x => x.addTime)) {
            addTime += 0.01;
        }
        insertIntoListMap(summaryObj.addTimes, { addTime, video, range }, x => x.addTime);
        insertIntoListMap(summaryObj.addTimesSortedByFirstTime, { addTime, firstTime: video.frameTimes[0].time }, x => x.firstTime);
    }

    private removeVideo(rate: number, addTime: number) {
        let summaryObj = this.GetInfo(rate);
        let videoAddObj = findAt(summaryObj.addTimes, addTime, x => x.addTime);
        if(!videoAddObj) {
            throw new Error(`No video added at time ${addTime}`);
        }

        removeFromListMap(summaryObj.addTimes, addTime, x => x.addTime);
        removeFromListMap(summaryObj.addTimesSortedByFirstTime, videoAddObj.video.frameTimes[0].time, x => x.firstTime);

        removeFromListMap(summaryObj.Videos, videoAddObj.video.frameTimes[0].time, x => x.frameTimes[0].time);

        for(let frameTime of videoAddObj.video.frameTimes) {
            removeFromListMap(summaryObj.VideoFrames, frameTime.time, x => x.time);
        }

        removeRange(videoAddObj.range, summaryObj.ReceivedRanges, false);

        // TODO: Warn if removing a permanent video, this should really only be for temporary videos (with undefined nextTimes).
        // fixed video should never need to be removed
        //removeRange(videoAddObj.range, summaryObj.fixedReceivedRanges, false);

        this.onVideoRemoved(videoAddObj.video);
    }

    public GetInfo(rate: number) {
        let summaryObj = this.data[rate];
        if(!summaryObj) {
            summaryObj = this.data[rate] = { ReceivedRanges: [], fixedReceivedRanges: [], Videos: [], VideoFrames: [], addTimes: [], addTimesSortedByFirstTime: [] };
        }
        return summaryObj;
    }
}