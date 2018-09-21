import { binarySearchMap, insertIntoListMap, binarySearchNumber, findAtOrBeforeIndex } from "../util/algorithms";
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
            console.error(`Overlapping ranges while counting frames. This should not happen. New range is after existing range.`);
        }

        if(countFrames) {
            base.frameCount += additional.frameCount; 
        }

        base.lastTime = additional.lastTime;
    }
    if(additional.firstTime < base.firstTime) {
        if(additional.lastTime < base.firstTime) return;

        if(additional.lastTime > base.lastTime && countFrames) {
            console.error(`Overlapping ranges while counting frames. This should not happen. New range is before existing range.`);
        }

        // If we completely eclipse it don't count the frames twice.
        if(countFrames && additional.lastTime <= base.lastTime) {
            base.frameCount += additional.frameCount;
        }

        base.firstTime = additional.firstTime;
    }
}

// Ranges are end exclusive?
//  Returns all changed/new ranges
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

        if(
            prevSegment && prevSegment.firstTime <= segment.firstTime && prevSegment.lastTime >= segment.lastTime
            || nextSegment && nextSegment.firstTime <= segment.firstTime && nextSegment.lastTime >= segment.lastTime
        ) {
            // Ignore cases when the entire range is already accounted for.
            return;
        }

        // Extend to prev/next to account for minGapSize.
        if(prevSegment) {
            if(segment.firstTime - prevSegment.lastTime < minGapSize) {
                segment.firstTime = prevSegment.lastTime;
            }
        }
        if(nextSegment) {
            if(nextSegment.firstTime - segment.lastTime < minGapSize) {
                segment.lastTime = nextSegment.firstTime;
            }
        }
    
        // prevSegment.firstTime <= segment.firstTime
        if(prevSegment && prevSegment.lastTime >= segment.firstTime) {
            if(segment.firstTime < prevSegment.firstTime || segment.lastTime > prevSegment.lastTime) {
                mergeOntoRange(prevSegment, segment, countFrames);
                segment = prevSegment;

                segments.splice(index, 1);
                index--;
            }
        }
    
        // nextSegment.firstTime > segment.firstTime
        if(nextSegment) {
            if(nextSegment.firstTime <= segment.lastTime) {
                if(segment.firstTime < nextSegment.firstTime || segment.lastTime > nextSegment.lastTime) {
                    mergeOntoRange(nextSegment, segment, countFrames);
                    segment = nextSegment;

                    segments.splice(index + 1, 1);
                }
            }
        }
    
        try {
            insertIntoListMap(segments, segment, x => x.firstTime);
        } catch(e) {
            debugger;
        }

        changedRanges.push({...segment});
    }

    for(let rangeObj of newRanges) {
        addSegment(rangeObj);
    }

    return changedRanges;
}

export function removeRange(removedRange: NALRange, ranges: NALRange[], countFrames: boolean): void {
    if(countFrames) {
        throw new Error(`countFrames with removeRange isn't supported`);
    }

    function removeSingleRange(removedRange: NALRange, range: NALRange): NALRange[] {
        let newRanges: NALRange[] = [];
        // Before range
        if(range.firstTime < removedRange.firstTime) {
            newRanges.push({
                firstTime: range.firstTime,
                lastTime: Math.min(range.lastTime, removedRange.firstTime),
                frameCount: 0
            });
        }

        // After range
        if(range.lastTime > removedRange.lastTime) {
            newRanges.push({
                firstTime: Math.max(range.firstTime, removedRange.lastTime),
                lastTime: range.lastTime,
                frameCount: 0
            });
        }

        return newRanges;
    }

    let index = findAtOrBeforeIndex(ranges, removedRange.firstTime, x => x.firstTime);
    while(ranges[index]) {
        if(ranges[index].firstTime > removedRange.lastTime) break;
        let mutatedRanges = removeSingleRange(removedRange, ranges[index]);
        ranges.splice(index, 1, ...mutatedRanges);
        index += mutatedRanges.length;
    }
}

export function getMaskedRanges(maskRange: NALRange, ranges: NALRange[]): NALRange[] {
    function getOverlap(maskRange: NALRange, range: NALRange): NALRange[] {
        let mask: NALRange = {
            firstTime: Math.max(maskRange.firstTime, range.firstTime),
            lastTime: Math.min(maskRange.lastTime, range.lastTime),
            frameCount: 0
        };
        mask.frameCount = range.frameCount / (range.lastTime - range.firstTime) * (mask.lastTime - mask.firstTime);

        if(mask.firstTime >= mask.lastTime) {
            return [];
        }

        return [mask];
    }

    let overlappingRanges: NALRange[] = [];

    let index = findAtOrBeforeIndex(ranges, maskRange.firstTime, x => x.firstTime);
    while(index < ranges.length) {
        if(ranges[index].firstTime > maskRange.lastTime) break;
        overlappingRanges.push(...getOverlap(maskRange, ranges[index]));
        index++;
    }

    return overlappingRanges;
}