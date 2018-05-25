import { isArray } from "./type";
import { max } from "./math";

export function isEmpty<T>(obj: {[key: string]: T}): boolean {
    for(var key in obj) {
        return false;
    }
    return true;
}
export function firstKey<T>(obj: {[key: string]: T}): string|undefined {
    for(var key in obj) {
        return key
    }
    return undefined; 
}

let UID = Math.random();
let nextId = 0;
export function randomUID(prefix = "UID") {
    return prefix + (+new Date()).toString() + "." + (nextId++);
}

export function cloneDeep<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

export function isDeepEqual<T>(a: T, b: T): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
export function isShallowEqual<T>(a: T, b: T): boolean {
    if(!a || !b || typeof a !== "object" || typeof b !== "object") return a === b;
    for(let key in a) {
        if(a[key] !== b[key]) return false;
    }
    for(let key in b) {
        if(a[key] !== b[key]) return false;
    }
    return true;
}
export function floatEqual(a: number, b: number): boolean {
    let max = Math.max(Math.abs(a), Math.abs(b));
    let baseBits = Math.log2(max);
    if(baseBits < 1) {
        baseBits = 1;
    }
    let mantissa = Math.pow(2, baseBits - 12);
    return (a - mantissa) <= b && (a + mantissa) >= b;
}

export function unique(arr: string[]): string[] {
    return Object.keys(keyBy(arr, x => x, true))
}

export function keyBy<T>(a: T[], key: (obj: T) => string, noCollisionWarning = false): { [key: string]: T } {
    let dict: { [key: string]: T } = {};
    for(let obj of a) {
        let keyStr = key(obj);
        if(!noCollisionWarning) {
            if(keyStr in dict) {
                console.warn(`keyBy has collision in key ${keyStr}`, a);
            }
        }
        dict[keyStr] = obj;
    }
    return dict;
}
export function keyByArray<T>(a: T[], key: (obj: T) => string): { [key: string]: T[] } {
    let dict: { [key: string]: T[] } = {};
    for(let obj of a) {
        let keyStr = key(obj);
        let arr = dict[keyStr] = dict[keyStr] || [];
        arr.push(obj);
    }
    return dict;
}

export function flatten<T>(a: T[][]) {
    let b: T[] = [];
    for(let arr of a) {
        for(let o of arr) {
            b.push(o);
        }
    }
    return b;
}

export function sort<T>(arr: T[], sortKey: (obj: T) => number) {
    arr.sort((a, b) => sortKey(a) - sortKey(b));
}

export function range(start: number, end: number): number[] {
    let values: number[] = [];
    for(let i = start; i < end; i++) {
        values.push(i);
    }
    return values;
}

export function arrayEqual<T>(a: T[], b: T[]): boolean {
    if(a.length !== b.length) return false;
    for(let ix = 0; ix < a.length; ix++) {
        if(a[ix] !== b[ix]) return false;
    }
    return true;
}
/** Really just arrayEquals(superset.slice(0, subset.length), subset) */
export function arrayIsSupersetOrEqual<T>(subset: T[], superset: T[]): boolean {
    if(superset.length < subset.length) return false;
    for(let ix = 0; ix < subset.length; ix++) {
        if(subset[ix] !== superset[ix]) return false;
    }
    return true;
}
/** Really just arrayIsSupersetOrEqual(subset, superset) && !arrayEquals(subset, superset) */
export function arrayIsSuperset<T>(subset: T[], superset: T[]): boolean {
    if(superset.length <= subset.length) return false;
    for(let ix = 0; ix < subset.length; ix++) {
        if(subset[ix] !== superset[ix]) return false;
    }
    return true;
}
export function arrayMerge<T>(a: T[], b: T[], hash: (val: T) => string): T[] {
    let array: T[] = [];
    let values: { [hash: string]: Object } = {};
    for(var i = 0; i < a.length; i++) {
        var x = a[i];
        let hashed = hash(x);
        if(hashed in values) continue;
        values[hashed] = true;
        array.push(x);
    }
    for(var i = 0; i < b.length; i++) {
        var x = b[i];
        let hashed = hash(x);
        if(hashed in values) continue;
        values[hashed] = true;
        array.push(x);
    }
    return array;
}

export function getPathRaw(object: any, path: string[]): {} {
    for(let i = 0; i < path.length; i++) {
        object = object[path[i]];
    }
    return object;
}

export function setPathRaw(object: any, value: any, path: string[]) {
    for(let i = 0; i < path.length - 1; i++) {
        object = object[path[i]];
    }
    object[path[path.length - 1]] = value;
}

export function asyncTimeout(delay: number): Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(resolve, delay);
    });
}

export function mapObjectValues<A, B>(
    object: { [key: string]: A },
    map: (value: A, key: string) => B
): { [key: string]: B } {
    let result: { [key: string]: B } = {};
    for(let key in object) {
        result[key] = map(object[key], key);
    }
    return result;
}


export function filterObjectValues<A>(
    object: { [key: string]: A },
    filter: (value: A, key: string) => boolean
): { [key: string]: A } {
    let result: { [key: string]: A } = {};
    for(let key in object) {
        if(filter(object[key], key)) {
            result[key] = object[key];
        }
    }
    return result;
}

export function zipObject<P extends string, O>(prop1: P, values1: O[]): {[key in P]: O}[];

export function zipObject<
    P1 extends string, V1,
    P2 extends string, V2
>(
    p1: P1, v1: V1[],
    p2: P2, v2: V2[],
):
(
    {[key in P1]: V1}
    & {[key in P2]: V2}
)[];
export function zipObject<
    P1 extends string, V1,
    P2 extends string, V2,
    P3 extends string, V3,
>(
    p1: P1, o1: V1[],
    p2: P2, o2: V2[],
    p3: P3, o3: V3[],
):
(
    {[key in P1]: V1}
    & {[key in P2]: V2}
    & {[key in P3]: V3}
)[];
export function zipObject<
    P1 extends string, V1,
    P2 extends string, V2,
    P3 extends string, V3,
    P4 extends string, V4,
>(
    p1: P1, o1: V1[],
    p2: P2, o2: V2[],
    p3: P3, o3: V3[],
    p4: P4, o4: V4[],
):
(
    {[key in P1]: V1}
    & {[key in P2]: V2}
    & {[key in P3]: V3}
    & {[key in P4]: V4}
)[];
export function zipObject<
    P1 extends string, V1,
    P2 extends string, V2,
    P3 extends string, V3,
    P4 extends string, V4,
    P5 extends string, V5,
>(
    p1: P1, o1: V1[],
    p2: P2, o2: V2[],
    p3: P3, o3: V3[],
    p4: P4, o4: V4[],
    p5: P5, o5: V5[],
):
(
    {[key in P1]: V1}
    & {[key in P2]: V2}
    & {[key in P3]: V3}
    & {[key in P4]: V4}
    & {[key in P5]: V5}
)[];

export function zipObject(...args: (string | object[])[]): object[] {
    let output: object[] = [];

    let argsObjects: { prop: string, values: object[] }[] = [];

    if(args.length % 2 !== 0) {
        throw new Error(`Expected an even number of arguments, one property per one list of objects.`);
    }

    let count = args.length / 2;
    for(let i = 0; i < count; i++) {
        let prop = args[i];
        if(typeof prop !== "string") {
            throw new Error(`Every other property should be the property name, instead we received: ${prop}`);
        }
        let objArray = args[i + 1];
        if(!isArray(objArray)) {
            throw new Error(`Every other property should be an array of values, instead we received: ${objArray}`);
        }

        argsObjects.push({prop, values: objArray as any});
    }

    let maxCount = max(argsObjects.map(x => x.values.length));

    return (
        range(0, maxCount)
        .map(i => {
            let obj: Types.DictionaryArr = {};
            for(let argObj of argsObjects) {
                let prop = argObj.prop;
                let value = argObj.values[i];
                obj[prop] = value;
            }
            return obj;
        })
    );
}