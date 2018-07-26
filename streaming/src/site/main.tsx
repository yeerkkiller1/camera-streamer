import { g, PChan, TransformChannel, TransformChannelAsync } from "pchannel";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";

import "./main.less";
import { ConnectToServer } from "ws-class";
import { setTimeServer, getTimeSynced } from "../util/time";
import { PropsListify } from "../util/PropsListify";
import { PixelGraph, Color } from "../util/PixelGraph";
import { min, max, sum } from "../util/math";
import { isFunction } from "util";


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
    latestSegment?: VideoSegment;
    latestSegmentURL?: string;
    prevSegment?: VideoSegment;
    test?: number;
    
    formats: v4l2camera.Format[];
    formatIndex: number;
    requestedFPS: number;
    iFrameRate: number;
}
class Main extends React.Component<{}, IState> {
    state: IState = {
        formats: [],
        // -1 is valid, we use this like: .slice(index)[0]
        formatIndex: 0, // 0 = 640x480, 5 = 800x600, 6 = 1280x720, 7=1920x1080
        requestedFPS: 1,
        iFrameRate: 2
    };

    vidStartTime: number|undefined;
    vidBuffer: SourceBuffer|undefined;
    videoStarted = false;
    videoElement: HTMLVideoElement|null|undefined;

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

    componentWillMount() {
        //todonext
        //  - Simulate connection lag, so we can start to figure out dynamic fps
        //  - Simulate connection closing, and add reconnection logic
        //  - Also turn off the pi, and make it so it relaunches the camera
        //  - And turn off the server, and make sure that relaunches
        //  - ws-class is not handling closes properly, and still calling functions on closed zombie classes, so... we should fix that.
        //  - Cancelling an encoder that is really far behind isn't working. I should kill the process if it doesn't die fast enough.

        (async () => {
            /*
            
            //*/
            //server.subscribeToCamera({time: "live", rate: 1});

            let ranges = await this.server.getRecordTimeRanges({startTime: 0});
            console.log(ranges);
        })();
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
            bitrate,
            format
        );
    }
    initVideo(vid: HTMLVideoElement|null) {
        if(!vid) return;
        if(this.videoElement === vid) return;

        console.log("New video element");
        this.videoElement = vid;

        // onstalled, onemptied, onended, onpause, are all useless. Watching polling currentTime is the only way to know
        //  when the video stalls.
        //const maxClientsideBuffer = 5 * 1000;

        // Max of two videos behind
        const maxClientsideBuffer = this.state.iFrameRate * (1 / this.state.requestedFPS) * 2 * 1000;
        const checkForStallOrLag = () => {
            if(this.videoElement !== vid) return;

            let seg = this.state.latestSegment;
            if(seg) {
                let firstTime = seg.cameraRecordTimes[0];
                if(vid.currentTime * 1000 + maxClientsideBuffer < firstTime) {
                    console.log(`Moving video up to current time, because client side buffer time got too high (above ${maxClientsideBuffer})`);
                    vid.currentTime = firstTime / 1000;
                }

                // We can't play in the future
                if(vid.currentTime * 1000 > seg.cameraRecordTimes.last()) {
                    console.log("Moving video back because it was playing in the future");
                    vid.currentTime = firstTime / 1000 - 0.00001;
                }
            }

            setTimeout(checkForStallOrLag, maxClientsideBuffer / 10);
        };
        checkForStallOrLag();
        

        
        var push = new MediaSource();
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            var buf = push.addSourceBuffer('video/mp4; codecs="avc1.640028"');
            this.vidBuffer = buf;
            let queue = this.updateEndQueue = new PChan<void>();
            
            const callback = () => {
                if(this.updateEndQueue !== queue) {
                    buf.removeEventListener("updatend", callback);
                    return;
                }
                queue.SendValue(undefined);
            };
            this.vidBuffer.addEventListener("updateend", callback);

            buf.addEventListener("updateend", () => {
                if(this.videoStarted) return;
                this.videoStarted = true;
                console.log("Trying to play");
                vid.currentTime = this.vidStartTime || 0;
                vid.play();
            });
        });
    }

    frameTimes: number[] = [];
    seekToFrame(index: number) {
        if(!this.videoElement) return;
        // We have to minus this time to make the last frame work. Now sure why...
        //  If we play a video until the end the time goes WAY (around 3/4 of a frame when I tested) past
        //  the start of the last frame, and seeking to exactly the last frame time doesn't even work.
        //  But subtracting a little bit does work. It must have to do with rounding or something? Odd...
        //  and unfortunate, as it will be hard to verify this frame mapping is correct with real video
        //  (which is not timestamped, as that takes too much CPU power).
        this.videoElement.currentTime = this.frameTimes[index] - 0.00001;
    }

    acceptVideoSegment_VOID(info: VideoSegment): void {
        if(info.type === "live") {
            info.clientReceiveTime = getTimeSynced();
        }

        for(let time of info.cameraRecordTimes) {
            this.frameTimes.push(time);
        }

        
        console.log(info.cameraRecordTimes[0], "to", info.cameraRecordTimes[info.cameraRecordTimes.length - 1]);

        let latestSegmentURL = URL.createObjectURL(new Blob([info.mp4Video]));

        this.setState({ latestSegment: info, prevSegment: this.state.latestSegment, latestSegmentURL });

        if(this.vidStartTime === undefined) {
            console.log("Init start time");
            this.vidStartTime = info.baseMediaDecodeTimeInSeconds;
        }

        if(this.vidBuffer) {
            console.log("Add buffer");
            this.appendQueue(info.mp4Video);
        }
    }

    updateEndQueue: PChan<void>|undefined;
    
    // TODO: If we ever call remove, we need to combine it in this loop, as both set updating to true.
    appendQueue = TransformChannel<Buffer, void>(async (input) => {
        if(!this.vidBuffer) {
            console.log(`Ignoring video because vidBuffer hasn't been initialized yet.`);
            return;
        }
        if(this.vidBuffer.updating) {
            throw new Error(`appendQueue is broken, tried to add while vidBuffer is updating`);
        }
        this.vidBuffer.appendBuffer(input);
    });

    renderTimes(): JSX.Element|null {
        let { latestSegment, latestSegmentURL } = this.state;
        if(!latestSegment || !this.videoElement || !this.videoStarted) return null;

        console.log(`Render times`);

        let seg = latestSegment;

        if(seg.type !== "live") {
            return null;
        }
        
        let recordDuration = seg.cameraRecordTimes[seg.cameraRecordTimes.length - 1] - seg.cameraRecordTimes[0];

        let cameraEncodeStartDelay = seg.cameraSendTimes[0] - seg.cameraRecordTimes[0];
        // A bit less than real encode time, because the line between time until encode and encode time is blurred.
        let cameraEncodeTime = seg.cameraRecordTimes[seg.cameraRecordTimes.length - 1] - seg.cameraRecordTimes[0];

        let cameraSendDelay = seg.serverReceiveTime[0] - seg.cameraSendTimes[0];
        let cameraSendTime = seg.serverReceiveTime[seg.serverReceiveTime.length - 1] - seg.serverReceiveTime[0];

        let serverSendDelay = seg.serverSendTime - seg.serverReceiveTime[seg.serverReceiveTime.length - 1];
        let serverSendDuration = seg.clientReceiveTime - seg.serverSendTime;

        let clientBufferedTime = seg.cameraRecordTimes[0] - this.videoElement.currentTime * 1000;
        let videoPlayLocalLag = Date.now() - this.videoElement.currentTime * 1000;
        let videoPlayRealLag = getTimeSynced() - this.videoElement.currentTime * 1000;
        let offsetToServer = getTimeSynced() - Date.now();

        let cameraTimeOffset = seg.cameraTimeOffset;       

        let displayData: {[key: string]: number} = {
            recordDuration,
            cameraEncodeStartDelay,
            cameraEncodeTime,
            cameraSendDelay,
            cameraSendTime,
            serverSendDelay,
            serverSendDuration,
            clientBufferedTime,
            videoPlayLocalLag,
            videoPlayRealLag,
            offsetToServer,
            cameraTimeOffset
        };

        let recordStart = seg.cameraRecordTimes[0];
        let recordEnd = seg.cameraRecordTimes[seg.cameraRecordTimes.length - 1];
        let encodeStart = seg.cameraSendTimes[0];
        let encodeEnd = seg.cameraSendTimes[seg.cameraSendTimes.length - 1];

        let serverReceiveTimeStart = seg.serverReceiveTime[0];
        let serverReceiveTimeEnd = seg.serverReceiveTime[seg.serverReceiveTime.length - 1];
        let serverSendTime = seg.serverSendTime;
        let videoPlayTime = this.videoElement.currentTime * 1000;
        let currentTime = getTimeSynced();


        //todonext
        //  We can't distinguish between latency and bandwidth problems... so just show time on each device,
        //      which should be equal to latency. Unless latency continues to increase, then it's a bandwidth problem.

        // Also some bitrate indicators?

        // For testing lag: http://output.jsbin.com/yewodox
        let recLists = seg.cameraRecordTimesLists;
        let sensorFrames = sum(recLists.map(x => x.length));
        let encodeFrames = recLists.length;

        let prevSegment = this.state.prevSegment;
        
        let lastTime = prevSegment && prevSegment.type === "live" ? prevSegment.cameraRecordTimesLists.last().last() : recLists[0][0];
        let sensorTime = recLists.last().last() - lastTime;

        let realLag = currentTime - videoPlayTime;
        let clientSideBuffer = recordStart - videoPlayTime;

        // Hmm... the problem is, that this will be delayed just because of timing. We basically stream it,
        //  so it's hard to determine what is taking time. ALSO, there is lots of latency, so we can't just
        //  measure active time, as sometimes things just add a certain amount of lag, but have a lot of bandwidth,
        //  and bandwidth vs lag measurements are hard...
        let timeOnCamera = seg.cameraSendTimes.last() - seg.cameraRecordTimes[0];

        // Bitrate calculations
        let bytes = seg.mp4Video.length;


        //todonext
        // We are just going to have to show the time spent on each device
        
        
        let cameraToServerTransferTime = sum(seg.cameraSendTimes.map((sendTime, i) => seg.cameraRecordTimes[i] - sendTime));

        return (
            <div>
                <div>
                    Lag: {realLag.toFixed(0)}ms
                    <div className="indent">
                        <div>Client side buffer {clientSideBuffer.toFixed(0)}ms</div>
                    </div>
                </div>
                <div>
                    <div>Sensor Time: {sensorTime.toFixed(0)}ms (Recorded {encodeFrames} out of {sensorFrames}) (Recorded {(encodeFrames / sensorTime * 1000).toFixed(1)} FPS out of {(sensorFrames / sensorTime * 1000).toFixed(1)} FPS)</div>
                    <div className="indent">
                        <div>Time on camera: {timeOnCamera.toFixed(0)}ms</div>
                    </div>
                </div>
                <div>
                    <div>Chunk bytes size: {bytes}</div>
                    <div>
                        {seg.frameSizes.join(", ")}
                    </div>
                    <div>
                        {bytes / sensorTime * 1000 / 1024} KB/s
                    </div>
                </div>
                <div>
                    { latestSegmentURL &&
                        <a href={latestSegmentURL} download={"segment.mp4"}>Download last video</a>
                    }
                </div>
            </div>
        );


        /*
        let timeProps: { [key: string]: number } = {
            recordStart,
            recordEnd,
            encodeStart,
            encodeEnd,
            serverReceiveTimeStart,
            serverReceiveTimeEnd,
            serverSendTime,
            videoPlayTime,
            currentTime
        };

        let start = recordStart;
        for(let key in timeProps) {
            timeProps[key] -= start;
        }

        return (
            <div>
                <PropsListify
                    value={timeProps}
                    listSize={50}
                    renderFnc={list => {
                        let minValue = min(list.map(x => min(Object.values(x))));
                        let maxValue = max(list.map(x => max(Object.values(x))));

                        let colors: Color[] = [
                            { h: 0, s: 0.75, l: 0.75, a: 1 },
                            { h: 30, s: 0.75, l: 0.75, a: 1 },
                            { h: 60, s: 0.75, l: 0.75, a: 1 },
                            { h: 90, s: 0.75, l: 0.75, a: 1 },
                            { h: 120, s: 0.75, l: 0.75, a: 1 },
                            { h: 150, s: 0.75, l: 0.75, a: 1 },
                            { h: 180, s: 0.75, l: 0.75, a: 1 },
                            { h: 210, s: 0.75, l: 0.75, a: 1 },
                            { h: 240, s: 0.75, l: 0.75, a: 1 },
                            { h: 270, s: 0.75, l: 0.75, a: 1 },
                            { h: 300, s: 0.75, l: 0.75, a: 1 },
                            { h: 330, s: 0.75, l: 0.75, a: 1 },
                        ];

                        let keys = Object.keys(timeProps);
                        let lists: { key: string, values: number[], color: Color }[] = [];
                        for(let i = 0; i < keys.length; i++) {
                            let key = keys[i];
                            let color = colors[i];
                            lists.push({
                                key,
                                color,
                                values: list.map(x => x[key])
                            });
                        }

                        return (
                            <div>
                                <div>
                                    <PixelGraph
                                        minY={minValue}
                                        maxY={maxValue}
                                        heightInPixels={100}
                                        lineWidth={10}
                                        lines={
                                            lists.map(x => ({
                                                color: x.color,
                                                data: x.values
                                            })) as any
                                        }
                                    />
                                </div>
                                <div>
                                    {JSON.stringify(list)}
                                </div>
                            </div>
                        );
                    }}
                />
                {
                    Object.keys(displayData).map(key => {
                        let value = displayData[key];

                        return (
                            <div key={key}>
                                {key}: {value}
                            </div>
                        );
                    })
                }
            </div>
        );
        */
    }

    render() {
        let { formats, formatIndex } = this.state;
        let selectedFormat = formats.slice(formatIndex)[0];

        return (
            <div>
                <video id="vid" width="1200" controls ref={x => this.initVideo(x)}></video>
                <button onClick={() => this.startCamera()}>Start Canera</button>
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