import { DiskStorageBase } from "./DiskStorageBase";
import { Deferred, PChan } from "pchannel";
import { randomUID } from "../../util/rand";
import { setNewPromiseStack } from "../../util/promise";
import { fixErrorStack } from "../../util/stack";

export interface CancellableCallObject {
    name: string;
    deferred: Deferred<"call"|"cancel">;
    onFinish: Deferred<void>;
    debugName: string;
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

    private doFunctionCall = fixErrorStack(1, async function (this: DiskStorageCancellable, call, fncName: string, code: () => any): Promise<any | "cancelled"> {
        let deferred = new Deferred<"call"|"cancel">();
        let onFinish = new Deferred<void>();
        this.callObjects.push({ name: fncName, deferred, onFinish, debugName: fncName });
        let action = await deferred.Promise();
        if(action === "cancel") {
            onFinish.Resolve();
            return "cancelled";
        }
        let result;
        try {
            // Preserve the original stack, so we can see where the calls are coming from.
            result = await call(1, code);
            onFinish.Resolve();
        } catch(e) {
            onFinish.Resolve();
            throw e;
        }
        return result;
    });

    /*
    private async doFunctionCall<T>(fncName: string, code: () => T): Promise<T | "cancelled"> {
        let deferred = new Deferred<"call"|"cancel">();
        let onFinish = new Deferred<void>();
        this.callObjects.push({ name: fncName, deferred, onFinish, debugName: fncName });
        let action = await deferred.Promise();
        if(action === "cancel") {
            onFinish.Resolve();
            return "cancelled";
        }
        let result;
        try {
            // Preserve the original stack, so we can see where the calls are coming from.
            result = await code();
            onFinish.Resolve();
        } catch(e) {
            onFinish.Resolve();
            throw e;
        }
        return result;
    }
    */

    public async GetDirectoryListing(path: string): Promise<string[]> {
        let result = await this.doFunctionCall(`GetDirectoryListing${path}`, () => this.baseStorage.GetDirectoryListing(path));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async GetFileSize(filePath: string): Promise<number> {
        let result = await this.doFunctionCall(`GetFileSize${filePath}`, () => this.baseStorage.GetFileSize(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async GetFileContents(filePath: string): Promise<Buffer> {
        let result = await this.doFunctionCall(`GetFileContents${filePath}`, () => this.baseStorage.GetFileContents(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async AppendData(filePath: string, data: string | Buffer): Promise<void> {
        await this.doFunctionCall(`AppendData${filePath}`, () => this.baseStorage.AppendData(filePath, data));
    }
    public async SetFileContents(filePath: string, data: string | Buffer): Promise<void> {
        await this.doFunctionCall(`SetFileContents${filePath}`, () => this.baseStorage.SetFileContents(filePath, data));
    }
    public async DeleteFile(filePath: string): Promise<void> {
        await this.doFunctionCall(`DeleteFile${filePath}`, () => this.baseStorage.DeleteFile(filePath));
    }
    public async Exists(filePath: string): Promise<boolean> {
        let result = await this.doFunctionCall(`Exists${filePath}`, () => this.baseStorage.Exists(filePath));
        if(result === "cancelled") throw new Error("cancelled");
        return result;
    }
    public async CreateDirectory(path: string): Promise<void> {
        await this.doFunctionCall(`CreateDirectory${path}`, () => this.baseStorage.CreateDirectory(path));
    }
}