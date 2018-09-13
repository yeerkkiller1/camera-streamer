import { insertIntoListMap, removeFromListMap, findAtIndex, findAt } from "./algorithms";

export class IndexLookup<T> {
    private indexSorted: { value: T; index: number; }[] = [];
    private valueSorted: { value: T; index: number; }[] = [];

    constructor(
        private getHash: (value: T) => number
    ) { }

    public PushValue(value: T): void {
        let index = this.indexSorted.length;
        let obj = { value, index };
        this.indexSorted.push(obj);
        insertIntoListMap(this.valueSorted, obj, x => this.getHash(x.value));
    }
    public RemoveIndex(index: number): void {
        let value = this.indexSorted.splice(index, 1)[0].value;
        removeFromListMap(this.valueSorted, this.getHash(value), x => this.getHash(x.value));
        // This should really be even faster. But... idk... that's hard, and N might not get large enough for it to matter.
        for(let i = index; i < this.indexSorted.length; i++) {
            let valueObj = this.indexSorted[i];
            valueObj.index--;
        }
    }
    public GetIndex(value: T): number {
        let valueObj = findAt(this.valueSorted, this.getHash(value), x => this.getHash(x.value));
        if(!valueObj) {
            throw new Error(`Cannot find value ${value} in values.`);
        }
        return valueObj.index;
    }
    public GetValue(index: number): T {
        return this.indexSorted[index].value;
    }
}