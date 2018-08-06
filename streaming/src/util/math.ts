export function max(value: number[]): number {
    return value.reduce((a, b) => Math.max(a, b), value[0]);
}
export function min(value: number[]): number {
    return value.reduce((a, b) => Math.min(a, b), value[0]);
}
export function sum(value: number[]): number {
    return value.reduce((a, b) => a + b, 0);
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