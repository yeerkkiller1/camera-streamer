import { UnionUndefined, isEmpty } from "../util/misc";
import { insertIntoListMap, findAtIndex } from "../util/algorithms";
import { TransformChannel, Deferred, TransformChannelAsync } from "pchannel";
import { GetMinGapSize } from "./TimeMap";
import { group, sum } from "../util/math";
import { writeNALToDisk, readNALsBulkFromDisk, loadIndexFromDisk, finalizeNALsOnDisk, deleteNALs, writeNALsBulkToDisk, readNALs } from "./NALBuffers";
import { createIgnoreDuplicateCalls } from "../algs/cancel";


type ChunkMetadataExtended = ChunkMetadata & {
    pendingReads: {
        [readId: string]: Deferred<void>
    }
};

type ChunkObj = {
    // Same instance as in chunksList
    metadata: ChunkMetadataExtended;
    index: (NALIndexInfo & { finishedWrite: boolean } | Deferred<void>)[];
    fileBasePath: string;
    writeLoop: ((code: () => Promise<void>) => void)|"exporting";
};

// Uses of chunks:
//  - We push onto the end when adding a new chunk
//      - Right now our implementation handles out or order times, but only in some places.
//          If we make it never handle out of order times then we will strictly only need to push to the end
//          of chunks.
//  - We remove the oldest chunk (shift) when too much data is being stored
//  - We look at the newest chunk to find the LastAddSeqNum
//  - We search chunk startTimes to find the chunk that contains the video we are looking for.
//      - That is the chunk with the a startTime before or at the startTime we requested, or the first chunk
//  - We call reduceRanges with GetMinGapSize(rate), on all Ranges, to get an overarching range list


// We need a class that stores a list, with a mutable last entry, that stores everything on disk,
//  with mutations to the last entry being stored on the local system, and the rest of the values




// There is a purely local DiskList, and one that is local and remote. The purely local one can read everything
//  off disk, and so have no access restrictions. The local and remote one needs to split things across files,
//  so accessing is a lot more difficult.

/*
todonext
// We need to remove GetChunkMetadatas, in fact all chunk code, move it into ChunkIndex,
//  and change the call sites that use the functions in LocalRemoteStorage, and then in
//  StorageCombined.

class ChunkIndex {
    constructor(
        private path: string,
        // We store large amounts of data in here (GB per year possibly)
        private storage: StorageBase,
        // We need this for small amounts of data (hopefully just KB), so we can write quickly,
        //  and append to files.
        private localStorage: StorageBaseAppendable
    ) { }

    public Init(): Promise<void> { }

    public LiveChunkCreated(
        chunkUID: string,
        firstAddSeqNum: number,
        firstTime: number,
    ): Promise<void> { }

    public LiveChunkUpdated(
        chunkUID: string,
        addSeqNum: number,
        time: number,
    ): void { }

    public LiveChunkFinished(
        
    ): Promise<void> { }


    // We need to support moving stuff in this order:
    //  pending add to new storage
    //  pending delete from old storage
    //  finish add to new storage
    //  finish delete to new storage
    // On pending delete we shouldn't make any new requests.
    // On pending add we should block until add finishes
    public ImportChunk(
        chunk: Chunk
    ): Promise<void> { }

    public StartRemoveChunk(
        chunkUID: string
    ): void { }
    public FinishRemoveChunk(
        chunkUID: string
    ): void { }


    public GetLastAddSeqNum(): number { }
   
    public GetRangeList(): NALRange[] { }

    public FindChunk(): Promise<string> { }

    public GetChunkInfo(): Promise<ChunkMetadata> { }
}
*/

export class LocalRemoteStorage implements RemoteStorageLocal {
    private chunksList: ChunkMetadataExtended[] = [];
    private chunks: {
        [chunkUID: string]: ChunkObj
    } = {};
    private nextStorageSystem: RemoteStorage|undefined;
    private onChunkDeleted!: (deleteTime: number) => void;
    private chunkThresholdBytes: number|undefined;
    private maxBytes: number|undefined;

    // Writes don't block (or even return a promise), so this is used to store the error, so we can throw it the next chance we get.
    private writeLoopError: { e: any } | undefined;
    private checkWriteError() {
        if(this.writeLoopError) {
            throw this.writeLoopError.e;
        }
    }

    constructor(
        private storage: StorageBase,
        private rate: number,
        private baseTotalCost: number,
        private baseTotalStorageBytes: number,
        private pathBase = "./dist/local/",
        private fakeOverrides?: {
            debugName: string;
            maxGB: (bytesPerSecond: number, secondPerChunk: number, maxCost: number) => number;
            costPerGB: (bytes: number) => number;
        }
    ) { }

    private path = this.pathBase + `rate_${this.rate}/`;

    // Data is appended every time a new index file is created, and every time it finishes.
    private chunkIndex = this.path + "chunk.index";

    public async Init(
        nextStorageSystem: RemoteStorage|undefined,
        onChunkDeleted: (deleteTime: number) => void,
        chunkThresholdBytes: number,
        maxBytes: number
    ): Promise<void> {
        this.checkWriteError();

        // TODO: Change path to include rate, that way we don't need to do as much filtering of file names,
        //  and getting every rate that exists is much easier.

        if(!await this.storage.Exists(this.pathBase)) {
            await this.storage.CreateDirectory(this.pathBase);
        }

        if(!await this.storage.Exists(this.path)) {
            await this.storage.CreateDirectory(this.path);
        }

        // We need to read all of the data from the file system (well not the nals I guess, but at least the index files)
        //  and then add the chunk metadatas.

        this.nextStorageSystem = nextStorageSystem;
        this.onChunkDeleted = onChunkDeleted;

        this.chunkThresholdBytes = chunkThresholdBytes;
        this.maxBytes = maxBytes;
        
        //todonext
        // Make an index file for chunks, so we don't need to load all the index files (or all the files names)
        let fileNames = await this.storage.GetDirectoryListing(this.path);
        let nalFileNames = fileNames.filter(x => x.endsWith(".nal"));

        console.log(`Init ${this.DebugName()}, max bytes: ${maxBytes}, next storage system: ${nextStorageSystem && nextStorageSystem.DebugName()}`);

        //todonext
        // We need to go through and delete any chunks that have addSeqNums that don't line up with their times. I guess...
        //  we can iterate by time, and if addSeqNum doesn't increase, we should delete the chunk.
        // BUT FIRST, we should probably fix the common addSeqNum problems

        for(let nalFileName of nalFileNames) {
            let indexFileName = nalFileName.slice(0, -".nal".length) + ".index";
            
            let nalFilePath = this.path + nalFileName;
            let indexFilePath = this.path + indexFileName;

            let nalInfosObj = await loadIndexFromDisk(this.storage, nalFilePath, indexFilePath);
            if(!nalInfosObj) {
                console.error(`Could not read index or nals. Ignoring file. ${nalFileName}`);
                continue;
            }

            let nalInfos = nalInfosObj.index;

            let chunkUID = this.createChunkUID(nalInfos[0]);
            if(nalFilePath !== this.path + chunkUID + ".nal") {
                console.error(`NAL contents did not match file name. Ignoring file. ${nalFileName}`);
                continue;
            }

            let minGapSize = GetMinGapSize(nalInfos[0].rate);
            let chunkMetadata: ChunkMetadataExtended = {
                ChunkUID: chunkUID,
                Ranges: group(nalInfos.map(x => x.time), minGapSize).map(x => ({ firstTime: x[0], lastTime: x.last(), frameCount: x.length })),
                IsLive: nalInfosObj.isLive,
                IsMoved: false,
                Size: nalInfos.last().pos + nalInfos.last().len,
                pendingReads: {},
                FirstAddSeqNum: nalInfos[0].addSeqNum,
                LastAddSeqNum: nalInfos.last().addSeqNum
            };

            let index: (NALIndexInfo & { finishedWrite: boolean } | Deferred<void>)[] = [];
            for(let indexInfo of nalInfos) {
                index.push({ ...indexInfo, finishedWrite: true });
            }

            if(chunkMetadata.IsLive) {
                index.push(new Deferred<void>());
            }

            this.chunks[chunkUID] = {
                metadata: chunkMetadata,
                index: index,
                fileBasePath: this.path + chunkUID,
                writeLoop: this.createWriteLoop(),
            };
            insertIntoListMap(this.chunksList, chunkMetadata, x => x.Ranges[0].firstTime);
        }
    }


    private createWriteLoop() {
        let writeLoopBase = TransformChannel<() => Promise<void>, { e: any } | undefined>(async input => {
            try {
                await input();
            } catch(e) {
                return { e };
            }
        });
        return async (code: () => Promise<void>) => {
            this.checkWriteError();
            
            let error = await writeLoopBase(code);
            if(error) {
                if(!this.writeLoopError) {
                    this.writeLoopError = error;
                }
                console.log(code);
                console.error(`Error in write loop. ${new Error().stack}`);
            }
        };
    }
    private createChunkUID(startNAL: NALInfoTime) {
        return `chunk_rate_${startNAL.rate}_addSeqNum_${startNAL.addSeqNum}`;
    }
    private addNewChunk(nal: NALInfoTime): string {
        let { chunks, chunksList } = this;

        let chunkUID = this.createChunkUID(nal);
        //console.log(`Creating new chunk ${chunkUID}, chunk limit ${this.chunkThresholdBytes}`);
        let chunkMetadata: ChunkMetadataExtended = {
            ChunkUID: chunkUID,
            Ranges: [{ firstTime: nal.time, lastTime: nal.time, frameCount: 0 }],
            Size: 0,
            IsLive: true,
            IsMoved: false,
            pendingReads: { },
            FirstAddSeqNum: nal.addSeqNum,
            LastAddSeqNum: nal.addSeqNum,
        };
        insertIntoListMap(chunksList, chunkMetadata, x => x.Ranges[0].firstTime);

        chunks[chunkUID] = {
            metadata: chunkMetadata,
            index: [new Deferred<void>()],
            fileBasePath: this.path + chunkUID,
            writeLoop: this.createWriteLoop()
        };

        return chunkUID;
    }

    public AddSingleNAL(nalHolder: NALHolderMin): void {
        this.checkWriteError();

        let { chunks, chunksList, chunkThresholdBytes, maxBytes } = this;

        let storage = this.storage;
        if(!("AppendData" in storage)) {
            throw new Error(`Can not AddSingleNAL when underlying storage is not appendable`);
        }
        let appendableStorage = storage as StorageBaseAppendable;

        if(chunkThresholdBytes === undefined || maxBytes === undefined) {
            throw new Error(`Cannot write to RemoteStorage as Init has not been called! ${this.DebugName()}`);
        }

        // Get the live chunk
        let liveChunkUID: string|undefined;
        if(chunksList.length > 0) {
            let chunkUID = chunksList.last().ChunkUID;
            let list = chunks[chunkUID].index;
            if(list.length > 0) {
                let last = list.last();
                if("Promise" in last) {
                    liveChunkUID = chunkUID;
                } else {
                    if(chunks[chunkUID].metadata.IsLive) {
                        throw new Error(`Chunk has IsLive true, but last value of index isn't a promise. This is invalid. Chunk: ${chunkUID}`);
                    }
                    // type check to make sure if check is correct
                    let x: NALInfoTime = last;
                }
            }
        }


        // Create it if it doesn't exist
        if(liveChunkUID === undefined) {
            liveChunkUID = this.addNewChunk(nalHolder);
        }

        
        let chunkObj = chunks[liveChunkUID];

        let nalDeferred = chunkObj.index.last();
        if(!nalDeferred || !("Promise" in nalDeferred)) {
            throw new Error(`Live chunk is corrupted. Last element in index isn't promise, and yet size exceeds threshold. Last value was ${nalDeferred}`);
        }

        if(chunkObj.writeLoop === "exporting") {
            throw new Error(`Chunk is being moved to another storage and is still being written to? This should not be possible. Chunk metadata says live status is ${chunkObj.metadata.IsLive}`);
        }

        if(nalHolder.time < chunkObj.metadata.Ranges.last().lastTime) {
            throw new Error(`Time cannot flow backwards. NAL received out of order.`);
        }

        // See if this chunk should be finished.
        if(chunkObj.metadata.Size > chunkThresholdBytes && nalHolder.type === NALType.NALType_keyframe) {

            // Yep, exceeds size and next nal is keyframe, make it not live, and create new chunk.
            chunkObj.metadata.IsLive = false;
            let finalizedBasePath = chunkObj.fileBasePath;
            chunkObj.writeLoop(async () => {
                await finalizeNALsOnDisk(appendableStorage, finalizedBasePath);
                //console.log(`Finished chunk ${chunkObj.metadata.ChunkUID}, size ${chunkObj.metadata.Size}`);
            });
            chunkObj.index.pop();
            liveChunkUID = this.addNewChunk(nalHolder);
            nalDeferred.Resolve();

            // Add nal to chunk, and queue it to be added to FS
            chunkObj = chunks[liveChunkUID];

            if(chunkObj.writeLoop === "exporting") {
                throw new Error(`Chunk is being moved to another storage and is still being written to? This should not be possible. Chunk metadata says live status is ${chunkObj.metadata.IsLive}`);
            }

            nalDeferred = chunkObj.index.last();
            if(!nalDeferred || !("Promise" in nalDeferred)) {
                throw new Error(`Live chunk is corrupted. Last element in index isn't promise, and yet size exceeds threshold. Last value was ${nalDeferred}`);
            }
        }

        

        let minGap = GetMinGapSize(this.rate);
        let lastRange = chunkObj.metadata.Ranges.last();
        if(!lastRange) {
            throw new Error(`Corrupted chunk object, no ranges?`);
        }

        // Check for time going backwards
        if(nalHolder.time <= lastRange.lastTime && lastRange.frameCount > 0) {
            throw new Error(`Time did not increase between two NALs. Time must always move forward, and no two NALs may have the same time.`);
        }
        lastRange.lastTime = nalHolder.time;

        // Check for gap size
        let gap = nalHolder.time - lastRange.lastTime;
        if(gap >= minGap) {
            lastRange = {
                firstTime: nalHolder.time,
                lastTime: nalHolder.time,
                frameCount: 0
            };
            chunkObj.metadata.Ranges.push(lastRange);
        }

        let last = chunkObj.index.pop();
        if(last !== nalDeferred) {
            throw new Error(`Chunk object is messed up, last value should be deferred`);
        }

        // Update chunk
        lastRange.frameCount++;

        let pos = chunkObj.index.length > 0 ? (chunkObj.index.last() as NALIndexInfo).pos + (chunkObj.index.last() as NALIndexInfo).len : 0;
        let { nal, pps, sps, ... nalInfo } = nalHolder;

        let writeObj = writeNALToDisk(appendableStorage, chunkObj.fileBasePath, nalHolder, pos);
        let indexObj: NALIndexInfo & { finishedWrite: boolean } = {
            ... nalInfo,
            pos: pos,
            len: writeObj.len,
            finishedWrite: false,
        };
        chunkObj.metadata.Size += writeObj.len;
        chunkObj.metadata.LastAddSeqNum = nalInfo.addSeqNum;
        
        chunkObj.index.push(indexObj);
        chunkObj.index.push(new Deferred<void>());
        nalDeferred.Resolve();


        // Queue write to disk
        chunkObj.writeLoop(async () => {
            await writeObj.fnc();
            indexObj.finishedWrite = true;
        });
        
        let removeIndex = 0;
        let curSize = this.GetCurrentBytes()
        while(curSize > maxBytes && removeIndex < this.chunksList.length) {
            let candidate = this.chunksList[removeIndex++];
            if(candidate.IsMoved) {
                continue;
            }

            if(candidate === undefined) {
                console.error(`GetCurrentBytes is broken. We exceed max bytes, but have no chunks. ${this.DebugName()}`);
                break;
            }
            if(this.chunks[candidate.ChunkUID].writeLoop === "exporting") {
                break;
            }
            //console.log(`Exporting chunk, ${candidate.ChunkUID} size ${candidate.Size} total storage size ${this.GetCurrentBytes()}, max size ${maxBytes}`);
            if(candidate.IsLive) {
                //console.error(`We have too many bytes, but the oldest chunk is not finished, so we cannot store export this storage. Candidate: ${candidate.ChunkUID}, ${this.DebugName()}`);
                break;
            }
            let candidateChecked = candidate;
            candidateChecked.IsMoved = true;

            let { nextStorageSystem } = this;
            if(nextStorageSystem === undefined) {
                let chunkUID = candidateChecked.ChunkUID;
                console.error(`Completely deleting chunk ${chunkUID}, ${this.DebugName()}`);
                (async () => {
                    if(chunkObj.writeLoop === "exporting") {
                        throw new Error(`We shouldn't be exporting this chunk, we decided to delete it.`);
                    }

                    // Wait until writes finish, as it may not even have finished writing before we try to delete it.
                    let writesFinished = new Deferred<void>();
                    chunkObj.writeLoop(async () => { writesFinished.Resolve() });
                    await writesFinished.Promise();

                    await this.removeChunk(chunkUID);
                })().catch(e => {
                    console.error(`Error when deleting chunk ${chunkUID}, ${e.stack}`);
                });
                this.onChunkDeleted(candidate.Ranges.last().lastTime);
            } else {
                //console.log(`Exporting chunk ${candidate.ChunkUID}`);

                let nextStorageSystemChecked = nextStorageSystem;
                
                this.ExportChunk(candidate.ChunkUID, async chunk => {
                    await nextStorageSystemChecked.AddChunk(chunk);
                });
            }
        }
    }

    public ExportChunk(chunkUID: string, exportFnc: (chunk: Chunk) => Promise<void>): void {
        this.checkWriteError();

        let { chunks } = this;

        if(!(chunkUID in chunks)) {
            throw new Error(`Chunk cannot be found. Chunk ${chunkUID}`);
        }

        let chunkObj = chunks[chunkUID];
        if(chunkObj.writeLoop === "exporting") {
            throw new Error(`Cannot export chunk as it is currently being exporting. ${chunkUID}`);
        }
        if(chunkObj.metadata.IsLive) {
            throw new Error(`Cannot export chunk as it is still live. ${chunkUID}`);
        }

        chunkObj.writeLoop(async () => {
            let index: NALIndexInfo[] = [];
            for(let info of chunkObj.index) {
                if("Promise" in info) {
                    throw new Error(`Chunk still has promise in index. ${chunkUID}`);
                }
                index.push(info);
            }
            let nalData = await readNALsBulkFromDisk(this.storage, chunkObj.fileBasePath);
            let chunkBuffer = createChunkData(index, nalData);

            if(chunkBuffer.length < nalData.length) {
                console.error(`What? How is the chunk smaller than just the nals?`);
                console.log(`Chunk ${chunkObj.metadata.ChunkUID}, chunkBuffer: ${chunkBuffer.length}, NALData: ${nalData.length}, index count: ${index.length}`);
                process.exit();
            }

            let { pendingReads, ...chunkMetadata } = chunkObj.metadata;
            let chunk: Chunk = {
                ... chunkMetadata,
                IsMoved: false,
                Data: chunkBuffer,
            };

            await exportFnc(chunk);
            await this.removeChunk(chunkUID);
        });
        chunkObj.writeLoop = "exporting";
    }
    private async removeChunk(chunkUID: string): Promise<void> {
        let { chunks, chunksList } = this;

        let chunkObj = chunks[chunkUID];

        let waitCount = 0;
        while(!isEmpty(chunkObj.metadata.pendingReads)) {
            let reads = Object.values(chunkObj.metadata.pendingReads).map(x => x.Promise());
            console.log(`Waiting for reads to finish to remove chunk ${chunkUID}, reads: ${Object.keys(chunkObj.metadata.pendingReads).join(", ")}`);
            await Promise.all(reads);
            waitCount++;
            if(waitCount > 10) {
                throw new Error(`Could not remove chunk, after too many waits for pending reads to finish.`);
            }
        }

        delete chunks[chunkUID];

        let chunksListIndex = findAtIndex(chunksList, chunkObj.metadata.Ranges[0].firstTime, x => x.Ranges[0].firstTime);
        if(chunksListIndex < 0) {
            console.error(`Cannot find chunk in chunksList`);
        } else {
            chunksList.splice(chunksListIndex, 1);
        }
        await deleteNALs(this.storage, chunkObj.fileBasePath);
    }

    public async AddChunk(chunk: Chunk): Promise<void> {
        this.checkWriteError();

        if(chunk.ChunkUID in this.chunks) {
            console.error(`Chunk already added. ${chunk.ChunkUID}`);
            return;
        }

        let { Data, ...chunkMetadataBase } = chunk;
        let chunkMetadata: ChunkMetadataExtended = { ... chunkMetadataBase, pendingReads: { } };

        //console.log(`Adding chunk ${chunk.ChunkUID}, data size: ${Data.length} to ${this.DebugName()}, isLive: ${chunkMetadata.IsLive}`);

        insertIntoListMap(this.chunksList, chunkMetadata, x => x.Ranges[0].firstTime);

        let chunkData = parseChunkData(Data);

        let chunkUID = chunk.ChunkUID;
        let fileBasePath = this.path + chunkUID;
        // Wait until we write to disk before we add it to memory, as all in memory reads
        //  read from disk presently (if they didn't then we could make writing non-blocking).
        await writeNALsBulkToDisk(this.storage, fileBasePath, chunkData.nalsBulk, chunkData.index, chunkMetadata.IsLive);

        let index: (NALIndexInfo & { finishedWrite: boolean })[] = [];
        for(let indexInfo of chunkData.index) {
            index.push({ ...indexInfo, finishedWrite: true });
        }

        this.chunks[chunkUID] = {
            metadata: chunkMetadata,
            index: index,
            fileBasePath: this.path + chunkUID,
            writeLoop: this.createWriteLoop(),
        };
    }

    // Hmm... so, this locks it synchronously, and then after the async part finishes, it should synchronously unlock it and return to
    //  the caller. So in theory, if multiple lockChunk functions are called, with gaps in between, there should be no race
    //  condition of the chunks being deleted inbetween (unless in the gaps we add nals, but that won't happen, as that function
    //  should be entirely independent of lockChunk calls.)
    private async lockChunk<T>(cancelId: string, chunkObj: ChunkObj, fnc: (onCancelled: Promise<void>) => Promise<T>): Promise<T | void> {
        let onRead = new Deferred<void>();
        let { pendingReads } = chunkObj.metadata;
        let chunkUID = chunkObj.metadata.ChunkUID;
        if(cancelId in pendingReads) {
            throw new Error(`cancelId already used on other ReadNALs. ${cancelId}`);
        }
        pendingReads[cancelId] = onRead;
        try {
            return await Promise.race([fnc(onRead.Promise() as any as Promise<void>), onRead.Promise()]);
        } finally {
            delete pendingReads[cancelId];
            onRead.Resolve();
        }
    }

    public async GetIndex(cancelId: string, chunkUID: string): Promise<{index: (NALInfoTime | { Promise(): Promise<void> })[]}> {
        this.checkWriteError();

        let chunkObj = this.chunks[chunkUID];
        if(chunkObj.metadata.IsMoved) {
            throw new Error(`Cannot Read from chunk as it has been moved. Do not attempt to start new reads on moved chunks. ${chunkUID}`);
        }

        let result = await this.lockChunk(cancelId, chunkObj, async onCancelled => {
            return chunkObj;
        });

        if(!result) {
            return {index: []};
        }
        return result;
    }

    public async ReadNALs(cancelId: string, chunkUID: string, timesRaw: (NALInfoTime | { Promise(): Promise<void> })[]): Promise<NALHolderMin[] | "CANCELLED"> {
        this.checkWriteError();

        let chunkObj = UnionUndefined(this.chunks[chunkUID]);
        if(!chunkObj) {
            throw new Error(`Cannot Read from chunk as it has been moved. Do not attempt to start new reads on moved chunks. ${chunkUID}`);
        }

        if(chunkObj.metadata.IsMoved) {
            throw new Error(`Cannot Read from chunk as it has been moved. Do not attempt to start new reads on moved chunks. ${chunkUID}`);
        }

        let chunkObjChecked = chunkObj;

        let result = await this.lockChunk(cancelId, chunkObj, async (onCancelled) => {
            let times = timesRaw.filter(x => !("Promise" in x)) as (NALIndexInfo & { finishedWrite: boolean })[];
            if(times.length === 0) {
                return [];
            }

            if(times.some(x => !x.finishedWrite)) {
                if(chunkObjChecked.writeLoop === "exporting") {
                    throw new Error(`Some writes are not finished but we are exporting data?`);
                }
                // Eh... excessive waiting, but this shouldn't happen that often.
                let writesFinished = new Deferred<void>();
                chunkObjChecked.writeLoop(async () => { writesFinished.Resolve() });
                await writesFinished.Promise();
                this.checkWriteError();
                if(times.some(x => !x.finishedWrite)) {
                    throw new Error(`Waited for writes to finish, but they didn't. This should be impossible.`);
                }
            }

            return await readNALs(this.storage, chunkObjChecked.fileBasePath, times, onCancelled);
        });

        if(!result) {
            return "CANCELLED";
        }
        return result;
    }


    public CancelCall(cancelId: string, chunkUID: string): void {
        this.checkWriteError();

        let chunkObj = UnionUndefined(this.chunks[chunkUID]);
        if(!chunkObj) return;
        let readDeferred = UnionUndefined(chunkObj.metadata.pendingReads[cancelId]);
        if(!readDeferred) return;
        console.log(`Resolving ${cancelId}`);
        delete chunkObj.metadata.pendingReads[cancelId];
        readDeferred.Resolve();
        console.log(`Resolved ${cancelId}`);
    }

    public GetChunkMetadatas(): ChunkMetadata[] {
        this.checkWriteError();

        return this.chunksList;
    }


    public GetCurrentBytes(): number {
        this.checkWriteError();

        return sum(this.GetChunkMetadatas().filter(x => !x.IsMoved).map(x => x.Size));
    }
    

    /** Requires bytesPerSecond, secondsPerChunk, and maxCost, so we can take into account extra glacier minimum storage restrictions. */
    public MaxGB(bytesPerSecond: number, secondsPerChunk: number, maxCost: number): number {
        this.checkWriteError();
        
        if(this.fakeOverrides) {
            return this.fakeOverrides.maxGB(bytesPerSecond, secondsPerChunk, maxCost);
        }
        return maxCost / this.baseTotalCost * this.baseTotalStorageBytes / 1024 / 1024 / 1024;
    }

    /** Assumes 1 request. If you are planning on making more than 1 request, call this once, and then multiply it by the number of requests.
     *      (this should probably be called with the chunk size).
    */
    public CostPerGBDownload(bytes: number): number {
        this.checkWriteError();

        if(this.fakeOverrides) {
            return this.fakeOverrides.costPerGB(bytes);
        }
        return 0;
    }

    public DebugName(): string {
        this.checkWriteError();

        if(this.fakeOverrides) {
            return this.fakeOverrides.debugName + "_" + this.rate;
        }
        return `disk_rate_${this.rate}`;
    }

    public IsFixedStorageSize(): boolean {
        this.checkWriteError();

        return !this.fakeOverrides;
    }
}

export function createChunkData(index: NALIndexInfo[], nalData: Buffer): Buffer {
    let indexData = Buffer.from(JSON.stringify(index));
    let indexLengthBytes = Buffer.alloc(4);
    indexLengthBytes.writeUInt32BE(indexData.length, 0);
    return Buffer.concat([ indexLengthBytes, indexData, nalData ]);
}

function parseChunkData(chunk: Buffer): {
    nalsBulk: Buffer;
    index: NALIndexInfo[];
} {
    let indexLength = chunk.readUInt32BE(0);
    let indexData = chunk.slice(4, 4 + indexLength);
    let NALData = chunk.slice(4 + indexLength);
    let indexArr: NALIndexInfo[] = JSON.parse(indexData.toString());

    return {
        nalsBulk: NALData,
        index: indexArr,
    };
}