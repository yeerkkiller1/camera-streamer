import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise, existsFilePromise, statFilePromise, closeDescPromise, writeFilePromise, openWritePromise, writeDescPromise, unlinkFilePromise, readdirPromise } from "../util/fs";
import { keyBy, profile, randomUID, UnionUndefined, isEmpty } from "../util/misc";
import { sort, insertIntoListMap, findAtIndex, findAt } from "../util/algorithms";
import { TransformChannel, Deferred } from "pchannel";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";
import { RoundRecordTime, GetMinGapSize } from "./TimeMap";
import { max, group, sum } from "../util/math";
import { NALManager, createNALManager } from "./NALManager";
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
    private path: string = "./dist/";
    private onChunkDeleted!: (deleteTime: number) => void;
    private chunkThresholdBytes: number|undefined;
    private maxBytes: number|undefined;

    constructor(
        private rate: number
    ) {}

    public async Init(
        nextStorageSystem: RemoteStorage|undefined,
        onChunkDeleted: (deleteTime: number) => void,
        chunkThresholdBytes: number,
        maxBytes: number
    ): Promise<void> {
        // We need to read all of the data from the file system (well not the nals I guess, but at least the index files)
        //  and then add the chunk metadatas.

        this.nextStorageSystem = nextStorageSystem;
        this.onChunkDeleted = onChunkDeleted;

        this.chunkThresholdBytes = chunkThresholdBytes;
        this.maxBytes = maxBytes;
        
        let fileNames = await readdirPromise(this.path);
        let nalFileNames = fileNames.filter(x => x.endsWith(".nal"));

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

            let index: (NALIndexInfo & { finishedWrite: boolean })[] = [];
            for(let indexInfo of nalInfos) {
                index.push({ ...indexInfo, finishedWrite: true });
            }

            this.chunks[chunkUID] = {
                metadata: chunkMetadata,
                index: index,
                fileBasePath: this.path + chunkUID,
                writeLoop: this.createWriteLoop(),
            };
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
        return `chunk_${startNAL.rate}_${startNAL.addSeqNum}`;
    }
    private addChunk(nal: NALInfoTime): string {
        let { chunks, chunksList } = this;

        let chunkUID = this.createChunkUID(nal);
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
            if(list.length > 0 && "then" in list.last()) {
                liveChunkUID = chunkUID;
            }
        }


        // Create it if it doesn't exist
        if(liveChunkUID === undefined) {
            liveChunkUID = this.addChunk(nalHolder);
        }

        
        let nalDeferred = chunks[liveChunkUID].index.last();
        if(!nalDeferred || !("Promise" in nalDeferred)) {
            throw new Error(`Live chunk is corrupted. Last element in index isn't promise, and yet size exceeds threshold. Last value was ${nalDeferred}`);
        }

        let chunkObj = chunks[liveChunkUID];

        if(chunkObj.writeLoop === "exporting") {
            throw new Error(`Chunk is being moved to another storage and is still being written to? This should not be possible. Chunk metadata says live status is ${chunkObj.metadata.IsLive}`);
        }

        // See if this chunk should be finished.
        if(chunkObj.metadata.Size > chunkThresholdBytes && nalHolder.type === NALType.NALType_keyframe) {
            // Yep, exceeds size and next nal is keyframe, make it not live, and create new chunk.
            chunkObj.metadata.IsLive = false;
            chunkObj.writeLoop(() => finalizeNALsOnDisk(chunkObj.fileBasePath));
            chunkObj.index.pop();
            liveChunkUID = this.addChunk(nalHolder);
            nalDeferred.Resolve();

            nalDeferred = chunks[liveChunkUID].index.last();
            if(!nalDeferred || !("Promise" in nalDeferred)) {
                throw new Error(`Live chunk is corrupted. Last element in index isn't promise, and yet size exceeds threshold. Last value was ${nalDeferred}`);
            }
        }

        // Add nal to chunk, and queue it to be added to FS
        chunkObj = chunks[liveChunkUID];

        if(chunkObj.writeLoop === "exporting") {
            throw new Error(`Chunk is being moved to another storage and is still being written to? This should not be possible. Chunk metadata says live status is ${chunkObj.metadata.IsLive}`);
        }

        let minGap = GetMinGapSize(this.rate);
        let lastRange = chunkObj.metadata.Ranges.last();
        if(!lastRange) {
            throw new Error(`Corrupted chunk object, no ranges?`);
        }

        // Check for time going backwards
        if(nalHolder.time <= lastRange.lastTime) {
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

        let pos = chunkObj.index.length > 0 ? (chunkObj.index.last() as NALIndexInfo).pos : 0;
        let { nal, pps, sps, ... nalInfo } = nalHolder;
        let indexObj: NALIndexInfo & { finishedWrite: boolean } = {
            ... nalInfo,
            pos: pos,
            len: 0,
            finishedWrite: false,
        };

        let writeObj = writeNALToDisk(chunkObj.fileBasePath, nalHolder, pos);
        indexObj.len = writeObj.len;
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

        (() => {
            if(this.GetCurrentBytes() < maxBytes) {
                return;
            }
            let candidate = this.chunksList[0];
            if(candidate === undefined) {
                console.error(`GetCurrentBytes is broken. We exceed max bytes, but have no chunks. ${this.DebugName()}`);
                return;
            }
            if(candidate.IsLive) {
                console.error(`We have too many bytes, but the oldest chunk is not finished, so we cannot store export this storage. ${this.DebugName()}`);
                return;
            }
            let candidateChecked = candidate;

            let { nextStorageSystem } = this;
            if(nextStorageSystem === undefined) {
                let chunkUID = candidateChecked.ChunkUID;
                console.error(`Completely deleting chunk ${chunkUID}, ${this.DebugName()}`);
                this.removeChunk(chunkUID).catch(e => {
                    console.error(`Error when deleting chunk ${chunkUID}, ${e.stack}`);
                    this.onChunkDeleted(candidate.Ranges.last().lastTime);
                });
                return;
            }
            let nextStorageSystemChecked = nextStorageSystem;
            
            this.ExportChunk(candidate.ChunkUID, async chunk => {
                await nextStorageSystemChecked.AddChunk(chunk);
            });
        })();
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

        chunkObj.metadata.IsMoved = true;

        let waitCount = 0;
        while(!isEmpty(chunkObj.metadata.pendingReads)) {
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
        insertIntoListMap(this.chunksList, chunkMetadata, x => x.Ranges[0].firstTime);

        let chunkData = parseChunkData(Data);

        // Wait until we write to disk before we add it to memory, as all in memory reads
        //  read from disk presently (if they didn't then we could make writing non-blocking).
        await writeNALsBulkToDisk(chunk.ChunkUID, chunkData.nalsBulk, chunkData.index);

        let index: (NALIndexInfo & { finishedWrite: boolean })[] = [];
        for(let indexInfo of chunkData.index) {
            index.push({ ...indexInfo, finishedWrite: true });
        }

        let chunkUID = chunk.ChunkUID;
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

        let times = await accessFnc(chunkObj.index);
        if(times.length === 0) {
            return [];
        }

        return readNALs(chunkObj.fileBasePath, times as NALIndexInfo[], onRead.Promise())
    }
    public CancelReadNALs(cancelId: string, chunkUID: string): void {
        this.chunks[chunkUID].metadata.pendingReads[cancelId].Resolve();
    }

    public GetChunkMetadatas(): ChunkMetadata[] {
        return this.chunksList;
    }


    public GetCurrentBytes(): number {
        return sum(this.GetChunkMetadatas().map(x => x.Size));
    }
    

    /** Requires bytesPerSecond, secondsPerChunk, and maxCost, so we can take into account extra glacier minimum storage restrictions. */
    public MaxGB(bytesPerSecond: number, secondsPerChunk: number, maxCost: number): number {
        let chunkSize = bytesPerSecond * secondsPerChunk;
        return chunkSize * 3;
    }

    /** Assumes 1 request. If you are planning on making more than 1 request, call this once, and then multiply it by the number of requests.
     *      (this should probably be called with the chunk size).
    */
    public CostPerGBDownload(bytes: number): number {
        return 0;
    }

    public DebugName(): string {
        return `disk_rate_${this.rate}`;
    }
}

export function createChunkData(index: NALIndexInfo[], nalData: Buffer): Buffer {
    let indexData = Buffer.from(JSON.stringify(index));
    let indexLengthBytes = Buffer.alloc(4);
    indexLengthBytes.writeUInt32BE(indexData.length, 0);
    return Buffer.from([ indexLengthBytes, indexData, nalData ]);
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