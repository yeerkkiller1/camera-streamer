import * as React from "react";

import "./PreviewVideo.less";
import { ConnectToServer } from "ws-class";
import { createCancelPending, createIgnoreDuplicateCalls } from "../algs/cancel";
import { findAtOrBefore, findAtOrBeforeIndex, findClosestIndex, findAtOrAfterIndex, sort, findAtOrBeforeOrAfterIndex } from "../util/algorithms";
import { VideoDownloader } from "./VideoDownloader";
import { GetVideoFrames } from "./getVideoFrame";
import { SetTimeoutAsync, g } from "pchannel";
import { GetVideoFPSEstimate, RealTimeToVideoTime, VideoDurationToRealDuration, GetMinGapSize } from "../NALStorage/TimeMap";
import { formatDate, formatDuration } from "../util/format";
import { profile, profileSync, UnionUndefined, randomUID, keyBy } from "../util/misc";
import { MeasuredElement } from "../site/MeasuredElement";
import { max, min, sum, histogram, mean, histogramLookup } from "../util/math";
import { getBits, getNumber } from "../util/bits";
import { IndexLookup } from "../util/IndexLookup";
import { V4MAPPED } from "dns";
import { getMaskedRanges } from "../NALStorage/rangeMapReduce";
import { PollLoop } from "../site/PollLoop";

//todonext
// - Sometimes downsampling removes all frames, so don't do that.
// - Upsampling? But then again... what's the point of zooming in so far there aren't enough frames to show?

interface IProps {
    viewport: { startTime: number; endTime: number; };
    setViewport: (viewport: { startTime: number; endTime: number; }) => void;
    serverRanges: {
        [rate: number]: {
            serverRanges: NALRange[];
        }|undefined
    };
}
interface FramePreviewImage {
    imageUrl: string;
    rate: number;

    time: number;
    nextTime: number;
    addSeqNum: number;
    /** If true there is a large gap of no video before this frame, so preview frame rendering should change accordingly. */
    cameraStart: boolean;

    frameCountEstimate: number;

    fullWidth: number;
    fullHeight: number;

    source: MP4Video;

    // If we are a duplicate, this is our base frame. Otherwise it is just a reference to ourself.
    //duplicateFrameBase: FramePreviewImage;
}
interface IState {
    previewFrames: FramePreviewImage[];

    widthPx: number;
    heightPx: number;
    imageRows: number;

    pollDelay: number;
    pollSeqNum: number;
}

const maxFrames = 500;

export class PreviewVideo extends React.Component<IProps, IState> {
    state: IState = {
        previewFrames: [],
        widthPx: 1000,
        heightPx: 400,

        imageRows: 3,

        pollDelay: 500,
        pollSeqNum: 0,
    };
    downloader = new VideoDownloader(
        video => { },
        async () => {},
        async () => {},
        true,
        // forPreview === false, because right request are slow, and preview downloads require a lot of exra calls.
        false
    );
    minFramesPerVideo = 1;
    
    componentDidMount() {
        this.getPreviewFrames(this.props, this.state);
    }
    shouldComponentUpdate(nextProps: IProps, nextState: IState): boolean {
        if(this.state.previewFrames !== nextState.previewFrames) return true;
        if(this.getUpdateHash(this.props, this.state) !== this.getUpdateHash(nextProps, nextState)) return true;
        return false;
    }
    getUpdateHash(props: IProps, state: IState): string {
        return JSON.stringify({
            viewport: props.viewport,
            widthPx: state.widthPx,
            heightPx: state.heightPx,
            imageRows: state.imageRows,
            pollDelay: state.pollDelay,
            pollSeqNum: state.pollSeqNum
        });
    }

    lastHash: string|undefined;
    componentWillUpdate(nextProps: IProps, nextState: IState) {
        let currentHash = this.getPreviewFramesHash(nextProps, nextState);
        if(this.lastHash !== currentHash) {
            this.lastHash = currentHash;
            (async () => {
                try {
                    await this.getPreviewFrames(nextProps, nextState);
                } catch(e) {
                    console.log(`Error in getPreviewFrames`, e);
                    throw e;
                }
            })();
        }
    }
    getPreviewFramesHash(props: IProps, state: IState): string {
        let { serverRanges, viewport } = props;

        let allVisisbleRanges: { [rate: number]: NALRange[] } = {};
        for(let rateStr in serverRanges) {
            let ranges = serverRanges[rateStr];
            if(!ranges) continue;
            let visibleRanges = getMaskedRanges(
                { firstTime: viewport.startTime, lastTime: viewport.endTime, frameCount: 0 },
                ranges.serverRanges
            );
            allVisisbleRanges[rateStr] = visibleRanges;
        }

        return JSON.stringify({
            viewport: props.viewport,
            widthPx: state.widthPx,
            allVisisbleRanges: allVisisbleRanges
        });
    }

    getPreviewFrames = createIgnoreDuplicateCalls(
    async (props: IProps, state: IState) => {
        await profile("getPreviewFrames", async (): Promise<any> => {
            console.log("getPreviewFrames start");

            let { viewport } = props;
            let { widthPx, imageRows } = state;
            let rates = this.downloader.Rates;

            let viewportSize = (viewport.endTime - viewport.startTime);

            const viewportFPSEstimate = 10;

            const getRate = async (maxFrameWidthPx: number): Promise<number> => {
                let targetPreviewFrames = Math.max(1, Math.floor(state.widthPx / maxFrameWidthPx)) * this.state.imageRows * this.state.imageRows;
                
                let perfectRate = viewportSize / 1000 * viewportFPSEstimate / targetPreviewFrames;

                let rateIndex = findAtOrBeforeIndex(rates, perfectRate, x => x);
                if(rateIndex < 0) {
                    rateIndex = 0;
                }
                if(rateIndex >= rates.length) {
                    rateIndex = rates.length - 1;
                }

                
                while(rateIndex > 0) {
                    let rate = rates[rateIndex];
                    let ranges = this.props.serverRanges[rate];
                    if(!ranges) {
                        throw new Error(`Have no server ranges for rate that is in rates list? ${rate}`);
                    }

                    let visibleRanges = getMaskedRanges({ firstTime: viewport.startTime, lastTime: viewport.endTime, frameCount: 0 }, ranges.serverRanges);
                    let frameCount = sum(visibleRanges.map(x => x.frameCount));
                    // If there aren't enough frame, get more frames
                    if(frameCount < targetPreviewFrames * 0.5 || frameCount < 4) {
                        console.log(`Rate ${rate} only has ${frameCount} frames in view, using a lower rate`);
                        rateIndex--;
                    } else {
                        break;
                    }
                }

                return rates[rateIndex];
            };

            const getVideos = async (currentRate: number): Promise<PreviewVideo["state"]["previewFrames"]> => {
                let startTime = viewport.startTime - viewportSize * 0.5;
                let lastTime = viewport.endTime + viewportSize * 0.5;

                {
                    let curFrames = 0;
                    let curTime = startTime;
                    while(curTime < lastTime) {
                        let video = await this.downloader.DownloadVideo(currentRate, curTime, this.minFramesPerVideo, false);
                        if(video === "CANCELLED" || video === "FINISHED") break;
                        if(!video.nextTime) break;
                        if(video.video) {
                            let frac = (curTime - startTime) / (lastTime - startTime);
                            //console.log(`Video ${video.video.frameTimes.length} frames, frac ${(frac * 100).toFixed(1)}, ${this.timeToPos(curTime)} to ${this.timeToPos(video.nextTime)}, really ${this.timeToPos(video.video.frameTimes[0].time)} to ${this.timeToPos(video.video.frameTimes.last().time)}, fps ${GetVideoFPSEstimate(video.video)}`);
                        }
                        curTime = video.nextTime;
                        if(video.video) {
                            curFrames += video.video.frameTimes.length;
                            if(curFrames > maxFrames) {
                                console.warn(`GetVideo download cut off after max frames was exceeded. Max frames: ${maxFrames}`);
                                break;
                            }
                        }
                    }
                    
                }

                let videos = this.downloader.GetInfo(currentRate).Videos;
                g["videos"] = videos;
                let index = findAtOrBeforeOrAfterIndex(videos, startTime, x => x.frameTimes[0].time);
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

                            //baseTime: frame.time,
                            //baseNextTime: frame.time,

                            time: frame.time,
                            nextTime: frame.time,

                            addSeqNum: frame.addSeqNum,
                            frameCountEstimate: 1,
                            //duplicateSeqNum: 0,
                            //duplicateCount: 1,
                            fullWidth: frame.width,
                            fullHeight: frame.height,

                            source: video,

                            cameraStart: false,
                        });
                    }

                    index++;
                }

                for(let i = 0; i < previewFrames.length - 1; i++) {
                    let frameTime = previewFrames[i + 1].time - previewFrames[i].time;
                    let frameCount = previewFrames[i + 1].addSeqNum - previewFrames[i].addSeqNum;
                    let estimateFrameTime = i > 0 ? (previewFrames[i].time - previewFrames[i - 1].time) : frameTime;
                    let estimateFrameCount = i > 0 ? (previewFrames[i].addSeqNum - previewFrames[i - 1].addSeqNum) : frameCount;

                    // If there is too big of a gap ignore the gap, and assume the video just dropped out at that time. Extrapolate the frame length
                    //  based on the last frame length instead.
                    let frameGapSize = GetMinGapSize(previewFrames[i].rate);
                    if(frameTime > Math.max(frameGapSize, estimateFrameTime * 6)) {
                        
                        frameTime = estimateFrameTime;
                        frameCount = estimateFrameCount;
                        if(i + 1 < previewFrames.length) {
                            previewFrames[i + 1].cameraStart = true;
                        }
                    }
                    
                    // This addition assumes times are nice numbers (basically integers), as decimals will break this by making the nextTime != to the time of the next frame.
                    previewFrames[i].nextTime = previewFrames[i].time + frameTime;
                    previewFrames[i].frameCountEstimate = frameCount;
                }
                if(previewFrames.length > 1) {
                    let secondLast = previewFrames[previewFrames.length - 2];
                    previewFrames[previewFrames.length - 1].nextTime = previewFrames[previewFrames.length - 1].time + secondLast.nextTime - secondLast.time;
                }
                for(let i = 0; i < previewFrames.length; i++) {
                    //previewFrames[i].baseNextTime = previewFrames[i].nextTime;
                }

                return previewFrames;
            };

            let aspectRatioEstimate = 3/4;
            if(this.state.previewFrames.length > 0) {
                aspectRatioEstimate = max(this.state.previewFrames.map(x => x.fullWidth / x.fullHeight));
            }

            let currentRate = await getRate(state.heightPx / aspectRatioEstimate);

            if(!currentRate) {
                console.log(`No current rate, cannot get previews.`);
                return;
            }

            let previewFrames = await getVideos(currentRate);

            let correctRate = await getRate(this.getMaxFrameWidthPx(previewFrames));

            // If the currentRate is less than the correctRate then we requested too many frames, which is fine. We only
            //  really care if we requested too few frames.
            if(correctRate < currentRate) {
                previewFrames = await getVideos(correctRate);
            }

            if(previewFrames.length === 0) {
                console.log(`No preview frames`);
                return;
            }
            
            // Get average width in time, and take a fraction of that, and make poll delay that.
            let framePositions = this.getPreviewFramePositions(previewFrames, false);
            let averageTime = mean(framePositions.map(x => (x.right - x.left) * (viewport.endTime - viewport.startTime)));

            let pollDelay = averageTime * 0.5 / imageRows;

            this.setState({ previewFrames, pollDelay });

            console.log(`getPreviewFrames finished, rate: ${correctRate}, frames: ${previewFrames.length}, pollDelay ${pollDelay}`);
        });
    });

    private getMaxFrameWidthPx(frames: PreviewVideo["state"]["previewFrames"]): number {
        let { heightPx } = this.state;
        if(frames.length === 0) {
            return 100;
        }
        return max(frames.map(x => x.fullWidth / x.fullHeight * heightPx));
    }

    private timeToPos(time: number) {
        let { viewport } = this.props;
        let viewWidth = viewport.endTime - viewport.startTime;

        return (time - viewport.startTime) / viewWidth;
    }

    private alignToGrid() {
        // TODO: Make this stable

        // height, width => optimum height per frame => frame that constrains width the most => optimum total width?
        //      The total width will be a bit of a guess, as we won't really lay it out as a grid, just extrapolate from the most
        //      constraining frame.

        let { viewport } = this.props;
        let { previewFrames } = this.state;
        
        let perfectHeightPerFrame = this.state.heightPx / this.state.imageRows;
        let constrainedAspectRatio = min(previewFrames.map(x => x.fullWidth / x.fullHeight));
        let averageFPS = sum(previewFrames.map(x => x.frameCountEstimate)) / (previewFrames.last().nextTime - previewFrames[0].time);
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

    private getPreviewFramePositions(previewFrames: PreviewVideo["state"]["previewFrames"], forRender: boolean) {
        let { viewport } = this.props;
        let { widthPx, heightPx, imageRows } = this.state;

        // Ideally
        //let downsampleRate = Math.pow(2, Math.ceil(Math.log(perfectFrameCount) / Math.log(2)));

        //todonext
        // We actually need a constant downsample filter, that runs over the frames and downsamples them when there are too many.
        //  But... it also needs to be consistent. So... crap.
        //  (we need this to solve the variable fps problem).
        // Okay... let's do it like this.
        // We merge frames left (as in, remove a frame, but extend the time of the frame to that frame's left)
        // At first we evaluate every 2nd frame to see if we should merge it left (based on if it or the frame to its left
        //  is too small). Then for every frame merged we do every 4th frame (4th by the addSeqNum), 8th, etc, until nothing is merged.
        //  - Actually, we have to check every merged frame, but use the nth frame numbering as the base frame. Because the base frame
        //      might not have merged for a while, but it might still have a neighbor that needs merging.
        //  We can only merge onto something that has merged the same number of times?
        //  - But... what if we have a really small set of frames, and we merge them, but their neighbors are fine. After 1 merge
        //      we can't merge with our unmerged neighbors, even though if we did the resultant size would be acceptable (because we
        //      are so small).
        //  - But, I think having this rule is the only way to make sure we stay consistent.

        // Every 2nd, 4th, 8th, etc... check the frame and the left frame, and if either are below the threshold (or the sum is below the threshold?)
        //  then merge them.
        // I think... if a frame falls far away from a nice

        

        // Column starts... is difficult, because we don't know what pattern of addSeqNums will exist
        //  (we could be rate x4, and so if we just mod 4 we may get no matches! But if we just start with an offset it could
        //  be inconsistent as the ends vary. Maybe... we start with an offset in the highest power of the column count in the middle?
        //  or... I'm not sure why that would work... but it might?)

        if(previewFrames.length > 1 && widthPx > 0) {
        
            // Merge in the direction of the addSeqNum key frame loop direction.
            //  Because we don't know the rate of addSeqNum (because camera stops and starts might cause jumps without a certain rate,
            //  or cause a certain rate to be written more frequently, depending on how we implement that) we can't skip iterating over
            //  any values assuming their left/right sibling will check them, as strange addSeqNums may cause runs where many values
            //  merge onto themselves and will for a few iterations.

            

            // If need to merge, but our merge alias is ourself, then we we need to wait until a higher iteration to merge.


            // We might need to upsample after downsampling. Because...
            //  Example:
            //      Min width: 8, Max Width: 16
            //      Seq nums: 8 12 17
            //      Widths: 16 7 7
            //      The highest alias per seq num are:
            //      8 4 1
            //      So at iteration 1, seq num 17 merges

            // Wait... alias key frames... must exist, right? If not, we could have problems. Basically,
            //  alias key frames provide order, by making certain frames more likely to appear, and more likely to consistently appear.
            //  But really bad seq nums could break this.
            //  And, we have single level breaks where a frame can flip flop if there isn't an alias keyframe two times in a row.
            //  But... that is really likely... so... wait...
            //  And actually, because of our indexes, key frames will never happen? Like, 3, 7, 11, 15, etc, will never yield a multiple of 4,
            //      so... how should we do this?
            //  Maybe... we rank them based on closeness to powers of 2, and merge the farthest from those first (starting highest first).


            // Actually... we have to assume addSeqNums don't get offset at any rates, even with camera starts/stops, because if they do,
            //  then changing zoom level and then downsampling could drastically change the frames that are shown. We assume if we add 1
            //  any rate will have addSeqNums that are multiples of the rate, which lets us choose downsampled frames at higher rates appropriately,
            //  but if this isn't the case, we don't know which frames to choose.
            for(let frame of previewFrames) {
                if((frame.addSeqNum + 1) % frame.rate !== 0) {
                    debugger;
                    throw new Error(`AddSeqNums are offset, this will mess up downsampling frame choices.`);
                }
            }

            //  Add 1 and then sort by lowest bit, then break ties with the next bit, etc
            // Which is really, just sorting by the number with the bits reversed (as a 53 bit integer, or at least an integer)
            function getSeqPriority(frame: FramePreviewImage): number {
                return getNumber(getBits(frame.addSeqNum).reverse());
            }

            type FrameLinkedNode = {
                frame: FramePreviewImage;
                left: FrameLinkedNode|undefined;
                right: FrameLinkedNode|undefined;
                debugIndex: number;
            };
            let previewFramesPriority: FrameLinkedNode[] = [];
            for(let i = 0; i < previewFrames.length; i++) {
                previewFramesPriority.push({
                    frame: { ... previewFrames[i] },
                    left: undefined,
                    right: undefined,
                    debugIndex: i,
                });
            }
            for(let i = 0; i < previewFramesPriority.length; i++) {
                previewFramesPriority[i].left = previewFramesPriority[i - 1];
                previewFramesPriority[i].right = previewFramesPriority[i + 1];
            }
            sort(previewFramesPriority, x => getSeqPriority(x.frame));

            // Divide by imageRows twice as we will extend the width when we make things in a column, which will extend the height.
            //  Also add a bit of a extra height, to prevent rounding issues?
            let maxHeight = this.state.heightPx / this.state.imageRows / this.state.imageRows * 1.05;
            let frameToHeight = (frame: FramePreviewImage) => {
                let { viewport } = this.props;
                let { widthPx } = this.state;
                let width = (frame.nextTime - frame.time) / (viewport.endTime - viewport.startTime) * widthPx;
                return width / frame.fullWidth * frame.fullHeight;
            };

            // Always keep the highest priority frame
            for(let i = previewFramesPriority.length - 1; i > 0; i--) {
                let priority = previewFramesPriority[i];
                let frame = priority.frame;
                let mergeBase = priority.left;
                if(!mergeBase) continue;

                if(mergeBase.frame.nextTime !== frame.time || frame.cameraStart) {
                    // Don't merge, as it's a gap. It's unfortunate, but frames on the edges of gaps will just need to be smaller.
                    continue;
                }
                if(mergeBase.right !== priority || priority.left !== mergeBase) {
                    throw new Error(`Two frames were connected, but not siblings? Our linked list is probably broken.`);
                }

                // We merge if either needs to merge. MergeBase too, as we don't want our frame (a lower priority
                //  frame than mergeBase) to be kept and mergeBase to be merged away.
                //if(frameToHeight(frame) < minHeight || frameToHeight(mergeBase.frame) < minHeight) {
                let frameHeight = frameToHeight(frame);
                let baseHeight = frameToHeight(mergeBase.frame);

                let regularMerge = (frameHeight + baseHeight) <= maxHeight;
                // If either is really small, and adding them doesn't exceed height by too much, the merge
                let mergeToPreventReallySmall = (frameHeight < maxHeight * 0.35 || baseHeight < maxHeight * 0.35) && ((frameHeight + baseHeight) < maxHeight * 2);

                if(regularMerge || mergeToPreventReallySmall) {
                    mergeBase.frame.nextTime = frame.nextTime;
                    mergeBase.frame.frameCountEstimate += frame.frameCountEstimate;
                    if(priority.right) {
                        priority.right.left = mergeBase;
                    }
                    mergeBase.right = priority.right;
                }
            }

            let leftMost = previewFramesPriority[0];
            while(leftMost.left) {
                leftMost = leftMost.left;
            }

            let downsampledFrames: FramePreviewImage[] = [];
            let node = UnionUndefined(leftMost);
            while(node) {
                downsampledFrames.push(node.frame);
                node = node.right;
            }

            sort(downsampledFrames, x => x.time);
            if(!forRender) {
                console.log(`Downsampled ${previewFrames.length} to ${downsampledFrames.length}`);
            }
            previewFrames = downsampledFrames;

            

            /*

            // Oh, we need to be able to iterate from the lowest priority to the highest, but... we want to know the value
            //  with the index before us, and we need to be able to remove values. So... we need a structure for this.

            //  Columns are still going to be really hard...


            if(averageWidthPerFrame < minFrameWidthPx) {
                // Downsample
                let downsampledFrames: typeof previewFrames = [];
                for(let i = 0; i < previewFrames.length; i++) {
                    let frame = previewFrames[i];
                    // ceil is very important here, or else a downsampled 16x rate won't line up with the 4x rate, meaning all of the frames
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
            */
        }

        let nextColumnPos = 0;
        let mostCommonOffset = 0;
        let mostCommonIncrement: number|undefined;
        const getColumnPos = (frame: FramePreviewImage) => {
            let rateSeqNum = Math.ceil(frame.addSeqNum + 1 - mostCommonOffset) / (mostCommonIncrement || frame.rate);
            return (rateSeqNum % imageRows);
        }
        const isColumnTop = (frame: FramePreviewImage) => {
            return getColumnPos(frame) === 0;
        };
        
        if(previewFrames.length > 1) {
            // We want to make column positioning also consistent... however, we already downsampled, so... addSeqNum no longer increases in increments of rate.
            //  So... some stuff with finding the most common numbers that work here.
            mostCommonIncrement = histogram(previewFrames.slice(0, -1).map((_, i) => previewFrames[i + 1].addSeqNum - previewFrames[i].addSeqNum))[0].value;
            let localMostCommonIncrement = mostCommonIncrement;
            mostCommonOffset = histogram(previewFrames.map((x) => (x.addSeqNum + 1) % localMostCommonIncrement))[0].value;

            let firstColumnTop = 0;
            while(firstColumnTop < previewFrames.length) {
                if(isColumnTop(previewFrames[firstColumnTop])) {
                    break;
                }
                firstColumnTop++;
            }

            nextColumnPos = (imageRows - firstColumnTop % imageRows) % imageRows;
        }
        let previewFramesLocation = previewFrames.map(preview => {
            if(isColumnTop(preview)) {
                nextColumnPos = 0;
            }
            let columnPos = (nextColumnPos++) % imageRows;

            return {
                preview,
                columnPos: columnPos,
                left: this.timeToPos(preview.time),
                right: this.timeToPos(preview.nextTime),
                top: columnPos / imageRows,
                playLinePos: 0,
                cameraStart: preview.cameraStart,
            };
        });

        function alignRight() {
            // Use the right of the last of the column as the right of all frames within that column
            let curRight: number|undefined;
            for(let i = previewFramesLocation.length - 1; i >= 0; i--) {
                let obj = previewFramesLocation[i];
                curRight = curRight || obj.right;
                if(i === previewFramesLocation.length - 1 || previewFramesLocation[i + 1].columnPos === 0 || previewFramesLocation[i + 1].cameraStart) {
                    curRight = obj.right;
                }
                obj.right = curRight;
            }
        }

        alignRight();

        // Use the left of the start of every column as the left of all frames within that columns
        let curLeft: number|undefined;
        for(let i = 0; i < previewFramesLocation.length; i++) {
            let obj = previewFramesLocation[i];
            curLeft = curLeft || obj.left;
            if(obj.columnPos === 0 || obj.cameraStart) {
                curLeft = obj.left;
            }
            obj.left = curLeft;
        }

        let maxHeight = this.state.heightPx / this.state.imageRows;
        const frameToHeight = (frame: typeof previewFramesLocation[0]) => {
            return (frame.right - frame.left) * widthPx * frame.preview.fullHeight / frame.preview.fullWidth;
        };

        let columCounts = histogramLookup(previewFramesLocation.map(x => x.left));

        type PreviewLocation = typeof previewFramesLocation[0];

        // If the height is too small (maybe less than 4/10ths of the max height), and the column is less than half full,
        //  merge the column, to make the height more reasonable.
        let columnsToMerge: { [left: number]: boolean } = {};
        for(let i = 0; i < previewFramesLocation.length; i++) {
            let frame = previewFramesLocation[i];
            let columnCount = columCounts[frame.left];
            let sparseColumn = columnCount < imageRows * 0.5;
            let smallImage = frameToHeight(frame) < maxHeight * 0.4;
            if(sparseColumn && smallImage) {
                // Merge the whole column, as resizing after removing one frame will shrink the other frames, and so almost certainly
                //  result in them having to be merged too.
                columnsToMerge[frame.left] = true;
            }
        }

        for(let i = 1; i < previewFramesLocation.length; i++) {
            let frame = previewFramesLocation[i];
            let prevFrame = previewFramesLocation[i - 1];
            if(columnsToMerge[frame.left]) {
                prevFrame.preview.frameCountEstimate += frame.preview.frameCountEstimate;
                prevFrame.preview.nextTime = frame.preview.nextTime;
                prevFrame.right = frame.right;
                previewFramesLocation.splice(i, 1);
                i--;
            }
        }

        alignRight();

        // Create lookup to increase widths (right side) to fill gaps or empty space
        let nextColumnLefts: { [left: number]: number|undefined } = {};
        let lastLeft: number|undefined;
        for(let frame of previewFramesLocation) {
            if(frame.left !== lastLeft) {
                if(lastLeft) {
                    nextColumnLefts[lastLeft] = frame.left;
                }
                lastLeft = frame.left;
            }
        }


        for(let frame of previewFramesLocation) {
            let preview = frame.preview;
            let maxViewWidth = maxHeight / preview.fullHeight * preview.fullWidth / widthPx;

            let absPlayPos = this.timeToPos(preview.time);

            let curWidth: number;
            let nextLeft = nextColumnLefts[frame.left];
            if(!nextLeft) {
                curWidth = maxViewWidth;
            } else {
                nextLeft = Math.max(nextLeft, frame.right);
                curWidth = nextLeft - frame.left;
            }
            let viewWidth = Math.min(curWidth, maxViewWidth);

            let minView = frame.left;
            let maxView = frame.left + viewWidth;

            // Hmmm... start left on playPos. We could center or do whatever, but starting on the left is what we do everywhere else.
            let localPos = 0;
            frame.left = absPlayPos + viewWidth * localPos;
            if(frame.left < minView) {
                frame.left = minView;
            }
            frame.right = frame.left + viewWidth;
            if(frame.right > maxView) {
                frame.right = maxView;
                frame.left = frame.right - viewWidth;
            }
        }




        for(let frame of previewFramesLocation) {
            let absPos = this.timeToPos(frame.preview.time);

            let localPos = (absPos - frame.left) / (frame.right - frame.left);
            frame.playLinePos = localPos;
        }

        return previewFramesLocation;
    }

    public render() {
        let { viewport } = this.props;
        let { previewFrames, widthPx, heightPx, imageRows } = this.state;

        let previewFramesLocation = this.getPreviewFramePositions(previewFrames, true);

        // TODO: Only increase pollSeqNum if a range inside the viewport has been extended.
        return (
            <div className="PreviewVideo">
                <PollLoop delay={this.state.pollDelay} callback={() => { this.setState({ pollSeqNum: this.state.pollSeqNum + 1 })}} />
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
                        {previewFramesLocation.map((obj, i) => {
                            let x = obj.preview;
                            return (
                                <div
                                    className={`PreviewVideo-img`}
                                    style={{ left: obj.left * 100 + "%", width: (obj.right - obj.left) * 100 + "%", top: obj.top * 100 + "%" }}
                                    key={x.time}
                                    title={`${formatDate(x.time)}, Frames: ${x.frameCountEstimate}, Time: ${formatDuration(x.nextTime - x.time)}, Add Seq: ${x.addSeqNum}, Rate: ${x.rate}, ${x.time}, New Segment Start: ${x.cameraStart}`}
                                >
                                    <div>
                                        {<img
                                            data-time={x.time}
                                            data-video-time={RealTimeToVideoTime(x.time, x.rate)}
                                            src={x.imageUrl}
                                        />}
                                        {<div className="PreviewVideo-img-playLine" style={{ left: obj.playLinePos * 100 + "%" }}></div>}
                                    </div>
                                    <div className="PreviewVideo-img-info">
                                        {formatDuration(x.nextTime - x.time)}
                                        {/*formatDate(x.time)*/}
                                        {/*{formatDuration(x.nextTime - x.time)}, {(x.frameCountEstimate / (x.nextTime - x.time) * 1000).toFixed(1)}FPS, rate: {x.rate}, seq {x.addSeqNum}, frames {x.frameCountEstimate}*/}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </MeasuredElement>
            </div>
        );
    }
}