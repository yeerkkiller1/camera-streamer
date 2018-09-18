import { g, PChan, TransformChannel, TransformChannelAsync, SetTimeoutAsync, Deferred } from "pchannel";

import * as React from "react";
import * as ReactDOM from "react-dom";

import { ConnectToServer } from "ws-class";
import { setTimeServer, getTimeSynced } from "../util/time";

// For polyfills
import "../util/math";
import { binarySearchMapped, binarySearchMap, insertIntoListMap, findAtOrBefore, findAfter, findAtOrBeforeIndex, findClosest, findClosestIndex, findAtOrBeforeOrAfter, findAtOrBeforeOrAfterIndex, findAt, findAtOrAfter, sort } from "../util/algorithms";
import { formatDuration } from "../util/format";
import { RangeSummarizer } from "../Video/RangeSummarizer";
import { VideoHolder, IVideoHolder } from "../Video/VideoHolder";
import { PollLoop } from "./PollLoop";
import { RealTimeToVideoTime, VideoDurationToRealDuration, RealDurationToVideoDuration, GetMinGapSize, GetRangeFPSEstimate, GetVideoFPSEstimate } from "../NALStorage/TimeMap";
import { reduceRanges, deleteRanges } from "../NALStorage/rangeMapReduce";
import { UnionUndefined, mapObjectValues } from "../util/misc";

import "./PlayerPage.less";
import { getInitialCheckboxValue, Checkbox, getIntialInputNumberValue, setInputValue, getInputValue } from "../util/Input";
import { GetVideoFrames, GetVideoFramesInternal } from "../Video/getVideoFrame";
import { createCancelPending } from "../algs/cancel";
import { VideoDownloader } from "../Video/VideoDownloader";

let VideoHolderClass = VideoHolder;


interface IProps { }

interface RangeSummaryObj {
    serverRanges: NALRange[];
    rangesLoaded: Deferred<void>;
}
interface IState {
    rate: number;

    targetFPS?: number;

    // Calculated as we play the video to reach targetFPS
    playRate: number;

    // This is not observational, it is intent based. So when the users toggles live, it should stay live unless they seek
    //  or pause. This lets us store this, and then continue playing live on refresh.
    isLive: boolean;

    rates: number[];

    currentPlayTime: number;
    targetPlayTime: number;

    rateSummaries: {
        [rate: number]: RangeSummaryObj|undefined
    };

    // Camera info
    formats: v4l2camera.Format[];
    formatIndex: number;
    requestedFPS: number;
    iFrameRate: number;
    bitrateMbps: number;
}

const rateConst = "rateConst";
const targetPlayTimeConst = "targetPlayTimeConst";
const isLiveConst = "isLiveConst";

// todonext
//  - Implement live streaming
//      X Then make the browser stable
//      X Fix memory usage
//      X make preview view stable and working with live streaming
//      - sometimes live view gets way too far behind, even though we have code that should fix that? So... fix that code.
//      - sometimes server throws an out of range error when encoding. Maybe there are cases when certain time offsets can exceed 32 bits?
//      - sometimes "waiting for firstNal" infinitely (or at least for many times) loops
//      X when playing live the view should probably "center" further towards the right, otherwise there will always be a gap on the right
//          side of the viewport (which means less preview images will be shown than possible).
//  - Camera auto-reconnecting
//      - Store a LIMITED number of frames when disconnected from the server, letting us
//          recover from a disconnection (while making sure the live stream can also start immediately),
//          but not run out of memory when we are disconnected from the server.
//      - (make the camera stable)
//  - Make the server stable

//todonext
//  S3
//  - Rolling buffers of varying sizes for different rates
//  - AND multiple sources of different access cost 
//  - Large chunks of immutable data
//  - Local index of what chunks exist, but indexes of video within chunks must also be stored remotely.
// - Add security
// - Put on digital ocean and fix and CPU/MEM/HDD usage issues

//todonext
//  - Selected ranges (maybe playing with auto looping?)
//  - very interesting stuff happening at 2018 Aug 10 06:46:00 am (the dingy hits another boat?)
//  - shutter settings? or whatever changes at around 2018 Aug 10 10:20:20 am
//  - Finding the extra frame of video switching would be useful.
//  - Should we put the track bar at the bottom or top? And if the bottom, should we move it there now?
//  - In preview grid or preview bar make each frame a timelapsed repeating video


//todonext
// - Increased FPS at higher rates (which lowers the rate?)
//      - Maybe let us set a minimum FPS? It would be nice if we could estimate FPS and show that somehow (on the timeline?)
//      - Estimate and show the FPS based on the current time, and do rate min event perceivable calculations from that (and rewrite
//          the rate control buttons to just min perceivable time and rate)
//          - We can see the current MP4Video and get the fps of that
//      - Maybe also show time to watch current view for each rate?
// - Custom video controls, with ability to jump by a single frame
// - Picture grid behavior
//      - Download a lot of video (of a clock preferrably), and then use that to test this mode
// - Maybe add frame marking ability? Or region marking?
// - S3 storage.
// - Days of test data http://output.jsbin.com/yewodox/4
export class PlayerPage extends React.Component<IProps, IState> implements IBrowserReceiver {
    state: IState = {
        rates: [],
        rate: getIntialInputNumberValue(rateConst, 1),
        //targetFPS: 60,

        // Calculated
        playRate: 1,
        isLive: getInitialCheckboxValue(isLiveConst),


        currentPlayTime: 0,
        targetPlayTime: getIntialInputNumberValue(targetPlayTimeConst, 0),

        rateSummaries: { },


        formats: [],
        // -1 is valid, we use this like: .slice(index)[0]
        //*
        formatIndex: 0, // 0 = 640x480, 5 = 800x600, 6 = 1280x720, 7=1920x1080
        requestedFPS: 10,
        iFrameRate: 2,
        bitrateMbps: 10 / 1000,
        //*/

        // Full resoluation, max fps, low quality
        /* This appears to work well, although IF a get a better camera I might want to lower the fps
        //      increase the iFrameRate, and increase the bitrate.
        formatIndex: -1, // 0 = 640x480, 5 = 800x600, 6 = 1280x720, 7=1920x1080
        requestedFPS: 5,
        iFrameRate: 5,
        bitrateMbps: 10 / 1000,
        //*/

        // Full resolution, low fps, max quality
        /*
        formatIndex: -1, // 0 = 640x480, 5 = 800x600, 6 = 1280x720, 7=1920x1080
        requestedFPS: 0.5,
        iFrameRate: 2,
        bitrateMbps: 8,
        //*/
    };

    videoCache: { [speed: number]: IVideoHolder|undefined|null } = {};

    server = ConnectToServer<IHost>({
        port: 7060,
        host: "localhost",
        bidirectionController: this
    });

    constructor(...args: any[]) {
        // This should be fixed in typescript 3.0 with https://github.com/Microsoft/TypeScript/issues/4130 .
        //@ts-ignore
        super(...args); 

        setTimeServer(this.server);
    }

    componentWillUpdate(nextProps: IProps, nextState: IState) {
        setInputValue(rateConst, nextState.rate);
        setInputValue(targetPlayTimeConst, nextState.targetPlayTime);
        setInputValue(isLiveConst, nextState.isLive);
    }

    unmountCallbacks: (() => void)[] = [];
    componentDidMount() {
        this.syncVideoInfo();
    }
    componentWillUnmount() {
        console.log(`componentWillUnmount`);
        for(let callback of this.unmountCallbacks) {
            try {
                callback();
            } catch(e) {
                console.error(`Error in unmountCallbacks`);
            }
        }
        this.streamVideo.cancel();
    }

    componentWillMount() {
        console.log(`componentWillMount`);
    }

    loadedVideoHolder(videoHolder: IVideoHolder|null, rate: number) {
        if(!videoHolder) return;
        if(this.videoCache[rate] === videoHolder) return;

        console.log(`LoadedVideo ${videoHolder && (videoHolder as any).element}`);
        this.videoCache[rate] = videoHolder;
        if(rate === this.state.rate) {
            videoHolder.SeekToTime(this.state.currentPlayTime);
        }
    }

    onNewRate(rate: number): void {
        let { rates } = this.state;
        if(rates.indexOf(rate) >= 0) return;

        rates.push(rate);
        sort(rates, x => x);

        (async () => {
            try {
                let ranges = await this.server.syncTimeRanges(rate);
                this.addServerRanges(rate, ranges);
                this.getSummaryObj(rate).rangesLoaded.Resolve();
            } catch(e) {
                console.error(`Error in syncing ranges, this is a big problem. ${e.stack}`);
            }
        })();
    }
    async syncVideoInfo() {
        let rates = await this.server.SyncRates();
        console.log({rates});
        for(let rate of rates) {
            this.onNewRate(rate);
        }

        this.setRate(this.state.rate, true);
    }
    
    private getSummaryObj(rate: number): RangeSummaryObj {
        let summary = this.state.rateSummaries[rate];
        if(!summary) {
            summary = this.state.rateSummaries[rate] = { serverRanges: [], rangesLoaded: new Deferred<void>() };
        }
        return summary;
    }
    // Called automatically when video is returned that happens to have a different rate.
    async setRate(rate: number, init = false) {
        if(!init && rate === this.state.rate) return;

        // And finally. Now get the real time they are seeked to, and get the same frame in the other rate.
        // Do we want to alias the time when we switch rates? This means the frame might jump, but will stablize?
        //  We want to down alias. So, if we are on a certain rate, we should move as close to the frame time of the
        //  current frame as possible, so we stick to it when lowering the rate (adding more precision).
        let seekTime = this.state.targetPlayTime;

        let oldRate = this.state.rate;
        // Seek in the old video, because... our frame detection isn't perfect, rounding may cause us to be off
        //  in very rare cases. So if we force it to a nice time it means the video will occassionally jump,
        //  but never stay in a bad state.
        {
            let { VideoFrames } = this.downloader.GetInfo(oldRate);
            
            let timeObj = findClosest(VideoFrames, seekTime, x => x.time);
            if(timeObj) {
                // Actually, it looks like rounding is to the closest frame? So just use the exact time.
                seekTime = timeObj.time;
            }
        }

        let videoHolder = this.videoCache[rate];
        if(videoHolder) {
            videoHolder.SeekToTime(seekTime);
        }

        await this.getServerRanges(rate);

        this.state.rate = rate;
        (async () => {
            this.setState({ rate: rate });
            try {
                this.streamVideo(seekTime, this.state.isLive, this.state.isLive);
            } catch(e) {
                if(!this.streamVideo.isCancelError(e)) {
                    console.error(e);
                }
            }
        })();
    }

    getServerRanges = async (rate: number): Promise<NALRange[]> => {
        let obj = this.getSummaryObj(rate);

        if(obj.rangesLoaded.Value()) {
            return obj.serverRanges;
        }

        await obj.rangesLoaded.Promise();

        return obj.serverRanges;
    };

    acceptNewTimeRanges_VOID(rate: number, ranges: NALRange[]): void {
        this.addServerRanges(rate, ranges);
    }

    onDeleteTime(rate: number, deleteTime: number): void {
        let summaryObj = this.getSummaryObj(rate);
        deleteRanges(summaryObj.serverRanges, deleteTime);
        this.setState({ rateSummaries: this.state.rateSummaries });
    }

    private addServerRanges(rate: number, ranges: NALRange[]) {
        ranges = JSON.parse(JSON.stringify(ranges));
        let summaryObj = this.getSummaryObj(rate);
        let minGapSize = GetMinGapSize(rate);
        reduceRanges(ranges, summaryObj.serverRanges, false, minGapSize);
        this.setState({ rateSummaries: this.state.rateSummaries });
    }



    async startCamera() {
        let formats = await this.server.getFormats();
        this.setState({ formats });

        let format = formats.slice(this.state.formatIndex)[0];
        console.log(formats);

        let fps = this.state.requestedFPS;

        await this.server.setFormat(
            fps,
            this.state.iFrameRate,
            this.state.bitrateMbps,
            format
        );
    }

    // TODO: We need to remove video, or else a live stream will eventually use all our memory.
    //  We will need to maintain received and requested lists when we delete video, so we know to download it again.
    //  Also, consider saving video to the local disk, as a few GB on the local disk is probably okay,
    //  and infinitely preferrable to a few GB in memory. And then when we store data on disk, add
    //  disk deletion code, so we don't fill up the disk (or our allocated space at least).


    downloader = new VideoDownloader(
        video => {
            let videoHolder = UnionUndefined(this.videoCache[video.rate]);
            if(videoHolder) {
                videoHolder.AddVideo(video);
            }
            let { targetFPS } = this.state;

            if(targetFPS) {
                let fps = GetVideoFPSEstimate(video);
                let playRate = targetFPS / fps / this.state.rate;
                if(playRate < 1 / 16) {
                    playRate = 1 / 16;
                }
                if(playRate > 16) {
                    playRate = 16;
                }
                this.setState({ playRate });
            }
        },
        video => {
            let videoHolder = UnionUndefined(this.videoCache[video.rate]);
            if(videoHolder) {
                videoHolder.RemoveVideo(video);
            }
        },
        () => {
            this.forceUpdate();
        }
    );

    streamVideo = createCancelPending(
        () => this.server.CancelVideo(),
        (doAsyncCall, isCancelError) =>
    async (startTime: number, startPlaying = false, live = false) => {

        this.setState({ isLive: live });

        //if(true as boolean) return;
        console.log(`streamVideo ${startTime}`);

        this.setState({ targetPlayTime: startTime, currentPlayTime: startTime });

        {
            let videoHolder = this.videoCache[this.state.rate];
            if(videoHolder) {
                videoHolder.SeekToTime(startTime);
            }
        }

        const isCurrentTimeClose = (time: number) => {
            let videoHolder = this.videoCache[this.state.rate];
            if(!videoHolder) return false;
            let videoTimeOff = (videoHolder.GetCurrentTime() - time) / this.state.rate / this.state.playRate;
            return Math.abs(videoTimeOff) < 1000;
        };

        let initialStartTime = startTime;
        if(!isCurrentTimeClose(initialStartTime)) {
            // For some reason seeking doesn't always work on fresh data. So just poll and keep trying to seek.
            setTimeout(async () => {
                try {
                    while(true) {
                        if(isCurrentTimeClose(initialStartTime)) {
                            // When we are within 1 second of play time of the target time, stop seeking. Otherwise wait, and try seeking again
                            break;
                        }
                        await doAsyncCall(SetTimeoutAsync, 100);
                        
                        let videoHolder = this.videoCache[this.state.rate];
                        if(!videoHolder) break;
                        videoHolder.SeekToTime(initialStartTime);
                    }
                } catch(e) {
                    if(!isCancelError(e)) {
                        console.error(e);
                    }
                }
            });
        }

        // TODO: Calculate this, as we need to balance it with muxing time. If the play rate is too high (or the CPU is too slow),
        //  then this needs to be higher, to reduce mux overhead as a percentage.
        let minFrames = 10;
        // TODO: Definitely calculate this based on i frame rate and current fps.
        let minPlayBuffer = 3000;

        while(true) {
            let { serverRanges } = this.getSummaryObj(this.state.rate);
            let serverRangeIndex = findAtOrBeforeOrAfterIndex(serverRanges, startTime, x => x.firstTime);
            let serverRange = serverRanges[serverRangeIndex];
            if(!live && serverRange && startTime >= serverRange.lastTime && serverRangeIndex === serverRanges.length - 1) {
                console.log("Reached end of video, stopping download loop");
                break;
            }

            let timeObj = await doAsyncCall(this.downloader.DownloadVideo, this.state.rate, startTime, minFrames, live);

            // TODO: Maybe add playback support (so not here, in an independent loop) for jumping video gaps
            //  during playback (as the regular video player won't jump gaps).

            // No more video available, so stop. (Probably hit the live data, and we don't have live video playing support right now)
            // Reached the end of the video
            if(timeObj === "FINISHED" || timeObj.nextTime === undefined) {
                // TODO: Switch to live video.
                console.log(`Reached end of video, but switching from non-live to live video isn't coded yet. ${timeObj}`);
                return;
            }

            let holder = this.videoCache[this.state.rate];
            if(startPlaying && holder && !holder.IsPlaying()) {
                let holderChecked = holder;
                await doAsyncCall(() => holderChecked.Play());
            }

            if(live && holder && this.state.currentPlayTime < startTime - minPlayBuffer * 1.5) {
                this.setState({targetPlayTime: startTime});
                holder.SeekToTime(startTime);
            }
            
            let nextTime = timeObj.nextTime;
            while(true) {
                let realTimeBuffer = 0;

                if(nextTime < this.state.currentPlayTime) {
                    let curRange = findAtOrBeforeOrAfter(this.downloader.GetInfo(this.state.rate).ReceivedRanges, this.state.currentPlayTime, x => x.firstTime);
                    if(curRange && curRange.lastTime >= this.state.currentPlayTime) {
                        realTimeBuffer = curRange.lastTime - this.state.currentPlayTime;
                        nextTime = curRange.lastTime;
                    }
                }

                let delay = RealDurationToVideoDuration(realTimeBuffer, this.state.rate) / this.state.playRate - minPlayBuffer;
                if(delay > 0) {
                    delay = Math.max(1000, delay);
                    delay = Math.min(1000, delay);
                    console.log(`Waiting ${delay}ms for video position to progress more.`);
                    await doAsyncCall(SetTimeoutAsync, delay);
                    // Actually... just delay once. Otherwise we might get in a bad state an infinitely loop (such as if the video stalls, even though it should have enough buffer).
                    // TODO: Figure out what it is stalling, as even if we can jump beyond the stall, it should never be stalling in the first place!
                    break;
                } else {
                    let lastTime = (await this.getServerRanges(1)).last().lastTime;

                    // TODO: Our live stream could probably be even closer to real time if we were more aggressive with this, but it is a lot more
                    //  complicated to determine the difference between a flucuating connection where we are temporarily ahead, and a stable
                    //  connection where we are always a few hundred milliseconds ahead of where we could be playing.
                    //  (the consequence of the way the code works now is that we could be 3-4 seconds behind for good, but the upside is that
                    //  if our connection is unstable is will level out at a 3-4 second delay...)

                    // If we are more than 1.5 * minPlayBuffer from the latest time, and we should be live, we have to move up the current time.
                    if(live && this.state.currentPlayTime < lastTime - minPlayBuffer * 1.5) {
                        console.log("Live feed has become delayed by too much, jumping to the present (this shouldn't occur often, and should only occur because of clock drift).");
                        nextTime = lastTime;
                    }
                    break;
                }
            }

            startTime = nextTime;
        }
    });

    playLive() {
        let startTime = this.getSummaryObj(1).serverRanges.last().lastTime;

        this.streamVideo(startTime, true, true);
    }
    play() {
        let holder = this.videoCache[this.state.rate];
        if(holder) {
            holder.Play();
        }
    }
    pause() {
        let holder = this.videoCache[this.state.rate];
        if(holder) {
            holder.Pause();
        }
        this.streamVideo.cancel();
        this.setState({ isLive: false });
    }

    

    renderPlayInfo(): JSX.Element|null {
        let { formats, formatIndex } = this.state;
        let selectedFormat = formats.slice(formatIndex)[0];

        let videoHolder = this.videoCache[this.state.rate];
        if(!videoHolder) return null;

        let now = getTimeSynced();
        let videoPlayTime = videoHolder.GetCurrentTime();
        let lag = now - videoPlayTime;

        

        return (
            <div>
                <div>Playing {formatDuration(lag)} AGO ({videoPlayTime})</div>
                {selectedFormat && <div>
                    {selectedFormat.width} x {selectedFormat.height}
                </div>}
            </div>
        );
    }

    videoCurrentTimePoll() {
        let videoHolder = this.videoCache[this.state.rate];
        if(videoHolder) {
            let currentPlayTime = videoHolder.GetCurrentTime();
            if(currentPlayTime !== this.state.currentPlayTime) {
                this.setState({ currentPlayTime });
            }
            if(RealDurationToVideoDuration(Math.abs(currentPlayTime - this.state.targetPlayTime), this.state.rate) < 5000) {
                if(currentPlayTime !== this.state.targetPlayTime) {
                    this.setState({ targetPlayTime: currentPlayTime });
                }
            }
        }
    }

    videoProps: IVideoHolder["props"]["videoProps"] = { };
    render() {
        let { videoCache } = this;
        let { rateSummaries, rate, currentPlayTime, isLive } = this.state;

        let curRate = rate;
        videoCache[rate] = videoCache[rate] || null;

        let curVideo = findAtOrBefore(this.downloader.GetInfo(rate).Videos, currentPlayTime, x => x.frameTimes[0].time);

        /*
        if(curVideo) {
            GetVideoFrame(curVideo, curVideo.frameTimes[0].time).then(x => {
                console.log(x);
            });
        }
        */

        return (
            <div className="PlayerPage">
                <PollLoop delay={200} callback={() => this.videoCurrentTimePoll() } />

                <div>
                    Rate: {this.state.rate}
                </div>
                <div>
                    Play rate: {this.state.playRate}
                </div>
                {curVideo && <div>
                    Cur FPS: {GetVideoFPSEstimate(curVideo) * rate * this.state.playRate}
                </div>}
                {curVideo && <div>
                    Rate: {curVideo.frameTimes[0].rate}
                </div>}
                {curVideo && <div>
                    {(GetVideoFPSEstimate(curVideo) * curVideo.mp4Video.length / curVideo.frameTimes.length / 1024 / 1024).toFixed(2)}MB/s
                </div>}
                
                <div>
                    Rates: {this.state.rates.map(rate => (
                        <button key={rate} className={`PlayerPage-rate ${rate === this.state.rate ? "PlayerPage-rate--selected" : ""}`} onClick={() => this.setRate(rate)}>{rate}</button>
                    ))}
                </div>

                <div key="videos">
                {
                    Object.keys(videoCache).map(x => +x).map(rate => {
                        return (
                            <div key={rate} data-rate={rate} className={`PlayerPage-video ${(rate === curRate) && "PlayerPage-video--visible"}`}>
                                {(() => {
                                    let { VideoFrames } = this.downloader.GetInfo(rate)
                                    let index = findClosestIndex(VideoFrames, currentPlayTime, x => x.time)
                                    let timeObj = VideoFrames[index];
                                    
                                    if(timeObj) {
                                        return (
                                            <div>
                                                Play time: {currentPlayTime}, frame time: {timeObj.time}, {VideoFrames.length} frames, index {index}, {VideoFrames[0].time} to {VideoFrames.last().time}
                                            </div>
                                        );
                                    }
                                })()}

                                {(() => {
                                    let rangesObj = rateSummaries[rate];
                                    let videoInfo = this.downloader.GetInfo(rate);
                                    return rangesObj && (
                                        <RangeSummarizer
                                            loadedVideos={videoInfo.Videos}
                                            server={this.server}
                                            debugVideo={false}
                                            currentPlayTime={this.state.currentPlayTime}
                                            targetPlayTime={this.state.targetPlayTime}
                                            onTimeClick={time => this.streamVideo(time)}
                                            isLiveStreaming={this.state.isLive}
                                            rate={rate}
                                            serverRangesFull={this.state.rateSummaries}
                                            receivedRangesFull={this.downloader.data}
                                        />
                                    );
                                })()}

                                <div>
                                    {isLive && "LIVE"}
                                    <button onClick={() => this.playLive()}>Play Live</button>
                                    <button onClick={() => this.play()}>Play</button>
                                    <button onClick={() => this.pause()}>Pause</button>
                                </div>
                                {<VideoHolderClass
                                    playRate={this.state.playRate}
                                    rate={rate}
                                    videoProps={this.videoProps}
                                    ref={x => this.loadedVideoHolder(x, rate)}
                                />}
                            </div>
                        );
                    })
                }
                </div>

                <button onClick={async () => {
                    let currentVideo = findClosest(
                        this.downloader.GetInfo(this.state.rate).Videos,
                        this.state.targetPlayTime,
                        x => x.frameTimes[~~(x.frameTimes.length / 2)].time
                    );

                    if(currentVideo) {
                        let url = URL.createObjectURL(new Blob([currentVideo.mp4Video], { type: "video/mp4" }))
                        let a = document.createElement("a");
                        a.href = url;
                        a.download = "video.mp4";
                        a.innerText = "video";
                        a.click();
                    }
                }}>
                    Download Video
                </button>

                <button onClick={() => this.startCamera()}>Start Camera</button>

                <div>
                    {this.renderPlayInfo()}
                </div>
            </div>
        );
    }
}