import { CreateTempFolderPath } from "temp-folder";
import { randomUID, range } from "../../util/misc";
import { mkdirPromise } from "../../util/fs";
import { execFile } from "child_process";
import { ThrowIfNotImplementsData, SetTimeoutAsync, Deferred } from "pchannel";
import { CancellableCallObject, DiskStorageCancellable } from "./DiskStorageCancellable";

export async function runCodeWithFolder(code: (folder: string) => Promise<void>) {
    let folder = await CreateTempFolderPath();
    folder += randomUID("subfolder") + "/";
    await mkdirPromise(folder);
    console.log(`Made folder ${folder}`);
    try {
        await code(folder);
    } finally {
        await execFile("rm", ["-rf", folder]);
        console.log(`Deleted folder ${folder}`);
    }
}



// We need a generic function to help test all cancellation paths of a program. At some point the program
//  will cancel, but we need to manipulate timing to find every possible combination of events that can happen before
//  that, and run them all, and THEN cancel it.
//  - If there is something like await Promise.all, we can't tell that the order of resolving doesn't matter,
//      so in these cases we will have to evaluate more (probably many more) combination than are really required.

// Runs the code through all possibly storage system crash timings.
export async function runAllStorageSystemCrashes(
    code: (folder: string, innerCancelCode: (code: (storage: StorageBaseAppendable) => Promise<void>) => Promise<void>) => Promise<void>
) {
    await runAllPossibilitiesDebug(async (choose) => {
        console.log("Start run possibilities");
        let storage = new DiskStorageCancellable();
        let startedCode = new Deferred<void>();
        let finished = new Deferred<void>();

        let masterLoopDeferred = new Deferred<void>();
        let masterLoopFncDeferred = new Deferred<void>();
        let allPendingPromises: CancellableCallObject[] = [];

        async function exhaustPendingCalls(): Promise<void> {
            if(allPendingPromises.length === 0) {
                let currentPromiseWaits = 0;
                while(!storage.HasCalls() && !finished.Value()) {
                    // Await a dummy promise a few times to get to handle nested promises.
                    //  Otherwise our SetTimeoutAsync may result some storage calls coming back
                    //  sometimes, but not other times (because of timing).

                    await Promise.resolve(0);
                    currentPromiseWaits++;
                    if(currentPromiseWaits >= 20) {
                        if(!finished.Value()) {
                            console.log("err");
                            throw new Error(`There are no storage system calls, and yet the given code did not finish yet. There is either a SetTimeout or other non storage async call, OR there is more than ${currentPromiseWaits} levels of nested async functions.`);
                        } else {
                            return;
                        }
                    }
                }
            }
            let waitCount = 0;
            while(storage.HasCalls()) {
                allPendingPromises.push(storage.GetNextCall());
                waitCount++;
                if(waitCount >= 1000) {
                    throw new Error(`Max exhaust wait count reached. ${waitCount}`);
                }
            }
        }

        let masterLoopFnc = (async () => {
            await startedCode.Promise();
            let curIterationCount = 0;
            while(!finished.Value() || allPendingPromises.length > 0) {
                await exhaustPendingCalls();
                if(allPendingPromises.length === 0) {
                    continue;
                }

                let choice = choose(allPendingPromises.map(x => x.debugName).concat("CANCEL"));
                if(choice === allPendingPromises.length) {
                    // Choose to cancel everything. We don't test for random failures, just the whole system dying and everything failing.

                    console.log(`Choose cancel`);
                    // Kill the storage system.
                    //  There won't be any more side effects, we are only running this loops to make sure we don't leak memory.
                    let killLoopCount = 0;
                    while(allPendingPromises.length > 0 && !finished.Value()) {
                        while(true) {
                            let value = allPendingPromises.pop();
                            if(!value) break;
                            value.deferred.Resolve("cancel");
                        }
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

    
        let codeLoop = runCodeWithFolder(async folder => {
            let insideInnerCode = false;
            await code(
                folder,
                async (code: (storage: StorageBaseAppendable) => Promise<void>) => {
                    if(insideInnerCode) {
                        throw new Error(`Can only call innerCancelCode once.`);
                    }
                    insideInnerCode = true;

                    masterLoopDeferred.Resolve((async () => {
                        // Wait a promise to let code(storage) actually be called
                        await Promise.resolve(0);
                        let masterLoop = masterLoopFnc();
                        masterLoopFncDeferred.Resolve(masterLoop);
                    })());

                    startedCode.Resolve();
                    try {
                        await code(storage);
                    } catch(e) {
                        finished.Reject(e);
                        throw e;
                    }
                    finished.Resolve();
                }
            );
        });

        await Promise.all([codeLoop, masterLoopDeferred.Promise()]);

        if(!masterLoopFncDeferred.Value()) {
            while(storage.HasCalls()) {
                allPendingPromises.push(storage.GetNextCall());
            }
            let waitCount = 0;
            while(allPendingPromises.length > 0) {
                let started = allPendingPromises.filter(x => !!x.deferred.Value());
                if(started.length > 0) {
                    console.log(`Waiting for ${started[0].name} to finish`);
                    await started[0].onFinish.Promise();
                    continue;
                }
                break;
            }
            if(allPendingPromises.length > 0) {
                throw new Error(`There are unresolved storage calls after the main code finished. This is bad, as it means when they finish (if they fail) there will be no where for the errors to be thrown, so the application will terminate. Calls: ${allPendingPromises.map(x => x.name).join(", ")}`);
            }
        }
    });
}

export async function runAllPossibilities(
    code: (
        // Chooses a number from 0 to count, count exclusive.
        chooseNumber: (count: number) => number
    ) => Promise<void>
): Promise<void> {
    return await runAllPossibilitiesDebug(async chooseNumber => {
        return await code(count => {
            return chooseNumber(range(0, count).map(i => i.toString()));
        });
    });
}

// Runs the given code multiple times, making sure there is a run with every possible result given
//  from chooseValue for every call.
export async function runAllPossibilitiesDebug(
    code: (
        // Chooses a number from 0 to count, count exclusive.
        chooseNumber: (debugValues: string[]) => number
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
        nextChoiceDepth = 0;
    }

    let nextChoiceDepth = 0;
    function chooseValue(debugValues: string[]): number {
        let count = debugValues.length;
        let choiceDepth = nextChoiceDepth++;
        if(choiceDepth >= choiceIndexes.length) {
            choiceIndexes.push({
                index: 0,
                count
            });
        }
        let choiceObj = choiceIndexes[choiceDepth];

        if(choiceObj.count !== count) {
            throw new Error(`Unexpected values count. Count: ${count}, at index: ${choiceDepth}`);
        }

        console.log(`Choose ${debugValues[choiceObj.index]} at depth ${choiceDepth} (index ${choiceObj.index} out of [${debugValues.join(", ")}])`);

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

