import { appendFilePromise, readFilePromise, openReadPromise, readDescPromise, existsFilePromise, statFilePromise, closeDescPromise, writeFilePromise, openWritePromise, writeDescPromise, unlinkFilePromise } from "../util/fs";
import { keyBy, profile } from "../util/misc";
import { sort, insertIntoListMap, findAtIndex } from "../util/algorithms";
import { TransformChannel } from "pchannel";
import { PChannelMultiListen } from "../receiver/PChannelMultiListen";
import { RoundRecordTime } from "./TimeMap";
import { max } from "../util/math";
import { NALManager, createNALManager } from "./NALManager";
import { Downsampler, DownsampledInstance } from "./Downsampler";
import { MuxVideo } from "mp4-typescript";

let path = "./dist/";

/** Used for both pure local data, and for after we load data from S3 (and then have to store it on disk, because
 *      the raspberry pi 3 only has 1GB of memory, and each chunk will easily be 100MB). */
export interface NALStorage {
    AddNAL(val: NALHolderMin): Promise<void>|void;

    GetNALTimes(): NALIndexInfo[];
    
    ReadNALs(times: number[]): Promise<NALHolderMin[]>;
    SubscribeToNALTimes(callback: (nalTime: NALInfoTime) => void): () => void;
}

export async function boot() {
    if(true as boolean) return;
    let rate = new LocalNALRate(1);
    await rate.Init();

    let times = rate.GetNALTimes();
    let nals = await rate.ReadNALs(times.slice(0, 2).map(x => x.time));

    let video = await MuxVideo({
        sps: nals[0].sps,
        pps: nals[0].pps,
        width: nals[0].width,
        height: nals[0].height,
        baseMediaDecodeTimeInSeconds: 0,
        frames: nals.map(x => ({
            frameDurationInSeconds: 1,
            nal: x.nal
        }))
    });


    /*
    try {
        let ratesBuffer = await readFilePromise(LocalNALRate.RatePath);
        let rates = ratesBuffer.toString().split("\n").slice(0, -1).map(x => +x);
        sort(rates, x => x);

        for(let rate of rates) {
            try { await unlinkFilePromise(path + `${rate}x.nal`); } catch(e) {}
            try { await unlinkFilePromise(path + `${rate}x.index`); } catch(e) {}
        }

        await unlinkFilePromise(LocalNALRate.RatePath);
    } catch(e) { }

    

    let nalManager = await createNALManager();

    class NALAdder implements DownsampledInstance<NALHolderMin> {
        constructor(public Rate: number) { }
        public async AddValue(nal: NALHolderMin): Promise<void> {
            await nalManager.AddNAL({...nal, rate: this.Rate});
        }
    }

    let downsampler = new Downsampler(4, NALAdder, 0);
    let nextAddSeqNum = 0;

    try {
        await readNalLoop(path + "base.nal", async nal => {
            nal.addSeqNum = nextAddSeqNum++;
            await downsampler.AddValue(nal);
        });
    } catch(e) {
        if(e !== stop) {
            throw e;
        }
    }
    */
    console.log("done boot");
}

function writeNal(nalInfo: NALHolderMin): Buffer {
    let buffer = Buffer.alloc(
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
        // addSeqNum
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

    buffer.writeDoubleLE(nalInfo.addSeqNum || 0, pos); pos += 8;

    nalInfo.sps.copy(buffer, pos); pos += nalInfo.sps.length;
    nalInfo.pps.copy(buffer, pos); pos += nalInfo.pps.length;
    nalInfo.nal.copy(buffer, pos); pos += nalInfo.nal.length;

    if(pos !== buffer.length) {
        throw new Error(`Length calculation is wrong. Calculated length ${buffer.length}, but used length ${pos}`);
    }

    return buffer;
}

function hasCompleteNal(nalFullBuffer: Buffer, pos: number): boolean {
    let minBytes = 8 * 9;
    if(nalFullBuffer.length < pos + minBytes) {
        return false;
    }

    let spsLength = nalFullBuffer.readDoubleLE(pos + 5 * 8);
    let ppsLength = nalFullBuffer.readDoubleLE(pos + 6 * 8);
    let nalLength = nalFullBuffer.readDoubleLE(pos + 7 * 8);

    return nalFullBuffer.length >= pos + minBytes + spsLength + ppsLength + nalLength;
}
function readNal(nalFullBuffer: Buffer, warnOnIncomplete = true, pos = 0): NALHolderMin & {len: number} {
    let startPos = pos;
    let rate = nalFullBuffer.readDoubleLE(pos); pos += 8;
    if(rate === 0) {
        throw new Error(`Read invalid NAL. Rate was 0, from buffer ${Array.from(nalFullBuffer)}`);
    }

    let time = nalFullBuffer.readDoubleLE(pos); pos += 8;
    time = RoundRecordTime(time);
    let type = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let width = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let height = nalFullBuffer.readDoubleLE(pos); pos += 8;

    if(Math.round(width) !== width) {
        throw new Error(`Width is not an integer. Data is likely corrupted. Start pos ${startPos}`);
    }

    let spsLength = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let ppsLength = nalFullBuffer.readDoubleLE(pos); pos += 8;
    let nalLength = nalFullBuffer.readDoubleLE(pos); pos += 8;

    let addSeqNum = nalFullBuffer.readDoubleLE(pos); pos += 8;

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
        addSeqNum,
        len: pos - startPos
    };
}

export async function readNalLoop(nalFilePath: string, onNal: (nal: NALHolderMin & {len: number}) => Promise<void>|void): Promise<void> {
    let remainingBuf: Buffer|undefined;
    let nalStats = await statFilePromise(nalFilePath);
    let fd = await openReadPromise(nalFilePath);
    let absPos = 0;
    try {
        let nalPos = 0;
        while(nalPos < nalStats.size) {
            let curSize = Math.min(Math.pow(2, 30) - 1, nalStats.size - nalPos);
            let buf = await readDescPromise(fd, nalPos, curSize);
            if(remainingBuf) {
                // Lol. So... if we don't copy remainingBuf, then Buffer.concat will reference the original buffer remainingBuf is from,
                //  which will prevent it from being deallocated, which will prevent all memory from being deallocated, which
                //  will cause us to run out of memory.
                /*
                let copyBuffer = Buffer.alloc(remainingBuf.length);
                remainingBuf.copy(copyBuffer);
                remainingBuf = copyBuffer;
                */
                buf = Buffer.concat([remainingBuf, buf]);
                remainingBuf = undefined;
            }
            let pos = 0;
            while(pos < buf.length && hasCompleteNal(buf, pos)) {
                let nal = readNal(buf, false, pos);
                await onNal(nal);
                pos += nal.len;
                absPos += nal.len;
            }

            if(pos < buf.length) {
                remainingBuf = buf.slice(pos);
                console.log(`Creating remainingBuf size ${remainingBuf.length}, pos ${absPos}`);
            }

            nalPos += curSize;
        }

        if(remainingBuf !== undefined) {
            throw new Error(`Last nal is truncated or corrupted? For file: ${nalFilePath}, extra ${remainingBuf.length} bytes`);
        }
    } finally {
        await closeDescPromise(fd);
    }
}

// TODO: S3 storage
//  REMEMBER! You can't split P frames from their I frames. We need to keep them together, or else it won't play!

export class LocalNALRate implements NALStorage {
    public static RatePath = path + "rates.txt";

    private nalTimeChannel = new PChannelMultiListen<NALInfoTime>();

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
        await profile(`Init ${this.Rate}`, async () => {
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
                    let index: NALIndexInfo[] = [];
                    let indexContents!: Buffer;

                    //await profile(`read contents ${this.Rate}`, async () => {
                        indexContents = await readFilePromise(this.indexFilePath);
                    //});
                    //await profile(`parse file ${this.Rate}`, async () => {
                        let contents = indexContents.toString().replace(/\n/g, ",").slice(0, -1);
                        index = JSON.parse("[" + contents + "]");
                        for(let nal of index) {
                            if(!("width" in nal)) {
                                throw new Error(`Outdated NAL format`);
                            }
                            if(!("addSeqNum" in nal)) {
                                throw new Error(`Outdated NAL format`);
                            }
                            nal.time = RoundRecordTime(nal.time);
                        }
                    //});
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

                    //await profile(`sort ${this.Rate}`, async () => {
                        this.nalInfos = index;
                        sort(this.nalInfos, x => x.time);
                    //});
                    this.nalInfoLookup = keyBy(this.nalInfos, x => String(x.time));
                })();
                //console.log(`Loaded LocalNALRate ${this.Rate}`);
                return;
            } catch(e) {
                console.error(`Failed to read index file for rate ${this.Rate} even though the nal file exists. We are going to try to generate the index from the nal file. The Error was ${e.toString()}`);
            }

            // TODO: Eh... if the nal file is corrupted we should rename the nal file. And ignore the error. But... we don't want
            //  too many nal files, so maybe always rename to the same file, so it overwrites it?

            // TODO: Oh... we need to handle files > 2GB, which is almost certain to be the case here.

            this.nalInfos = [];
            let absPos = 0;
            await readNalLoop(this.nalFilePath, nal => {
                this.nalInfos.push({
                    rate: this.Rate,
                    pos: absPos,
                    len: nal.len,
                    time: nal.time,
                    type: nal.type,
                    width: nal.width,
                    height: nal.height,
                    addSeqNum: nal.addSeqNum,
                });
                absPos += nal.len;
            });
            
            sort(this.nalInfos, x => x.time);
            this.nalInfoLookup = keyBy(this.nalInfos, x => String(x.time));

            try {
                await unlinkFilePromise(this.indexFilePath);
            } catch(e) { }

            let i = 0;
            let chunkSize = 10000;
            while(i < this.nalInfos.length) {
                let size = Math.min(chunkSize, this.nalInfos.length - i);
                let nals = this.nalInfos.slice(i, i + size);

                let nalInfosText = nals.map(x => JSON.stringify(x) + "\n").join("");
                await appendFilePromise(this.indexFilePath, nalInfosText);
                console.log(`Wrote part at ${i}, length ${size}`);

                i += size;
            }
            console.log(`Rewrote index file ${this.Rate}`);
        });
    }

    private writeLoop = TransformChannel<{nalFullBuffer: Buffer, indexObj: NALIndexInfo}, void>(async input => {
        await Promise.all([
            appendFilePromise(this.nalFilePath, input.nalFullBuffer),
            appendFilePromise(this.indexFilePath, JSON.stringify(input.indexObj) + "\n")
        ]);
    });
    public async AddNAL(nalInfo: NALHolderMin): Promise<void> {

        // We need to store all of NALMinInfo on disk here, because the index file is optional
        let nalFullBuffer = writeNal(nalInfo);

        let indexObj: NALIndexInfo = {
            rate: nalInfo.rate,
            pos: this.curByteLocation,
            len: nalFullBuffer.length,
            time: nalInfo.time,
            type: nalInfo.type,
            width: nalInfo.width,
            height: nalInfo.height,
            addSeqNum: nalInfo.addSeqNum
        };
        (indexObj as any).toString = function() {
            return JSON.stringify(this);
        };
        // TODO: We need to store some nal buffers in memory, because right now we add stuff to index before
        //  we confirm the disk write. And I don't want to block on the disk write, so...
        //console.log(`Adding ${indexObj.time} to ${this.Rate}`);
        insertIntoListMap(this.nalInfos, indexObj, x => x.time);
        this.nalInfoLookup[indexObj.time] = indexObj;

        this.curByteLocation += nalFullBuffer.length;

        //this.writeLoop({ nalFullBuffer, indexObj });
        await appendFilePromise(this.nalFilePath, nalFullBuffer),
        await appendFilePromise(this.indexFilePath, JSON.stringify(indexObj) + "\n")

        this.nalTimeChannel.SendValue({
            time: nalInfo.time,
            type: nalInfo.type,
            rate: nalInfo.rate,
            width: nalInfo.width,
            height: nalInfo.height,
            addSeqNum: nalInfo.addSeqNum,
        });
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

    public SubscribeToNALTimes(callback: (nalTimes: NALInfoTime) => void): () => void {
        return this.nalTimeChannel.Subscribe(callback);
    }
}