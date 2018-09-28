import { CreateTempFolderPath } from "temp-folder";
import { randomUID } from "../../util/misc";
import { mkdirFilePromise } from "../../util/fs";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData, SetTimeoutAsync, Deferred } from "pchannel";
import { CancellableCallObject, DiskStorageCancellable } from "./DiskStorageCancellable";

export async function runCodeWithFolder(code: (folder: string) => Promise<void>) {
    let folder = await CreateTempFolderPath();
    folder += randomUID("subfolder") + "/";
    await mkdirFilePromise(folder);
    try {
        await code(folder);
    } finally {
        console.log(`Deleting folder ${folder}`);
        await execFile("rm", ["-rf", folder]);
    }
}



// We need a generic function to help test all cancellation paths of a program. At some point the program
//  will cancel, but we need to manipulate timing to find every possible combination of events that can happen before
//  that, and run them all, and THEN cancel it.
//  - If there is something like await Promise.all, we can't tell that the order of resolving doesn't matter,
//      so in these cases we will have to evaluate more (probably many more) combination than are really required.

// Runs the code through all possibly storage system crash timings.
export async function runAllStorageSystemCrashes(
    code: (folder: string, storageSystem: StorageBaseAppendable) => Promise<void>
) {
    await runAllPossibilities(async (choose) => {
        let allPendingPromises: CancellableCallObject[] = [];
        async function exhaustPendingCalls(): Promise<void> {
            await SetTimeoutAsync(0);
            if(!storage.HasCalls()) {
                // This means that the underlyings function is not finished and needs more time to generate writes/reads
                //  (likely because it is doing something else that is asynchronous).
                await SetTimeoutAsync(0);
            }
            let waitCount = 0;
            while(storage.HasCalls()) {
                allPendingPromises.push(await storage.GetNextCall());
                waitCount++;
                if(waitCount >= 1000) {
                    throw new Error(`Max exhaust wait count reached. ${waitCount}`);
                }
            }
        }

        let storage = new DiskStorageCancellable();

        let startedCode = new Deferred<void>();
        let finished = new Deferred<void>();
        // Eh... not really any reason to keep using this promise. When there are no more storage system requests we
        //  will just stop fulfilling storage requests, and presumably the returned promise to this will have finished.
        runCodeWithFolder(async folder => {
            startedCode.Resolve();
            try {
                await code(folder, storage);
            } catch(e) {
                finished.Reject(e);
                return;
            }
            finished.Resolve();
        });

        await startedCode.Promise();

        let curIterationCount = 0;
        while(!finished.Value()) {
            await exhaustPendingCalls();
            if(allPendingPromises.length === 0) {
                continue;
            }

            let choice = choose(allPendingPromises.length + 1);           
            if(choice === allPendingPromises.length) {
                console.log(`Choose cancel`);
                // Kill the storage system.
                //  There won't be any more side effects, we are only running this loops to make sure we don't leak memory.
                let killLoopCount = 0;
                while(allPendingPromises.length > 0) {
                    for(let i = 0; i < allPendingPromises.length; i++) {
                        allPendingPromises[i].deferred.Resolve("cancel");
                    }
                    allPendingPromises = [];
                    await exhaustPendingCalls();
                    killLoopCount++;
                    if(killLoopCount >= 100) {
                        throw new Error(`Max kill iterations reached. ${killLoopCount}`);
                    }
                }
                break;
            }

            let pendingPromise = allPendingPromises.splice(choice, 1)[0];
            pendingPromise.deferred.Resolve();
            await pendingPromise.onFinish.Promise();

            curIterationCount++;
            if(curIterationCount >= 100) {
                throw new Error(`Max iterations reached. ${curIterationCount}`);
            }
        }
    });
}


// Runs the given code multiple times, making sure there is a run with every possible result given
//  from chooseValue for every call.
export async function runAllPossibilities(
    code: (
        // Chooses a number from 0 to count, count exclusive.
        chooseNumber: (count: number) => number
    ) => Promise<void>
): Promise<void> {
    let choiceIndexes: {
        index: number;
        count: number;
    }[] = [];

    function incrementChoice() {
        while(choiceIndexes.length > 0) {
            let last = choiceIndexes.last();
            last.index++;
            if(last.index < last.count) {
                break;
            }
            choiceIndexes.pop();
        }
        nextChoiceIndex = 0;
    }

    let nextChoiceIndex = 0;
    function chooseValue(count: number): number {
        let choiceIndex = nextChoiceIndex++;
        if(choiceIndex >= choiceIndexes.length) {
            choiceIndexes.push({
                index: 0,
                count
            });
        }
        let choiceObj = choiceIndexes[choiceIndex];

        if(choiceObj.count !== count) {
            throw new Error(`Unexpected values count. ${count}`);
        }

        return choiceObj.index;
    }

    let curCount = 0;
    while(true) {
        await code(chooseValue);
        incrementChoice();
        if(choiceIndexes.length === 0) {
            break;
        }
        curCount++;
        if(curCount >= 10000) {
            throw new Error(`Max iterations reached ${curCount}`);
        }
    }
}

