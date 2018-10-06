import { DiskStorageBase } from "./DiskStorageBase";
import { StorageSizeInstrumentAppendable } from "./StorageSizeInstrument";
import { runCodeWithFolder } from "./testHelpers";
import { ThrowIfNotImplementsData } from "pchannel";

describe("DiskStorageBase", () => {
    it("writes and reads", async () => {
        await runCodeWithFolder(async folder => {
            let storageBase = new DiskStorageBase();
            let storage = new StorageSizeInstrumentAppendable(storageBase);

            let kFile = Buffer.alloc(1024);
            let mFile = Buffer.alloc(1024 * 1024);

            await storage.AppendData(folder + "file1", kFile);
            ThrowIfNotImplementsData(storage.BytesWrite, 1024);

            await storage.AppendData(folder + "file1", mFile);
            ThrowIfNotImplementsData(storage.BytesWrite, 1024 + 1024 * 1024);

            await storage.GetFileContents(folder + "file1");
            ThrowIfNotImplementsData(storage.BytesRead, 1024 + 1024 * 1024);

            await storage.GetDirectoryListing(folder);
            if(storage.BytesRead <= 1024 + 1024 * 1024) {
                throw new Error(`GetDirectoryListing should count as reading something, or else directories could have million of files and their reading would be considred free`);
            }
        });
    });
});