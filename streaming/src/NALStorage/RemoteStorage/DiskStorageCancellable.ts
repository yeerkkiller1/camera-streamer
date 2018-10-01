import { DiskStorageBase } from "./DiskStorageBase";
import { Deferred, PChan } from "pchannel";
import { randomUID } from "../../util/rand";

export interface CancellableCallObject {
    name: string;
    deferred: Deferred<"call"|"cancel">;
    onFinish: Deferred<void>;
}

export class DiskStorageCancellable implements StorageBaseAppendable {
    constructor() { }

    baseStorage = new DiskStorageBase();

    callObjects: CancellableCallObject[] = [];

    public HasCalls() {
        return this.callObjects.length > 0;
    }
    public GetNextCall() {
        let call = this.callObjects.pop();
        if(!call) {
            throw new Error(`GetNextCall called with no calls`);
        }
        return call;
    }

    private async doFunctionCall<T>(fncName: string, code: () => T): Promise<T | "cancelled"> {
        let deferred = new Deferred<"call"|"cancel">();
        let onFinish = new Deferred<void>();
        this.callObjects.push({ name: fncName, deferred, onFinish });
        let action = await deferred.Promise();
        if(action === "cancel") {
            onFinish.Resolve();
            return "cancelled";
        }
        let result;
        try {
            result = await code();
            onFinish.Resolve();
        } catch(e) {
            onFinish.Resolve();
            throw e;
        }
        return result;
    }

    public async GetDirectoryListing(path: string): Promise<string[]> {
        let result = await this.doFunctionCall("GetDirectoryListing", () => this.baseStorage.GetDirectoryListing(path));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async GetFileSize(filePath: string): Promise<number> {
        let result = await this.doFunctionCall("GetFileSize", () => this.baseStorage.GetFileSize(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async GetFileContents(filePath: string): Promise<Buffer> {
        let result = await this.doFunctionCall("GetFileContents", () => this.baseStorage.GetFileContents(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async AppendData(filePath: string, data: string | Buffer): Promise<void> {
        await this.doFunctionCall("AppendData", () => this.baseStorage.AppendData(filePath, data));
    }
    public async SetFileContents(filePath: string, data: string | Buffer): Promise<void> {
        await this.doFunctionCall("SetFileContents", () => this.baseStorage.SetFileContents(filePath, data));
    }
    public async DeleteFile(filePath: string): Promise<void> {
        await this.doFunctionCall("DeleteFile", () => this.baseStorage.DeleteFile(filePath));
    }
    public async Exists(filePath: string): Promise<boolean> {
        let result = await this.doFunctionCall("Exists", () => this.baseStorage.Exists(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async CreateDirectory(path: string): Promise<void> {
        await this.doFunctionCall("CreateDirectory", () => this.baseStorage.CreateDirectory(path));
    }
}