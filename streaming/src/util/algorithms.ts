const uniqueKey = "uniqueKey" + Math.random() + +new Date();

export function binarySearchNumber(list: number[], value: number): number {
    return binarySearch<number>(list, value, (a, b) => a - b);
}

export function binarySearchMap<T>(list: T[], value: number, map: (t: T) => number): number {
    return binarySearchMapped<T, number>(list, value, map, (a, b) => a - b);
}

export function binarySearchMapped<T, M>(list: T[], value: M, map: (t: T) => M, comparer: (lhs: M, rhs: M) => number): number {
    return binarySearch<T>(list, {[uniqueKey]: value} as any as T, (a, b) => {
        let aMap = uniqueKey in a ? (a as any)[uniqueKey] as M : map(a);
        let bMap = uniqueKey in b ? (b as any)[uniqueKey] as M : map(b);

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

export function findAtOrBefore<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number): T|undefined {
    let index = binarySearch(list, value, comparer);

    if (index < 0) {
        index = ~index - 1;
    }

    return list[index];
}

export function findBefore<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number): T|undefined {
    let index = binarySearch(list, value, comparer);

    if (index < 0) {
        index = ~index;
    }

    return list[index - 1];
}

export function insertIntoListMap<T>(list: T[], value: T, map: (t: T) => number, duplicates: "throw"|"ignore"|"add" = "throw"): number {
    return insertIntoList(list, value, (a, b) => map(a) - map(b), duplicates);
}

export function insertIntoListMapped<T, M>(list: T[], value: T, map: (t: T) => M, comparer: (lhs: M, rhs: M) => number, duplicates: "throw"|"ignore"|"add" = "throw"): number {
    return insertIntoList(list, value, (a, b) => comparer(map(a), map(b)), duplicates);
}

export function insertIntoList<T>(list: T[], value: T, comparer: (lhs: T, rhs: T) => number, duplicates: "throw"|"ignore"|"add" = "throw"): number {
    let index = binarySearch(list, value, comparer);
    if(index >= 0) {
        if(duplicates === "throw") throw new Error(`Duplicate value in list ${value}.`);
        if(duplicates === "ignore") return index;
    } else {
        index = ~index;
    }
    list.splice(index, 0, value);
    return index;
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