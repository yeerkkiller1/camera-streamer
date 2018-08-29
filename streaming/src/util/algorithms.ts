const uniqueKey = "uniqueKey" + Math.random() + +new Date();

export function findAtOrBeforeOrAfter<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findAtOrBeforeOrAfterIndex(list, value, map)];
}
export function findAtOrBefore<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findAtOrBeforeIndex(list, value, map)];
}
export function findAfter<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findAfterIndex(list, value, map)];
}
export function findAfterIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    return findAtOrBeforeIndex(list, value, map) + 1;
}
export function findAtOrAfter<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findAtOrAfterIndex(list, value, map)];
}

export function findAt<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findAtIndex(list, value, map)];
}
export function findAtIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    let index = binarySearchMap(list, value, map);
    return index;
}

export function findAtOrAfterIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    let index = binarySearchMap(list, value, map);
    if(index < 0) {
        index = ~index;
    }
    return index;
}
export function findAtOrBeforeIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    let index = binarySearchMap(list, value, map);
    if(index < 0) {
        index = ~index - 1;
    }
    return index;
}
export function findAtOrBeforeOrAfterIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    let index = binarySearchMap(list, value, map);
    if(index < 0) {
        index = ~index - 1;
    }
    if(index < 0) {
        index = 0;
    }
    return index;
}

export function findClosest<T>(list: T[], value: number, map: (t: T) => number): T|undefined {
    return list[findClosestIndex(list, value, map)];
}
export function findClosestIndex<T>(list: T[], value: number, map: (t: T) => number): number {
    let beforeIndex = findAtOrBeforeIndex(list, value, map);
    let afterIndex = findAfterIndex(list, value, map);
    let before = list[beforeIndex];
    let after = list[afterIndex];
    if(!before) {
        return afterIndex;
    }
    if(!after) {
        return beforeIndex;
    }

    if(Math.abs(map(before) - value) < Math.abs(map(after) - value)) {
        return beforeIndex;
    } else {
        return afterIndex;
    }
}

export function binarySearchNumber(list: number[], value: number): number {
    return binarySearch<number>(list, value, (a, b) => a - b);
}

export function binarySearchMap<T>(list: T[], value: number, map: (t: T) => number): number {
    return binarySearchMapped<T, number>(list, value, map, (a, b) => a - b);
}

export function binarySearchMapped<T, M>(list: T[], value: M, map: (t: T) => M, comparer: (lhs: M, rhs: M) => number): number {
    return binarySearch<T>(list, {[uniqueKey]: value} as any as T, (a, b) => {
        let aMap = typeof a === "object" && uniqueKey in a ? (a as any)[uniqueKey] as M : map(a);
        let bMap = typeof b === "object" && uniqueKey in b ? (b as any)[uniqueKey] as M : map(b);

        return comparer(aMap, bMap);
    });
}
export function binarySearch<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number): number {
    let minIndex = 0;
    let maxIndex = list.length;

    while (minIndex < maxIndex) {
        let fingerIndex = ~~((maxIndex + minIndex) / 2);
        //if (fingerIndex >= list.length) return ~fingerIndex;
        let finger = list[fingerIndex];
        let comparisonValue = comparer(value, finger);
        if(comparisonValue < 0) {
            maxIndex = fingerIndex;
        } else if(comparisonValue > 0) {
            minIndex = fingerIndex + 1;
        } else {
            return fingerIndex;
        }
    }
    return ~minIndex;
}

export function insertIntoListMap<T>(list: T[], value: T, map: (t: T) => number, duplicates: "throw"|"ignore"|"add"|"warn" = "throw"): number {
    return insertIntoList(list, value, (a, b) => map(a) - map(b), duplicates);
}

export function insertIntoListMapped<T, M>(list: T[], value: T, map: (t: T) => M, comparer: (lhs: M, rhs: M) => number, duplicates: "throw"|"ignore"|"add" = "throw"): number {
    return insertIntoList(list, value, (a, b) => comparer(map(a), map(b)), duplicates);
}

export function insertIntoList<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number, duplicates: "throw"|"ignore"|"add"|"warn" = "throw"): number {
    let index = binarySearch(list, value, comparer);
    if(index >= 0) {
        if(duplicates === "throw") throw new Error(`Duplicate value in list ${value}.`);
        if(duplicates === "warn") {
            console.warn(`Duplicate in list`);
            return index;
        }
        if(duplicates === "ignore") return index;
    } else {
        index = ~index;
    }
    list.splice(index, 0, value);
    return index;
}

export function removeFromListMap<T>(list: T[], value: number, map: (t: T) => number, throwOnNotExists = false) {
    return removeFromListMapped(list, value, map, (a, b) => a - b, throwOnNotExists);
}
export function removeFromListMapped<T, M>(list: T[], value: M, map: (t: T) => M, comparer: (lhs: M, rhs: M) => number, throwOnNotExists = false) {
    let index = binarySearchMapped(list, value, map, comparer);
    if(index >= 0) {
        list.splice(index, 1);
    } else if(throwOnNotExists) {
        throw new Error(`Tried to remove value that didn't exist. ${value}`);
    }
}

export function removeFromList<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number) {
    let index = binarySearch(list, value, comparer);
    if(index >= 0) {
        list.splice(index, 1);
    }
}

export function sort<T>(arr: T[], sortKey: (obj: T) => number) {
    arr.sort((a, b) => sortKey(a) - sortKey(b));
}