import { randomUID, UnionUndefined, profile } from "../../util/misc";
import { sort, findAtOrBefore, findAtOrBeforeIndex, binarySearchMap, findAt, findAtIndex } from "../../util/algorithms";
import { reduceRanges, deleteRanges, removeRange } from "../rangeMapReduce";
import { GetMinGapSize } from "../TimeMap";
import { max } from "../../util/math";
import { PChannelMultiListen } from "../../receiver/PChannelMultiListen";
import { PChan, TransformChannel, Deferred } from "pchannel";
import { readNal } from "../NALBuffers";
import { GetVideoTimes, muxVideo } from "../muxing";
import { createChunkData } from "../LocalNALRate";

// Eh... we'll use Buffers, so we have a 2GB chunk limit. But... that should be fine.
// We'll store chunk lists and metadata locally. 
//  TODO: Setup chunk list and metadata recovery from amazon
//  REMEMBER! You can't split P frames from their I frames. We need to keep them together, or else it won't play!


export class NALStorageManagerImpl implements NALStorageManager {
    private nextAddSeqNum = new Deferred<number>();

    private storageHolders: { [rate: number]: {
        storage: Deferred<NALStorage>;
        deferredAddChannel: PChan<NALHolderMin>;
    } } = {};

    private storageSystemsCtors: ((rate: number) => RemoteStorage)[];
    private maxCostPerMonthStorage: number;
    private averageFrameBytes: number;
    private framesPerSecond: number;
    private baseRate: number;
    private secondPerRate1Chunk: number;
    constructor(
        config: {
            storageSystemsCtors: ((rate: number) => RemoteStorage)[];
            maxCostPerMonthStorage: number;
            averageFrameBytes: number;
            framesPerSecond: number;
            baseRate: number;
            secondPerRate1Chunk: number;
        }
    ) {
        this.storageSystemsCtors = config.storageSystemsCtors;
        this.maxCostPerMonthStorage = config.maxCostPerMonthStorage;
        this.averageFrameBytes = config.averageFrameBytes;
        this.framesPerSecond = config.framesPerSecond;
        this.baseRate = config.baseRate;
        this.secondPerRate1Chunk = config.secondPerRate1Chunk;

        // And now, we need to read the storage systems for rate 1, and find the newest addSeqNum.

        this.GetStorage(1)
            .then(async storage => {
                try {
                    this.nextAddSeqNum.Resolve(storage.GetNextAddSeqNum());
                } catch(e) {
                    console.error(`Could process storage for rate 1. ${e.stack}`);
                    console.error(`This is a fatal error, the StorageManager will just break after this.`);
                }
            },
            e => {
                console.error(`Could not get storage for rate 1. ${e.stack}`);
                console.error(`This is a fatal error, the StorageManager will just break after this.`);
            });

        this.getRates().catch(e => {
            console.error(`getRates error, ${e.stack}`);
        });
    }

    private async getRates(): Promise<number[]> {
        let rate = 1;
        let emptyCountLeft = 2;
        while(true) {
            let storage = await this.GetStorage(rate);

            if(storage.GetRanges().length === 0) {
                emptyCountLeft--;

                if(emptyCountLeft === 0) {
                    break;
                }
            }

            rate = rate * this.baseRate;
        }
        
        let rates = Object.keys(this.storageHolders).map(x => +x);
        sort(rates, x => x);
        return rates;
    }

    public AddNAL(val: NALHolderMin): void {
        if(val.rate === 1) {
            this.nextAddSeqNum.ForceResolve(val.addSeqNum + 1);
        }
        
        let rate = val.rate;
        this.GetStorage(rate);
        let storageObj = this.storageHolders[rate];
        let value = storageObj.storage.Value();
        if(value && !storageObj.deferredAddChannel.HasValues()) {
            if("error" in value) {
                throw new Error(`Could not get storage, rate ${rate}, error: ${value.error}`);
            }
            if(!value.v.IsWriteable()) {
                console.warn(`Ignoring NAL for rate as it is impractical to store. Rate: ${rate}.`);
                return;
            }
        }
        // Only synchronously add if there is nothing asynchronously added
        if(value && !storageObj.deferredAddChannel.HasValues()) {
            if("error" in value) {
                throw new Error(`Could not get storage, rate ${rate}, error: ${value.error}`);
            }
            value.v.AddNAL(val);
        } else {
            storageObj.deferredAddChannel.SendValue(val);
        }
    }

    private newRateChannel = new PChannelMultiListen<number>();
    public async SyncRates(callback: (newRate: number) => void): Promise<number[]> {
        this.newRateChannel.Subscribe(callback);
        let rates = Object.keys(this.storageHolders).map(x => +x);
        sort(rates, x => x);
        return rates;
    }
    public GetNextAddSeqNum(): Promise<number> {
        return this.nextAddSeqNum.Promise();
    }

    public GetStorage(rate: number): Promise<NALStorage> {
        if(rate === null || isNaN(rate)) {
            console.error(`What? ${new Error().stack}`);
            throw new Error(`Tried to get storage with invalid rate ${rate}`);
        }
        if(!(rate in this.storageHolders)) {
            let costPerStorage = this.maxCostPerMonthStorage / Math.pow(2, Math.log(rate) / Math.log(this.baseRate) + 1);
            let deferred = new Deferred<NALStorage>().Resolve(this.createStorageHolder(rate, costPerStorage));
            let pchan = new PChan<NALHolderMin>();
            this.storageHolders[rate] = {
                storage: deferred,
                deferredAddChannel: pchan
            };

            (async () => {
                let storage = await deferred.Promise();

                if(!storage.IsWriteable()) {
                    console.warn(`Ignoring NALs for rate as it is impractical to store. Rate: ${rate}.`);
                    while(pchan.HasValues()) {
                        await pchan.GetPromise();
                    }
                    return;
                }
                
                while(true) {
                    let nal = await pchan.GetPromise();
                    storage.AddNAL(nal);
                }
            })();

            this.newRateChannel.SendValue(rate);
        }
        return this.storageHolders[rate].storage.Promise();
    }
    private async createStorageHolder(rate: number, costAvailable: number): Promise<NALStorage> {
        const minChunks = 3;

        let storageSystems = this.storageSystemsCtors.map(fnc => fnc(rate));

        let framesPerSecond = this.framesPerSecond / rate;
        let bytesPerSecond = this.averageFrameBytes * framesPerSecond;
        
        let chunkSizeBytes = bytesPerSecond * rate * this.secondPerRate1Chunk;
        if(chunkSizeBytes < this.averageFrameBytes * 2) {
            chunkSizeBytes = this.averageFrameBytes * 2;
        }
        let secondsPerChunk = chunkSizeBytes / bytesPerSecond;

        console.log(`Creating storage holder for ${rate}, costAvailable ${costAvailable}, chunk size ${chunkSizeBytes}, seconds per chunk ${secondsPerChunk}`);

        let costPerStorage = costAvailable / storageSystems.length;

        let storageCosts = storageSystems.map(storage => {
            let maxGB = storage.MaxGB(bytesPerSecond, secondsPerChunk, costPerStorage);
            let costPerChunkDownload = storage.CostPerGBDownload(chunkSizeBytes);

            return {
                maxGB,
                costPerChunkDownload,
                storage,
            };
        });

        sort(storageCosts, x => x.costPerChunkDownload);
        let liveStorageObj = storageCosts[0];
        let liveStorage = liveStorageObj.storage;
        if(!("AddSingleNAL" in liveStorage)) {
            throw new Error(`The storage with the cheapest access cost doesn't support live data. The local system should have 0 access cost, and should support live data. And anything that has free accesses should support live data.`);
        }

        let lastMaxStorage: typeof storageCosts[0] | undefined;
        let writeStorageSystems: RemoteStorage[] = [];
        for(let i = 0; i < storageCosts.length; i++) {
            let obj = storageCosts[i];
            let notUsed = lastMaxStorage && obj.maxGB < lastMaxStorage.maxGB;

            console.log(`Candidate storage ${obj.storage.DebugName()}, rate ${rate}, maxGB ${(obj.maxGB).toFixed(3)}, rough maxCost ${costPerStorage} ${notUsed ? (`not used`) : ""}`);
            if(notUsed) {
                continue;
            }
            if(!obj.storage.IsFixedStorageSize()) {
                lastMaxStorage = obj;
            }
            writeStorageSystems.push(obj.storage);
        }

        costPerStorage = costAvailable / writeStorageSystems.length;
        let writeStorageSystemObjs = writeStorageSystems.map(storage => ({
            storage,
            maxBytes: storage.MaxGB(bytesPerSecond, secondsPerChunk, costPerStorage) * 1024 * 1024 * 1024,
            chunkThresholdBytes: chunkSizeBytes
        }));

        writeStorageSystemObjs = writeStorageSystemObjs.filter(storage => {
            if(!storage.storage.IsFixedStorageSize() && storage.maxBytes < storage.chunkThresholdBytes * minChunks) {
                console.warn(`Storage stores less than ${minChunks} chunks, so we won't use it. ${storage.storage.DebugName()}`);
                return false;
            }
            return true;
        });

        let storageHolder = new StorageCombined(
            rate,
            liveStorage,
            storageSystems,
            writeStorageSystemObjs
        );

        await storageHolder.Init();

        return storageHolder;
    }
}


// We should take multiple StorageSystem constructors so we can create various tiers of storage.
//  But also a disk based rolling storage? Maybe we can retrofit LocalNALStorage to do that?
// We need to fill up a LocalNALStorage until it reaches the chunk size, then we need to make a new one,
//  copy the old storage to a StorageSystem, and delete the local files.
class StorageCombined implements NALStorage {
    constructor(
        private rate: number,
        // Should also be in writeStorageSystemObjs, we just pass it twice to help with typings
        private liveSystem: RemoteStorageLocal,
        private readStorageSystems: RemoteStorage[],
        private writeStorageSystemObjs: {
            storage: RemoteStorage;
            maxBytes: number;
            chunkThresholdBytes: number;
        }[],
    ) { }


    public async Init(): Promise<void> {
        let { readStorageSystems, writeStorageSystemObjs } = this;
        let promises: (Promise<void>)[] = [];
        for(let i = 0; i < writeStorageSystemObjs.length; i++) {
            let obj = writeStorageSystemObjs[i];
            let next = UnionUndefined(writeStorageSystemObjs[i + 1]);
            promises.push(obj.storage.Init(next && next.storage, (x) => this.onChunkDeleted(x), obj.chunkThresholdBytes, obj.maxBytes));
        }
        for(let i = 0; i < readStorageSystems.length; i++) {
            // Don't double init if it has already been write inited.
            if(writeStorageSystemObjs.map(x => x.storage).indexOf(readStorageSystems[i]) >= 0) continue;
            promises.push(readStorageSystems[i].Init(undefined, (x) => this.onChunkDeleted(x), 0, 0));
        }
        await Promise.all(promises);

        let minGapSize = GetMinGapSize(this.rate);

        for(let storage of readStorageSystems) {
            let metadataLookup = await storage.GetChunkMetadatas();
            for(let metadata of Object.values(metadataLookup)) {
                reduceRanges(metadata.Ranges, this.ranges, true, minGapSize);
            }
        }
    }

    public IsWriteable(): boolean {
        return this.writeStorageSystemObjs.length > 0;
    }

    private ranges: NALRange[] = [];

    private lastTime?: number;
    private changedRangesListener = new PChannelMultiListen<NALRange[]>();
    private deleteRangesListener = new PChannelMultiListen<number>();

    private addNALTime(time: number): void {
        // TODO: Warn on overlaps between times.

        let minGapSize = GetMinGapSize(this.rate);
        let { lastTime } = this;
        let diff = lastTime ? time - lastTime : 0;
        if(!lastTime || diff >= GetMinGapSize(this.rate) || diff <= 0) {
            lastTime = time;
        }
        let newRange = { firstTime: lastTime, lastTime: time, frameCount: 1 };
        let changedRanges = reduceRanges([newRange], this.ranges, true, minGapSize);
        this.changedRangesListener.SendValue(changedRanges);
        this.lastTime = time;
    }
    public GetRanges(): NALRange[] {
        return this.ranges;
    }
    public GetNextAddSeqNum(): number {
        // Go through all systems, in case we just loaded data, and the live storage system has changed since them
        let addSeqNum = max(this.readStorageSystems.map(x => {
            let metadatas = x.GetChunkMetadatas();
            if(metadatas.length === 0) {
                return 0;
            }
            return metadatas.last().LastAddSeqNum;
        }));

        console.log({addSeqNum});

        return addSeqNum;
    }

    public SubscribeToRanges(
        rangesChanged: (changedRanges: NALRange[]) => void,
        rangesDeleted: (deleteTime: number) => void
    ): () => void {
        let unsub = this.changedRangesListener.Subscribe(rangesChanged);
        let unsub2 = this.deleteRangesListener.Subscribe(rangesDeleted);
        return () => {
            unsub();
            unsub2();
        };
    }
    private onChunkDeleted(deleteTime: number) {
        deleteRanges(this.ranges, deleteTime);
        this.deleteRangesListener.SendValue(deleteTime);
    }

    public AddNAL(val: NALHolderMin): void {
        this.addNALTime(val.time);
        this.liveSystem.AddSingleNAL(val);
    }
    
    public async GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number | "live" | undefined,
        onlyTimes: boolean | undefined,
        forPreview: boolean | undefined,
        cancelToken: {
            Promise(): Promise<void>;
            Value(): {
                v: void;
            } | {
                error: any;
            } | undefined;
        }
    ): Promise<MP4Video | "CANCELLED"> {
        let cancelId = randomUID("GetVideo_canceltoken");

        const getFirstTimeOfNextChunk = (chunkFirstTime: number): number|undefined => {
            for(let i = 0; i < this.writeStorageSystemObjs.length; i++) {
                let { storage } = this.writeStorageSystemObjs[i];
                let metadatas = storage.GetChunkMetadatas();

                let index = findAtIndex(metadatas, chunkFirstTime, x => x.Ranges[0].firstTime);
                let metadata = UnionUndefined(metadatas[index]);
                if(metadata && !metadata.IsMoved) {
                    let nextMetadata = UnionUndefined(metadatas[index + 1]);
                    if(nextMetadata && !nextMetadata.IsMoved) {
                        return nextMetadata.Ranges[0].firstTime;
                    }

                    while(i > 0) {
                        i--;
                        let obj = this.writeStorageSystemObjs[i];
                        let metadatas = obj.storage.GetChunkMetadatas();
                        for(let i = 0; i < metadatas.length; i++) {
                            let metadata = metadatas[i];
                            if(!metadata.IsMoved) {
                                return metadata.Ranges[0].firstTime;
                            }
                        }
                    }
                    return undefined;
                }
            }
            return undefined;
        };

        const getChunk = (chunkFirstTime: number): { storage: RemoteStorage; chunk: ChunkMetadata }|undefined => {
            for(let i = 0; i < this.writeStorageSystemObjs.length; i++) {
                let obj = this.writeStorageSystemObjs[i];
                let { storage } = obj;
                let metadatas = storage.GetChunkMetadatas();

                let metadata = findAt(metadatas, chunkFirstTime, x => x.Ranges[0].firstTime);
                if(metadata && !metadata.IsMoved) {
                    return {
                        storage,
                        chunk: metadata
                    };
                }
            }
            return undefined;
        };

        const prepareRead = async (): Promise<{ times: NALInfoTime[]; nextKeyFrameTime: number|undefined; chunkFirstTime?: number; } | "CANCELLED"> => {

            const fnc = async (): Promise<{ times: NALInfoTime[]; nextKeyFrameTime: number|undefined; chunkFirstTime?: number; } | undefined> => {

                let oldestTime = this.writeStorageSystemObjs.last().storage.GetChunkMetadatas()[0].Ranges[0].firstTime;
                if(startTime < oldestTime) {
                    console.log(`startTime less than oldestTime, so it is being changed to oldestTime.`);
                    startTime = oldestTime;
                }

                // We check from small sources to larger sources, as small sources contain more recent data.
                //  So, data maybe be something like [7, 8], [4, 7], [0, 4]
                //  Which means if we are looking for data from 5 to 8 then we want the first range with data before or at 5,
                //  which is, [4, 7], which is the range we want to start at.
                for(let i = 0; i < this.writeStorageSystemObjs.length; i++) {
                    let obj = this.writeStorageSystemObjs[i];
                    let { storage } = obj;
                    let metadatas = storage.GetChunkMetadatas();

                    let chunkIndex = findAtOrBeforeIndex(metadatas, startTime, x => x.Ranges[0].firstTime);
                    let baseChunkIndex = chunkIndex;
                    while(metadatas[chunkIndex] && metadatas[chunkIndex].IsMoved) {
                        chunkIndex++;
                    }
                    let chunk = UnionUndefined(metadatas[chunkIndex]);

                    console.log(`Storage ${storage.DebugName()}, chunkIndex: ${chunkIndex}, valid ${!!chunk}, baseChunkIndex: ${baseChunkIndex}`);

                    if(!chunk) {
                        continue;
                    }

                    let chunkUID = chunk.ChunkUID;

                    cancelToken.Promise().then(() => {
                        storage.CancelCall(cancelId, chunkUID);
                    });
                    console.log(`Reading ${chunk.ChunkUID} from ${obj.storage.DebugName()}`);

                    let indexObj = await Promise.race([storage.GetIndex(cancelId, chunkUID), cancelToken.Promise()]);
                    if(!indexObj) {
                        return;
                    }
                    let { livePromise, videoTimes } = callGetVideoTimes(indexObj.index);
                    let { nextKeyFrameTime } = videoTimes;

                    if(!nextKeyFrameTime) {
                        if(livePromise) {
                            // No next chunk to choose from
                            if(nextReceivedFrameTime === "live") {
                                if(forPreview) {
                                    // Fine, just read it
                                } else {
                                    // Wait on live promise, then return and rerun the function
                                    await Promise.race([livePromise, cancelToken.Promise()]);
                                    return;
                                }
                            } else {
                                return { times: [], nextKeyFrameTime: undefined };
                            }
                        } else {
                            // Get the time from the next chunk
                            nextReceivedFrameTime = getFirstTimeOfNextChunk(chunk.Ranges[0].firstTime);
                        }
                    }

                    return {
                        times: videoTimes.times,
                        nextKeyFrameTime,
                        chunkFirstTime: chunk.Ranges[0].firstTime
                    };
                };
            };

            let curLiveWait = 0;
            while(true) {
                let value = await fnc();
                if(cancelToken.Value()) {
                    return "CANCELLED";
                }
                if(value) {
                    return value;
                }
                curLiveWait++;
                let maxWaitCount = Math.max(minFrames * 2, 100);
                if(curLiveWait > maxWaitCount) {
                    throw new Error(`Took too long to get values, waited ${maxWaitCount} times.`)
                }
            }

            throw new Error(`Cannot find any storage systems that matches. This should not be possible.`);
        }

        let readObj = await prepareRead();
        if(readObj === "CANCELLED") {
            return "CANCELLED";
        }
        let { times, nextKeyFrameTime, chunkFirstTime } = readObj;

        if(times.length === 0 || onlyTimes) {
            return {
                frameTimes: times,
                height: 0,
                width: 0,
                mp4Video: Buffer.from([]),
                nextKeyFrameTime: nextKeyFrameTime,
                rate: this.rate
            };
        }

        if(!chunkFirstTime) {
            throw new Error(`Impossible, no chunk, but we have times? Times ${times.map(x => x.time).join(", ")}`);
        }

        let chunkData = getChunk(chunkFirstTime);
        if(!chunkData) {
            throw new Error(`Cannot find chunk. ${chunkFirstTime}`);
        }

        let chunkDataChecked = chunkData;
        cancelToken.Promise().then(x => {
            chunkDataChecked.storage.CancelCall(cancelId, chunkDataChecked.chunk.ChunkUID);
        });

        let nals = await Promise.race([chunkData.storage.ReadNALs(cancelId, chunkData.chunk.ChunkUID, times), cancelToken.Promise()]);

        if(!nals || nals === "CANCELLED") {
            return "CANCELLED";
        }
        let video = await Promise.race([await muxVideo(nals, this.rate, 1, nextKeyFrameTime), cancelToken.Promise()]);
        if(!video) {
            return "CANCELLED";
        }
        return video;
        

        function callGetVideoTimes(index: (NALInfoTime | { Promise(): Promise<void> })[]) {
            let livePromise: Promise<void>|undefined;
            // Index should always have entries, unless it is finished and empty. But how could it finish if it is empty!?
            let nextPromise = index.last();
            if("Promise" in nextPromise) {
                livePromise = nextPromise.Promise();
                index.pop();
            }
            try {
                let indexTyped = index as NALInfoTime[];
                let videoTimes = GetVideoTimes(
                    startTime,
                    minFrames,
                    nextReceivedFrameTime === "live" ? undefined : nextReceivedFrameTime,
                    indexTyped
                );

                return {
                    videoTimes,
                    livePromise
                };
            } finally {
                if(livePromise) {
                    index.push(nextPromise);
                }
            }
        }
    }
}