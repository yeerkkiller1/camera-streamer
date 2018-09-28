import { CreateTempFolderPath } from "temp-folder";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData, ThrowsAsync, Deferred, PChan } from "pchannel";
import { DiskStorageBase } from "./DiskStorageBase";
import { DiskStorageCancellable } from "./DiskStorageCancellable";
import { randomUID } from "../../util/rand";
import { mkdirFilePromise } from "../../util/fs";
import { runCodeWithFolder } from "./testHelpers";

describe("DiskStorageCancellable", () => {
    it("writes and reads", async () => {
        await runCodeWithFolder(async folder => {
            let storage = new DiskStorageCancellable();
            let done = false;
            (async () => {
                while(!done) {
                    (await storage.GetNextCall()).deferred.Resolve("call");
                }
            })();
            try {
                let file = folder + "test";

                await storage.AppendData(file, "data");
                await storage.AppendData(file, "data2");

                let buf = await storage.GetFileContents(file);
                let str = buf.toString();

                ThrowIfNotImplementsData(str, "datadata2");
            } finally {
                done = true;
            }
        });
    });
    it("allows write cancellation", async () => {
        await runCodeWithFolder(async folder => {
            let storage = new DiskStorageCancellable();
            let file = folder + "test";
            
            storage.AppendData(file, "data");
            while(storage.HasCalls()) {
                let { deferred, onFinish } = await storage.GetNextCall();
                deferred.Resolve("call");
                await onFinish.Promise();
            }
            storage.AppendData(file, "data2");
            while(storage.HasCalls()) {
                let { deferred, onFinish } = await storage.GetNextCall();
                deferred.Resolve("cancel");
                await onFinish.Promise();
            }

            let buf = await new DiskStorageBase().GetFileContents(file);
            let str = buf.toString();

            ThrowIfNotImplementsData(str, "data");
        });
    });

    it("throws instead of read after cancellation", async () => {
        await runCodeWithFolder(async folder => {
            let storage = new DiskStorageCancellable();
            let file = folder + "test";
            
            storage.AppendData(file, "data");
            while(storage.HasCalls()) {
                let { deferred, onFinish } = await storage.GetNextCall();
                deferred.Resolve("call");
                await onFinish.Promise();
            }
            storage.AppendData(file, "data2");
            while(storage.HasCalls()) {
                let { deferred, onFinish } = await storage.GetNextCall();
                deferred.Resolve("cancel");
                await onFinish.Promise();
            }

            let buf = storage.GetFileContents(file);
            while(storage.HasCalls()) {
                let { deferred, onFinish } = await storage.GetNextCall();
                deferred.Resolve("cancel");
                await onFinish.Promise();
            }
            await ThrowsAsync(async () => {
                let str = (await buf).toString();
            });
        });
    });
});