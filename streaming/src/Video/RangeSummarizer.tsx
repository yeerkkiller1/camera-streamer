import * as React from "react";
import { PropsMapReduce } from "../util/PropsMapReduce";

// Polyfills.
import "../util/math";
import { binarySearchMap, binarySearchNumber, binarySearch, findAtOrBefore, findAtOrAfter, findAtOrAfterIndex, findAtOrBeforeIndex, findAtOrBeforeOrAfter } from "../util/algorithms";
import { formatDuration, formatDate } from "../util/format";
import { getTimeSynced } from "../util/time";

import "./RangeSummarizer.less";
import { group, sum } from "../util/math";
import { RealTimeToVideoTime, RealDurationToVideoDuration, GetRangeFPSEstimate, GetVideoFPSEstimate } from "../NALStorage/TimeMap";
import { getIntialInputNumberValue, InputNumber, setInputValue, getInitialCheckboxValue, Checkbox } from "../util/Input";
import { unitList, UnitDurationObj, UnitType } from "../util/timeUnits";
import { keyBy, mapObjectValues, cloneDeep } from "../util/misc";
import { ClickAnim } from "../util/ClickAnim";
import { PreviewVideo } from "./PreviewVideo";


//todonext
// - unified trackbar
//      - show times
//          - have ticks, large ticks with labels, small ticks without labels
//          - show absolute time... somewhere, and then relative times?
//              - like, show the day below a chunk, and then within that just show the hour?
//              - maybe stacked times?
//      - should show what rates are available at various times
//      - when playing automatically switch rates when future video for the current rate isn't available?

//todonext
// On scroll have a visual indicator to show location
//  - Can we animate zoom in/out?
//  - When zoom out flash/highlight the area that was previously shown
//  - On zoom in flash/highlight the position that was centered


//todonext
//  - Lock onto (center) play line / auto locked off / locked off
//      - Add a stem that overlaps the video (or whatever is above us). They can hide it by unlocking the play time and scrolling the viewport, if they absolutely have to.
//  - Display ranges for different rate levels
//      - Perhaps overlap all ranges, but then highlight it differently or something to show when any rates are missing?
//  - Correct measurement of text and alignment
//  - Days of week, and color indicators option for colored weekends
//  - Navigation features
//      - Drag to select and zoom in
//      - Middle click to zoom out to level of unit.
//  - Have labels be in one of two modes
//      - Fit within range, so every range has a label
//      - Not within range, so we show the labels a bit farther up?, and downsample them so the text doesn't overlap
//      - We could also have a minimum text margin (based on the size of the text? or max size, or average?), and downsample like that
//          - The results would be fairly similiar
//  - Keep unused small increments as greyed as boxes, so the height doesn't change.
//  - Maybe we shouldn't playtime lines when the user clicks? The only reason we animate them is so they line up with the grid
//      when the grid moves, but if the grid isn't moving they should probably be exact.

// When ranges get small enough make them actual ticks, with major and minor ticks.
// Don't proc major/minor counts if they will collide with rollover (ex, don't proc the rate of 7 if in 7 we will rollover).
// Day of week next to day
// Maybe we could have a daylight indicator as another bar? It could be pretty useful in identifying the time,
//  both in medium (hourly) views, and in daily views, where the cycle can be seen.

// Maybe scrollwheel to move when over an indicator?
// But then also someway to zoom in/out? Maybe scroll wheel zooms, but
//  scrollwheel side/side can pan?
// Drag to select a region (and zoom into it)?
// Play time indicator? Perhaps it is a line/flag that goes up and overlaps the video? And maybe... it has an
//  "edit" button/link at the end of the time, to directly input.
// Also start/end times of the view should probably have direct input?
// Maybe middle click, or double click? to open up "select video" on unit line. This puts an overlay on that
//  bar that is slightly bigger (with shadows or something to show it is popping out / is a dialog), that has
//  all the unit times for the unit (all the months, or hours, etc), which are clearly clickable, and then
//  clicking on them sets the zoom to be that exact unit (with the unit values above that unit preserved).
//  - Perhaps start the numbering offset somewhat? so it centers around the current time. That way you can be working
//      around like midnight, but still have the hours for both days?

// Actually... if we had kind of like a multi radial thing, with numbers spanning each unit count,
//  and then had a line where the current play indicator was, and where video was? That would make it really
//  easy to go from a large span of time to small. Except... the small spans of time might be confusing,
//  as they would be essentially meaningless when you are jumping around at larger units of time.
//  - I could autoalign all lesser units to 0 when you seek on a larger scale?
// Maybe instead of that, we could just add quick "zoom out" buttons to each unit, to show a bunch of that unit type as labels.
//  - Or even an "set" mode, where the labels become links, and clicking on them zooms into that. So you zoom all the way out,
//      and then click the month, day, hour, minute, second.


interface IProps {
    server: IHost;

    // TODO: Allow ranges to be mutated, by changing endTimes of the last range,
    //  OR by adding new ranges. Removing ranges will never be allowed.
    // ranges are sorted be time
    receivedRanges: NALRange[];
    serverRanges: NALRange[];
    receivedFrames: NALInfoTime[];

    currentPlayTime: number;
    targetPlayTime: number;

    debugVideo: boolean;

    loadedVideos: MP4Video[];

    onTimeClick: (time: number) => void;
    getServerRanges: (rate: number) => Promise<NALRange[]>;

    isLiveStreaming: boolean;
}

interface Viewport {
    startTime: number;
    endTime: number;
}

interface IState {
    viewport: Viewport;

    viewLocked: boolean;
    softViewUnlocked: boolean;
}

const viewportStart = "viewportStart";
const viewportEnd = "viewportEnd";
const viewLockedConst = "viewLocked";
const softViewUnlocked = "softViewUnlocked";

export class RangeSummarizer extends React.Component<IProps, IState> {
    state: IState = this.initState();
    private initState(): IState {
        return {
            viewport: {
                startTime: getIntialInputNumberValue(viewportStart, +new Date("Tue Aug 07 2018 18:32:34 GMT-0400")),
                endTime: getIntialInputNumberValue(viewportEnd, +new Date("Tue Aug 07 2018 18:32:34 GMT-0400") + 60 * 1000 * 15)
            },
            viewLocked: getInitialCheckboxValue(viewLockedConst),
            softViewUnlocked: getInitialCheckboxValue(softViewUnlocked),
        };
    };

    componentWillUpdate(nextProps: IProps, nextState: IState) {
        setInputValue(viewportStart, nextState.viewport.startTime);
        setInputValue(viewportEnd, nextState.viewport.endTime);
        setInputValue(viewLockedConst, nextState.viewLocked);
        setInputValue(softViewUnlocked, nextState.softViewUnlocked);

        if(nextProps.targetPlayTime !== this.props.targetPlayTime) {
            if(this.state.softViewUnlocked && !this.state.viewLocked) {
                this.setState({ viewLocked: true });
            }
            this.setState({ softViewUnlocked: false });
        }

        if(nextState.viewLocked) {
            if(this.props.targetPlayTime !== nextProps.targetPlayTime) {
                let { targetPlayTime } = nextProps;
                let { viewport } = nextState;
                let size = viewport.endTime - viewport.startTime;

                let center = nextProps.isLiveStreaming ? 0.8 : 0.5;

                viewport.startTime = targetPlayTime - size * center;
                viewport.endTime = targetPlayTime + size * (1 - center);

                this.setState({ viewport });
            }
        }
    }

    private animateViewport(viewport: Viewport, highlighted: number|Viewport|undefined) {
        this.setState({ viewport });
        /*
        this.setState({ viewportAnimation: viewport, onViewportRender: () => {
            setTimeout(() => {
                this.setState({ viewportAnimation: undefined, viewport });
            }, 0);
        } });
        */
    }

    private onWheelRuler(event: React.WheelEvent<HTMLElement>) {
        if(event.deltaY !== 0) {
            let { viewport } = this.state;

            let s = viewport.startTime;
            let e = viewport.endTime;
            let size = e - s;

            if(event.deltaY < 0) {
                let elem = event.currentTarget;
                let rect = elem.getBoundingClientRect();

                let fraction = (event.clientX - rect.left) / rect.width;

                if(this.state.viewLocked) {
                    fraction = 0.5;
                }

                s = s + size * fraction * 0.5;
                e = e - size * (1 - fraction) * 0.5;

                if(fraction !== 0.5) {
                    this.setState({ viewLocked: false, softViewUnlocked: this.state.viewLocked || this.state.softViewUnlocked });
                }
            } else {
                let center = (s + e) * 0.5;

                s = center - size * 1;
                e = center + size * 1;
            }

            viewport.startTime = s;
            viewport.endTime = e;

            this.animateViewport(viewport, undefined);
            //this.setState({ viewport });

            event.preventDefault();
        }
        if(event.deltaX !== 0) {
            let { viewport } = this.state;

            let s = viewport.startTime;
            let e = viewport.endTime;
            let size = e - s;

            if(event.deltaX < 0) {
                s = s - size * 0.25;
                e = e - size * 0.25;
            } else {
                s = s + size * 0.25;
                e = e + size * 0.25;
            }

            viewport.startTime = s;
            viewport.endTime = e;

            this.animateViewport(viewport, undefined);

            if(this.state.softViewUnlocked && (s + e) / 2 === this.props.targetPlayTime) {
                this.setState({ viewLocked: true, softViewUnlocked: false });
            } else {
                this.setState({ viewLocked: false, softViewUnlocked: this.state.viewLocked || this.state.softViewUnlocked });
            }

            event.preventDefault();
        }
    }

    private onClickRuler(event: React.MouseEvent<HTMLElement>) {
        if(event.button !== 0) return;

        let elem = event.currentTarget as HTMLElement;
        let rect = elem.getBoundingClientRect();
        let fraction = (event.clientX - rect.left) / rect.width;

        let { viewport } = this.state;
        let clickTime = viewport.startTime + (viewport.endTime - viewport.startTime) * fraction;

        this.props.onTimeClick(clickTime);
    }

    private renderUnits(): JSX.Element[] {
        let lastFreezedTimes = this.lastFreezedTimes;
        let newFreezedTimes: typeof lastFreezedTimes = {};
        this.lastFreezedTimes = newFreezedTimes;

        let viewport = this.state.viewport;

        let duration = viewport.endTime - viewport.startTime;
        
        let maxLabelCount = 20;

        // TODO: Actually make ticks work...
        let maxTickCount = 30;

        // TODO: We should actually calculate this...
        let textSizeFractionOfBar = 0.08;

        let bufferFraction = 1;

        let unitsInScope = unitList.filter((x, i) => i >= 2 || duration / x.defaultDuration < 160);
        return unitsInScope.map(unit => {
            let durations = duration / unit.defaultDuration < 160 ? unit.getDurations(viewport.startTime, viewport.endTime, bufferFraction) : [];

            // TODO: This is a temporary fix for rounding issues with very large sizes (causing the text label to not appear in the correct
            //  position for large ranges). It doesn't work if you are close to a year boundary... but that should be fine for now.
            if(durations.length === 1 && durations[0].fracSize > 1000) {
                durations[0].fracSize = 1000;
                durations[0].fracPos = -200;
            }

            let estimatedCount = duration / unit.defaultDuration;
            let majorCount = Math.floor(estimatedCount / unit.defaultMajorCount);
            let minorCount = Math.floor(estimatedCount / unit.defaultMinorCount);
            let noneCount = estimatedCount;

            let minLabelImportance: 0|1|2 = 0;
            if(durations.length > 0) {
                if(noneCount > maxLabelCount) {
                    minLabelImportance = 1;
                    if(minorCount > maxLabelCount) {
                        minLabelImportance = 2;
                        if(majorCount > maxLabelCount) {
                            minLabelImportance = 3 as any;
                            console.warn(`Hiding labels from ${unit.defaultDuration}, as the major count is still too great. Either the major frequency is too high, or our threshold for hiding units is too high or our threshold for the max labels we can show is too low.`);
                        }
                    }
                }
            }

            let lastFreezed = lastFreezedTimes[unit.unit] || {};
            let newFreezed = newFreezedTimes[unit.unit] = newFreezedTimes[unit.unit] || {};

            function getCenter(posObj: UnitDurationObj, textSizeFractionOfBar: number): { pos: number, aligned: boolean } {
                let barMargin = Math.min(posObj.fracSize / 2, textSizeFractionOfBar);
                let unitChunkMargin = textSizeFractionOfBar / posObj.fracSize;
                if(unitChunkMargin > 0.5) {
                    unitChunkMargin = 0.5;
                }

                let centerPos = posObj.fracPos + posObj.fracSize * 0.5;
                if(centerPos < barMargin) {
                    // barMargin = posObj.fracPos + posObj.fracSize * X,
                    //  but posObj.fracPos + posObj.fracSize * X not outside of [posObj.fracPos + textSizeFractionOfBar, posObj.fracPos + posObj.fracSize - textSizeFractionOfBar]
                    //  posObj.fracSize * X not outside of [textSizeFractionOfBar, posObj.fracSize - textSizeFractionOfBar]

                    // textSizeFractionOfBar
                    let pos = (barMargin - posObj.fracPos) / posObj.fracSize;
                    if(pos < 1 - unitChunkMargin) {
                        return { pos, aligned: true };
                    }
                    return {
                        pos: 1 - unitChunkMargin,
                        aligned: false
                    };
                }
                if(centerPos > 1 - barMargin) {
                    // 1 - barMargin = posObj.fracPos + posObj.fracSize * X
                    let pos = (1 - barMargin - posObj.fracPos) / posObj.fracSize;
                    if(pos > unitChunkMargin) {
                        return { pos, aligned: true };
                    }
                    return {
                        pos: unitChunkMargin,
                        aligned: false
                    };
                }
                return { pos: 0.5, aligned: false };
            }

            return (
                <div
                    className="RangeSummarizer-ruler-units"
                    key={unit.defaultDuration}
                >
                    {durations.map(posObj => {
                        let centerObj = getCenter(posObj, textSizeFractionOfBar);
                        if(centerObj.aligned) {
                            newFreezed[posObj.time] = true;
                        }
                        return (
                            <React.Fragment key={"unit" + posObj.time}>
                                <div
                                    className={`RangeSummarizer-ruler-units-unitTray`}
                                    style={{ left: posObj.fracPos * 100 + "%", width: posObj.fracSize * 100 + "%" }}
                                    key={"tray" + posObj.time}
                                    title={`${new Date(posObj.time).toString()}`}
                                >
                                    <div className="RangeSummarizer-ruler-units-unitLabel-tray"></div>
                                    <div className="RangeSummarizer-ruler-units-unitLabel-trayLeft"></div>
                                    <div className="RangeSummarizer-ruler-units-unitLabel-trayRight"></div>
                                </div>
                                <div
                                    className={`RangeSummarizer-ruler-units-unitLabel ${centerObj.aligned && lastFreezed[posObj.time] ? "RangeSummarizer-ruler-units-unitLabel--noAnimation" : ""} ${centerObj.aligned ? "RangeSummarizer-ruler-units-unitLabel--aligned" : ""}`}
                                    style={{ left: posObj.fracPos * 100 + "%", width: posObj.fracSize * 100 + "%" }}
                                    key={"label" + posObj.time}
                                    title={`${new Date(posObj.time).toString()}`}
                                >
                                    {posObj.importances[minLabelImportance] && (
                                        <div
                                            className={`RangeSummarizer-ruler-units-unitLabel-text`}
                                            style={{ left: centerObj.pos * 100 + "%" }}
                                        >
                                            {posObj.unitTime}
                                        </div>
                                    )}
                                </div>
                            </React.Fragment>
                        );
                    })}
                </div>
            )
        });
    }

    private toggleViewLock() {
        let { currentPlayTime } = this.props;
        let { viewport } = this.state;
        let s = viewport.startTime;
        let e = viewport.endTime;
        let size = e - s;

        viewport.startTime = currentPlayTime - size / 2;
        viewport.endTime = currentPlayTime + size / 2;

        this.setState({ viewport, viewLocked: !this.state.viewLocked, softViewUnlocked: false });
    }

    private renderVideo(): JSX.Element {
        let {
            serverRanges,
            receivedRanges,
            receivedFrames,

            targetPlayTime,
            currentPlayTime,
        } = this.props;
        let {
            viewport,
            viewLocked,
            softViewUnlocked,
        } = this.state;

        function pos(time: number) {
            return (time - viewport.startTime) / (viewport.endTime - viewport.startTime);
        }
        function filterSegments(ranges: NALRange[]): NALRange[] {
            return ranges.filter(x =>
                viewport.startTime <= x.firstTime && x.firstTime <= viewport.endTime || viewport.startTime <= x.lastTime && x.lastTime <= viewport.endTime
                || x.firstTime <= viewport.startTime && viewport.startTime <= x.lastTime || x.firstTime <= viewport.endTime && viewport.endTime <= x.lastTime
            );
        }
        function filterFrames<T extends {time: number}>(timeObjs: T[] | undefined): T[] {
            if(!timeObjs) return [];
            return timeObjs.filter(x => viewport.startTime <= x.time && x.time <= viewport.endTime);
        }
        function formatRangeCSS(range: NALRange): React.CSSProperties {
            // Dammit, css is 16 bit precision? At a render level too, so we can't cheat it by using left and translateX
            // So... we have to make sure the ranges aren't very large, which means we can't just use pos.

            let start = pos(range.firstTime);
            let end = pos(range.lastTime);

            if(start < -10) {
                start = -10;
            }
            if(end > 10) {
                end = 10;
            }

            return {
                left: start * 100 + "%",
                width: (end - start) * 100 + "%",
            };
        }

        let enableFrameLevelDisplay = receivedFrames.length < 100 || (viewport.endTime - viewport.startTime) < 10000;

        let curSeqNum = -1;
        let curPlayTimeObj = findAtOrBefore(receivedFrames, currentPlayTime, x => x.time);
        if(curPlayTimeObj) {
            curSeqNum = curPlayTimeObj.addSeqNum;
        }

        return (
            <div className={`RangeSummarizer-ruler-video ${!viewLocked ? "RangeSummarizer-ruler-video--viewUnlocked" : ""} ${softViewUnlocked ? "RangeSummarizer-ruler-video--softViewUnlocked" : ""}`}>
                <div
                    className="RangeSummarizer-ruler-video-cutOffOverflow"
                >
                    {filterSegments(serverRanges).map(range => (
                        <div
                            key={"serverRange-" + range.firstTime}
                            className="RangeSummarizer-ruler-video-serverRange"
                            style={formatRangeCSS(range)}
                        ></div>
                    ))}

                    {filterSegments(receivedRanges).map(range => (
                        <div
                            key={"receivedRange-" +range.firstTime}
                            className="RangeSummarizer-ruler-video-receivedRange"
                            style={formatRangeCSS(range)}
                        ></div>
                    ))}

                    {enableFrameLevelDisplay && filterFrames(receivedFrames).map(timeObj => (
                        <div
                            key={"receivedFrame-" + timeObj.time}
                            className={`RangeSummarizer-ruler-video-receivedFrame ${timeObj.type === NALType.NALType_keyframe ? "RangeSummarizer-ruler-video-receivedFrame--keyframe" : ""}`}
                            style={{
                                left: pos(timeObj.time) * 100 + "%"
                            }}
                        ></div>
                    ))}
                </div>

                <div
                    className="RangeSummarizer-ruler-video-targetPlayLine"
                    style={{ left: pos(targetPlayTime) * 100 + "%" }}
                    title={`${targetPlayTime}`}
                >
                    <div className="RangeSummarizer-ruler-video-targetPlayLine-time">
                        {formatDate(targetPlayTime)} {curSeqNum < 0 ? "" : curSeqNum}
                    </div>
                </div>
                <div className="RangeSummarizer-ruler-video-playLine" style={{ left: pos(currentPlayTime) * 100 + "%" }}></div>

                <ClickAnim
                    button={<div className="RangeSummarizer-ruler-video-lock">
                        <span className="RangeSummarizer-ruler-video-lock-text">Unlocked View</span>
                        <Checkbox globalKey={viewLockedConst} indeterminate={softViewUnlocked} onValue={() => {}} />
                    </div>}
                    onClick={() => this.toggleViewLock() }
                    hoverClassName="RangeSummarizer-ruler-video-lock--hover"
                />
                
            </div>
        );
    }

    private lastFreezedTimes: { [unit: string]: { [time: number]: boolean } } = {};
    private renderRuler(): JSX.Element {
        
        let viewport = this.state.viewport;

        // TODO:
        //  Actually, maybe take the largest removed unit, and put it's major ticks as ticks on the next largest unit,
        //      to give more granularity. As if we are viewing a period of 8 hours, or even 4 hours, there would be
        //      240 or 480 minute ticks (way too many), but too few hour ticks (only 8), so we really want to combine them.
        //      OR... maybe we should allow way more base units, as even if there are 600 minute units, there will only be
        //      like 20 major ticks, which don't even need to show up as labels, so it is really alright.

        return (
            <div
                className="RangeSummarizer-ruler"
            >
                {this.renderVideo()}
                <div
                    className="RangeSummarizer-rulerClickArea"
                    data-view-start={viewport.startTime}
                    data-view-end={viewport.endTime}
                    onWheel={x => this.onWheelRuler(x)}
                    onClick={x => this.onClickRuler(x)}
                >
                    {this.renderUnits()}
                </div>
            </div>
        )
    }

    public render() {
        let { viewport } = this.state;
        let { serverRanges } = this.props;
        //let segments = serverRanges.segments;

        //let beforeRanges = segments.filter(x => x.firstTime < viewport.startTime);
        //let afterRanges = segments.filter(x => x.lastTime > viewport.endTime);
        //let ranges = segments.filter(x => !(x.lastTime < viewport.startTime || x.firstTime > viewport.endTime));

        // Absolute times at start and end of viewport.
        // Maybe we can have ruler for the whole duration? And then highlight the areas where there is actually view.
        // Ruler could be thin/frail/ghost-like/stenciled, and then we could use colors behind that ghost text/lines
        //  to show where video is? And then maybe... something more to show the current play position? (because the current
        //  play position also needs indicators when it is out of the current viewport)

        // Stack of units, with increments too small not shown, increments that are fairly small (so high in quantity), with less height/font size,
        //  and units that are too large also with less heigh/font size.
        //  So there is a bubble/zoom effect on the sizes that are the most in line with the current zoom level?

        let realDuration = this.state.viewport.endTime - this.state.viewport.startTime;

        let currentVideo = findAtOrBeforeOrAfter(this.props.loadedVideos, (viewport.endTime + viewport.startTime) / 2, x => x.frameTimes[0].time);
        let viewportFPSEstimate: number = currentVideo ? GetVideoFPSEstimate(currentVideo) * currentVideo.rate : 10;
        let videoDimensionsEstimate: { width: number; height: number; } = currentVideo ? { width: currentVideo.width, height: currentVideo.height } : { width: 1920, height: 1080 };

        return (
            <div className="RangeSummarizer">
                <div>
                    View Capture Duration: {formatDuration(realDuration)}
                </div>
                {/*
                <div>
                    Start Time: {new Date(viewport.startTime).toString()}
                    <InputNumber globalKey={viewportStart} onValue={x => { viewport.startTime = x; this.setState({ viewport: viewport }); }} />
                </div>
                <div>
                    End Time: {new Date(viewport.endTime).toString()}
                    <InputNumber globalKey={viewportEnd} onValue={x => { viewport.endTime = x; this.setState({ viewport: viewport }); }} />
                </div>
                */}

                {
                <PreviewVideo
                    viewport={cloneDeep(viewport)}
                    setViewport={viewport => this.setState({viewport})}
                    getServerRanges={this.props.getServerRanges}
                />
                }

                {this.renderRuler()}
                {/*this.renderExcludedRanges(beforeRanges, -1)*/}
                {/*this.renderExcludedRanges(afterRanges, +1)*/}
            </div>
        );
    }
}