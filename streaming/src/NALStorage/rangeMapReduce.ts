import { binarySearchMap, insertIntoListMap, binarySearchNumber } from "../util/algorithms";
import { group } from "../util/math";
import { UnionUndefined } from "../util/misc";

// Sorted by startTime
export function deleteRanges(ranges: NALRange[], deleteTime: number): void {
    if(ranges.length === 0) {
        return;
    }
    let index = binarySearchMap(ranges, deleteTime, x => x.firstTime);

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
    let range = ranges[index];
    if(range.lastTime < deleteTime) {
        // If deleteTime < lastTime, then we delete everything at or after index.
        ranges.splice(0, index + 1);
        return;
    }

    // Ugh... we have to split range.
    // The frame at deleteTime is gone, but we don't know the next frame time. So... hack.
    //  This isn't good... but it's in the UI, so it should be fine... (also this deleteTime shouldn't happen)
    //  -4, because... a date takes 41 bits, and we have 53 bits of integer precision. So this number can't be over 11,
    //  (without losing precision) and 9 is cutting it pretty close anyways.
    range.firstTime = deleteTime + Math.pow(2, -9);
}

function mergeOntoRange(base: NALRange, additional: NALRange, countFrames: boolean): void {
    if(additional.lastTime > base.lastTime) {
        if(additional.firstTime > base.lastTime) return;

        if(additional.firstTime < base.lastTime && countFrames) {
            throw new Error(`Overlaping ranges while counting frames. This should not happen.`);
        }

        if(countFrames) {
            base.frameCount += additional.frameCount; 
        }

        base.lastTime = additional.lastTime;
    }

    if(additional.firstTime < base.firstTime) {
        if(additional.lastTime < base.firstTime) return;

        if(additional.lastTime > base.lastTime && countFrames) {
            throw new Error(`Overlaping ranges while counting frames. This should not happen.`);
        }

        if(countFrames) {
            base.frameCount += additional.frameCount;
        }

        base.firstTime = additional.firstTime;
    }
}

// Ranges are end exclusive?
//  Returns all changes/new ranges
export function reduceRanges(newRanges: NALRange[], ranges: NALRange[], countFrames: boolean, minGapSize = 0): NALRange[] {
    let changedRanges: NALRange[] = [];

    let segments = ranges;

    function addSegment(segment: NALRange) {
        let originalSegment = segment;
        segment = {...segment};
        if(segment.lastTime < segment.firstTime) {
            throw new Error(`Invalid segment ${segment.firstTime} to ${segment.lastTime}`);
        }
        let index = binarySearchMap(segments, segment.firstTime, x => x.firstTime);
    
        if(index < 0) {
            index = ~index - 1;
        }
        let prevSegment = UnionUndefined(segments[index]);
        let nextSegment = UnionUndefined(segments[index + 1]);

        let changed = false;
    
        // prevSegment.firstTime <= segment.firstTime
        if(prevSegment) {
            if(prevSegment.lastTime >= segment.firstTime) {
                if(segment.firstTime < prevSegment.firstTime || segment.lastTime > prevSegment.lastTime) {
                    mergeOntoRange(prevSegment, segment, countFrames);
                    segment = prevSegment;

                    segments.splice(index, 1);
                    index--;
                    changed = true;
                }
            }
        } else {
            changed = true;
        }
    
        // nextSegment.firstTime > segment.firstTime
        if(nextSegment) {
            if(nextSegment.firstTime <= segment.lastTime) {
                if(segment.firstTime < nextSegment.firstTime || segment.lastTime > nextSegment.lastTime) {
                    mergeOntoRange(nextSegment, segment, countFrames);
                    segment = nextSegment;

                    segments.splice(index + 1, 1);
                    changed = true;
                }
            }
        } else {
            changed = true;
        }
    
        if(changed) {
            try {
                insertIntoListMap(segments, segment, x => x.firstTime);
            } catch(e) {
                debugger;
            }

            changedRanges.push(originalSegment);
        }
    }

    for(let rangeObj of newRanges) {
        addSegment(rangeObj);
    }

    return changedRanges;
}