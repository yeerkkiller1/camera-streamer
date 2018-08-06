/*
import { insertIntoListMapped, binarySearchMapped } from "../util/algorithms";
import { DownsampledInstance, Downsampler } from "./Downsampler";

// I need a data structure that can contain infinite ranges (with associated data), but summarize the ranges (by limiting the count)
//  between any times with sub ranges that are either full, or just have a flag that says inside of them they have holes.
//  (bonus if they say the fill fraction instead of just saying there are holes).
// (also needs to have a mode to get all ranges in a range, without any summarization)
// Then we can use this structure to tell the client roughly what ranges exist, and then get the S3 objects
//  for a requested range.
// We need to persist this structure on disk.
// We will almost always extend the last range, sometimes add a new range to the end, and we need to behave
//  correctly if ranges are added out of order (even though that should virtually never happen).

// Ranges are inclusive. This just works for our data, hopefully.


// Each Range represents a continous chunk of NALs, stored in locally on disk or in S3.
//  When we mutate the ranges we update this. Then this allows us to both show the client what
//  data exists, and access the locations of all the S3/disk files (by adding extra data associated
//  with each ValueRange, that is a url or something).

// We will have a RangeDB per NAL rate we store at, via using a Downsampler to split
//  NALs into rates.

export interface ValueRange {
    first: number;
    last: number;

    // Some string that gives a path or S3 url, or something.
    source?: string;
    fillRate?: number;
}

export class RangeDB {
    constructor(
        **
         *  We use 1 + 2 / exponentialFactor times more space than the data passed in.
         * 
         *  Summary accesses will return up to 1 / exponentialFactor times less than the requested data count.
         * *
        public readonly ExponentialFactor = 4,
        private ctor: Ctor<RangeInstance> = RangeInstance
    ) { }
    private downsampler = new Downsampler(this.ExponentialFactor, this.ctor);

    public AddRange(range: ValueRange): void {
        range.fillRate = 1;
        this.downsampler.AddValue(range);
    }
    public MutateRange(oldRange: ValueRange, newRange: ValueRange): void {
        oldRange.fillRate = 1;
        newRange.fillRate = 1;

        // We need to update all rates
        let sampler = this.downsampler;
        let rates = sampler.GetRates();
        for(let rate of rates) {
            let instance = sampler.GetInstanceRate(rate);
            instance.MutateRange(oldRange, newRange);
        }
    }

    public SummarizeRanges(range: ValueRange, max: number): ValueRange[] {
        if(range.last < range.first) {
            throw new Error(`Range is invalid, last is less than first.`);
        }
        if(max < 1) {
            return [];
        }

        // Okay... we need to play around with the max a bit to get the data we need.
        //  If the range is really small, we will tend towards using the data from the min rate.
        //  Otherwise, if it is very large, we tend towards using data from the max rate.

        let sampler = this.downsampler;
        let curMax = max;
        let lastRanges = getRanges(curMax);
        function getRanges(max: number) {
            let instance = sampler.GetInstance(max);
            let ranges = instance.Ranges;
            ranges = ranges.filter(r => {
                // Any overlap
                return (
                    range.first <= r.first && r.first <= range.last
                    || range.first <= r.last && r.last <= range.last
                );
            });
            return ranges;
        }

        while(true) {
            let nextMax = curMax * this.ExponentialFactor;
            if(nextMax > sampler.GetCount()) {
                break;
            }
            let ranges = getRanges(nextMax);
            if(ranges.length > max) {
                // TODO: Actually... we already iterated over the data, so we might as well use these ranges, and just summarize
                //  them further to be the exact length we want.
                break;
            }
            lastRanges = ranges;
            curMax = nextMax;
        }

        return lastRanges;
    }

    public GetCount() {
        return this.downsampler.GetCount();
    }
}

function rangeOverlaps(a: ValueRange, b: ValueRange) {
    return !(a.last < b.first || a.first > b.last);
}

function MaybeUndefined<T>(value: T): T|undefined {
    return value;
}

export class RangeInstance implements DownsampledInstance<ValueRange> {
    // Sorted by first
    public Ranges: ValueRange[] = [];

    constructor(public Rate: number) { }
    public InitFromPrevInstance(prevTierInstance: RangeInstance): number {
        let prevRanges = prevTierInstance.Ranges;

        this.AddValue(prevRanges[0]);
        for(let i = 1; i < prevRanges.length; i++) {
            this.DroppedValue(prevRanges[i]);
        }

        return 1;
    }
    public AddValue(val: ValueRange): void {
        val = { ...val };

        if(val.last < val.first) {
            throw new Error(`Invalid range`);
        }

        let index = this.getClosestRange(val);

        let prevRange = this.Ranges[index];
        if(prevRange && rangeOverlaps(prevRange, val)) {
            // We want to split the found range, to preserve having no overlapping ranges, AND to have AddValue always add
            //  a range (otherwise our downsampling could degrade to only have 1 range).
            // BUT, we can't, because we don't know how to split the fill rate. So... we just have to drop the value.
            this.DroppedValue(val);
        } else {
            insertIntoListMapped(this.Ranges, val, x => x.first, (a, b) => a - b);
        }
    }

    private getClosestRange(range: ValueRange): number {
        if(this.Ranges.length === 0) {
            return -1;
        }
        let index = binarySearchMapped(this.Ranges, range.first, x => x.first, (a, b) => a - b);
        if(index < 0) {
            index = ~index;
        }

        let mergedRangesDistances: {
            distance: number;
            index: number;
        }[] = [];

        let beforeRange = MaybeUndefined(this.Ranges[index - 1]);
        let afterRange = MaybeUndefined(this.Ranges[index]);
        if(beforeRange) {
            // Maybe negative if we overlap the range, which will force it to overlap.
            let dist = range.first - beforeRange.last;
            mergedRangesDistances.push({
                distance: dist,
                index: index - 1
            });
        }
        if(afterRange) {
            // Maybe negative if we overlap the range, which will force it to overlap.
            let dist = afterRange.first - range.last;
            mergedRangesDistances.push({
                distance: dist,
                index: index
            });
        }

        mergedRangesDistances.sort((a, b) => a.distance - b.distance);

        return mergedRangesDistances[0].index;
    }

    public MutateRange(oldRange: ValueRange, newRange: ValueRange): void {
        if(oldRange.fillRate !== 1 || newRange.fillRate !== 1) {
            throw new Error("MutateRange should be done on raw ranges, so both the oldRange and newRange should have a fill rate of 1");
        }

        let index = this.getClosestRange(oldRange);

        let newFirstPos = binarySearchMapped(this.Ranges, newRange.first, x => x.first, (a, b) => a - b);
        let newLastPos = binarySearchMapped(this.Ranges, newRange.last, x => x.first, (a, b) => a - b);

        // Check neighbors to new range, and if neighbors collide with newRange (and aren't oldRange).
        if(newFirstPos < 0) {
            newFirstPos = ~newFirstPos - 1;
        }
        {
            let range = this.Ranges[newFirstPos];
            if(range && newFirstPos !== index) {
                if(rangeOverlaps(range, newRange)) {
                    throw new Error(`Range mutation would have caused an overlap before the range. Not adding. New range ${JSON.stringify(newRange)}, collides with existing range ${JSON.stringify(range)}`);
                }
            }
        }
        if(newLastPos < 0) {
            newLastPos = ~newLastPos + 1;
        }
        {
            let range = this.Ranges[newLastPos];
            if(range && newLastPos !== index) {
                if(rangeOverlaps(range, newRange)) {
                    throw new Error(`Range mutation would have caused an overlap before the range. Not adding. New range ${JSON.stringify(newRange)}, collides with existing range ${JSON.stringify(range)}`);
                }
            }
        }

        // Copy it, so we don't mess up any existing objects.
        let prevFillRate = this.Ranges[index].fillRate;
        if(prevFillRate === undefined) {
            throw new Error(`Expected fillRate`);
        }
        let prevFill = (this.Ranges[index].last - this.Ranges[index].first) * prevFillRate;

        this.Ranges[index] = { ... this.Ranges[index] };
        let range = this.Ranges[index];
        range.first = Math.min(range.first, newRange.first);
        range.last = Math.max(range.last, newRange.last);

        let prevBaseFill = oldRange.last - oldRange.first;
        let newBaseFill = newRange.last - newRange.first;

        let newFill = prevFill + (newBaseFill - prevBaseFill);
        let baseRange = (range.last - range.first);

        if(newFill > baseRange) {
            throw new Error(`MutateRange increased fill rate by too much. Maybe you mutated a range that was never added? ${JSON.stringify({oldRange, newRange, newFill, prevFillRate})}`);
        }

        range.fillRate = baseRange === 0 ? 1 : newFill / baseRange;
    }
    // Should mutate the adjacent range, and set a fill rate factor
    public DroppedValue(val: ValueRange): void {
        // Find an adjacent range, and combine it, setting the fill rate appropriately.
        
        let closeRange = this.Ranges[this.getClosestRange(val)];

        let prevFillRate = closeRange.fillRate;
        if(prevFillRate === undefined) {
            throw new Error(`Fill rate should not be undefined, but it was.`);
        }
        let addFillRate = val.fillRate;
        if(addFillRate === undefined) {
            throw new Error(`Fill rate should not be undefined, but it was.`);
        }

        let prevFill = (closeRange.last - closeRange.first) * prevFillRate;
        let newFill = (val.last - val.first) * addFillRate;
        closeRange.first = Math.min(closeRange.first, val.first);
        closeRange.last = Math.max(closeRange.last, val.last);

        let newSize = closeRange.last - closeRange.first;
        let newFilledSize = prevFill + newFill;
        if(newFilledSize > newSize) {
            throw new Error(`When combining ranges we certain added ranges overlapped each other. Maybe one range was added twice? Maybe ${JSON.stringify(val)}`);
        }

        closeRange.fillRate = (
            newSize === 0 ?
            1
            : newFilledSize / newSize
        )
    }
}
*/