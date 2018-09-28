import { CreateTempFolderPath } from "temp-folder";
import { unlinkFilePromise } from "../util/fs";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData, SetTimeoutAsync } from "pchannel";
import { LocalRemoteStorage, SmallDiskList } from "./LocalNALRate";
import { LocalStorage } from "node-localstorage";
import { DiskStorageBase } from "./RemoteStorage/DiskStorageBase";
import { DiskStorageCancellable, CancellableCallObject } from "./RemoteStorage/DiskStorageCancellable";
import { runCodeWithFolder, runAllStorageSystemCrashes } from "./RemoteStorage/testHelpers";
import { range, flatten } from "../util/misc";

enum NALType {
    //NALType_sps = 0,
    //NALType_pps = 1,
    NALType_keyframe = 2,
    NALType_interframe = 3,
}

let nextAddSeqNum = 0;
function createFakeNAL(rate: number, time: number, type: NALType): NALHolderMin {
    return {
        rate,
        time,
        type: type as any,
        width: 1000,
        height: 500,
        addSeqNum: nextAddSeqNum++,

        nal: Buffer.from([]),
        sps: Buffer.from([]),
        pps: Buffer.from([]),
    };
}

describe("DiskStorageBase", () => {
    it("writes and reads", async () => {
        await runCodeWithFolder(async folder => {
            let rate = 1;
            let storage = new LocalRemoteStorage(new DiskStorageBase(), rate, 10, 1024 * 1024 * 10, folder);
            await storage.Init(undefined, () => {}, 1024, 1024 * 1024 * 10);
            storage.AddSingleNAL(createFakeNAL(rate, 0, NALType.NALType_keyframe));
            storage.AddSingleNAL(createFakeNAL(rate, 1, NALType.NALType_interframe));

            let metadata = storage.GetChunkMetadatas()[0];

            let { index } = await storage.GetIndex("cancel", metadata.ChunkUID);

            ThrowIfNotImplementsData(index[0], { type: NALType.NALType_keyframe });
            ThrowIfNotImplementsData(index[1], { type: NALType.NALType_interframe });
            ThrowIfNotImplementsData("Promise" in index[2], true);
        });
    });

    it("runAllStorageSystemCrashes actuals runs all possibilities", async () => {
        let crashCount = 0;
        let runCount = 0;
        await runAllStorageSystemCrashes(async (folder, storage) => {
            runCount++;
            await storage.SetFileContents(folder + "test.txt", "data");
            try {
                let contents = await storage.GetFileContents(folder + "test.txt");
                ThrowIfNotImplementsData(contents.toString(), "data");
            } catch(e) {
                crashCount++;
            }
        });
        // We should run 3 times. Cancel SetFileContents - Run SetFileContents, Cancel GetFileContents - Run SetFileContents, Run GetFileContents
        ThrowIfNotImplementsData(runCount, 3);

        // We should crash when the SetFileContents is cancelled, or the GetFileContents is cancelled, two cases.
        ThrowIfNotImplementsData(crashCount, 2);
    });

    it("keeps local index in sync with actual data", async () => {
        await runAllStorageSystemCrashes(async (folder, cancelStorage) => {

            // Create a populated nal system with a working storage system.
            // Do a basic set of operations, using storageBase. Try/catch this, so it can run and crash/cancel.
            // Then, we read back from that folder using the working storage system (that doesn't crash), and make sure
            //  it is consistent.

            let rate = 1;
            async function GetStorage(base: StorageBase) {
                let storage = new LocalRemoteStorage(base, rate, 10, 1024 * 1024 * 10, folder);
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

            try {
                await runSimpleOperations(await GetStorage(cancelStorage));
            } catch(e) {
                console.log(e);
            }

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
});