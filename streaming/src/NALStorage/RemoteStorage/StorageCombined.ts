import { randomUID, UnionUndefined, profile } from "../../util/misc";
import { sort, findAtOrBefore, findAtOrBeforeIndex } from "../../util/algorithms";
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
        private localSystem: RemoteStorageLocal,
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
        return max(this.readStorageSystems.map(x => {
            let metadatas = x.GetChunkMetadatas();
            if(metadatas.length === 0) {
                return 0;
            }
            return metadatas.last().LastAddSeqNum;
        }));
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
        this.localSystem.AddSingleNAL(val);
    }

    public async GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number | "live" | undefined,
        startTimeExclusive: boolean,
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
    ): Promise<MP4Video | "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" | "CANCELLED"> {

        let cancelId = randomUID("GetVideo_canceltoken");

        // We check from small sources to larger sources, as small sources contain more recent data.
        //  So, data maybe be something like [0, 1], [2, 4], [4, 8]
        //  Which means if we are looking for data from 3 to 0 then we want the first range with data before or at 3,
        //  which is, [2, 4], which is the range we want to start at.        
        for(let obj of this.writeStorageSystemObjs) {
            let { storage } = obj;
            let metadatas = storage.GetChunkMetadatas();

            let chunkIndex = findAtOrBeforeIndex(metadatas, startTime, x => x.Ranges[0].firstTime);
            let chunk = UnionUndefined(metadatas[chunkIndex]);

            if(!chunk || chunk.IsMoved) {
                continue;
            }
            let chunkChecked = chunk;
            let chunkUID = chunk.ChunkUID;

            cancelToken.Promise().then(() => {
                storage.CancelReadNALs(cancelId, chunkUID);
            });

            let abortResult: "VIDEO_EXCEEDS_LIVE_VIDEO" | "VIDEO_EXCEEDS_NEXT_TIME" | undefined;
            let nextKeyFrameTime: number|undefined;

            let timeOnlyTimes: NALInfoTime[] | undefined;

            let nals = await Promise.race([storage.ReadNALs(cancelId, chunkUID,
                async index => {

                    let curLiveIterationCount = 0;
                    while(true) {
                        if(curLiveIterationCount++ > 1000) {
                            throw new Error(`Exceeded live iteration max of 1000, so aborting GetVideo loop.`);
                        }

                        let { videoTimes, livePromise } = callGetVideoTimes();

                        if((videoTimes === "VIDEO_EXCEEDS_NEXT_TIME" || videoTimes === "VIDEO_EXCEEDS_LIVE_VIDEO") && nextReceivedFrameTime === "live") {
                            if(livePromise) {
                                await livePromise;
                                continue;
                            } else {
                                throw new Error(`GetVideo failed because request exceeded live video... but requested chunk was not live. Either there is a bug in GetVideo, or the input parameters were invalid. videoTimes ${videoTimes}, startTime ${startTime}, startTimeExclusive: ${startTimeExclusive}, nextReceivedTime ${nextReceivedFrameTime}, chunk ${chunkChecked.Ranges[0].firstTime} to ${chunkChecked.Ranges.last().lastTime}`);
                            }
                        }

                        if(typeof videoTimes === "string") {
                            abortResult = videoTimes;
                            return [];
                        }
                        
                        nextKeyFrameTime = videoTimes.nextKeyFrameTime;
                        timeOnlyTimes = videoTimes.times;
                        if(onlyTimes) {
                            return [];
                        } else {
                            return videoTimes.times;
                        }
                    }

                    function callGetVideoTimes() {
                        let livePromise: Promise<void>|undefined;
                        // Index should always have entries, unless it is finished and empty. But how could it finish if it is empty!?
                        let nextPromise = index.last();
                        if("Promise" in nextPromise) {
                            livePromise = nextPromise.Promise();
                            index.pop();
                        }
                        try {
                            let indexTyped = index as NALInfoTime[];
                            let allowMissingEndKeyframe: boolean = livePromise === undefined ? true : false;
                            if(forPreview) {
                                allowMissingEndKeyframe = true;
                            }
                            let videoTimes = GetVideoTimes(
                                startTime,
                                minFrames,
                                nextReceivedFrameTime === "live" ? undefined : nextReceivedFrameTime,
                                startTimeExclusive,
                                // If the chunk is finished, we don't need an end keyframe, as every chunk implicitly has a keyframe
                                //  after the last NAL.
                                allowMissingEndKeyframe,
                                indexTyped
                            );

                            return {
                                videoTimes,
                                livePromise,
                            };
                        } finally {
                            if(livePromise) {
                                index.push(nextPromise);
                            }
                        }
                    }
                }
            ), cancelToken.Promise()]);

            if(nals == undefined || nals === "CANCELLED") {
                return "CANCELLED";
            }

            if(abortResult !== undefined) {
                return abortResult;
            }

            // Set nextKeyFrameTime to the next chunk start if it is undefined.
            if(nextKeyFrameTime === undefined && !forPreview) {
                // Get a new chunkIndex, as if any chunk is exported the indexes will change.
                //  If the chunk we are searching for was deleted we will get -1 (~0), so we will take the first chunk,
                //  which turns out to be correct, so we can just leave it.
                let chunkIndex = findAtOrBeforeIndex(metadatas, startTime, x => x.Ranges[0].firstTime);
                let nextChunk = UnionUndefined(metadatas[chunkIndex + 1]);
                if(nextChunk) {
                    nextKeyFrameTime = nextChunk.Ranges[0].firstTime;
                } else {
                    if(nextReceivedFrameTime === "live") {
                        // No matter how many chunks are deleted chunkIndex should always be at least -1, and never greater than all the chunks that are
                        //  left (we delete old chunks, not newer ones, so a deleted chunk will never be newer than existing chunks), so nextChunk
                        //  should always be valid, unless we read from the last chunk, in which case it should have been live, and blocked while
                        //  reading until nextKeyFrameTime could be populated... so this should really never happen.

                        // This can happen if the next chunk is deleted before we get the nextTime from it.
                        //todonext
                        // Fix this.

                        console.log(`Using chunk ${chunkUID}`);
                        console.log("nals", nals.map(x => x.time));
                        console.error(`Live data requested, but we found no next time, and we are the last chunk? So... this shouldn't be possible, the previous chunk should still be live until the next chunk is ready to be live. startTime ${startTime}, startTimeExclusive: ${startTimeExclusive}, nextReceivedTime ${nextReceivedFrameTime}, chunk ${chunkChecked.Ranges[0].firstTime} to ${chunkChecked.Ranges.last().lastTime}`);
                        process.exit();
                    }
                }
            }

            if(onlyTimes && timeOnlyTimes) {
                let firstTime = UnionUndefined(timeOnlyTimes[0]);
                let video: MP4Video = {
                    rate: this.rate,

                    width: firstTime ? firstTime.width : 0,
                    height: firstTime ? firstTime.height : 0,

                    nextKeyFrameTime,
                    mp4Video: Buffer.alloc(0),
                    frameTimes: timeOnlyTimes,
                };
                return video;
            }
            
            let video = await Promise.race([await muxVideo(nals, this.rate, 1, nextKeyFrameTime), cancelToken.Promise()]);
            if(!video) {
                return "CANCELLED";
            }
            return video;
        }

        return "VIDEO_EXCEEDS_LIVE_VIDEO";
    }
}