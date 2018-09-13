import { sort } from "./algorithms";
import { keyBy, mapObjectValues } from "./misc";

export function max(value: number[]): number {
    return value.reduce((a, b) => Math.max(a, b), value[0]);
}
export function min(value: number[]): number {
    return value.reduce((a, b) => Math.min(a, b), value[0]);
}
export function minMap<T>(values: T[], map: (t: T) => number): T {
    let min = values[0];
    for(let value of values) {
        if(map(value) < map(min)) {
            min = value;
        }
    }
    return min;
}
export function sum(value: number[]): number {
    return value.reduce((a, b) => a + b, 0);
}
export function mean(value: number[]): number {
    return sum(value) / value.length;
}

/** Sorted by count from high to low. */
export function histogram(values: number[]): { value: number; count: number; }[] {
    let data: { [value: number]: number } = {};
    for(let value of values) {
        data[value] = data[value] || 0;
        data[value]++;
    }
    
    let counts: { value: number; count: number; }[] = [];
    for(let valueStr in data) {
        let value = +valueStr;
        let count = data[value];
        counts.push({ value, count });
    }
    sort(counts, x => -x.count);
    return counts;
}

export function histogramLookup(values: number[]): { [value: number]: number } {
    return mapObjectValues(keyBy(histogram(values), x => x.value.toString()), x => x.count);
}


(Array as any).prototype.last = function<T>(this: Array<T>) {
    if(this.length === 0) {
        throw new Error(`Cannot get last of an empty array.`);
    }
    return this[this.length - 1];
};


export function group(values: number[], minGroupGap: number): number[][] {
    let prevValue: number|undefined;

    let groups: number[][] = [];
    let curGroup: number[] = [];
    for(let i = 0; i < values.length; i++) {
        let v = values[i];

        if(prevValue !== undefined) {
            let gap = v - prevValue;
            if(gap > minGroupGap) {
                groups.push(curGroup);
                curGroup = [];
            }
        }

        curGroup.push(v);

        prevValue = v;
    }

    if(curGroup.length > 0) {
        groups.push(curGroup);
    }

    return groups;
}