
export function max(values: number[], defaultValue = Number.NEGATIVE_INFINITY): number {
    return values.reduce((a, b) => Math.max(a, b), defaultValue);
}

export function sum(nums: number[]): number {
    let result = 0;
    for(let i = 0; i < nums.length; i++) {
        result += nums[i];
    }
    return result;
}