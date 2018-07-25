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