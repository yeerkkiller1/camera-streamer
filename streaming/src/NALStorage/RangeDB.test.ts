/*
import { ThrowIfNotImplementsData, ThrowsAsync, PChanFromArray, PChanFromGenerator } from "pchannel";
import { RangeDB, ValueRange } from "./RangeDB";
import { throws } from "assert";


function r(value: number): ValueRange {
    return { first: value, last: value };
}

function assertSummarize(db: RangeDB, summaryRange: ValueRange, max: number): void {
    let allCount = db.SummarizeRanges({ first: Number.MIN_SAFE_INTEGER, last: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER).length;
    if(allCount !== db.GetCount()) {
        // ignore coverage
        throw new Error(`Summarize ranges call for all data didn't return all data. There are ${db.GetCount()} values, and it returned ${allCount}`);
    }

    let count = db.SummarizeRanges(summaryRange, Number.MAX_SAFE_INTEGER).length;
    
    // Hmm... +1, because of stuff... (InitFromPrevInstance)
    let maxExpected = Math.min(count, max);
    // - 2, because the values on both ends could be removed due to downsampling
    let minExpected = Math.ceil(maxExpected / db.ExponentialFactor) - 2;

    

    let ranges = db.SummarizeRanges(summaryRange, max);
    let realCount = ranges.length;

    if(realCount < minExpected || realCount > maxExpected) {
        // ignore coverage
        throw new Error(`Invalid number of ranges returned. Expected between ${minExpected} and ${maxExpected}, but got ${realCount}`);
    }

    for(let range of ranges) {
        // ignore coverage
        if(range.last < summaryRange.first) {
            throw new Error(`Range returned outside of summaryRange. Range is ${JSON.stringify(range)}, summary range is ${JSON.stringify(summaryRange)}`);
        }
        // ignore coverage
        if(range.first > summaryRange.last) {
            throw new Error(`Range returned outside of summaryRange. Range is ${JSON.stringify(range)}, summary range is ${JSON.stringify(summaryRange)}`);
        }
    }
}

describe("RangeDB", () => {
    describe("errors", () => {
        it("throws on fractional rates", () => {
            throws(() => {
                new RangeDB(5.5);
            });
        });
        it("throws on small rates", () => {
            throws(() => {
                new RangeDB(1);
            });
        });

        it("throws on invalid range", () => {
            let db = new RangeDB(2);
            throws(() => {
                db.AddRange({first: 0, last: -1});
            });
        });
        it("throws on invalid summary range", () => {
            let db = new RangeDB(2);
            throws(() => {
                db.SummarizeRanges({first: 0, last: -1}, 0);
            });
        });

        it("throws on overlapping ranges", () => {
            let db = new RangeDB(2);
            db.AddRange({first: 0, last: 3});
            throws(() => {
                db.AddRange({first: 2, last: 4});
            });
            throws(() => {
                db.AddRange({first: -1, last: 4});
            });
        });

        it("throws on mutating ranges to overlap", () => {
            let db = new RangeDB(2);
            db.AddRange({first: 0, last: 3});
            db.AddRange({first: 4, last: 4});
            throws(() => { db.MutateRange({first: 4, last: 4}, {first: 2, last: 4}); });
            throws(() => { db.MutateRange({first: 0, last: 3}, {first: 2, last: 4}); });
        });
    });

    describe("misc", () => {
        it("MutateRange calls", () => {
            let db = new RangeDB(2);
            db.AddRange({first: 0, last: 3});
            db.AddRange({first: 4, last: 4});

            db.MutateRange({first: 4, last: 4}, {first: 4, last: 4});
            db.MutateRange({first: 4, last: 4}, {first: 4, last: 5});
        });
    });

    describe("cases", () => {
        it("summarizes only the requested ranges", async () => {
            let db = new RangeDB(2);
            let count = 10;
            for(let i = 0; i < count; i++) {
                db.AddRange(r(i));
            }

            for(let i = 0; i < count + 20; i++) {
                assertSummarize(db, {first: 0, last: count / 2}, i);
            }
        });

        it("summarizes to the correct count", async () => {
            let db = new RangeDB(2);
            let count = 10;
            for(let i = 0; i < count; i++) {
                db.AddRange(r(i));
            }

            for(let i = 0; i < count; i++) {
                assertSummarize(db, {first: 0, last: count}, i);
            }
        });

        it("mutates ranges", () => {
            let db = new RangeDB(2);
            let count = 10;
            for(let i = 0; i < count; i++) {
                db.AddRange({ first: i * 2, last: i * 2 });
            }

            for(let i = 0; i < count; i++) {
                let oldRange = { first: i * 2, last: i * 2 };
                let newRange = { first: i * 2, last: i * 2 + 1 };
                db.MutateRange(oldRange, newRange);
            }

            for(let i = 0; i < count; i++) {
                assertSummarize(db, {first: 0, last: count}, i);
            }

            let ranges = db.SummarizeRanges({first: 0, last: count * 2}, count);
            for(let i = 0; i < count; i++) {
                let range = ranges[i];
                let val = i * 2;
                let newRange: ValueRange = { first: val, last: val + 1 };
                if(range.first !== newRange.first || range.last !== newRange.last) {
                    // ignore coverage
                    throw new Error(`Range didn't change. Should have been ${JSON.stringify(newRange)}, was ${JSON.stringify(range)}`);
                }
            }
        });

        it("handles merging dropped values correctly", () => {
            let db = new RangeDB(2);
            let count = 10;
            let rangeSize = 2;
            let rangeStartDiff = 5;
            for(let i = 0; i < count; i++) {
                db.AddRange({ first: i * rangeStartDiff, last: i * rangeStartDiff });
            }

            for(let i = 0; i < count; i++) {
                let oldRange = { first: i * rangeStartDiff, last: i * rangeStartDiff };
                let newRange = { ... oldRange };
                newRange.last += rangeSize;
                db.MutateRange(oldRange, newRange);
            }

            // On boundaries we need all ranges touching the boundaries.
            let summary = db.SummarizeRanges({ first: 0, last: 5 }, 1);
            ThrowIfNotImplementsData(summary.length, 1);
            ThrowIfNotImplementsData(summary[0].first, 0);

            // The end could be and amount at or after 5.
            if(summary[0].last < 5) {
                throw new Error(`Data at boundaries should be included.`);
            }

            // The fillrate should definitely not be 1
            let fillRate = summary[0].fillRate;
            if(!fillRate || fillRate >= 1) {
                throw new Error(`Invalid fill rate. Expecting a value > 0 (as there is data between 0 and 5, but < than 1 (because it isn't full). Got a fill rate of ${fillRate}`);
            }
        });

        it("handles AddValue overlaps with partially fill rate", () => {
            let db = new RangeDB(2);

            db.AddRange({ first: 5, last: 6 });
            db.AddRange({ first: 0, last: 1 });

            db.AddRange({ first: 3, last: 4 });

            ThrowIfNotImplementsData(db.SummarizeRanges({ first: -10, last: 10}, 1), [{ first: 0, last: 6, fillRate: 0.5 }]);
        });
    });
});
*/