/*
todonext
// Like LargeDiskLookup, but handles separate keys and values, which lets us store a lot more data
// Remember! When using this and muxing, we need to split up groups of NALs with large time gaps, even though
//  they may be stored in the same chunk.

export interface LargeDiskLookupSummary {
    // Inclusive
    startSearchKey: number;
    // Inclusive
    lastSearchKey: number;
}

export class LargeDiskLookup<TKey, TValue, TReduced> {
    constructor(
        private canStartChunk: (key: TKey) => boolean,
        private getSearchIndex: (key: TKey) => number,
        private reduceCtor: () => TReduced,
        private reduce: (key: TKey, value: TValue, prevReduced: TReduced) => TReduced,

    ) { }

    public async Init() {
        todonext
    }

    public async Add(obj: { key: TKey, value: TValue }) {
        todonext
    }

    public GetReducedValue(): TReduced { }

    public GetRangeSummary(): LargeDiskLookupSummary[] { }
    
    public async FindAtOrBeforeOrAfter(searchKey: number): Promise<{ chunkStart: number; } | undefined> {

    }

    // Calls confirm with the oldest chunk, and when the confirm function finishes deletes the chunk.
    public async ExportOldest(confirm: (
        ... probably a Buffer here, with some metadata
    ) => Promise<void>): Promise<void> {

    }

    todonext
    // Actually, we should probably expose a compressed chunk Buffer, and allow importing based on that.
    //  - It helps a lot in making operations atomic, and should be a lot faster.
    //  - But it only works if all the metadata aspects are kept the same. So the buffer should probably
    //      only have TKey and TValue, and then we should also return some metadata info (at least the chunkStart
    //      and nextChunkStart), in the returned object.

    public async GetChunkKeys(
        chunkStart: number,
    ): Promise<{ list: TKey[]; nextChunkStart: number|undefined; }> {
        todonext
        throw new Error(`Not implemented`);
    }

    public async GetChunkValues(
        chunkStart: number,
    ): Promise<{ list: { key: TKey; value: TValue }[]; nextChunkStart: number|undefined; }> {
        todonext
        throw new Error(`Not implemented`);
    }
}
*/