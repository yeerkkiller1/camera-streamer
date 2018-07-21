export function clock() {
    var time = process.hrtime();
    return time[0]*1000 + time[1] / 1000 / 1000;
}