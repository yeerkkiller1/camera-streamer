interface StorageBaseBase {
    GetDirectoryListing(path: string): Promise<string[]>;
    GetFileSize(filePath: string): Promise<number>;
    GetFileContents(filePath: string): Promise<Buffer>;
    SetFileContents(filePath: string, data: string|Buffer): Promise<void>;
    DeleteFile(filePath: string): Promise<void>;
    Exists(filePath: string): Promise<boolean>;
    CreateDirectory(path: string): Promise<void>;
}
interface StorageBaseAppendableBase {
    AppendData(filePath: string, data: string|Buffer): Promise<void>;
}
type StorageBaseAppendable = StorageBaseBase & StorageBaseAppendableBase;
type StorageBase = StorageBaseBase | StorageBaseAppendable;


type ChunkMetadata = {
    ChunkUID: string;
    Ranges: NALRange[];
    Size: number;
    /** If live all the values are subject to change on it, and it cannot be transitioned to another storage. */
    IsLive: boolean;
    /** If the chunk has been moved to another storage system. The only reason this would be true and the chunk would still
     *      be returned from a storage system is if the system is waiting for pending reads on the chunk to finish.
     *      However, if this is true no new pending reads should be attempted.
     */
    IsMoved: boolean;
    FirstAddSeqNum: number;
    LastAddSeqNum: number;
};
type Chunk = ChunkMetadata & {
    Data: Buffer;
};



interface NALStorageManager {
    AddNAL(val: NALHolderMin): Promise<void>|void;
    GetNextAddSeqNum(): Promise<number>;

    SyncRates(callback: (newRate: number) => void): Promise<number[]>;
    GetStorage(rate: number): Promise<NALStorage>;
}

interface NALStorage {
    Init(): Promise<void>;

    IsWriteable(): boolean;

    AddNAL(val: NALHolderMin): void;

    GetRanges(): NALRange[];
    SubscribeToRanges(
        rangesChanged: (changedRanges: NALRange[]) => void,
        rangesDeleted: (deleteTime: number) => void,
    ): () => void;

    GetNextAddSeqNum(): number;

    
    GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number|undefined|null|"live",
        onlyTimes: boolean|undefined|null,
        forPreview: boolean|undefined|null,
        cancelToken: {
            Promise(): Promise<void>;
            Value(): {
                v: void;
            } | {
                error: any;
            } | undefined;
        },
    ): Promise<MP4Video | "CANCELLED">;
}


// One instance per rate (and eventually camera + rate combination)
interface RemoteStorageBase {
    /** May be called many times, which should not init the metadata multiple times, but should replace the nextStorageSystem value and onChunkDeletion callback. */
    Init(
        nextStorageSystem: RemoteStorage|undefined,
        // Not just moved, completed deleted from this storage.
        onChunkDeleted: (deleteTime: number) => void,
        chunkThresholdBytes: number,
        maxBytes: number,
    ): Promise<void>;

    /** Requires bytesPerSecond, secondsPerChunk, and maxCost, so we can take into account extra glacier minimum storage restrictions. */
    MaxGB(bytesPerSecond: number, secondsPerChunk: number, maxCost: number): number;

    /** Assumes 1 request. If you are planning on making more than 1 request, call this once, and then multiply it by the number of requests.
     *      (this should probably be called with the chunk size).
    */
    CostPerGBDownload(bytes: number): number;


    GetCurrentBytes(): number;
    
    /** Sorted by Ranges[0].firstTime */
    GetChunkMetadatas(): ChunkMetadata[];




    // A promise value may exist at the end of the array, and signifies that the index is live. When the promise is resolved
    //  the array will be updated (either to have another NALInfoTime, or to no longer be live). If it isn't live it means
    //  the NAL after the last nal is a keyframe.
    GetIndex(cancelId: string, chunkUID: string): Promise<{index: (NALInfoTime | { Promise(): Promise<void> })[]}>;
    // Must be called synchronously after calling GetIndex.
    //  And { Promise()... } objects will be ignored.
    ReadNALs(cancelId: string, chunkUID: string, times: (NALInfoTime | { Promise(): Promise<void> })[]): Promise<NALHolderMin[] | "CANCELLED">;

    CancelCall(cancelId: string, chunkUID: string): void;

    /** Exports chunk. Assumes exportFnc moves it to another storage system, and when it finishes we delete the chunk from ourself. */
    ExportChunk(chunkUID: string, exportFnc: (chunk: Chunk) => Promise<void>): void;

    AddChunk(chunk: Chunk): Promise<void>;

    DebugName(): string;

    IsFixedStorageSize(): boolean;
}
interface RemoteStorageLocal extends RemoteStorageBase {
    /** If this is present, this storage system can accept single nals. This means the caller doesn't need to buffer them,
     *      and can just send nals as it receives them.
     */
    AddSingleNAL(nal: NALHolderMin): void;
    
}
type RemoteStorage = RemoteStorageBase | RemoteStorageLocal;