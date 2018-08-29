import { SetTimeoutAsync } from "pchannel";

export function clock() {
    if(NODE) {
        var time = process.hrtime();
        return time[0]*1000 + time[1] / 1000 / 1000;
    }
    return Date.now();
}

export class TimeServer implements ITimeServer {
    public async getTime() { return Date.now(); }
}

class ValuesExpectedValue {
    values: number[] = [];
    constructor(private historySize: number) { }
    public AddValue(newValue: number): void {
        this.values.push(newValue);
        if(this.values.length > this.historySize) {
            this.values.shift();
        }
    }
    public GetExpectedValue(): number {
        let values = filterOutliers(this.values);
        if(values.length === 0) return 0;
        let sum = values.reduce((x, y) => x + y, 0);
        return sum / values.length;
    }
}
let serverTimeOffsets = new ValuesExpectedValue(10);
let remoteServer: ITimeServer|undefined;
/** Returns the current time (in milliseconds).
 * setRemoteServer must be called before this (even if you are the server, and just pass in an instance running locally). */
export function getTimeSynced(): number {
    return toRemoteTimeSynced(Date.now());
}
function toRemoteTimeSynced(localTime: number): number {
    if(remoteServer === undefined) {
        throw new Error(`setRemoteServer must be called before getTimeSynced`);
    }

    let serverTimeOffset = serverTimeOffsets.GetExpectedValue();
    //serverTimeOffset = 0;

    return localTime + serverTimeOffset;
}
export function setTimeServer(server: ITimeServer): void {
    if(remoteServer === server) return;
    if(remoteServer !== undefined) {
        throw new Error(`Remote server already set, and the newly set server is different than server.`);
    }
    remoteServer = server;
    timeSyncLoop(server);
}

// https://stackoverflow.com/questions/20811131/javascript-remove-outlier-from-an-array
function filterOutliers(someArray: number[]): number[] {  
    // Copy the values, rather than operating on references to existing values
    var values = someArray.concat();

    // Then sort
    values.sort((a, b) => a - b);

    /* Then find a generous IQR. This is generous because if (values.length / 4) 
     * is not an int, then really you should average the two elements on either 
     * side to find q1.
     */     
    var q1 = values[Math.floor((values.length / 4))];
    // Likewise for q3. 
    var q3 = values[Math.ceil((values.length * (3 / 4)))];
    var iqr = q3 - q1;

    // Then find min and max values
    var maxValue = q3 + iqr*1.5;
    var minValue = q1 - iqr*1.5;

    // Then filter anything beyond or beneath these values.
    var filteredValues = values.filter(x => (x >= minValue) && (x <= maxValue));

    // Then return
    return filteredValues;
}

function timeSyncLoop(timeServer: ITimeServer) {
    (async () => {
        while(true) {
            await SetTimeoutAsync(1000);

            let clientTime = +new Date();

            let before = +new Date();
            let serverTime = await timeServer.getTime();
            let after = +new Date();

            let latencyMs = (after - before) / 2;

            let serverTimeOffset = serverTime - clientTime - latencyMs;
            //console.log({serverTimeOffset, latencyMs});

            serverTimeOffsets.AddValue(serverTimeOffset);
        }
    })().then(() => {
        console.error(`Time sync loop terminated, this is bad.`);
    }).catch((e) => {
        console.error(`Time sync loop crashed, this is bad.`, e);
    });
}