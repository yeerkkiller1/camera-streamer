import { insertIntoList, removeFromListMap } from "../util/algorithms";

export class SizedCache<K, V> {
    constructor(
        private maxSize: number,
        private getSize: (key: K, value: V) => number,
        private hashKey: (key: K) => string|number
    ) { }

    private cache: { [key: string]: { value: V; seqNum: number; } } = {};
    private keyHistory: { key: K; seqNum: number; }[] = [];
    private totalSize = 0;
    private nextSeqNum = 0;

    private removeKey(key: K) {
        let hash = this.hashKey(key);
        if(!(hash in this.cache)) return;
        this.totalSize -= this.getSize(key, this.cache[hash].value);
        removeFromListMap(this.keyHistory, this.cache[hash].seqNum, x => x.seqNum);
        delete this.cache[hash];
    }
    public Add(key: K, value: V): void {
        let hash = this.hashKey(key);
        this.removeKey(key);
        let seqNum = this.nextSeqNum++;
        this.cache[hash] = { value, seqNum };
        this.totalSize += this.getSize(key, value);

        this.keyHistory.push({ key, seqNum });
        while(this.totalSize > this.maxSize && this.keyHistory.length > 0) {
            let key = this.keyHistory[0].key;
            this.removeKey(key);
        }
    }
    public Get(key: K): {v: V}|undefined {
        let hash = this.hashKey(key);
        if(hash in this.cache) {
            return { v: this.cache[hash].value };
        }
        return undefined;
    }
}