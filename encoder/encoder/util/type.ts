//As in a JS number... as obviously... why would we want to detect non-JS numbers. I am not explaining that.
export function isNumber(str: string): boolean {
    return (+str).toString() === str;
}

export function isInteger(num: number): boolean {
    return Number.isSafeInteger(num);
}

export function isPrimitive(value: Types.AnyAll): value is Types.Primitive {
    if(typeof value === "string") return true;
    if(typeof value === "number") return true;
    if(typeof value === "boolean") return true;
    if(typeof value === "undefined") return true;
    if(value === null) return true;
    return false;
}

/** As in, {} can have children. But null can't. Also, function(){} doesn't count. Yes, it can have children, but it is more likely a mistake. */
export function canHaveChildren(value: Types.AnyAll): value is Types.Dictionary {
    return value && typeof value === "object" || false;
}

export function isArray(obj: Types.AnyAll): obj is Types.Arr {
    return obj instanceof Array;
}