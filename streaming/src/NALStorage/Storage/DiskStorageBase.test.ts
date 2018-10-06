import { CreateTempFolderPath } from "temp-folder";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData } from "pchannel";
import { DiskStorageBase } from "./DiskStorageBase";
import { runCodeWithFolder } from "./testHelpers";

describe("DiskStorageBase", () => {
    it("writes and reads", async () => {
        await runCodeWithFolder(async folder => {
            let storage = new DiskStorageBase();
            let file = folder + "test";
            await storage.AppendData(file, "data");
            await storage.AppendData(file, "data2");

            let buf = await storage.GetFileContents(file); 
            let str = buf.toString();

            ThrowIfNotImplementsData(str, "datadata2");
        });
    });
});