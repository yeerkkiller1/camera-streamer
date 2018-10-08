import { runAllStorageSystemCrashes, runCodeWithFolder } from "./Storage/testHelpers";
import { LocalRemoteStorage } from "./LocalRemoteStorage";
import { ThrowIfNotImplementsData } from "pchannel";
import { DiskStorageBase } from "./Storage/DiskStorageBase";
import { StorageSizeInstrumentAppendable, StorageSizeInstrument } from "./Storage/StorageSizeInstrument";
import { randomUID } from "../util/misc";

enum NALType {
    //NALType_sps = 0,
    //NALType_pps = 1,
    NALType_keyframe = 2,
    NALType_interframe = 3,
}

let nextAddSeqNum = 0;
function createFakeNAL(rate: number, time: number, type: NALType, nalData = Buffer.from([])): NALHolderMin {
    return {
        rate,
        time,
        type: type as any,
        width: 1000,
        height: 500,
        addSeqNum: nextAddSeqNum++,

        nal: nalData,
        sps: Buffer.from([]),
        pps: Buffer.from([]),
    };
}

xdescribe("DiskStorageBase", () => {
    it("keeps local index in sync with actual data", async () => {
        await runAllStorageSystemCrashes(async (folder, innerCancelCode) => {

            // Create a populated nal system with a working storage system.
            // Do a basic set of operations, using storageBase. Try/catch this, so it can run and crash/cancel.
            // Then, we read back from that folder using the working storage system (that doesn't crash), and make sure
            //  it is consistent.

            let rate = 1;
            async function GetStorage(base: StorageBaseAppendable) {
                let storage = new LocalRemoteStorage(base, base, rate, 10, 1024 * 1024 * 10, folder);
                await storage.Init(undefined, () => {}, 1024, 1024 * 1024 * 10);
                return storage;
            }

            async function runSimpleOperations(storage: RemoteStorageLocal) {
                let metadatas = storage.GetChunkMetadatas();
                let nextTime = 0;
                if(metadatas.length > 0) {
                    nextTime = metadatas[0].Ranges.last().lastTime + 1;
                }
                
                let time1 = ++nextTime;
                let time2 = ++nextTime;
                
                storage.AddSingleNAL(createFakeNAL(rate, time1, NALType.NALType_keyframe));
                storage.AddSingleNAL(createFakeNAL(rate, time2, NALType.NALType_interframe));
                
                let chunkUID = metadatas[0].ChunkUID;
                let { index } = await storage.GetIndex("cancel", chunkUID);
                index = index.filter(x => !("Promise" in x) && (x.time === time1 || x.time === time2));
                let nals = await storage.ReadNALs("cancel", metadatas[0].ChunkUID, index);
                if(nals === "CANCELLED") {
                    throw new Error(`Should not have been cancelled`);
                }
                ThrowIfNotImplementsData(index, [{ time: time1, type: NALType.NALType_keyframe }, { time: time2, type: NALType.NALType_interframe }]);
            }

            {
                let workingStorage = await GetStorage(new DiskStorageBase());
                await runSimpleOperations(workingStorage);
                await runSimpleOperations(workingStorage);
            }

            await innerCancelCode(
                async cancelStorage => {
                    try {
                        let storage = await GetStorage(cancelStorage);
                        await runSimpleOperations(storage);
                    } catch(e) {
                        console.log(e);
                    }
                }
            );

            // Now verify the data. Read all the nals, and make sure the chunk metadatas line up, and then make sure the indexes line up.
            // And also throw if there is no data. We definitely wrote some data with workingStorage, even if cancelStorage crashed immediately.

            let workingStorage = await GetStorage(new DiskStorageBase());

            await verifyData();
            await runSimpleOperations(workingStorage);
            await verifyData();

            async function verifyData() {
                let chunks = workingStorage.GetChunkMetadatas();
                if(chunks.length === 0) {
                    throw new Error(`No chunks exist, we definitely wrote data, so write cancellations must have corrupted the underlying data.`);
                }

                let nalCount = 0;
                for(let chunk of chunks) {
                    let { index } = await workingStorage.GetIndex("cancel", chunk.ChunkUID);

                    let nals = await workingStorage.ReadNALs("cancel", chunk.ChunkUID, index);
                    if(nals === "CANCELLED") {
                        throw new Error(`Read cancelled`);
                    }

                    let indexLength = index.length;
                    if(indexLength > 0 && "Promise" in index.last()) {
                        indexLength--;
                    }

                    ThrowIfNotImplementsData(indexLength, nals.length);
                    nalCount += nals.length;
                }

                if(nalCount === 0) {
                    throw new Error(`No NALs exist, we definitely wrote data, so write cancellations must have corrupted the underlying data.`);
                }
            }



            /*
            workingStorage.AddSingleNAL(createFakeNAL(rate, NALType.NALType_keyframe));
            workingStorage.AddSingleNAL(createFakeNAL(rate, NALType.NALType_interframe));
            workingStorage.


            let storage = await GetStorage(storageBase);
            storage.AddSingleNAL(createFakeNAL(rate, NALType.NALType_keyframe));
            storage.AddSingleNAL(createFakeNAL(rate, NALType.NALType_interframe));

            let metadata = storage.GetChunkMetadatas()[0];

            let { index } = await storage.GetIndex("cancel", metadata.ChunkUID);

            ThrowIfNotImplementsData(index[0], { type: NALType.NALType_keyframe });
            ThrowIfNotImplementsData(index[1], { type: NALType.NALType_interframe });
            ThrowIfNotImplementsData("Promise" in index[2], true);
            */
        });
    });

    it("doesn't store entire indexes locally", async () => {
        await runCodeWithFolder(async folder => {
            let rate = 1;

            let count = 500;

            // Write
            {
                let localStorage = new StorageSizeInstrumentAppendable(new DiskStorageBase());
                let remoteStorage = new StorageSizeInstrument(new DiskStorageBase());

                let storage = new LocalRemoteStorage(localStorage, remoteStorage, rate, 10, 1024 * 1024 * 10, folder);/*?.*/
                await storage.Init(undefined, () => {}, 1, 1024 * 1024 * 10);/*?.*/

                for(let i = 0; i < count; i++) {
                    storage.AddSingleNAL(createFakeNAL(rate, i, NALType.NALType_keyframe));/*?.*/
                }
                await storage.Block();/*?.*/
            }

            let localStorage = new StorageSizeInstrumentAppendable(new DiskStorageBase());
            let remoteStorage = new StorageSizeInstrument(new DiskStorageBase());
            // Read
            {
                let storage = new LocalRemoteStorage(localStorage, remoteStorage, rate, 10, 1024 * 1024 * 10, folder);/*?.*/
                await storage.Init(undefined, () => {}, 1024, 1024 * 1024 * 10);/*?.*/

                storage.AddSingleNAL(createFakeNAL(rate, count, NALType.NALType_keyframe)); /*?.*/

                storage.GetChunkMetadatas();

                await storage.Block();/*?.*/
            }/*?.*/
            
            if(localStorage.BytesRead > 1024 * 10) {
                // Writing is so slow that count has to be low. 10KB isn't really too much, but to really test this count would have to be around 1 million, and then
                //  we could make the max read limit more like 10MB. But that test would take an hour to run. If this becomes a problem and we the alorithmn
                //  for calculating the threshold of local storage size, then removing this error would probably be fine...
                throw new Error(`Getting the NAL overview and adding a single nal shouldn't require reading more than 10KB. We are only reading indexes, and the NALs in this test are 0 bytes long. This failure likely means we are storing the index locally inefficently.`);
            }
        });
    });
});