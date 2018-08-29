import * as React from "react";

import "./PreviewVideo.less";
import { ConnectToServer } from "ws-class";
import { createCancelPending } from "../algs/cancel";
import { findAtOrBefore, findAtOrBeforeIndex, findClosestIndex, findAtOrAfterIndex } from "../util/algorithms";
import { VideoDownloader } from "./VideoDownloader";
import { GetVideoFrames } from "./getVideoFrame";
import { SetTimeoutAsync, g } from "pchannel";
import { GetVideoFPSEstimate, RealTimeToVideoTime, VideoDurationToRealDuration } from "../NALStorage/TimeMap";
import { formatDate, formatDuration } from "../util/format";
import { profile, profileSync, UnionUndefined } from "../util/misc";
import { MeasuredElement } from "../site/MeasuredElement";
import { max, min, sum } from "../util/math";

interface IProps {
    // If this is wrong, it doesn't really matter, we will just need to download more data from the server
    //  for a little bit.
    viewportFPSEstimate: number;
    videoDimensionsEstimate: { width: number; height: number; };
    viewport: { startTime: number; endTime: number; };
    setViewport: (viewport: { startTime: number; endTime: number; }) => void;
}
interface IState {
    previewFrames: {
        imageUrl: string;
        rate: number;

        baseTime: number;
        baseNextTime: number;

        time: number;
        nextTime: number;
        
        addSeqNum: number;

        frameCountEstimate: number;

        duplicateSeqNum: number;
        duplicateCount: number;

        width: number;
        height: number;
    }[];

    widthPx: number;
    heightPx: number;
    imageRows: number;
}

const maxFrames = 1000;

export class PreviewVideo extends React.Component<IProps, IState> {
    state: IState = {
        previewFrames: [],
        widthPx: 1000,
        heightPx: 420,

        imageRows: 3,
    };
    downloader = new VideoDownloader(
        video => { },
        async () => {},
        true
    );
    
    componentDidMount() {
        this.getPreviewFrames(this.props, this.state);
    }
    componentWillUpdate(nextProps: IProps, nextState: IState) {
        if(this.getPreviewFramesHash(this.props, this.state) !== this.getPreviewFramesHash(nextProps, nextState)) {
            this.getPreviewFrames(nextProps, nextState);
        }
    }
    getPreviewFramesHash(props: IProps, state: IState): string {
        return JSON.stringify({
            viewportFPSEstimate: props.viewportFPSEstimate,
            videoDimensionsEstimate: props.videoDimensionsEstimate,
            viewport: props.viewport,
            widthPx: state.widthPx,
        });
    }

    getPreviewFrames = createCancelPending(
        () => {},
        (doAsyncCall, isCancelError) =>
    async (props: IProps, state: IState) => {
        await profile("getPreviewFrames", async () => {
            let { viewport, viewportFPSEstimate } = props;
            let rates = await doAsyncCall(() => this.downloader.Rates);

            let viewportSize = (viewport.endTime - viewport.startTime);

            const getRate = (maxFrameWidthPx: number): number => {
                let targetPreviewFrames = Math.max(1, Math.floor(state.widthPx / maxFrameWidthPx)) * this.state.imageRows * this.state.imageRows;
                let perfectRate = viewportSize / 1000 * viewportFPSEstimate / targetPreviewFrames;

                let rateIndex = findAtOrBeforeIndex(rates, perfectRate, x => x);
                if(rateIndex < 0) {
                    rateIndex = 0;
                }
                if(rateIndex >= rates.length) {
                    rateIndex = rates.length - 1;
                }
                return rates[rateIndex];
            };

            const getVideos = async (currentRate: number): Promise<PreviewVideo["state"]["previewFrames"]> => {
                let minFramesPerVideo = 10;
                let startTime = viewport.startTime - viewportSize * 0.5;
                let lastTime = viewport.endTime + viewportSize * 0.5;

                {
                    let curFrames = 0;
                    let curTime = startTime;
                    while(curTime < lastTime) {
                        let video = await doAsyncCall(this.downloader.DownloadVideo, currentRate, curTime, minFramesPerVideo);
                        if(video === "CANCELLED" || video === "FINISHED") break;
                        if(!video.nextTime) break;
                        if(video.video) {
                            let frac = (curTime - startTime) / (lastTime - startTime);
                            console.log(`Video ${video.video.frameTimes.length} frames, frac ${(frac * 100).toFixed(1)}, ${this.timeToPos(curTime)} to ${this.timeToPos(video.nextTime)}, really ${this.timeToPos(video.video.frameTimes[0].time)} to ${this.timeToPos(video.video.frameTimes.last().time)}, fps ${GetVideoFPSEstimate(video.video)}`);
                        }
                        curTime = video.nextTime;
                        if(video.video) {
                            curFrames += video.video.frameTimes.length;
                            if(curFrames > maxFrames) {
                                console.warn(`GetVideo download cut off after max frames was exceeded. Max frames: ${maxFrames}`);
                            }
                        }
                    }
                    
                }

                let videos = this.downloader.GetInfo(currentRate).Videos;
                g["videos"] = videos;
                let index = findAtOrAfterIndex(videos, startTime, x => x.frameTimes[0].time);
                if(index < 0) {
                    index = 0;
                }

                let previewFrames: PreviewVideo["state"]["previewFrames"] = [];
                while(index < videos.length && videos[index].frameTimes[0].time <= lastTime) {
                    let video = videos[index];
                    for(let i = 0; i < video.frameTimes.length; i++) {
                        let frame = video.frameTimes[i];
                        previewFrames.push({
                            imageUrl: `http://localhost:7061/frame?rate=${currentRate}&time=${frame.time}`,
                            rate: currentRate,

                            baseTime: frame.time,
                            baseNextTime: frame.time,

                            time: frame.time,
                            nextTime: frame.time,

                            addSeqNum: frame.addSeqNum,
                            frameCountEstimate: 1,
                            duplicateSeqNum: 0,
                            duplicateCount: 1,
                            width: frame.width,
                            height: frame.height,
                        });
                    }

                    index++;
                }

                for(let i = 0; i < previewFrames.length - 1; i++) {
                    previewFrames[i].nextTime = previewFrames[i + 1].time;
                    previewFrames[i].frameCountEstimate = previewFrames[i + 1].addSeqNum - previewFrames[i].addSeqNum;
                }
                if(previewFrames.length > 1) {
                    let secondLast = previewFrames[previewFrames.length - 2];
                    previewFrames[previewFrames.length - 1].nextTime = previewFrames[previewFrames.length - 1].time + secondLast.nextTime - secondLast.time;
                }
                for(let i = 0; i < previewFrames.length; i++) {
                    previewFrames[i].baseNextTime = previewFrames[i].nextTime;
                }

                return previewFrames;
            };

            let aspectRatioEstimate = 3/4;
            if(this.state.previewFrames.length > 0) {
                aspectRatioEstimate = max(this.state.previewFrames.map(x => x.width / x.height));
            }

            let currentRate = getRate(state.heightPx / aspectRatioEstimate);
            let previewFrames = await getVideos(currentRate);

            let correctRate = getRate(this.getMaxFrameWidthPx(previewFrames));

            // If the currentRate is less than the correctRate then we requested too many frames, which is fine. We only
            //  really care if we requested too few frames.
            if(correctRate < currentRate) {
                previewFrames = await getVideos(correctRate);
            }
            
            this.state.previewFrames = previewFrames;
            this.setState({ previewFrames });

            console.log(`finished getPreviewFrames, frames: ${previewFrames.length}`);
        });
    });

    private getAverageWidthPerFrame(frames: PreviewVideo["state"]["previewFrames"]): number {
        if(frames.length === 0) {
            return 1;
        }
        let timeWidth = (this.timeToPos(frames.last().time) - this.timeToPos(frames[0].time)) * this.state.widthPx;
        let averageWidthPerFrame = timeWidth / (frames.length - 1) * this.state.imageRows * this.state.imageRows;
        return averageWidthPerFrame;
    }
    private getMaxFrameWidthPx(frames: PreviewVideo["state"]["previewFrames"]): number {
        let { heightPx } = this.state;
        if(frames.length === 0) {
            return 100;
        }
        return max(frames.map(x => x.width / x.height * heightPx));
    }

    private timeToPos(time: number) {
        let { viewport } = this.props;
        let viewWidth = viewport.endTime - viewport.startTime;

        return (time - viewport.startTime) / viewWidth;
    }

    private alignToGrid() {
        // height, width => optimum height per frame => frame that constrains width the most => optimum total width?
        //      The total width will be a bit of a guess, as we won't really lay it out as a grid, just extrapolate from the most
        //      constraining frame.

        let { viewport } = this.props;
        let { previewFrames } = this.state;
        
        let perfectHeightPerFrame = this.state.heightPx / this.state.imageRows;
        let constrainedAspectRatio = min(previewFrames.map(x => x.width / x.height));
        let averageFPS = sum(previewFrames.map(x => x.frameCountEstimate)) / (previewFrames.last().baseNextTime - previewFrames[0].baseTime);
        let rate = previewFrames[0].frameCountEstimate;
        let perfectWidthPerFrame = perfectHeightPerFrame * constrainedAspectRatio;

        // time * averageFPS / rate * perfectWidthPerFrame / this.state.imageRows = this.state.widthPx
        let targetTimeSize = this.state.widthPx / averageFPS * rate / perfectWidthPerFrame * this.state.imageRows;

        let s = viewport.startTime;
        let e = viewport.endTime;

        let center = s / 2 + e / 2;

        s = center - targetTimeSize / 2;
        e = center + targetTimeSize / 2;

        this.props.setViewport({ startTime: s, endTime: e });
    }

    public render() {
        let { viewport } = this.props;
        let { previewFrames, widthPx } = this.state;

        let maxFrameWidthPx = this.getMaxFrameWidthPx(previewFrames);
        let minFrameWidthPx = maxFrameWidthPx / 2;

        let averageWidthPerFrame = this.getAverageWidthPerFrame(previewFrames);
        let perfectFrameCount = minFrameWidthPx / averageWidthPerFrame;
        // Ideally
        let downsampleRate = Math.pow(2, Math.ceil(Math.log(perfectFrameCount) / Math.log(2)));

        if(previewFrames.length > 1 && widthPx > 0) {
            if(averageWidthPerFrame < minFrameWidthPx) {
                // Downsample
                let downsampledFrames: typeof previewFrames = [];
                for(let i = 0; i < previewFrames.length; i++) {
                    let frame = previewFrames[i];
                    // ceil is very important here, or else a downsampled 16x rate won't line up the 4x rate, meaning all of the frames
                    //  will be the new frames, instead of a downsampled 16x rate having half of the frames the same as 4x, and half new.
                    if(Math.ceil(frame.addSeqNum / frame.rate) % downsampleRate === 0) {
                        frame = {...frame};
                        downsampledFrames.push(frame);
                    } else {
                        // We ignore some frames at the beginning of the view. We have to, as if we adjust the start time/frame
                        //  we will adjust it to a different frame depending on the zoom level and view state, which is inconsistent.
                        if(downsampledFrames.length > 0) {
                            downsampledFrames.last().nextTime = frame.nextTime;
                            downsampledFrames.last().frameCountEstimate += frame.frameCountEstimate;
                        }
                    }
                }
                previewFrames = downsampledFrames;
            }

            // If the frame width is too high we have to show duplicates and then indicate they are duplicates
            if(averageWidthPerFrame > maxFrameWidthPx) {
                let upsampledFrames: typeof previewFrames = [];
                for(let i = 0; i < previewFrames.length; i++) {
                    let frame = previewFrames[i];
                    let next = UnionUndefined(previewFrames[i + 1]);
                    if(!next) {
                        upsampledFrames.push(frame);
                        continue;
                    }
                    let frameWidth = (this.timeToPos(next.time) - this.timeToPos(frame.time)) * widthPx;
                    let targetCount = Math.ceil(frameWidth / minFrameWidthPx / 2);
                    if(targetCount < 1) {
                        targetCount = 1;
                    }
                    
                    for(let j = 0; j < targetCount; j++) {
                        upsampledFrames.push({ ...frame, duplicateSeqNum: j, duplicateCount: targetCount });
                        if(upsampledFrames.length >= maxFrames) {
                            console.warn(`Upsampling stopped because max frame count was exceeded. Max frames ${maxFrames}`);
                            break;
                        }
                    }
                }
                previewFrames = upsampledFrames;
            }
        }

        const getColumnStart = (previewIndex: number): number => {
            for(let i = previewIndex; i >= 0; i--) {
                let frame = previewFrames[i];
                let index = Math.ceil((frame.addSeqNum * frame.duplicateCount + frame.duplicateSeqNum) / frame.rate / downsampleRate) % this.state.imageRows;
                if(index === 0 && frame.duplicateSeqNum === 0) {
                    return i;
                }
            }
            return 0;
        };
        const getNextColumnStart = (previewIndex: number): number => {
            for(let i = previewIndex; i < previewFrames.length; i++) {
                let frame = previewFrames[i];
                let index = Math.ceil((frame.addSeqNum * frame.duplicateCount + frame.duplicateSeqNum) / frame.rate / downsampleRate) % this.state.imageRows;
                if(index === 0 && frame.duplicateSeqNum === 0) {
                    return i;
                }
            }
            return previewFrames.length - 1;
        };
        const getFramePositioning = (frame: typeof previewFrames[0], previewIndex: number) => {
            let columnStartIndex = getColumnStart(previewIndex);
            let columnStart = previewFrames[columnStartIndex];
            let nextColumnStartIndex = getNextColumnStart(previewIndex + 1);
            let nextColumnStart = previewFrames[nextColumnStartIndex];

            let startBase = this.timeToPos(columnStart.time);
            let endBase = this.timeToPos(nextColumnStart.time);

            //startBase = this.timeToPos(frame.baseTime);
            //endBase = this.timeToPos(frame.baseNextTime);

            let startFraction = (frame.duplicateCount - frame.duplicateSeqNum) / frame.duplicateCount;
            let endFraction = (frame.duplicateCount - frame.duplicateSeqNum - 1) / frame.duplicateCount;

            //startFraction = 1;
            //endFraction = 0;

            let start = startBase * startFraction + endBase * (1 - startFraction);
            let end = startBase * endFraction + endBase * (1 - endFraction);

            let width = end - start;
            //width = width / frame.duplicateCount;
            //start -= width * 0.5;
            //end -= width * 0.5;

            let top = 0;
            for(let i = columnStartIndex; i < previewIndex; i++) {
                //(1683) * 21.4193 * 9 / 16
                let frame = previewFrames[i];
                let height = this.state.widthPx * width / (frame.width / frame.height);
                top += height;
            }

            // Eh... this causes problems if some frames have duplicates while others don't
            if(frame.duplicateCount > 1) {
                top = 0;
            }

            return { top, start, end };
        };

        const getImageStyles = (frame: typeof previewFrames[0], previewIndex: number): React.CSSProperties => {
            let { top, start, end } = getFramePositioning(frame, previewIndex);

            return {
                top: top + "px",
                left: start * 100 + "%",
                width: (end - start) * 100 + "%",
            };
        };

        const formatPlayLineWithinFrame = (frame: typeof previewFrames[0], previewIndex: number): React.CSSProperties => {
            let framePositioning = getFramePositioning(frame, previewIndex);
            let { start, end } = framePositioning;
            let absPos = this.timeToPos(frame.baseTime);
            let pos = (absPos - start) / (end - start);
            return {
                left: pos * 100 + "%"
            };
        };

        return (
            <div className="PreviewVideo">
                <div>
                    <button onClick={() => this.alignToGrid()}>Align to grid</button>
                </div>
                <MeasuredElement onSizeChange={x => this.setState({ widthPx: x.widthPx })}>
                    <div
                        className="PreviewVideo-ruler"
                        style={{ height: this.state.heightPx + "px" }}
                        data-view-start={viewport.startTime}
                        data-view-end={viewport.endTime}
                    >
                        {previewFrames.map((x, i) => (
                            <div
                                className={`PreviewVideo-img ${x.duplicateSeqNum === 0 ? "" : "PreviewVideo-img--duplicateFrames"}`}
                                style={getImageStyles(previewFrames[i], i)}
                                key={x.time + "_" + x.duplicateSeqNum}
                                title={`${formatDate(x.time)}, Frames: ${x.frameCountEstimate}, Time: ${formatDuration(x.nextTime - x.time)}, Add Seq: ${x.addSeqNum}, Rate: ${x.rate}, Duplicate Count: ${x.duplicateCount}, ${x.baseTime} ${x.time}`}
                            >
                                <div>
                                    <img
                                        data-time={x.time}
                                        data-video-time={RealTimeToVideoTime(x.time, x.rate)}
                                        src={x.imageUrl}
                                    />
                                    <div className="PreviewVideo-img-playLine" style={formatPlayLineWithinFrame(previewFrames[i], i)}></div>
                                </div>
                                <div className="PreviewVideo-img-info">
                                    {x.addSeqNum}, {x.frameCountEstimate}, {formatDuration(x.nextTime - x.time)}
                                </div>
                            </div>
                        ))}
                    </div>
                </MeasuredElement>
            </div>
        );
    }
}