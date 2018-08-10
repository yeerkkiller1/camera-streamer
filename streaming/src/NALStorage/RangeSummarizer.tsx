import * as React from "react";
import { PropsMapReduce } from "../util/PropsMapReduce";

// Polyfills.
import "../util/math";
import { binarySearchMap, binarySearchNumber, binarySearch, findAtOrBefore, findAtOrAfter, findAtOrAfterIndex, findAtOrBeforeIndex } from "../util/algorithms";
import { formatDuration } from "../util/format";
import { getTimeSynced } from "../util/time";

import "./RangeSummarizer.less";
import { group, sum } from "../util/math";
import { SegmentRanges } from "./rangeMapReduce";
import { RealTimeToVideoTime, RealDurationToVideoDuration } from "./TimeMap";
import { getIntialInputNumberValue, InputNumber, setInputValue } from "../util/Input";

interface IProps {
    // TODO: Allow ranges to be mutated, by changing endTimes of the last range,
    //  OR by adding new ranges. Removing ranges will never be allowed.

    rate: number;
    speedMultiplier: number;

    // ranges are sorted be time
    receivedRanges: SegmentRanges|undefined;
    serverRanges: SegmentRanges;
    requestedRanges: SegmentRanges|undefined;
    receivedFrames: NALTime[]|undefined;

    currentPlayTime: number;

    debugVideo: boolean;

    onTimeClick: (time: number) => void;
}
interface IState {
    viewport: {
        startTime: number;
        endTime: number;
    }
}

function getOverlaps(baseRange: NALRange, ranges: SegmentRanges|undefined, toFracPos: (pos: number) => number): { startFrac: number, sizeFrac: number }[] {
    let overlapFracs: { startFrac: number, sizeFrac: number }[] = [];
    if(!ranges) {
        return overlapFracs;
    }
    let segments = ranges.segments;
    let index = binarySearchMap(segments, baseRange.firstTime, x => x.firstTime);
    if(index < 0) {
        index = ~index - 1;
        if(index < 0) {
            index = 0;
        }
    }

    while(index < segments.length && segments[index].firstTime < baseRange.lastTime) {
        let receivedStart = Math.max(segments[index].firstTime, baseRange.firstTime);
        let receivedEnd = Math.min(segments[index].lastTime, baseRange.lastTime);

        overlapFracs.push({
            startFrac: toFracPos(receivedStart),
            sizeFrac: toFracPos(receivedEnd) - toFracPos(receivedStart)
        });
        index++;
    }

    return overlapFracs;
}


const unitTypeList: UnitType[] = ["ms", "s", "m", "h", "d", "mon", "y"];
type UnitType = "ms" | "s" | "m" | "h" | "d" | "mon" | "y";

function getPreviousUnitBoundary(time: number, unit: UnitType): number {
    let unitIndex = unitTypeList.indexOf(unit);
    if(Math.abs(time - setUnitValue(time, "ms", 0)) > 1000) {
        // For DST setting any fields for certain times wipes out the timezone. So... that would matter (for "h" unit type and lower),
        //  set the times differently (explicitly subtract milliseconds).
        if(unitIndex <= unitTypeList.indexOf("h")) {
            if(unitIndex <= unitTypeList.indexOf("h")) {
                time -= new Date(time).getMinutes() * 60 * 1000;
            }
            if(unitIndex <= unitTypeList.indexOf("m")) {
                time -= new Date(time).getSeconds() * 1000;
            }
            if(unitIndex <= unitTypeList.indexOf("s")) {
                time -= new Date(time).getMilliseconds();
            }
            return time;
        }
    }
    let smallerUnits = unitTypeList.filter(x => unitTypeList.indexOf(x) < unitIndex);
    for(let smallerUnit of smallerUnits) {
        time = setUnitValue(time, smallerUnit, 0);
    }
    return time;
}

/** Gives the next boundary on the indicated unit. (as in, the time when the indicator of that unit changes).
 * 
 *      For DST we consider 1am DST and 1am NO DST different hour units, so although the indicator may not change
 *          (or it might, if DST / NO DST is shown), we will have a boundary between them (making every hour almost exactly
 *          an hour, instead of one hour being 2 hours).
 * 
 *      Operates in the local timezone. In Javascript the native date object doesn't let us do anything more (except for UTC,
 *          but this function in UTC is trivial).
 */
function getNextUnitBoundary(time: number, unit: UnitType): number {
    let prevBoundary = getPreviousUnitBoundary(time, unit);
    let nextTime = setUnitValue(prevBoundary, unit, getUnitValue(time, unit) + 1);

    // Stupid DST...
    if(unit === "h") {
        let delta = (nextTime - prevBoundary);
        if(delta > 1000 * 60 * 60 * 1.5) {
            // We left daylight savings, an hour repeated
            nextTime -= 1000 * 60 * 60 * 1;
        }
        if(delta < 1000 * 60 * 60 * 0.5) {
            // We entered daylight savings, an hour was skipped
            nextTime += 1000 * 60 * 60 * 1;
        }
    }

    return nextTime;
}
function getUnitValue(time: number, unit: UnitType): number {
    switch(unit) {
        default: {
            // Missing handler for a unit
            let x: never = unit;
            throw new Error(`No handler for ${unit}`);
        }
        case "ms": return new Date(time).getMilliseconds();
        case "s": return new Date(time).getSeconds();
        case "m": return new Date(time).getMinutes();
        case "h": return new Date(time).getHours();
        // Force zero index
        case "d": return new Date(time).getDate() - 1;
        case "mon": return new Date(time).getMonth();
        case "y": return new Date(time).getFullYear();
    }
}
/** It's expected that invalid values will just roll over here. */
function setUnitValue(time: number, unit: UnitType, value: number): number {
    switch(unit) {
        default: {
            // Missing handler for a unit
            let x: never = unit;
            throw new Error(`No handler for ${unit}`);
        }
        case "ms": return new Date(time).setMilliseconds(value);
        case "s": return new Date(time).setSeconds(value);
        case "m": return new Date(time).setMinutes(value);
        case "h": return new Date(time).setHours(value);
        // Force zero index
        case "d": return new Date(time).setDate(value + 1);
        case "mon": return new Date(time).setMonth(value);
        case "y": return new Date(time).setFullYear(value);
    }
}

function getCurrentUnitSize(time: number, unit: UnitType): number {
    return getNextUnitBoundary(time, unit) - getPreviousUnitBoundary(time, unit);
}

type UnitDurationObj = {
    fracPos: number;
    fracSize: number;
    duration: number;
    // Global time
    time: number;
    // Time formated. Ex, 5h, or 5am, or Wed, 9th, etc.
    unitTime: string;
    // Visual importance, used to thin the durations we show. For example, we probably can't show 100 minute labels.
    //  So we will show less, but if we show any we should show the half hour marks, instead of random times.
    // Higher means we are more likely to show as a label, or at least a tick.
    importances: { [key in 0|1|2]: boolean };
};
type Unit = {
    unit: UnitType;

    // Default, could change with leap hours, leap years and always changes with months
    defaultDuration: number;

    defaultMinorCount: number;
    defaultMajorCount: number;

    /** Gets the duration of the unit at that specific time */
    getDurationAt(time: number): number;

    /** Fractional alignment of unit that falls on that time. From 0 (unit starts on time) to just less than 1 (unit ends just after the time). */
    getAlignment(time: number): number;

    /** Gets list of durations for this time span.
     *      If startTime is offset from unit boundaries we give the full duration, which may extend beyond startTime. Same for endTime.
     * 
     *      It is highly recommend you add a bufferFraction. Both to prevent labels that may have a duration out of the view, but a label
     *          in the view from being hidden, and then suddenly appearing (with a buffer they can appear naturally, as if they were always there),
     *          and because the end behavior of this isn't great (if endTime is on or close to a boundary durations may be excluded, or included, randomly).
     * 
     * */
    getDurations(startTime: number, endTime: number, bufferFraction: number): UnitDurationObj[];
};
const unitList: Unit[] = (() => {
    let increments: Unit[] = [];
    let lastUnitMs = 1;
    function addNextUnitIncrement(unit: UnitType, factor: number) {
        let index = increments.length;
        let defaultDuration = lastUnitMs * factor;
        lastUnitMs = defaultDuration;

        function getLargerUnitNextBoundary(time: number) {
            let nextObj = increments[index + 1];
            if(nextObj) {
                return getNextUnitBoundary(time, nextObj.unit);
            }
            throw new Error(`Could not find unit larger than ${unit}`);
        }
        function getLargerUnitPrevBoundary(time: number) {
            let nextObj = increments[index + 1];
            if(nextObj) {
                return getPreviousUnitBoundary(time, nextObj.unit);
            }
            throw new Error(`Could not find unit larger than ${unit}`);
        }

        // Both should usually divide the number of units before we wrap over evenly. However, with DST they can't, and as a result there might be
        //  more space than usual between ticks, or ticks may be closer together than usual. Oh well...
        let { majorCount, minorCount } = (() => {
            switch(unit) {
                default: {
                    // Missing handler for a unit
                    let x: never = unit;
                    throw new Error(`No handler for ${unit}`);
                }
                // type UnitType = "ms" | "s" | "m" | "h" | "d";
                case "ms": return { majorCount: 500, minorCount: 100 };
                case "s": return { majorCount: 30, minorCount: 10 };
                case "m": return { majorCount: 30, minorCount: 10 };
                case "h": return { majorCount: 12, minorCount: 4 };
                case "d": return { majorCount: 14, minorCount: 7 };
                case "mon": return { majorCount: 6, minorCount: 2 };
                case "y": return { majorCount: 5, minorCount: 2 };
            }
        })();

        increments.push({
            unit,
            defaultDuration,
            defaultMinorCount: minorCount,
            defaultMajorCount: majorCount,
            getDurationAt(time: number): number {
                return getCurrentUnitSize(time, unit);
            },
            getAlignment(time: number): number {
                return (time - getPreviousUnitBoundary(time, unit)) / getCurrentUnitSize(time, unit);
            },
            getDurations(startTime: number, endTime: number, bufferFraction: number): UnitDurationObj[] {
                let durations: UnitDurationObj[] = [];
                
                let viewDuration = endTime - startTime;
                let time = startTime - viewDuration * bufferFraction;
                let effectiveEndTime = endTime + viewDuration * bufferFraction;

                time = getPreviousUnitBoundary(time, unit);

                let localIndex: number;
                if(unit === "y") {
                    localIndex = new Date(time).getFullYear();
                } else {                   
                    // localIndex resets every time the unit larger than us increases by 1
                    localIndex = 0;

                    let indexZeroStart = getLargerUnitPrevBoundary(time);
                    let tempTime = indexZeroStart;
                    while(true) {
                        tempTime += getCurrentUnitSize(tempTime, unit);
                        if(tempTime > time) break;
                        localIndex++;
                    }
                }

                while(time < effectiveEndTime) {
                    if(durations.length > 1000) {
                        debugger;
                    }
                    let nextTime = getNextUnitBoundary(time, unit);
                    let duration = getCurrentUnitSize(time, unit);

                    let fracPos = (time - startTime) / viewDuration;
                    let fracSize = duration / viewDuration;

                    let unitTime: string;
                    {
                        unitTime = localIndex + unit;
                        if(unit === "h") {
                            let index = new Date(time).getHours();
                            let suffix = index < 12 ? "am" : "pm";
                            index = index % 12;
                            if(index === 0) {
                                index = 12;
                            }
                            unitTime = index + suffix;
                        }
                        if(unit === "d") {
                            unitTime = "Day " + (localIndex + 1);
                        }
                        if(unit === "mon") {
                            let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                            unitTime = months[localIndex];
                        }
                        if(unit === "y") {
                            unitTime = localIndex.toString();
                        }
                    }

                    durations.push({
                        fracPos,
                        fracSize,
                        time,
                        duration,
                        unitTime,
                        // On days where DST stops the time increments will be funny. (12am, 3am, 7am, 11am, 3pm, 7pm, 11pm). It corrects itself after that day, so...
                        //  it's fine, and every indicator is still correct (and spaced at 4 hour increments).
                        importances: {
                            2: localIndex % majorCount === 0,
                            1: localIndex % minorCount === 0,
                            0: true
                        }
                    });

                    localIndex++;
                    if(unit !== "y") {
                        let localIndexRollover = getLargerUnitNextBoundary(time);
                        if(nextTime >= localIndexRollover) {
                            localIndex = 0;
                        }
                    }
                    time = nextTime;
                }

                return durations;
            }
        });
    }
    addNextUnitIncrement("ms", 1);
    addNextUnitIncrement("s", 1000);
    addNextUnitIncrement("m", 60);
    addNextUnitIncrement("h", 60);
    addNextUnitIncrement("d", 24);
    addNextUnitIncrement("mon", 365 / 12);
    addNextUnitIncrement("y", 12);
    //addNextUnitIncrement("w", 7);

    // TODO:
    //  - Leap hours
    //      - Leap seconds will need to be dealt with on the server, preferrably by bleeding the second across the day.
    //  - Weeks need days of week
    //  - Months need variable length, and names
    
    return increments;
})();

//todonext
// - unified trackbar
//      - show times
//          - have ticks, large ticks with labels, small ticks without labels
//          - show absolute time... somewhere, and then relative times?
//              - like, show the day below a chunk, and then within that just show the hour?
//              - maybe stacked times?
//      - should show what rates are available at various times
//      - when playing automatically switch rates when future video for the current rate isn't available?

const viewportStart = "viewportStart";
const viewportEnd = "viewportEnd";

export class RangeSummarizer extends React.Component<IProps, IState> {
    state: IState = this.initState();
    private initState(): IState {
        return {
            viewport: {
                startTime: getIntialInputNumberValue(viewportStart, +new Date("Tue Aug 07 2018 18:32:34 GMT-0400")),
                endTime: getIntialInputNumberValue(viewportEnd, +new Date("Tue Aug 07 2018 18:32:34 GMT-0400") + 60 * 1000 * 15)
            }
        };
    };

    componentWillUpdate(nextProps: IProps, nextState: IState) {
        setInputValue(viewportStart, nextState.viewport.startTime);
        setInputValue(viewportEnd, nextState.viewport.endTime);
    }

    private async clickTimeBar(e: React.MouseEvent<HTMLDivElement>, range: NALRange) {
        let now = getTimeSynced();

        let elem = e.currentTarget as HTMLDivElement;
        let rect = elem.getBoundingClientRect();

        let fraction = (e.clientX - rect.left) / rect.width;

        let end = range.lastTime;
        let offsetTime = (end - range.firstTime) * fraction;
        let time = range.firstTime + offsetTime;
        let timeAgo = formatDuration(now - time);

        console.log(`${timeAgo} AGO`);
        
        this.props.onTimeClick(time);
    }

    private renderExcludedRanges(ranges: NALRange[], direction: -1|1): JSX.Element|null {
        if(ranges.length === 0) {
            return null;
        }
        let { viewport } = this.state;

        // ranges could be partially excluded, so remember that...

        let rangeClosestTime = direction === -1 ? ranges.last().lastTime : ranges[0].firstTime;
        let viewportClosestTime = direction === -1 ? viewport.startTime : viewport.endTime;

        let gap = (rangeClosestTime - viewportClosestTime) * direction;
        if(gap < 0) {
            gap = 0;
        }

        let size = sum(ranges.map(x => {
            let size = x.lastTime - x.firstTime;
            if(direction === -1) {
                if(x.lastTime > viewport.startTime) {
                    size -= x.lastTime - viewport.startTime;
                }
            } else {
                if(x.firstTime < viewport.endTime) {
                    size -= viewport.endTime - x.firstTime;
                }
            }

            return size;
        }));

        let gapUI: JSX.Element|null = null;
        let excludedRangesUI: JSX.Element|null = null;

        if(gap > 0) {
            gapUI = (
                <div key="gap">
                    Gap: {formatDuration(gap)}
                </div>
            );
        }

        excludedRangesUI = (
            <div key="excluded">
                <div>Closest time: {rangeClosestTime}</div>
                <div>Size: {formatDuration(size)}</div>
            </div>
        );

        let ui = [gapUI, excludedRangesUI];
        if(direction === -1) {
            ui.reverse();
        }

        return (
            <div>
                {ui}
            </div>
        );
    }

    private renderRuler(): JSX.Element {
        let { viewport } = this.state;

        // TODO:
        //  Actually, maybe take the largest removed unit, and put it's major ticks as ticks on the next largest unit,
        //      to give more granularity. As if we are viewing a period of 8 hours, or even 4 hours, there would be
        //      240 or 480 minute ticks (way too many), but too few hour ticks (only 8), so we really want to combine them.
        //      OR... maybe we should allow way more base units, as even if there are 600 minute units, there will only be
        //      like 20 major ticks, which don't even need to show up as labels, so it is really alright.

        let duration = viewport.endTime - viewport.startTime;
        let unitsInScope = unitList.filter(x => duration / x.defaultDuration < 160);
        let maxLabelCount = 8;

        // TODO: Actually make ticks work...
        let maxTickCount = 30;

        // TODO: We should actually calculate this...
        let textSizeFractionOfBar = 0.08;

        let unitsUI = unitsInScope.map(unit => {
            const seek = (quantity: number) => {
                let offset = quantity * unit.defaultDuration;
                this.state.viewport.startTime += offset;
                this.state.viewport.endTime += offset;
                this.setState({
                    viewport: this.state.viewport
                });
            };


            let estimatedCount = duration / unit.defaultDuration;
            let majorCount = Math.floor(estimatedCount / unit.defaultMajorCount);
            let minorCount = Math.floor(estimatedCount / unit.defaultMinorCount);
            let noneCount = estimatedCount;

            let minLabelImportance: 0|1|2 = 0;
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

            // unitsInScope should filter out bad calls to this (ex, millisecond ticks for 1 year of data, which will generate way
            //  too many objects and probably crash the browser).
            let durations = unit.getDurations(viewport.startTime, viewport.endTime, 0.2);
            if(durations.length === 0) {
                return null;
            }

            //todonext
            // Ticks
            //  - Should be choosen from 
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

            function getCenter(posObj: UnitDurationObj, textSizeFractionOfBar: number): number {
                let barMargin = Math.min(posObj.fracSize / 2, textSizeFractionOfBar);
                let unitChunkMargin = textSizeFractionOfBar / posObj.fracSize;

                let centerPos = posObj.fracPos + posObj.fracSize * 0.5;
                if(centerPos < barMargin) {
                    // barMargin = posObj.fracPos + posObj.fracSize * X,
                    //  but posObj.fracPos + posObj.fracSize * X not outside of [posObj.fracPos + textSizeFractionOfBar, posObj.fracPos + posObj.fracSize - textSizeFractionOfBar]
                    //  posObj.fracSize * X not outside of [textSizeFractionOfBar, posObj.fracSize - textSizeFractionOfBar]

                    // textSizeFractionOfBar
                    let pos = Math.min(1 - unitChunkMargin, (barMargin - posObj.fracPos) / posObj.fracSize);
                    return pos;
                }
                if(centerPos > 1 - barMargin) {
                    // 1 - barMargin = posObj.fracPos + posObj.fracSize * X
                    let pos = Math.max(unitChunkMargin, (1 - barMargin - posObj.fracPos) / posObj.fracSize);
                    return pos;
                }
                return 0.5;
            }

            return (
                <div className="RangeSummarizer-ruler-unitsHolder" key={unit.defaultDuration}>
                    <div className="RangeSummarizer-ruler-unitsHolder-seekButtons RangeSummarizer-ruler-unitsHolder-seekButtons--minus">
                        <button onClick={() => seek(-5)}>-5{unit.unit}</button>
                        <button onClick={() => seek(-1)}>-1{unit.unit}</button>
                    </div>
                    <div className="RangeSummarizer-ruler-units">
                        {durations.filter(x => x.importances[minLabelImportance]).map(posObj => (
                            <div
                                className="RangeSummarizer-ruler-units-unitLabel"
                                style={{ left: posObj.fracPos * 100 + "%", width: posObj.fracSize * 100 + "%" }}
                                key={"label" + posObj.time}
                                title={`${new Date(posObj.time).toString()}`}
                            >
                                <div className="RangeSummarizer-ruler-units-unitLabel-text" style={{ left: getCenter(posObj, textSizeFractionOfBar) * 100 + "%" }}>
                                    {posObj.unitTime}
                                </div>
                                <div className="RangeSummarizer-ruler-units-unitLabel-tray"></div>
                                <div className="RangeSummarizer-ruler-units-unitLabel-trayLeft"></div>
                                <div className="RangeSummarizer-ruler-units-unitLabel-trayRight"></div>
                            </div>
                        ))}
                    </div>
                    <div className="RangeSummarizer-ruler-unitsHolder-seekButtons RangeSummarizer-ruler-unitsHolder-seekButtons--plus">
                        <button onClick={() => seek(+1)}>+1{unit.unit}</button>
                        <button onClick={() => seek(+5)}>+5{unit.unit}</button>
                    </div>
                </div>
            )
        });

        const zoom = (factor: number) => {
            let { viewport } = this.state;
            let s = viewport.startTime;
            let e = viewport.endTime;

            let center = (s + e) / 2;
            let size = (e - s) * factor;

            s = center - size / 2;
            e = center + size / 2;

            viewport.startTime = s;
            viewport.endTime = e;

            this.setState({ viewport });
        };

        return (
            <div className="RangeSummarizer-ruler">
                <div>
                    Duration: {formatDuration(duration)}
                </div>
                <div>
                    Start Time: {new Date(viewport.startTime).toString()}
                    <InputNumber globalKey={viewportStart} onValue={x => { this.state.viewport.startTime = x; this.setState({ viewport: this.state.viewport }); }} />
                </div>
                <div>
                    End Time: {new Date(viewport.endTime).toString()}
                    <InputNumber globalKey={viewportEnd} onValue={x => { this.state.viewport.endTime = x; this.setState({ viewport: this.state.viewport }); }} />
                </div>
                <div>
                    <button onClick={() => zoom(0.5)}>Zoom In</button>
                    <button onClick={() => zoom(2)}>Zoom Out</button>
                </div>
                {unitsUI}
            </div>
        )
    }

    private renderBar(): JSX.Element {
        let { viewport } = this.state;
        let { serverRanges } = this.props;
        let segments = serverRanges.segments;

        let beforeRanges = segments.filter(x => x.firstTime < viewport.startTime);
        let afterRanges = segments.filter(x => x.lastTime > viewport.endTime);
        let ranges = segments.filter(x => !(x.lastTime < viewport.startTime || x.firstTime > viewport.endTime));

        // Absolute times at start and end of viewport.
        // Maybe we can have ruler for the whole duration? And then highlight the areas where there is actually view.
        // Ruler could be thin/frail/ghost-like/stenciled, and then we could use colors behind that ghost text/lines
        //  to show where video is? And then maybe... something more to show the current play position? (because the current
        //  play position also needs indicators when it is out of the current viewport)

        // Stack of units, with increments too small not shown, increments that are fairly small (so high in quantity), with less height/font size,
        //  and units that are too large also with less heigh/font size.
        //  So there is a bubble/zoom effect on the sizes that are the most in line with the current zoom level?


        return (
            <div className="RangeSummarizer-bar">
                {this.renderRuler()}
                {this.renderExcludedRanges(beforeRanges, -1)}
                {this.renderExcludedRanges(afterRanges, +1)}
            </div>
        );
    }

    private renderSegments() {
        let { receivedRanges, serverRanges, requestedRanges, receivedFrames, debugVideo } = this.props;
        if(!serverRanges) return null;

        let rate = this.props.rate;
        let mult = this.props.speedMultiplier;

        // Show loaded percent, and current frame position indicator.
        let segments = serverRanges.segments.slice().reverse();

        let now = getTimeSynced();

        let currentRealTime = this.props.currentPlayTime;

        return (
            <div>
                {
                    segments.map((range, index) => {
                        let isPlaying = false;
                        let selectedFrac = 0;
                        function toFracPos(pos: number) {
                            return (pos - range.firstTime) / (range.lastTime - range.firstTime);
                        }
                        
                        if(range.firstTime <= currentRealTime && currentRealTime <= range.lastTime) {
                            isPlaying = true;
                            selectedFrac = toFracPos(currentRealTime);
                        }

                        let receivedOverlapFracs = getOverlaps(range, receivedRanges, toFracPos);
                        let requestedOverlapFracs = getOverlaps(range, requestedRanges, toFracPos);

                        receivedFrames = receivedFrames || [];
                        let frameIndex = findAtOrAfterIndex(receivedFrames, range.firstTime, x => x.time);
                        let endFrameIndex = findAtOrBeforeIndex(receivedFrames, range.lastTime, x => x.time);
                        let frames = receivedFrames.slice(frameIndex, endFrameIndex);

                        return (
                            <div
                                className={`RangeSummarizer-segment ${isPlaying && "RangeSummarizer-segment--playing" || ""}`}
                                key={index}
                                onClick={(e) => this.clickTimeBar(e, range)}
                            >
                                <div>
                                    {formatDuration(range.lastTime - range.firstTime)}, {formatDuration(now - range.firstTime)} AGO
                                    {
                                        rate !== 1 && (
                                        <span>
                                            , {formatDuration(RealDurationToVideoDuration(range.lastTime - range.firstTime, rate, mult))} play time
                                        </span>
                                    )}
                                    {debugVideo && (
                                        ` (${range.firstTime} to ${range.lastTime})`
                                    )}
                                </div>

                                <div className="RangeSummarizer-segment-bars">
                                    {requestedOverlapFracs.map((overlap, i) => (
                                        <div key={i} className="RangeSummarizer-segment-requestRange" style={{marginLeft: overlap.startFrac * 100 + "%", width: overlap.sizeFrac * 100 + "%"}}></div>
                                    ))}

                                    {receivedOverlapFracs.map((overlap, i) => (
                                        <div key={i} className="RangeSummarizer-segment-loadedRange" style={{marginLeft: overlap.startFrac * 100 + "%", width: overlap.sizeFrac * 100 + "%"}}></div>
                                    ))}

                                    {isPlaying &&<div className="RangeSummarizer-segment-playMarker" style={{marginLeft: selectedFrac * 100 + "%"}}></div>}

                                    {debugVideo && frames.map(frame => (
                                        <div key={frame.time} className="RangeSummarizer-segment-time" style={{marginLeft: toFracPos(frame.time) * 100 + "%"}}></div>
                                    ))}
                                </div>
                            </div>
                        );
                    })
                }
            </div>
        );
    }

    public render() {
        let { props, state } = this;

        return (
            <div className="RangeSummarizer">
                {this.renderBar()}
                {this.renderSegments()}
            </div>
        );
    }
}