import { g, PChan, TransformChannel, TransformChannelAsync, SetTimeoutAsync } from "pchannel";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";

import "./main.less";
import { ConnectToServer } from "ws-class";
import { setTimeServer, getTimeSynced } from "../util/time";
import { PixelGraph, Color } from "../util/PixelGraph";
import { min, max, sum } from "../util/math";

// For polyfills
import "../util/math";
import { binarySearchMapped, binarySearchMap, insertIntoListMap } from "../util/algorithms";
import { formatDuration } from "../util/format";
import { RangeSummarizer } from "../NALStorage/RangeSummarizer";
import { VideoHolder, IVideoHolder } from "./VideoHolder";
import { VideoHolderFake } from "./VideoHolderFake";
import { PollLoop } from "./PollLoop";
import { RealTimeToVideoTime } from "../NALStorage/TimeMap";
import { SegmentRanges, reduceRanges } from "../NALStorage/rangeMapReduce";
import { UnionUndefined } from "../util/misc";

let VideoHolderClass = VideoHolder;
//let VideoHolderClass = VideoHolderFake;

function getBitRateMBPS(fps: number, format: v4l2camera.Format) {
    let { height } = format;
    // https://support.google.com/youtube/answer/1722171?hl=en (youtube recommend upload bitrates)
    let lowFps = fps <= 30;
    let bitRateMBPS: number;
    if(height <= 360) {
        bitRateMBPS = lowFps ? 1 : 1.5;
    } else if(height <= 480) {
        bitRateMBPS = lowFps ? 2.5 : 4;
    } else if(height <= 720) {
        bitRateMBPS = lowFps ? 5 : 7.5;
    } else if(height <= 1080) {
        bitRateMBPS = lowFps ? 8 : 12;
    } else if(height <= 1440) {
        bitRateMBPS = lowFps ? 16 : 24;
    } else if(height <= 2160) {
        bitRateMBPS = lowFps ? 40 : 60;
    } else {
        bitRateMBPS = lowFps ? 60 : 80;
    }

    return bitRateMBPS;
}



interface IState {
    latestSegment?: MP4Video;
    latestSegmentURL?: string;
    prevSegment?: MP4Video;
    test?: number;

    rate: number;
    speedMultiplier: number;
    
    formats: v4l2camera.Format[];
    formatIndex: number;
    requestedFPS: number;
    iFrameRate: number;
    bitrateMbps: number;

    currentPlayTime: number;

    rangeSummaries: {
        [rate: number]: {
            serverRanges?: SegmentRanges;
            receivedRanges?: SegmentRanges;
            requestedRanges?: SegmentRanges;
        }
    };
}


class Main extends React.Component<{}, IState> implements IBrowserReceiver {
    state: IState = {
        rate: 1,
        speedMultiplier: 1,

        formats: [],
        // -1 is valid, we use this like: .slice(index)[0]
        //*
        formatIndex: 0, // 0 = 640x480, 5 = 800x600, 6 = 1280x720, 7=1920x1080
        requestedFPS: 10,
        iFrameRate: 2,
        bitrateMbps: 10 / 1000,

        currentPlayTime: 0,
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

        rangeSummaries: {}
    };

    videoHolder: IVideoHolder|undefined|null;
    
    //vidBuffer: SourceBuffer|undefined;
    //videoElement: HTMLVideoElement|null|undefined;

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

    unmountCallbacks: (() => void)[] = [];
    componentDidMount() {
        this.syncVideoInfo();
    }
    componentWillUnmount() {
        for(let callback of this.unmountCallbacks) {
            try {
                callback();
            } catch(e) {
                console.error(`Error in unmountCallbacks`);
            }
        }
    }

    componentWillMount() {
        //todonext
        //  - Simulate connection lag, so we can start to figure out dynamic fps
        //  - Simulate connection closing, and add reconnection logic
        //  - Also turn off the pi, and make it so it relaunches the camera
        //  - And turn off the server, and make sure that relaunches
        //  - ws-class is not handling closes properly, and still calling functions on closed zombie classes, so... we should fix that.
        //  - Cancelling an encoder that is really far behind isn't working. I should kill the process if it doesn't die fast enough.
    }

    async syncVideoInfo() {
        let ranges = await this.server.syncTimeRanges(this.state.rate, this.state.speedMultiplier);
        this.addServerRanges(ranges);
    }

    acceptNewTimeRanges_VOID(ranges: NALRanges): void {
        this.addServerRanges(ranges);
    }

    private addServerRanges(ranges: NALRanges) {
        ranges = JSON.parse(JSON.stringify(ranges));
        let rate = ranges.rate;
        if(!this.state.rangeSummaries[rate]) {
            this.state.rangeSummaries[rate] = { };
        }
        this.state.rangeSummaries[rate].serverRanges = reduceRanges([ranges], this.state.rangeSummaries[rate].serverRanges);
        this.setState({ rangeSummaries: this.state.rangeSummaries });
    }
    private addReceivedRanges(ranges: NALRanges) {
        ranges = JSON.parse(JSON.stringify(ranges));
        let rate = ranges.rate;
        if(!this.state.rangeSummaries[rate]) {
            this.state.rangeSummaries[rate] = { };
        }
        this.state.rangeSummaries[rate].receivedRanges = reduceRanges([ranges], this.state.rangeSummaries[rate].receivedRanges);
        this.setState({ rangeSummaries: this.state.rangeSummaries });
    }
    private addRequestedRanges(ranges: NALRanges) {
        ranges = JSON.parse(JSON.stringify(ranges));
        let rate = ranges.rate;
        if(!this.state.rangeSummaries[rate]) {
            this.state.rangeSummaries[rate] = { };
        }
        this.state.rangeSummaries[rate].requestedRanges = reduceRanges([ranges], this.state.rangeSummaries[rate].requestedRanges);
        this.setState({ rangeSummaries: this.state.rangeSummaries });
    }

    async startCamera() {
        let formats = await this.server.getFormats();
        this.setState({ formats });

        let format = formats.slice(this.state.formatIndex)[0];
        console.log(formats);

        let fps = this.state.requestedFPS;

        let bitrate = getBitRateMBPS(fps, format);
        await this.server.setFormat(
            fps,
            this.state.iFrameRate,
            this.state.bitrateMbps,
            format
        );
    }

    acceptVideo_VOID(info: MP4Video, requestRange: NALRange): void {
        let latestSegmentURL = URL.createObjectURL(new Blob([info.mp4Video]));
        this.setState({ latestSegmentURL, latestSegment: info, prevSegment: this.state.latestSegment });

        if(!this.videoHolder) {
            console.warn(`Ignoring video as video element hasn't been mounted yet.`);
            return;
        }

        if(info.frameTimes.length > 0) {
            if(info.incomplete) {
                console.log(`Received incomplete video, not counted it as a received range. ${info.frameTimes[0].time} to ${info.frameTimes.last().time}`);
            } else {
                let rate = info.frameTimes[0].rate;
                if(!this.state.rangeSummaries[rate]) {
                    this.state.rangeSummaries[rate] = { };
                }

                let firstTime = requestRange.firstTime;
                let lastTime = info.frameTimes.last().time;

                if(lastTime < firstTime) {
                    // We received data before the requested time. This should only happen for 1 key frame (1 video),
                    //  so we have all the data from the start of this video to the start of the requested range.
                    firstTime = info.frameTimes[0].time;
                    lastTime = requestRange.firstTime;
                }

                let ranges: NALRanges = {
                    rate,
                    frameTimes: [],
                    segmentRanges: [{
                        firstTime,
                        lastTime
                    }]
                };
                this.addReceivedRanges(ranges);
                // Add it as requested, as we use requested to determine what should be requested, and if we received it,
                //  we should definitely not request it again.
                this.addRequestedRanges(ranges);

                //console.log(`Add buffer ${info.frameTimes[0].time} to ${info.frameTimes.last().time}, range ${firstTime} to ${lastTime}`);
                let size = lastTime - firstTime;
                console.log(`Add buffer, pos ${size}`);
            }
        }

        (async () => {
            if(!this.videoHolder) return;                
            await this.videoHolder.AddVideo(info);
        })();
    }
    
    curPlayToken: object = {};
    async onTimeClick(startTime: number) {
        let videoHolder = this.videoHolder;
        if(!videoHolder) return;

        videoHolder.SeekToTime(startTime);
        this.setState({ currentPlayTime: startTime });

        let loadChunkSize = 10000;
        let minPlayBuffer = 5000;

        let rate = this.state.rate;
        let summaryObj = this.state.rangeSummaries[rate] = this.state.rangeSummaries[rate] || {};
        let { serverRanges } = summaryObj;
        if(!serverRanges) return;

        let ourPlayToken = {};
        this.curPlayToken = ourPlayToken;

        // TODO: Move this to something trigger by play behavior. That way we try to kickstart playback
        //  when they seek, but we don't keep trying to download video after we reach the end of the video.
        while(this.curPlayToken === ourPlayToken) {
            let index = binarySearchMap(serverRanges.segments, startTime, x => x.firstTime);
            if(index < 0) {
                index = ~index - 1;
            }
            let segment = UnionUndefined(serverRanges.segments[index]);
            if(!segment) break;
            if(startTime > segment.lastTime) break;

            let loaded = await this.downloadVideo(startTime, loadChunkSize);
            if(!loaded) break;

            let endTime = startTime + loadChunkSize;
            while(this.curPlayToken === ourPlayToken) {
                let delay = endTime - this.state.currentPlayTime - minPlayBuffer;
                if(delay > 0) {
                    console.log(`Waiting ${delay}ms for video position to progress more.`);
                    await SetTimeoutAsync(delay);
                } else {
                    break;
                }
            }

            startTime += loadChunkSize;
        }
    }


    inDownload = false;
    curDownloadToken: object = {};
    async downloadVideo(startTime: number, minBuffer: number): Promise<boolean> {
        let rate = this.state.rate;

        //todonext
        // TODO: Request cancellation.
        //  In this function add a try/finally flag to know when we are making a request.
        //  Call cancelStream, when that comes back make requested ranges exactly equal to received, and then make the new request.
        if(this.inDownload) {
            let summaryObj = this.state.rangeSummaries[rate] = this.state.rangeSummaries[rate] || {};
            summaryObj.requestedRanges = JSON.parse(JSON.stringify(summaryObj.receivedRanges));
            this.setState({ rangeSummaries: this.state.rangeSummaries });
            this.curDownloadToken = {};
            await this.server.CancelVideo();
        }

        this.inDownload = true;
        try {
            let requestedSegments: NALRange[] = [];
            let summaryObj = this.state.rangeSummaries[rate] = this.state.rangeSummaries[rate] || {};

            let { requestedRanges } = summaryObj;
            if(requestedRanges) {
                requestedSegments = requestedRanges.segments;
            }

            let index = binarySearchMap(requestedSegments, startTime, x => x.firstTime);
            if(index < 0) {
                index = ~index - 1;
            }
            let prevSegment = UnionUndefined(requestedSegments[index]);
            let nextSegment = UnionUndefined(requestedSegments[index + 1]);

            let endTime = startTime + minBuffer;

            
            let startTimeExclusive = false;
            if(prevSegment) {
                if(prevSegment.lastTime >= startTime) {
                    startTime = prevSegment.lastTime;

                    // prevSegment is a requested range, which is exclusive by default. So lastTime is exclusive,
                    //  meaning we do need to request it to get that frame.
                    startTimeExclusive = true;
                }
            }

            if(nextSegment) {
                if(nextSegment.firstTime < endTime) {
                    endTime = nextSegment.firstTime;
                }
            }

            if(endTime <= startTime) {
                console.log(`Already loaded video (and buffered), not loading anything.`);
                return true;
            }

            let ranges: NALRanges = {
                rate,
                frameTimes: [],
                segmentRanges: [{
                    firstTime: startTime,
                    lastTime: endTime
                }]
            };
            this.addRequestedRanges(ranges);

            console.log(`Requesting video from ${startTime} to ${endTime}`);

            let downloadToken = {};
            this.curDownloadToken = downloadToken;
            await this.server.GetVideo(startTime, endTime, startTimeExclusive, this.state.rate, this.state.speedMultiplier);

            let didFinishDownload = this.curDownloadToken === downloadToken;

            if(didFinishDownload) {
                this.addReceivedRanges(ranges);
            }

            return didFinishDownload;
        } finally {
            this.inDownload = false;
        }
    }
    

    renderTimes(): JSX.Element|null {
        let { latestSegment, latestSegmentURL } = this.state;
        if(!latestSegment || !this.videoHolder) return null;

        let seg = latestSegment;

       
        let videoPlayTime = this.videoHolder.GetCurrentTime();
        let currentTime = getTimeSynced();

        let frameTimes = latestSegment.frameTimes.map(x => x.time);

        let recordStart = frameTimes.last();

        let realLag = currentTime - videoPlayTime;
        let clientSideBuffer = recordStart - videoPlayTime;


        // Some rough estimations...
        let playTime;
        {
            let frameTimes = latestSegment.frameTimes.map(x => RealTimeToVideoTime(x.time, seg.rate, seg.speedMultiplier));
            let timeOfFrames = frameTimes.last() - frameTimes[0];
            let timePerFrame = timeOfFrames / (frameTimes.length - 1) * (frameTimes.length);
            playTime = timePerFrame * frameTimes.length;
        }

        // Bitrate calculations
        let bytes = seg.mp4Video.length;

        let KBPerSecond = bytes / playTime * 1000 / 1024;
        let framesPerSecond = latestSegment.frameTimes.length / playTime * 1000;

        return (
            <div>
                
                <div>
                    Lag: {realLag.toFixed(0)}ms
                    <div className="indent">
                        <div>Client side buffer {clientSideBuffer.toFixed(0)}ms</div>
                    </div>
                </div>
                <div>
                    { latestSegmentURL &&
                        <a href={latestSegmentURL} download={"segment.mp4"}>Download last video ({latestSegment.frameTimes[0].time} to {latestSegment.frameTimes.last().time}, {(latestSegment.mp4Video.length / 1024).toFixed(1)}KB)</a>
                    }
                </div>
                <div>
                    {KBPerSecond.toFixed(1)}KB/s, {framesPerSecond.toFixed(1)}FPS
                </div>
            </div>
        );
    }

    renderPlayInfo(): JSX.Element|null {
        if(!this.videoHolder) return null;

        let now = getTimeSynced();
        let videoPlayTime = this.videoHolder.GetCurrentTime();
        let lag = now - videoPlayTime;

        let seg = this.state.latestSegment;


        return (
            <div>
                <div>Playing {formatDuration(lag)} AGO</div>
            </div>
        );
    }

    render() {
        let { formats, formatIndex, rangeSummaries } = this.state;
        let selectedFormat = formats.slice(formatIndex)[0];

        let rangesObj = rangeSummaries[this.state.rate];
        if(!rangesObj) {
            rangesObj = { };
        }

        return (
            <div>
                <VideoHolderClass
                    rate={this.state.rate}
                    speedMultiplier={this.state.speedMultiplier}
                    videoProps={{id:"vid", width: "1200", controls: true}}
                    ref={x => this.videoHolder = x}
                />

                <PollLoop delay={500} callback={() => {
                    let newTime = this.videoHolder && this.videoHolder.GetCurrentTime() || 0;
                    if(this.state.currentPlayTime !== newTime) {
                        this.state.currentPlayTime = newTime;
                        this.setState({ currentPlayTime: newTime });
                    }
                }} />

                <button onClick={() => this.startCamera()}>Start Camera</button>
                <div>
                    {this.renderPlayInfo()}
                </div>
                <RangeSummarizer
                    rate={this.state.rate}
                    speedMultiplier={this.state.speedMultiplier}
                    receivedRanges={rangesObj.receivedRanges}
                    serverRanges={rangesObj.serverRanges}
                    requestedRanges={rangesObj.requestedRanges}
                    currentPlayTime={this.state.currentPlayTime}
                    onTimeClick={time => this.onTimeClick(time)}
                />
                <div>
                    {this.renderTimes()}
                </div>
                {selectedFormat && <div>
                    {selectedFormat.width} x {selectedFormat.height}
                </div>}
            </div>
        );
    }
}


let rootElement = document.getElementById("root");
if(!rootElement) throw new Error("Missing root, at element with id=root");

render();
function render() {
    ReactDOM.render(
        <div>
            <div>
                <Main />
            </div>
        </div>,
        rootElement
    );
}

let moduleAny = module as any;

if (moduleAny.hot) {
    moduleAny.hot.accept("./site/CameraViewer.tsx", () => {
        debugger;
        render();
    });
}

/*
<video id="vid" controls></video>
<script>
    test();
    async function test() {
        var push = new MediaSource();
        var buf;
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            // TODO: Get this codec from the video file, so we know it is correct
            
            // I am not sure if the profile, compatibility and level even matter (the part after avc1.). Seems to work
            //  either way, which it should, because that info is in both the mp4 box, and the sps NAL unit.
            buf = push.addSourceBuffer('video/mp4; codecs="avc1.420029"');
            //buf = push.addSourceBuffer(`video/mp4; codecs="avc1.64001E"`);

            //let startTime = 38417943360 / 90000;
            //await addVideo("../youtube.mp4");

            let startTime = 100;
            //let startTime = 0;
            await addVideo("../dist/output0.mp4");
            await addVideo("../dist/output1.mp4");

            //let startTime = 20480 / 10240;
            //await addVideo("../10fps.dash_2.m4s");

            //await addVideo("../dist/output1.mp4");
            //await addVideo("../dist/output2.mp4");

            //let startTime = 200 * 10 / 1000;
            buf.addEventListener("updateend", () => {
                console.log("Trying to play");
                vid.currentTime = startTime;
                vid.play();

                console.log(buf.videoTracks);
            });
        });

        async function addVideo(path) {
            let result = await fetch(path);
            //let result = await fetch("./test.h264.mp4");
            let raw = await result.arrayBuffer();
            buf.appendBuffer(raw);
        }
    }
</script>
*/