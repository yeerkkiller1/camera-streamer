import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise, existsFilePromise, statFilePromise, closeDescPromise } from "../util/fs";
import { keyBy } from "../util/misc";
import { sort, insertIntoListMap } from "../util/algorithms";
import { TransformChannel } from "pchannel";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";

let path = "./dist/";

/** Used for both pure local data, and for after we load data from S3 (and then have to store it on disk, because
 *      the raspberry pi 3 only has 1GB of memory, and each chunk will easily be 100MB). */
export interface LocalNALStorage {
    AddNAL(val: NALHolderMin): void;
    /** Should return the underlying array, that is automatically updated as new data is read. */
    GetNALTimes(): NALTime[];
    
    ReadNALs(times: number[]): Promise<NALHolderMin[]>;
    SubscribeToNALTimes(callback: (nalTime: NALTime) => void): () => void;
}

function writeNal(nalInfo: NALHolderMin): Buffer {
    let buffer = new Buffer(
        // rate
        8 +
        // time
        8 +
        // type
        8 +
        // width
        8 +
        // height
        8 +
        // sps length
        8 +
        // pps length
        8 +
        // nal length
        8 +
        nalInfo.sps.length +
        nalInfo.pps.length + 
        nalInfo.nal.length
    );
    let pos = 0;
    buffer.writeDoubleLE(nalInfo.rate, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.time, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.type, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.width, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.height, pos); pos += 8;

    buffer.writeDoubleLE(nalInfo.sps.length, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.pps.length, pos); pos += 8;
    buffer.writeDoubleLE(nalInfo.nal.length, pos); pos += 8;

    nalInfo.sps.copy(buffer, pos); pos += nalInfo.sps.length;
    nalInfo.pps.copy(buffer, pos); pos += nalInfo.pps.length;
    nalInfo.nal.copy(buffer, pos); pos += nalInfo.nal.length;

    if(pos !== buffer.length) {
        throw new Error(`Length calculation is wrong. Calculated length ${buffer.length}, but used length ${pos}`);
    }

    return buffer;
}
function readNal(nalFullBuffer: Buffer, warnOnIncomplete = true, pos = 0): NALHolderMin & {len: number} {
    let startPos = pos;
    let rate = nalFullBuffer.readDoubleLE(pos); pos += 8;
    if(rate === 0) {
        throw new Error(`Read invalid NAL. Rate was 0, from buffer ${Array.from(nalFullBuffer)}`);
    }

    let time = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let type = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let width = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let height = nalFullBuffer.readDoubleLE(pos); pos += 8;

    let spsLength = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let ppsLength = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let nalLength = nalFullBuffer.readDoubleLE(pos); pos += 8;

    let sps = nalFullBuffer.slice(pos, pos + spsLength); pos += spsLength;
    let pps = nalFullBuffer.slice(pos, pos + ppsLength); pos += ppsLength;

    let nal = nalFullBuffer.slice(pos, pos + nalLength); pos += nalLength;

    if(pos > nalFullBuffer.length) {
        throw new Error(`Did not find enough bytes to read nal. This nal is corrupted. Required ${pos} bytes, but buffer had ${nalFullBuffer.length} bytes.`);
    }
    if(warnOnIncomplete && pos < nalFullBuffer.length) {
        console.warn(`When reading nal from buffer we found nal, but we also found extra bytes. There should have been ${pos} bytes, but the buffer had ${nalFullBuffer.length} bytes.`);
    }

    return {
        rate,
        time,
        type,
        width,
        height,
        sps,
        pps,
        nal,
        len: pos - startPos
    };
}

// TODO: S3 storage
//  REMEMBER! You can't split P frames from their I frames. We need to keep them together, or else it won't play!

export class LocalNALRate implements LocalNALStorage {
    public static RatePath = path + "rates.txt";

    private nalTimeChannel = new PChannelMultiListen<NALTime>();

    constructor(public Rate: number, private firstInit = false) {
        if(firstInit) {
            console.log(`Created LocalNALRate ${this.Rate}`);
            appendFilePromise(LocalNALRate.RatePath, `${this.Rate}\n`);
        } else {
            console.log(`Loading LocalNALRate ${this.Rate}`);
        }
    }
    
    private nalFilePath = path + `${this.Rate}x.nal`;
    private indexFilePath = path + `${this.Rate}x.index`;

    private curByteLocation = 0;

    // Sorted by time
    private nalInfos: NALIndexInfo[] = [];
    private nalInfoLookup: { [time: number]: NALIndexInfo } = {};

    public async Init() {
        if(!(await existsFilePromise(this.nalFilePath))) {
            if(await existsFilePromise(this.indexFilePath)) {
                console.warn(`Found index file but no nal file. Index: ${this.indexFilePath}, nal: ${this.nalFilePath}`);
            }
            return;
        }

        let nalStats = await statFilePromise(this.nalFilePath);
        this.curByteLocation = nalStats.size;

        try {
            await (async () => {
                let indexContents = await readFilePromise(this.indexFilePath);
                let index = indexContents.toString().split("\n").slice(0, -1).map(x => JSON.parse(x) as NALIndexInfo);
                // Reading the entire nal file defeats the purpose of even having the index file, so
                //  we'll do soft corruption detection.
                // So only check the last nal.
                
                let lastNal = index.last();
                let predictedEnd = lastNal.pos + lastNal.len;
                if(predictedEnd !== nalStats.size) {
                    throw new Error(`Index and nal file don't specify the same size. The index thinks the nal file is ${predictedEnd} long, but the nal file is really ${nalStats.size}`);
                }
                let fd = await openReadPromise(this.nalFilePath);
                try {
                    let nalBuffer = await readDescPromise(fd, lastNal.pos, lastNal.len);
                    let nal = readNal(nalBuffer);
                    
                    if(lastNal.time !== nal.time) {
                        throw new Error(`Last index nal and last real nal have different times. Index ${lastNal.time}, nal ${nal.time}`);
                    }
                    if(lastNal.type !== nal.type) {
                        throw new Error(`Last index nal and last real nal have different types. Index ${lastNal.type}, nal ${nal.type}`);
                    }
                } finally {
                    await closeDescPromise(fd);
                }

                this.nalInfos = index;
                sort(this.nalInfos, x => x.time);
                this.nalInfoLookup = keyBy(this.nalInfos, x => String(x.time));
            })();
        } catch(e) {
            console.error(`Failed to read index file even though the nal file exists. We are going to try to generate the index from the nal file. Error ${e.toString()}`);
        }

        // TODO: Eh... if the nal file is corrupted we should rename the nal file. And ignore the error. But... we don't want
        //  too many nal files, so maybe always rename to the same file, so it overwrites it?

        let nalFile = await readFilePromise(this.nalFilePath);

        this.nalInfos = [];

        let pos = 0;
        while(pos < nalFile.length) {
            let nal = readNal(nalFile, false, pos);
            this.nalInfos.push({
                rate: this.Rate,
                pos: pos,
                len: nal.len,
                time: nal.time,
                type: nal.type
            });
            pos += nal.len;
        }
        sort(this.nalInfos, x => x.time);
        this.nalInfoLookup = keyBy(this.nalInfos, x => String(x.time));
    }

    private writeLoop = TransformChannel<{nalFullBuffer: Buffer, indexObj: NALIndexInfo}, void>(async input => {
        await Promise.all([
            appendFilePromise(this.nalFilePath, input.nalFullBuffer),
            appendFilePromise(this.indexFilePath, JSON.stringify(input.indexObj) + "\n")
        ]);
    });
    public AddNAL(nalInfo: NALHolderMin): void {
        let { sps, pps } = nalInfo;

        // We need to store all of NALMinInfo on disk here, because the index file is optional
        let nalFullBuffer = writeNal(nalInfo);

        let indexObj: NALIndexInfo = {
            rate: nalInfo.rate,
            pos: this.curByteLocation,
            len: nalFullBuffer.length,
            time: nalInfo.time,
            type: nalInfo.type
        };
        (indexObj as any).toString = function() {
            return JSON.stringify(this);
        };
        insertIntoListMap(this.nalInfos, indexObj, x => x.time);
        this.nalInfoLookup[indexObj.time] = indexObj;

        this.curByteLocation += nalFullBuffer.length;

        this.writeLoop({ nalFullBuffer, indexObj });

        this.nalTimeChannel.SendValue({ time: nalInfo.time, type: nalInfo.type, rate: nalInfo.rate });
    }

    public GetNALTimes(): NALIndexInfo[] {
        return this.nalInfos;
    }
    public async ReadNALs(times: number[]): Promise<NALHolderMin[]> {
        // On the raspberry pi 3 it looks like read speed will be around 5MB/s?, so this will be a bottleneck,
        //  but we should have sufficient read speed to handle up to 83KB/frame at 60fps, which SHOULD be enough.
        //  https://www.jeffgeerling.com/blog/2018/raspberry-pi-microsd-card-performance-comparison-2018

        // TODO: Combine continugous writes, which should make this faster?

        let nals: NALHolderMin[];

        let fd = await openReadPromise(this.nalFilePath);
        try {
            nals = await Promise.all(times.map(async x => {
                let obj = this.nalInfoLookup[x];
                let data = await readDescPromise(fd, obj.pos, obj.len);
                let nal = readNal(data);
                return nal;
            }));
        } finally {
            await closeDescPromise(fd);
        }

        return nals;
    }

    public SubscribeToNALTimes(callback: (nalTimes: NALTime) => void): () => void {
        return this.nalTimeChannel.Subscribe(callback);
    }
}