import { TransformChannel, Deferred, PChan } from "pchannel";
import { createIgnoreDuplicateCalls } from "../algs/cancel";
import { sum } from "../util/math";
import { fixErrorStack } from "../util/stack";
import { randomUID } from "../util/rand";
import { writeFile, write } from "fs";

//todonext
// We need to use multiple files actually, so we can delete values. Maybe... exactly 3 files? To prevent having to read a file
//  to determine which file contains which value and also so the file names are always the same.

// Has small amounts of data so everything is stored locally, and read in on boot.
export class SmallDiskList<T> {
    constructor(
        private localStorage: StorageBaseAppendable,
        // Should contain a single *, which indicates the location a unique identifer can be set.
        private mainFilePath: string,
        private mutateFilePath: string,
    ) {

    }

    private values: T[] = [];
    private valuesBufferLengths: number[] = [];

    // The amounts of values we have appended to mainFilePath. (the last value should always be in the mutateFilePath,
    //  so this should always be less than values.length, unless it is 0 of course)
    private appendCount = 0;

    private mainFilePathLength = 0;
    private mainFilePathLengthCount = 0;

    public messages: string[] = [];

    /** The amount of values that are written to the disk, and will not be lost. */
    private confirmedCount = 0;
    private onConfirmedCountChanged = new Deferred<void>();
    private setConfirmedCount(count: number) {
        if(count <= this.confirmedCount) return;
        let confirmObj = this.onConfirmedCountChanged.Value();
        // ignore coverage, because only happens in race conditions with errors, which cannot be consistently reproduced
        if(confirmObj && "error" in confirmObj) {
            // ignore coverage, because only happens in race conditions with errors, which cannot be consistently reproduced
            return;
        }
        this.messages.push(`Confirmed count ${count}`);
        this.confirmedCount = count;
        this.onConfirmedCountChanged.Resolve();
        this.onConfirmedCountChanged = new Deferred<void>();
    }

    private async readFile<U>(path: string): Promise<{ values: U[]; fileLength: number }> {
        let contents = "";
        try {
            let contentsBuffer = await this.localStorage.GetFileContents(path);
            contents = contentsBuffer.toString();
        } catch(e) { }

        let lines = contents
            .split("\n")
            .slice(0, -1);

        let values = lines.map(str => JSON.parse(str) as U);

        return {
            values,
            fileLength: contents.length,
        };
    }

    private initedFinished = new Deferred<void>();

    public IsAlreadyInited(): void {
        this.initedFinished.Resolve();
    }

    /** If there are definitely no mainFilePath or mutateFilePath then this shouldn't need to be called. */
    public async Init(): Promise<void> {
        await this.requireAsyncBlock(async () => {
            let { values, fileLength } = await this.readFile<T>(this.mainFilePath);
            this.values = values;
            
            let mutateValuesObj = await this.readFile<{ value: T, mainFilePathLength: number }>(this.mutateFilePath);
            let mutateValues = mutateValuesObj.values;
            if(mutateValues.length > 1) {
                // exclude coverage, this happening requires valid data being written, in an invalid way. There is no point to test for this.
                throw new Error(`mutate file path is corrupted. It has more than 1 value!? ${this.mutateFilePath}`);
            }

            this.appendCount = this.values.length;
            this.valuesBufferLengths = this.values.map(x => JSON.stringify(x).length + 1);
            this.mainFilePathLength = sum(this.valuesBufferLengths);
            this.mainFilePathLengthCount = this.values.length;

            if(mutateValues.length === 1) {
                let mutateValueObj = mutateValues[0];
                if(mutateValueObj.mainFilePathLength !== fileLength) {
                    let message = `Mutable value has a main file length inconsistent with the actual main file length. Should be ${fileLength}, was ${mutateValueObj.mainFilePathLength}`;
                    console.error(message);
                    this.messages.push(message);
                } else {
                    this.values.push(mutateValueObj.value);
                    this.valuesBufferLengths.push(JSON.stringify(mutateValueObj.value).length + 1);
                    this.messages.push(`Loaded mutable value`);
                }
            }

            this.confirmedCount = this.values.length;

            this.initedFinished.Resolve();

            this.messages.push(`Loaded values ${JSON.stringify(this.values)}`);
        });
    }

    public async BlockUntilInitFinished(): Promise<void> {
        return this.initedFinished.Promise();
    }

    private currentFatalError: { e: unknown }|undefined;
    private fatalError(e: unknown) {
        // exclude coverage, actually... because we serialize all calls this can't happen, as we wouldn't even make a call
        //  after an error already happened. But just in case, add this check.
        if(this.currentFatalError) {
            // exclude coverage
            console.error(`Impossible, we should never make a call attempt while this.currentFatalError has a value, and all call attempt should be serialized.`)
            return;
        }
        this.currentFatalError = { e };
        this.onConfirmedCountChanged.Reject(e);

    }
    private async requireAsyncBlock<T>(code: () => Promise<T>): Promise<T> {
        if(this.currentFatalError !== undefined) {
            throw this.currentFatalError.e;
        }
        try {
            return await code();
        } catch(e) {
            this.fatalError(e);
            throw e;
        }
    }
    private requiredSyncBlock<T>(code: () => T): T {
        if(this.currentFatalError !== undefined) {
            throw this.currentFatalError.e;
        }
        try {
            return code();
        } catch(e) {
            // exclude coverage, because there is no way to trigger this, but there may be in the future, and I don't want
            //  to have to remember to change the utility functions because I deleted code that just happened to not be in use...
            this.fatalError(e);
            // exclude coverage
            throw e;
        }
    }

    public async BlockUntilIndexSaved(index: number): Promise<void> {
        return this.requireAsyncBlock(async () => {
            // This can clearly block forever if a write call fails. So... we need to error out onConfirmedCountChanged when that happens.
            let requireCount = index + 1;
            //console.log(`Waiting until confirmed ${requireCount} (confirmed ${this.confirmedCount})`);
            while(this.confirmedCount < requireCount) {
                await this.onConfirmedCountChanged.Promise();
            }
            //console.log(`Confirmed up to ${requireCount} (confirmed ${this.confirmedCount})`);
        });
    }

    /** Returns when all the current writes are finished and the mutable value is moved ot the mainFilePath.
     *      If more values are added after Finish is called then this won't mean anything.
    */
    public async Finish(): Promise<void> {
        this.messages.push(`Finishing`);

        if(this.appendCount === this.values.length) {
            return;
        }
        let valuesCount = this.values.length;
        await this.BlockUntilIndexSaved(valuesCount - 1);

        if(this.appendCount + 1 !== valuesCount) {
            // Maybe we appended too many values, or something
            /* exclude coverage */
            console.error(`Finish was called, but appentCount has changed in an unexpected way. Is ${this.appendCount}, should be ${valuesCount - 1}.`);
            /* exclude coverage */
            return;
        }

        // We don't need to change the mutate file. It will have an incorrect mainFilePathLength after we append this,
        //  which means it will be ignored after this.
        let appendIndex = this.appendCount;
        this.appendCount++;
        await this.localStorage.AppendData(this.mainFilePath, JSON.stringify(this.values[appendIndex]) + "\n");

        this.setConfirmedCount(appendIndex + 1);
    }

    public AddNewValue = fixErrorStack(0, async function AddNewValue(this: SmallDiskList<T>, call, value: T): Promise<void> {
        return this.requireAsyncBlock(async () => {
            let valueLength = JSON.stringify(value).length + 1;

            let index = this.values.length;
            this.values.push(value);
            this.valuesBufferLengths.push(valueLength);
            
            for(let i = this.mainFilePathLengthCount; i < this.values.length - 1; i++) {
                this.mainFilePathLength += this.valuesBufferLengths[i];
            }
            this.mainFilePathLengthCount = this.values.length - 1;

            //console.log(`Queuing Add`);
            //await call(0, this.addNewValueInternal, { value, index });
            await call(0, this.addNewValueInternal, { value, index });
            //console.log(`Finished Add`);
        });
    });

    //todonext
    // We should just have one serialized function that performs all IO. add, mutate and remove.
    //  And actually... we should start actually overwriting files
    //  fs.write and stuff
    //  so, we need to use wx, and then if that fails (because the file exists), do r+ (or vice versa)?
    //      And then... try a few times? In case the file exists, we error, it is deleted, we check, we error.
    // But again, we have issues with automatically cancelling mutates. So... we are going to need to write our own pchan thing. BUT,
    //      we can do it without a management loop, to preserve callstacks, which will in the end be better.

    



    private addNewValueInternal = TransformChannel<{value: T, index: number}, void>(async (valueObj) => {
        //console.log(`Inside Add`);
        let { value, index } = valueObj;

        //this.messages.push(`Append, confirmed: ${this.confirmedCount}, values: ${this.values.length}, appendCount: ${this.appendCount}`);

        // If the last one can be appended (because even after appending it we won't have appened all the values),
        //  then we should append it.
        if(this.appendCount + 1 < this.values.length) {
            // If we wipe out the mutate file before we append to the main file we could crash before we get around to
            //  moving the mutate value to the main file, losing data we had previous written to disk. So we have
            //  to wait until the append finishes before we set the mutate value, no matter how slow that is.

            this.appendCount++;
            await this.localStorage.AppendData(this.mainFilePath, JSON.stringify(this.values[this.appendCount - 1]) + "\n");
        }

        // If we are the last value, we should change the mutatable file instead
        //  Because this is after the await this data might be a bit old. But that should be fine,
        //  the last value should always set the mutate file, and waiting might actually help cancel extra
        //  mutate writes.
        if(index === this.values.length - 1) {
            let id = randomUID("mutate");
            //console.log(`Before add mutate ${id}`);
            try {
                await this.setMutateFile(value, this.mainFilePathLength);
            } finally {
                //console.log(`after add mutate ${id}`);
            }
        }

        this.setConfirmedCount(index + 1);
    });

    private setMutateFile = createIgnoreDuplicateCalls<(value: T, mainFilePathLength: number) => Promise<void>>(async (value, mainFilePathLength) => {
        await this.localStorage.SetFileContents(this.mutateFilePath, JSON.stringify({value, mainFilePathLength}) + "\n");
    });

    public async MutateLastValue(code: (value: T|undefined) => T): Promise<unknown> {
        return this.requireAsyncBlock(async () => {
            // There is a race here though, with the writes to the mutable file inside addNewValueInternal.
            //  We don't want a channel, as intermediate writes aren't needed, but a loop with a single buffer
            //  should work. Actually... createIgnoreDuplicateCalls should just do that anyway, and we could
            //  just use that function instead. And then, if we happen to write to mutate, append, and then have the
            //  subsequent update of mutate not get written... the mutate file will be recognized as invalid in the
            //  Init because it's file length will be too small.

            // This of course allows the possibility of writing to the mutate file WHILE writing to the append file.
            //  - When we run we will always use the last value, so at the time of our run we will be correct.
            //  - If we wait for the last mutate file to run (which we have to), and more appends happen, then
            //          our buffered mutate will be cancelled.
            // So I don't think there is a more optimum approach, short of write cancellation, or possibly a multiple
            //  file name scheme to allow effective write cancellation.

            this.messages.push(`Mutate, confirmed: ${this.confirmedCount}, values: ${this.values.length}, appendCount: ${this.appendCount}`);

            if(this.appendCount === this.values.length) {
                // There are no mutable values, so we need to just add it.
                return this.AddNewValue(code(undefined));
            }

            let value = code(this.values.last());

            let pos = this.values.length - 1;
            this.values[pos] = value;
            this.valuesBufferLengths[pos] = JSON.stringify(value).length + 1;

            // If the value in the current mutate file is waiting to be written to the mainFile we have to
            //  wait. As if we clobber it now, it will only be stored in memory, and we should never go from
            //  something being stored on disk to only stored in memory (because that allows data loss).

            //console.log(`Starting BlockUntilIndexSaved`);
            try {
                await this.BlockUntilIndexSaved(pos);
            } finally {
                //console.log(`Finished BlockUntilIndexSaved`);
            }
            if(!(this.values[pos] === value && this.values.length - 1 === pos)) {
                this.messages.push(`Bailing on mutate as more values have been added`);
                // If values have been added, or our value has been changed, just return,
                //  we are out of order for setting the mutate file.
                return;
            }

            await this.setMutateFile(value, this.mainFilePathLength);
        });
    }

    public GetValues(): T[] {
        return this.requiredSyncBlock(() => this.values);
    }
}

//export class MutableDiskList

//todonext
// Crap, we do need the ability to remove values from this. So... we do need to chunk this. I think we need a lookup that wraps this,
//  and just adds chunking capabilities?