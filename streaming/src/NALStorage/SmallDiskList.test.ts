import { runCodeWithFolder, runAllStorageSystemCrashes } from "./RemoteStorage/testHelpers";
import { DiskStorageBase } from "./RemoteStorage/DiskStorageBase";
import { SmallDiskList } from "./SmallDiskList";
import { ThrowIfNotImplementsData } from "pchannel";
import { range, flatten } from "../util/misc";

describe("SmallDiskList", () => {
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

                ThrowIfNotImplementsData(list.GetValues(), [1, 2, 3]);
            }
        });
    });

    it("works with cancellations", async () => {
        await runAllStorageSystemCrashes(async (folder, storage) => {
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

    it("reloads data perfectly when there are no cancellations", async () => {
        await runCodeWithFolder(async (folder) => {
            async function getList() {
                let storage = new DiskStorageBase();
                let list = new SmallDiskList<string>(
                    storage,
                    folder + "main",
                    folder + "mutate",
                );
                await list.Init();
                return list;
            }

            let count = 2;
            for(let i = 0; i < count; i++) {
                let list = await getList();
                await list.AddNewValue(range(0, i + 1).join(""));
                await list.AddNewValue(range(0, i + 1).join(""));
            }

            {
                let list = await getList();
                let values = list.GetValues();
                ThrowIfNotImplementsData(values, 
                    flatten(
                        range(0, count)
                            .map(i => [range(0, i + 1).join(""), range(0, i + 1).join("")])
                    )
                );
            }
        });
    });
});