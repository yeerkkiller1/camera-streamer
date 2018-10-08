import { CreateTempFolderPath } from "temp-folder";
import { unlinkFilePromise, writeFilePromise } from "../util/fs";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData, SetTimeoutAsync } from "pchannel";
import { LocalRemoteStorage } from "./LocalRemoteStorage";
import { LocalStorage } from "node-localstorage";
import { DiskStorageBase } from "./Storage/DiskStorageBase";
import { DiskStorageCancellable, CancellableCallObject } from "./Storage/DiskStorageCancellable";
import { runCodeWithFolder, runAllStorageSystemCrashes } from "./Storage/testHelpers";
import { range, flatten, randomUID } from "../util/misc";
import { StorageSizeInstrumentAppendable, StorageSizeInstrument } from "./Storage/StorageSizeInstrument";
import { NALType } from "../srcEnums";





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
    it("writes and reads", async () => {
        await runCodeWithFolder(async folder => {
            let rate = 1;
            let storage = new LocalRemoteStorage(new DiskStorageBase(), new DiskStorageBase(), rate, 10, 1024 * 1024 * 10, folder);
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
        await runAllStorageSystemCrashes(async (folder, innerCancelCode) => {
            await innerCancelCode(
                async storage => {
                    runCount++;
                    await storage.SetFileContents(folder + "test.txt", "data");
                    try {
                        let contents = await storage.GetFileContents(folder + "test.txt");
                        ThrowIfNotImplementsData(contents.toString(), "data");
                    } catch(e) {
                        crashCount++;
                    }
                }
            );
        });
        // We should run 3 times. Cancel SetFileContents - Run SetFileContents, Cancel GetFileContents - Run SetFileContents, Run GetFileContents
        ThrowIfNotImplementsData(runCount, 3);

        // We should crash when the SetFileContents is cancelled, or the GetFileContents is cancelled, two cases.
        ThrowIfNotImplementsData(crashCount, 2);
    });


    it("doesn't store all the data locally", async () => {
        await runCodeWithFolder(async folder => {
            let rate = 1;

            let localStorage = new StorageSizeInstrumentAppendable(new DiskStorageBase());
            let remoteStorage = new StorageSizeInstrument(new DiskStorageBase());

            // Write
            {
                let storage = new LocalRemoteStorage(localStorage, remoteStorage, rate, 10, 1024 * 1024 * 100, folder);/*?.*/
                await storage.Init(undefined, () => {}, 1, 1024 * 1024 * 100);/*?.*/

                storage.AddSingleNAL(createFakeNAL(rate, 0, NALType.NALType_keyframe, Buffer.alloc(1024 * 1024 * 10)));/*?.*/
                storage.AddSingleNAL(createFakeNAL(rate, 1, NALType.NALType_keyframe, Buffer.alloc(1024 * 1024 * 10)));/*?.*/
                storage.AddSingleNAL(createFakeNAL(rate, 2, NALType.NALType_keyframe, Buffer.alloc(1024 * 1024 * 10)));/*?.*/

                await storage.Block();/*?.*/
            }

            // Read
            {
                let storage = new LocalRemoteStorage(localStorage, remoteStorage, rate, 10, 1024 * 1024 * 100, folder);/*?.*/
                await storage.Init(undefined, () => {}, 1024, 1024 * 1024 * 100);/*?.*/

                let nals: NALHolderMin[] = [];

                let chunks = storage.GetChunkMetadatas();
                
                if(chunks.length <= 0) {
                    throw new Error(`There should be at least one chunk`);
                }
                for(let chunk of chunks) {
                    let { index } = await storage.GetIndex(randomUID("cancel"), chunk.ChunkUID);
                
                    for(let indexValue of index) {
                        if("Promise" in indexValue) continue;
                        let nalsRead = await storage.ReadNALs(randomUID("cancel"), chunk.ChunkUID, [indexValue]);
                        if(nalsRead === "CANCELLED") {
                            throw new Error(`Read cancelled?`);
                        }
                        ThrowIfNotImplementsData(nalsRead.length, 1);
                        nals.push(nalsRead[0]);
                    }
                }

                ThrowIfNotImplementsData(nals.length, 3);

                await storage.Block();/*?.*/
            }

            if(localStorage.TotalSizeStored >= 1024 * 1024 * 20) {
                throw new Error(`Too much data is stored locally. Data should be stored remotely when possible. Local stored: ${localStorage.TotalSizeStored}, remote stored: ${remoteStorage.TotalSizeStored}`);
            }
        });
    });
});