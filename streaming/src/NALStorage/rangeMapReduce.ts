import { binarySearchMap, insertIntoListMap, binarySearchNumber } from "../util/algorithms";
import { group } from "../util/math";
import { UnionUndefined } from "../util/misc";

export type SegmentRanges = {
    // Sorted by startTime
    segments: NALRange[];
    unsegmentedFrameTimes: NALTime[];
    allFrameTimes: NALTime[];
};

// Ranges are all inclusive.
export function reduceRanges(list: NALRanges[], prevValue: SegmentRanges|undefined, minGapSize = 750): SegmentRanges {
    prevValue = prevValue || { segments: [], unsegmentedFrameTimes: [], allFrameTimes: [] };
    let { segments, unsegmentedFrameTimes, allFrameTimes } = prevValue;

    function addSegment(segment: NALRange, removeUnsegmentedTimes: boolean) {
        if(segment.lastTime < segment.firstTime) {
            throw new Error(`Invalid segment ${segment.firstTime} to ${segment.lastTime}`);
        }
        let index = binarySearchMap(segments, segment.firstTime, x => x.firstTime);

        if(index < 0) {
            index = ~index - 1;
        }
        let prevSegment = UnionUndefined(segments[index]);
        let nextSegment = UnionUndefined(segments[index + 1]);

        // prevSegment.firstTime <= segment.firstTime
        if(prevSegment) {
            if(prevSegment.lastTime >= segment.firstTime) {
                segment.firstTime = Math.min(segment.firstTime, prevSegment.firstTime);
                segment.lastTime = Math.max(segment.lastTime, prevSegment.lastTime);
                segments.splice(index, 1);
                index--;
            }
        }

        // nextSegment.firstTime > segment.firstTime
        if(nextSegment) {
            if(nextSegment.firstTime <= segment.lastTime) {
                segment.firstTime = Math.min(segment.firstTime, nextSegment.firstTime);
                segment.lastTime = Math.max(segment.lastTime, nextSegment.lastTime);
                segments.splice(index + 1, 1);
            }
        }

        try {
            insertIntoListMap(segments, segment, x => x.firstTime);
        } catch(e) {
            debugger;
        }

        // Remove overlapping unsegmentedFrameTimes
        if(removeUnsegmentedTimes) {
            let index = binarySearchMap(unsegmentedFrameTimes, segment.firstTime, x => x.time);
            if(index < 0) {
                index = ~index;
            }
            let start = index;
            while(index < unsegmentedFrameTimes.length && unsegmentedFrameTimes[index].time <= segment.lastTime) {
                index++;
            }
            unsegmentedFrameTimes.splice(start, index - start);
        }
        
    }

    for(let rangeObj of list) {
        // Hmm... this may be slow?
        for(let time of rangeObj.frameTimes) {
            let index = binarySearchMap(allFrameTimes, time.time, x => x.time);
            if(index >= 0) {
                console.error(`Duplicate frame time received. At ${time.time}`);
                continue;
            }
            allFrameTimes.splice(~index, 0, time);


            index = binarySearchMap(unsegmentedFrameTimes, time.time, x => x.time);
            if(index >= 0) {
                console.error(`Duplicate frame time received. At ${time.time}`);
                continue;
            }
            unsegmentedFrameTimes.splice(~index, 0, time);
        }
    }

    for(let rangeObj of list) {
        // Take this and frameTimes ranges, and add them to prevValue.ranges, finding
        //  and startTime collisions and replacing the previous segments.
        let segments: NALRange[] = rangeObj.segmentRanges;
        
        for(let segment of segments) {
            addSegment(segment, true);
        }

        let deleteTime = rangeObj.deletionTime;
        if(deleteTime !== undefined) {
            (() => {
                if(segments.length === 0) {
                    return;
                }
                let index = binarySearchMap(segments, deleteTime, x => x.firstTime);

                if(index < 0) {
                    // ranges[~index].startTime > deleteTime,
                    //  but ranges[~index - 1].startTime < deleteTime,
                    index = ~index - 1;
                    // Then 
                    if(index < 0) {
                        // ranges[0].startTime > deleteTime, so nothing to delete
                        return;
                    }
                }

                // ranges[index].startTime <= deleteTime
                let range = segments[index];
                if(range.lastTime < deleteTime) {
                    // If deleteTime < lastTime, then we delete everything at or after index.
                    segments.splice(0, index + 1);
                    return;
                }

                // Ugh... we have to split range.
                // The frame at deleteTime is gone, but we don't know the next frame time. So... hack.
                //  This isn't good... but it's in the UI, so it should be fine... (also this deleteTime shouldn't happen)
                //  -4, because... a date takes 41 bits, and we have 53 bits of integer precision. So this number can't be over 11,
                //  (without losing precision) and 9 is cutting it pretty close anyways.
                range.firstTime = deleteTime + Math.pow(2, -9);
            })();

            (() => {
                if(unsegmentedFrameTimes.length === 0) {
                    return;
                }
                let index = binarySearchMap(unsegmentedFrameTimes, deleteTime, x => x.time);
                if(index < 0) {
                    index = ~index - 1;
                    if(index < 0) {
                        return;
                    }
                }
                unsegmentedFrameTimes.splice(0, index + 1);
            })();

            (() => {
                if(allFrameTimes.length === 0) {
                    return;
                }
                let index = binarySearchMap(allFrameTimes, deleteTime, x => x.time);
                if(index < 0) {
                    index = ~index - 1;
                    if(index < 0) {
                        return;
                    }
                }
                allFrameTimes.splice(0, index + 1);
            })();
        }
    }

    // Now, we make unsegmentedFrameTimes into segments,

    // Split frameTimes into groups (anything over a certain distance is a new group),
    //  and then make those groups into ranges.
    let frameTimeSegments: NALRange[] = group(unsegmentedFrameTimes.map(x => x.time), minGapSize).map(g => ({ firstTime: g[0], lastTime: g.last()}));
    for(let segment of frameTimeSegments) {
        addSegment(segment, false);
    }

    return prevValue;
}