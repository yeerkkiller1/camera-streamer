import { TransformChannel } from "pchannel";
import { createIgnoreDuplicateCalls } from "../algs/cancel";
import { sum } from "../util/math";

// Has small amounts of data so everything is stored locally, and read in on boot.
export class SmallDiskList<T> {
    constructor(
        private localStorage: StorageBaseAppendable,
        private mainFilePath: string,
        private mutateFilePath: string,
    ) { }

    private values: T[] = [];
    private valuesBufferLengths: number[] = [];

    // The amounts of values we have appended to mainFilePath. (the last value should always be in the mutateFilePath,
    //  so this should always be less than values.length, unless it is 0 of course)
    private appendCount = 0;

    private mainFilePathLength = 0;
    private mainFilePathLengthCount = 0;

    private async readFile<U>(path: string): Promise<{ values: U[]; fileLength: number }> {
        let contents = "";
        try {
            contents = (await this.localStorage.GetFileContents(path)).toString();
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

    /** If there are definitely no mainFilePath or mutateFilePath then this shouldn't need to be called. */
    public async Init(): Promise<void> {
        let { values, fileLength } = await this.readFile<T>(this.mainFilePath);
        this.values = values;
        
        let mutateValuesObj = await this.readFile<{ value: T, mainFilePathLength: number }>(this.mutateFilePath);
        let mutateValues = mutateValuesObj.values;
        if(mutateValues.length > 1) {
            throw new Error(`mutate file path is corrupted. It has more than 1 value!? ${this.mutateFilePath}`);
        }

        this.appendCount = this.values.length;
        this.valuesBufferLengths = this.values.map(x => JSON.stringify(x).length + 1);
        this.mainFilePathLength = sum(this.valuesBufferLengths);
        this.mainFilePathLengthCount = this.values.length;

        console.log(`Loaded mainFilePathLength ${this.mainFilePathLength}`);

        if(mutateValues.length === 1) {
            let mutateValueObj = mutateValues[0];
            if(mutateValueObj.mainFilePathLength !== fileLength) {
                console.error(`Mutable value has a main file length inconsistent with the actual main file length. Should be ${fileLength}, was ${mutateValueObj.mainFilePathLength}`);
            } else {
                this.values.push(mutateValueObj.value);
                this.valuesBufferLengths.push(JSON.stringify(mutateValueObj.value).length + 1);
            }
        }
    }

    public async BlockUntilInitFinished(): Promise<void> {
        todonext
    }

    /** Returns when all the current writes are finished and the mutable value is moved ot the mainFilePath. */
    public async Finish(): Promise<void> {
        todonext
    }

    public async BlockUntilIndexSaved(index: number): Promise<void> {
        todonext
    }

    public AddNewValue(value: T): Promise<void> {
        let valueLength = JSON.stringify(value).length + 1;

        let index = this.values.length;
        this.values.push(value);
        this.valuesBufferLengths.push(valueLength);

        for(let i = this.mainFilePathLengthCount; i < this.values.length - 1; i++) {
            this.mainFilePathLength += this.valuesBufferLengths[i];
            console.log(`Updated mainFilePathLength to ${this.mainFilePathLength}`);
        }
        this.mainFilePathLengthCount = this.values.length - 1;

        return this.addNewValueInternal({ value, index });
    }
    private addNewValueInternal = TransformChannel<{value: T, index: number}, void>(async (valueObj) => {
        let { value, index } = valueObj;

        let writes: Promise<void>[] = [];

        // If we are the last value, we should change the mutatable file instead
        if(index === this.values.length - 1) {
            writes.push(this.setMutateFile(value, this.mainFilePathLength));
        }

        // If the last one can be appended (because even after appending it we won't have appened all the values),
        //  then we should append it.
        if(this.appendCount + 1 < this.values.length) {
            writes.push(this.localStorage.AppendData(this.mainFilePath, JSON.stringify(this.values[this.appendCount]) + "\n"));
            this.appendCount++;
        }

        await Promise.all(writes);
    });

    private setMutateFile = createIgnoreDuplicateCalls<(value: T, mainFilePathLength: number) => Promise<void>>(async (value, mainFilePathLength) => {
        console.log(`Set mutate with main file length ${mainFilePathLength}`);
        await this.localStorage.SetFileContents(this.mutateFilePath, JSON.stringify({value, mainFilePathLength}) + "\n");
    });

    public MutateLastValue(code: (value: T|undefined) => T): Promise<void> {
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

        if(this.appendCount === this.values.length) {
            // There are no mutable values, so we need to just add it.
            return this.AddNewValue(code(undefined));
        }

        let value = code(this.values.last());

        this.values[this.values.length - 1] = value;
        this.valuesBufferLengths[this.values.length - 1] = JSON.stringify(value).length + 1;

        return this.setMutateFile(value, this.mainFilePathLength);
    }

    public GetValues(): T[] {
        return this.values;
    }
}