import { shortMonthsList } from "./format";

const unitTypeList: UnitType[] = ["ms", "s", "m", "h", "d", "mon", "y"];
export type UnitType = "ms" | "s" | "m" | "h" | "d" | "mon" | "y";

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

export type UnitDurationObj = {
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
export type Unit = {
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
export const unitList: Unit[] = (() => {
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
                            let months = shortMonthsList;
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