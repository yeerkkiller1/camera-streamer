import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise, existsFilePromise, statFilePromise, closeDescPromise, writeFilePromise, openWritePromise, writeDescPromise, unlinkFilePromise, readdirPromise, mkdirFilePromise } from "../util/fs";
import { keyBy, profile, randomUID, UnionUndefined, isEmpty } from "../util/misc";
import { sort, insertIntoListMap, findAtIndex, findAt } from "../util/algorithms";
import { TransformChannel, Deferred } from "pchannel";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";
import { RoundRecordTime, GetMinGapSize } from "./TimeMap";
import { max, group, sum } from "../util/math";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { MuxVideo } from "mp4-typescript";
import { readNalLoop, readNal, writeNALToDisk, readNALsBulkFromDisk, loadIndexFromDisk, finalizeNALsOnDisk, deleteNALs, writeNALsBulkToDisk, readNALs } from "./NALBuffers";
import { reduceRanges } from "./rangeMapReduce";


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
export class LocalRemoteStorage implements RemoteStorageLocal {
    private chunksList: ChunkMetadataExtended[] = [];
    private chunks: {
        [chunkUID: string]: ChunkObj
    } = {};
    private nextStorageSystem: RemoteStorage|undefined;
    private onChunkDeleted!: (deleteTime: number) => void;
    private chunkThresholdBytes: number|undefined;
    private maxBytes: number|undefined;

    constructor(
        private rate: number,
        private baseTotalCost: number,
        private baseTotalStorageBytes: number,
        private path = "./dist/local/",
        private fakeOverrides?: {
            debugName: string;
            maxGB: (bytesPerSecond: number, secondPerChunk: number, maxCost: number) => number;
            costPerGB: (bytes: number) => number;
        }
    ) {}

    public async Init(
        nextStorageSystem: RemoteStorage|undefined,
        onChunkDeleted: (deleteTime: number) => void,
        chunkThresholdBytes: number,
        maxBytes: number
    ): Promise<void> {

        if(!await existsFilePromise(this.path)) {
            await mkdirFilePromise(this.path);
        }

        // We need to read all of the data from the file system (well not the nals I guess, but at least the index files)
        //  and then add the chunk metadatas.

        this.nextStorageSystem = nextStorageSystem;
        this.onChunkDeleted = onChunkDeleted;

        this.chunkThresholdBytes = chunkThresholdBytes;
        this.maxBytes = maxBytes;
        
        let fileNames = await readdirPromise(this.path);
        let nalFileNames = fileNames.filter(x => x.endsWith(".nal") && x.startsWith(`chunk_rate_${this.rate}_`));

        console.log(`Init ${this.DebugName()}, max bytes: ${maxBytes}, next storage system: ${nextStorageSystem && nextStorageSystem.DebugName()}`);

        for(let nalFileName of nalFileNames) {
            let indexFileName = nalFileName.slice(0, -".nal".length) + ".index";
            
            let nalFilePath = this.path + nalFileName;
            let indexFilePath = this.path + indexFileName;

            let nalInfosObj = await loadIndexFromDisk(nalFilePath, indexFilePath);
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
        let writeLoopBase = TransformChannel<() => Promise<void>, void>(input => input());
        return async (code: () => Promise<void>) => {
            try {
                await writeLoopBase(code);
            } catch(e) {
                console.log(code);
                console.error(`Error in write loop. ${e.stack}`);
            }
        };
    }
    private createChunkUID(startNAL: NALInfoTime) {
        return `chunk_rate_${startNAL.rate}_addSeqNum_${startNAL.addSeqNum}`;
    }
    private addChunk(nal: NALInfoTime): string {
        let { chunks, chunksList } = this;

        let chunkUID = this.createChunkUID(nal);
        //console.log(`Creating new chunk ${chunkUID}, chunk limit ${this.chunkThresholdBytes}`);
        let chunkMetadata: ChunkMetadataExtended = {
            ChunkUID: chunkUID,
            Ranges: [{ firstTime: nal.time, lastTime: nal.time, frameCount: 0 }],
            Size: 0,
            IsLive: true,
            IsMoved: false,
            pendingReads: {},
            LastAddSeqNum: nal.addSeqNum
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
        let { chunks, chunksList, chunkThresholdBytes, maxBytes } = this;

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
            liveChunkUID = this.addChunk(nalHolder);
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
            console.log(`Finishing chunk ${chunkObj.metadata.ChunkUID}, size ${chunkObj.metadata.Size}`);

            // Yep, exceeds size and next nal is keyframe, make it not live, and create new chunk.
            chunkObj.metadata.IsLive = false;
            let finalizedBasePath = chunkObj.fileBasePath;
            chunkObj.writeLoop(async () => await finalizeNALsOnDisk(finalizedBasePath));
            chunkObj.index.pop();
            liveChunkUID = this.addChunk(nalHolder);
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

        // Check for gap size
        let gap = nalHolder.time - lastRange.lastTime;
        if(gap >= minGap) {
            lastRange.lastTime = nalHolder.time;
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

        let writeObj = writeNALToDisk(chunkObj.fileBasePath, nalHolder, pos);
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
        while(this.GetCurrentBytes() < maxBytes && removeIndex < this.chunksList.length) {
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
            let nalData = await readNALsBulkFromDisk(chunkObj.fileBasePath);
            let chunkBuffer = createChunkData(index, nalData);

            if(chunkBuffer.length < nalData.length) {
                console.error(`What? How is the chunk smaller than just the nals?`);
                console.log(`Chunk ${chunkObj.metadata.ChunkUID}, chunkBuffer: ${chunkBuffer.length}, NALData: ${nalData.length}, index count: ${index.length}`);
                process.exit();
            }

            let { pendingReads, ...chunkMetadata } = chunkObj.metadata;
            let chunk: Chunk = {
                ... chunkMetadata,
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
            console.log(`Waiting for reads to finish to remove chunk ${chunkUID}`);
            await Promise.all(Object.values(chunkObj.metadata.pendingReads));
            waitCount++;
            if(waitCount > 100) {
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
        await deleteNALs(chunkObj.fileBasePath);
    }

    public async AddChunk(chunk: Chunk): Promise<void> {
        if(chunk.ChunkUID in this.chunks) {
            throw new Error(`Chunk already added. ${chunk.ChunkUID}`);
        }

        let { Data, ...chunkMetadataBase } = chunk;
        let chunkMetadata: ChunkMetadataExtended = { ... chunkMetadataBase, pendingReads: {} };

        console.log(`Adding chunk ${chunk.ChunkUID}, data size: ${Data.length} to ${this.DebugName()}, isLive: ${chunkMetadata.IsLive}`);

        insertIntoListMap(this.chunksList, chunkMetadata, x => x.Ranges[0].firstTime);

        let chunkData = parseChunkData(Data);

        let chunkUID = chunk.ChunkUID;
        let fileBasePath = this.path + chunkUID;
        // Wait until we write to disk before we add it to memory, as all in memory reads
        //  read from disk presently (if they didn't then we could make writing non-blocking).
        await writeNALsBulkToDisk(fileBasePath, chunkData.nalsBulk, chunkData.index, chunkMetadata.IsLive);

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


    public async ReadNALs(
        cancelId: string,
        chunkUID: string,
        accessFnc: (
            index: (NALInfoTime | { Promise(): Promise<void> })[]
        ) => Promise<NALInfoTime[]>
    ): Promise<NALHolderMin[] | "CANCELLED"> {
        let chunkObj = this.chunks[chunkUID];
        if(chunkObj.metadata.IsMoved) {
            throw new Error(`Cannot Read from chunk as it has been moved. Do not attempt to start new reads on moved chunks. ${chunkUID}`);
        }

        let onRead = new Deferred<void>();
        let { pendingReads } = chunkObj.metadata;
        if(cancelId in pendingReads) {
            throw new Error(`cancelId already used on other ReadNALs. ${cancelId}`);
        }
        pendingReads[cancelId] = onRead;
        try {
            let times = await accessFnc(chunkObj.index) as (NALIndexInfo & { finishedWrite: boolean })[];
            if(times.length === 0) {
                return [];
            }

            if(times.some(x => !x.finishedWrite)) {
                if(chunkObj.writeLoop === "exporting") {
                    throw new Error(`Some writes are not finished but we are exporting data?`);
                }
                // Eh... excessive waiting, but this shouldn't happen that often.
                let writesFinished = new Deferred<void>();
                chunkObj.writeLoop(async () => { writesFinished.Resolve() });
                await writesFinished.Promise();
                if(times.some(x => !x.finishedWrite)) {
                    throw new Error(`Waited for writes to finish, but they didn't. This should be impossible.`);
                }
            }

            return await readNALs(chunkObj.fileBasePath, times, onRead.Promise());
        } finally {
            onRead.Resolve();
            delete pendingReads[cancelId];
        }
    }
    public CancelReadNALs(cancelId: string, chunkUID: string): void {
        this.chunks[chunkUID].metadata.pendingReads[cancelId].Resolve();
    }

    public GetChunkMetadatas(): ChunkMetadata[] {
        return this.chunksList;
    }


    public GetCurrentBytes(): number {
        return sum(this.GetChunkMetadatas().filter(x => !x.IsMoved).map(x => x.Size));
    }
    

    /** Requires bytesPerSecond, secondsPerChunk, and maxCost, so we can take into account extra glacier minimum storage restrictions. */
    public MaxGB(bytesPerSecond: number, secondsPerChunk: number, maxCost: number): number {
        if(this.fakeOverrides) {
            return this.fakeOverrides.maxGB(bytesPerSecond, secondsPerChunk, maxCost);
        }
        return maxCost / this.baseTotalCost * this.baseTotalStorageBytes / 1024 / 1024 / 1024;
    }

    /** Assumes 1 request. If you are planning on making more than 1 request, call this once, and then multiply it by the number of requests.
     *      (this should probably be called with the chunk size).
    */
    public CostPerGBDownload(bytes: number): number {
        if(this.fakeOverrides) {
            return this.fakeOverrides.costPerGB(bytes);
        }
        return 0;
    }

    public DebugName(): string {
        if(this.fakeOverrides) {
            return this.fakeOverrides.debugName + "_" + this.rate;
        }
        return `disk_rate_${this.rate}`;
    }

    public IsFixedStorageSize(): boolean {
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