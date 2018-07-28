const uniqueKey = "uniqueKey" + Math.random() + +new Date();
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