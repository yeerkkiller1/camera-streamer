import { runCodeWithFolder, runAllStorageSystemCrashes } from "./Storage/testHelpers";
import { DiskStorageBase } from "./Storage/DiskStorageBase";
import { SmallDiskList } from "./SmallDiskList";
import { ThrowIfNotImplementsData, ThrowsAsync, Throws, Deferred } from "pchannel";
import { range, flatten } from "../util/misc";
import { DiskStorageCancellable, CancellableCallObject } from "./Storage/DiskStorageCancellable";

class BrokenStorage implements StorageBaseAppendable {
    GetDirectoryListing(path: string): Promise<string[]> { throw new Error("Method not implemented."); }
    GetFileSize(path: string): Promise<number> { throw new Error("Method not implemented."); }
    GetFileContents(path: string): Promise<Buffer> { throw new Error("Method not implemented."); }
    SetFileContents(path: string, data: string | Buffer): Promise<void> { throw new Error("Method not implemented."); }
    DeleteFile(path: string): Promise<void> { throw new Error("Method not implemented."); }
    Exists(path: string): Promise<boolean> { throw new Error("Method not implemented."); }
    CreateDirectory(path: string): Promise<void> { throw new Error("Method not implemented."); }
    AppendData(path: string, data: string | Buffer): Promise<void> { throw new Error("Method not implemented."); }
}

async function hasCalls(storage: DiskStorageCancellable) {
    if(storage.HasCalls()) {
        return true;
    }
    for(let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
    return storage.HasCalls();
}

/** Resolves the calls, and any subsequently created calls. Requires the storage system to have no outstanding calls when this is called. */
async function resolveCalls(calls: CancellableCallObject[], storage: DiskStorageCancellable, result: "call"|"cancel"): Promise<void> {
    if(storage.HasCalls()) {
        throw new Error(`Storage system has pending calls. These must be gathered before you start resolving calls, or else too many calls will be randomly running`);
    }
    for(let call of calls) {
        call.deferred.Resolve(result);
        await call.onFinish.Promise();
    }

    while(await hasCalls(storage)) {
        let call = storage.GetNextCall();
        call.deferred.Resolve(result);
        await call.onFinish.Promise();
    }
}
/** Gets all pending calls, with some promise waiting to make sure we get all calls.*/
async function getCalls(storage: DiskStorageCancellable): Promise<CancellableCallObject[]> {
    let calls: CancellableCallObject[] = [];
    while(await hasCalls(storage)) {
        let call = storage.GetNextCall();
        calls.push(call);
    }
    return calls;
}

describe("SmallDiskList", () => {
    describe("throws", () => {
        it("throws when the underlying storage breaks, and rethrow on other calls", async () => {
            let list = new SmallDiskList(new BrokenStorage(), "", "");
            await ThrowsAsync(async () => {
                await list.Init();
                await list.AddNewValue(1);
            });
            await ThrowsAsync(async () => {
                await list.BlockUntilIndexSaved(0);
            });

            Throws(() => {
                list.GetValues();
            });
        });
        /*
        it("throws if there is a successful read after a failed read", async () => {
            await runCodeWithFolder(async folder => {
                let storage = new DiskStorageCancellable();

                let list = new SmallDiskList(storage, folder + "main", folder + "mutate");

                let l1 = list.Init();
                await resolveCalls(await getCalls(storage), storage, "call");
                await l1;



                // Hmm... if we get the promises that come out of a call, and then when we resolve those promises we use onFinish
                //  and a promise loop to get the promises that result from that... we can have 2 pending Add calls, and fail
                //  everything in the first, and then after that allow everything in the second. So we should do that...
                let a1 = list.AddNewValue(0);
                let a1Calls = await getCalls(storage);

                let a2 = list.AddNewValue(1);
                let a2Calls = await getCalls(storage);

                await resolveCalls(a2Calls, storage, "cancel");
                try { await a2; } catch(e) { }

                await resolveCalls(a1Calls, storage, "call");

                // This should throw, as the disk should not return values after exceptions happen, even if it obtained the results
                //  before the exception.
                await a1;
            });
        });
        */
    });

    

    it("works with simple data", async () => {
        await runCodeWithFolder(async (folder) => {
            async function getList() {
                let storage = new DiskStorageBase();
                let list = new SmallDiskList(
                    storage,
                    folder + "main",
                    folder + "mutate",
                );
                await list.Init();
                return list;
            }
            {
                let list = await getList();

                list.AddNewValue(1);
                list.AddNewValue(2);
                list.MutateLastValue(value => {
                    ThrowIfNotImplementsData(value, 2);
                    return 2;
                });
                await list.AddNewValue(3);
                ThrowIfNotImplementsData(list.GetValues(), [1, 2, 3]);
            }

            {
                let list = await getList();
                await list.Finish();
                await list.Finish();
            }

            {
                let list = await getList();
                list.MutateLastValue(() => 5);
                list.AddNewValue(4);
                await list.Finish();
            }

            {
                let list = await getList();

                ThrowIfNotImplementsData(list.GetValues(), [1, 2, 3, 5, 4]);
            }
        });
    });

    it("works with cancellations", async () => {
        await runAllStorageSystemCrashes(async (folder, innerCancelCode) => {
            console.log(folder);
            async function getList(storage = new DiskStorageBase()) {
                let list = new SmallDiskList<number>(
                    storage,
                    folder + "main",
                    folder + "mutate",
                );
                await list.Init();
                return list;
            }
            let count = 3;
            {
                await innerCancelCode(
                    async storage => {
                        let expectedList: number[] = [];
                        let list = await getList(storage);

                        for(let i = 0; i < count; i++) {
                            list.AddNewValue(i);
                            expectedList.push(i);
                        }
                        list.MutateLastValue(value => {
                            if(value === undefined) {
                                throw new Error(`Impossible`);
                            }
                            ThrowIfNotImplementsData(value, count - 1);
                            return value * 2;
                        });
                        expectedList[count - 1] *= 2;
                        await list.AddNewValue(count);
                        expectedList.push(count);
                        ThrowIfNotImplementsData(list.GetValues(), expectedList);
                    }
                );
            }

            await assertDataCorrect(false);
            {
                let list = await getList();
                let values = list.GetValues();
                list.AddNewValue(values.length);
                await list.AddNewValue(values.length);
            }
            await assertDataCorrect(true);

            async function assertDataCorrect(mustHaveValues: boolean) {
                let list = await getList();
                let values = list.GetValues();
                for(let i = 0; i < values.length; i++) {
                    let v = values[i];
                    if(v !== i && v !== i * 2) {
                        throw new Error(`Value incorrect, at index ${i}, value ${v}, all values: ${values}`);
                    }
                }

                if(mustHaveValues && values.length === 0) {
                    throw new Error(`Should have values, the data structure must be corrupted.`);
                }
            }
        });
    });

    it("cancellation don't corrupt confirmed data", async () => {
        await runAllStorageSystemCrashes(async (folder, innerCancelCode) => {
            console.log(folder);
            async function getList(storage = new DiskStorageBase()) {
                let list = new SmallDiskList<number>(
                    storage,
                    folder + "main",
                    folder + "mutate",
                );
                await list.Init();
                return list;
            }

            // Definitely add
            {
                let list = await getList();
                await list.AddNewValue(0);
            }

            // Maybe add
            await innerCancelCode(
                async cancelStorage => {
                    try {
                        let list = await getList(cancelStorage);
                        list.AddNewValue(1);
                        list.MutateLastValue(x => 0);
                        await list.AddNewValue(2);
                    } catch(e) { }
                }
            );

            {
                let list = await getList();
                let values = list.GetValues();
                console.log(values);
                if(values[0] !== 0) {
                    throw new Error(`Storage cancellation resulted in previous confirmed data being lost. Should start with 0, values were ${JSON.stringify(values)}`);
                }
            }
        });
    });
});