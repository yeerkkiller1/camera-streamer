import { runCodeWithFolder, runAllStorageSystemCrashes } from "./Storage/testHelpers";
import { DiskStorageBase } from "./Storage/DiskStorageBase";
import { SmallDiskList } from "./SmallDiskList";
import { ThrowIfNotImplementsData, SetTimeoutAsync } from "pchannel";
import { range, flatten } from "../util/misc";
import { LargeDiskList } from "./LargeDiskList";
import { mkdirSync } from "fs";
import { mkdirPromise, writeFilePromise, appendFilePromise } from "../util/fs";
import { findAtOrBeforeOrAfter } from "../util/algorithms";
import { basename } from "path";
import { DiskStorageCancellable } from "./Storage/DiskStorageCancellable";

xdescribe("LargeDiskList", () => {
    it("works with simple data", async () => {
        await runCodeWithFolder(async (folder) => {
            let localFolder = folder + "local/";
            let remoteFolder = folder + "remote/";
            await mkdirPromise(localFolder);
            await mkdirPromise(remoteFolder);

            async function getList(storage = new DiskStorageBase()) {
                let list = new LargeDiskList<number>(
                    storage,
                    storage,
                    localFolder,
                    remoteFolder,
                    x => x
                );

                await list.Init();

                return list;
            }
            let realList = [1,3,4];
            {
                let list = await getList();

                list.AddNewValue(1);
                list.AddNewValue(2);
                list.MutateLastValue(value => {
                    ThrowIfNotImplementsData(value, 2);
                    return 3;
                });
                await list.AddNewValue(4);

                for(let i = 0; i < 5; i++) {
                    let listValue = await list.FindAtOrBeforeOrAfter(i);
                    let correctValue = findAtOrBeforeOrAfter(realList, i, x => x);
                    ThrowIfNotImplementsData(listValue, correctValue);
                }
            }
            {
                let list = await getList();
                for(let i = 0; i < 5; i++) {
                    let listValue = await list.FindAtOrBeforeOrAfter(i);
                    let correctValue = findAtOrBeforeOrAfter(realList, i, x => x);
                    ThrowIfNotImplementsData(listValue, correctValue);
                }
            }
        });
    });

    it("ranges exists", async () => {
        await runCodeWithFolder(async (folder) => {
            let localFolder = folder + "local/";
            let remoteFolder = folder + "remote/";
            await mkdirPromise(localFolder);
            await mkdirPromise(remoteFolder);

            async function getList(storage = new DiskStorageBase()) {
                let list = new LargeDiskList<number>(
                    storage,
                    storage,
                    localFolder,
                    remoteFolder,
                    x => x
                );

                await list.Init();

                return list;
            }
            let dir: any;
            {
                let list = await getList();
                await list.AddNewValue(0);

                dir = await new DiskStorageBase().GetDirectoryListing(localFolder);

                let ranges = list.GetRangeSummary();
                if(ranges.length === 0) {
                    throw new Error(`No ranges? How?`);
                }
            }
            {
                let list = await getList();
                
                let ranges = list.GetRangeSummary();
                if(ranges.length === 0) {
                    console.log(dir);
                    throw new Error(`No ranges on reload?`);
                }
            }
        });
    });

    // We need to test for leaking promises

    //*
    it("works with cancellation", async () => {
        let runCount = 0;
        await runAllStorageSystemCrashes(async (folder, innerCancelCode) => {
            runCount++;
            let localFolder = folder + "local/";
            let remoteFolder = folder + "remote/";
            await mkdirPromise(localFolder);
            await mkdirPromise(remoteFolder);

            async function getList(storage = new DiskStorageBase()) {
                let list = new LargeDiskList<number>(
                    storage,
                    storage,
                    localFolder,
                    remoteFolder,
                    x => x
                );
                await list.Init();

                return list;
            }
            let listPossibilities = [
                [0],
                [0, 1],
                [0, 1, 2],
                [0, 1, 3],
                [0, 1, 3, 4],
            ];
            
            let dir: any;

            let prevMessagesObj: { messages: string[] } = { messages: [] };
            {
                let list = await getList();
                await list.AddNewValue(0);

                //dir = await new DiskStorageBase().GetDirectoryListing(localFolder);

                let ranges = list.GetRangeSummary();
                if(ranges.length === 0) {
                    throw new Error(`No ranges? How?`);
                }
            }
            
            

            await innerCancelCode(
                async cancelStorage => {
                    //console.log(`startcancel ${Date.now()}`);

                    prevMessagesObj.messages = ["NO SUMMARY"];
                    try
                    {
                        let list = await getList(cancelStorage);

                        let summary = Object.values(list.pendingSummaries)[0];
                        if(summary) {
                            prevMessagesObj.messages = summary.messages;
                        }
                        
                        let p1: Promise<unknown>|undefined;
                        let p2: Promise<unknown>|undefined;
                        let p3: Promise<unknown>|undefined;
                        let p4: Promise<unknown>|undefined;

                        p1 = list.AddNewValue(1);
                        //p2 = list.AddNewValue(2);
                        p3 = list.MutateLastValue(value => 3);
                        p4 = list.AddNewValue(4);

                        await Promise.all([p1, p2, p3, p4]); /*?.*/
                    } catch(e) { }
                    //console.log("endcancel");
                }
            ); /*?.*/

            {
                let list = await getList();
                function printMessages() {
                    console.log("Previous messages start");
                    for(let message of prevMessagesObj.messages) {
                        console.log(message);
                    }
                    console.log("Messages start");
                    for(let message of list.messages) {
                        console.log(message);
                    }
                    console.log("Messages finished");
                }

                let ranges = list.GetRangeSummary();
                if(ranges.length === 0) {
                    printMessages();
                    throw new Error(`Ranges were deleted after data cancellation. Data corruption like this shouldn't happen.`);
                }

                let inferredList: number[] = [];
                for(let i = 0; i < 5; i++) {
                    let listValue = await list.FindAtOrBeforeOrAfter(i);
                    let valueType = typeof listValue;
                    let isInvalid = valueType !== "number";
                    if(isInvalid) {
                        //  ${list.summaryLookup.messages.join(" ")}
                        throw new Error(`
${i}

${list.messages.join("\n")}

${Object.values(list.pendingSummaries).map(x => x && `[${x.messages.join(", ")}]`).join("\n")}

${list.summaryLookup.GetValues().map(x => `${x.start} to ${x.last}`).join("\n")}

${prevMessagesObj.messages.join("\n")}

${folder}`
                        );
                        //throw new Error(`Invalid FindAtOrBeforeOrAfter result for ${i}. Should have been a number, was ${listValue}, ${JSON.stringify(valueType)}`);
                    }
                    if(inferredList.length > 0 && inferredList.last() === listValue) continue;
                    inferredList.push(listValue as number);
                }
                if(inferredList[0] !== 0) {
                    throw new Error(`Confirmed value was lost, values were [${inferredList.join(", ")}], should have started with 0`);
                }
                console.log(inferredList);
            }
        });
        runCount;
    });
    //*/
    // Cancellations don't lose data
    // That data is still valid even with cancellations

    //todonext
    // Make sure we test ExportOldest
});