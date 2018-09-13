import { RoundRecordTime } from "./TimeMap";
import { statFilePromise, openReadPromise, readDescPromise, closeDescPromise, existsFilePromise, readFilePromise, unlinkFilePromise, appendFilePromise, writeFilePromise } from "../util/fs";
import { profile } from "../util/misc";
import { sort } from "../util/algorithms";
import { Deferred } from "pchannel";

function writeNal(nalInfo: NALHolderMin): Buffer {
    let buffer = Buffer.alloc(
        // finished flag
        1 +
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
    buffer.writeUInt8(0, pos); pos += 1;
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
    let minBytes = 8 * 9 + 1;
    if(nalFullBuffer.length < pos + minBytes) {
        return false;
    }

    let spsLength = nalFullBuffer.readDoubleLE(pos + 5 * 8 + 1);
    let ppsLength = nalFullBuffer.readDoubleLE(pos + 6 * 8 + 1);
    let nalLength = nalFullBuffer.readDoubleLE(pos + 7 * 8 + 1);

    return nalFullBuffer.length >= pos + minBytes + spsLength + ppsLength + nalLength;
}

export function readNal(nalFullBuffer: Buffer, warnOnIncomplete = true, pos = 0): NALHolderMin & {len: number} {
    let startPos = pos;

    let finished = nalFullBuffer.readUInt8(pos); pos += 1;

    if(finished !== 0) {
        throw new Error(`Tried to read finished flag. This should not be parsed as a nal.`);
    }

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

type IsLive = boolean;
export async function readNalLoop(nalFilePath: string, onNal: (nal: NALHolderMin & {len: number}) => Promise<void>|void): Promise<IsLive> {
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
                buf = Buffer.concat([remainingBuf, buf]);
                remainingBuf = undefined;
            }
            let pos = 0;
            while(pos < buf.length && hasCompleteNal(buf, pos)) {
                if(buf[pos] !== 0) {
                    return false;
                }
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
    } catch(e) {
        throw new Error(`Error at absPos: ${absPos}, ${e.message}`);
    } finally {
        await closeDescPromise(fd);
    }
    return true;
}

export async function loadIndexFromDisk(nalFilePath: string, indexFilePath: string): Promise<{
    index: NALIndexInfo[];
    isLive: boolean;
} | undefined> {
    return await profile(`Init ${nalFilePath}`, async () => {
        let nalExists = await existsFilePromise(nalFilePath);
        let indexExists = await existsFilePromise(indexFilePath);
        if(!nalExists) {
            if(indexExists) {
                console.warn(`Found index file but no nal file. Index: ${indexFilePath}, nal: ${nalFilePath}`);
            }

            return;
        }

        let isLive = true;
        let nalStats = await statFilePromise(nalFilePath);

        try {
            let index: NALIndexInfo[] = [];
            {
                let indexContents = await readFilePromise(indexFilePath);
                let contents = indexContents.toString().replace(/\n/g, ",").slice(0, -1);
                 
                let indexRaw: (NALIndexInfo|"finished")[] = JSON.parse("[" + contents + "]");
                for(let i = 0; i < indexRaw.length; i++) {
                    let indexObj = indexRaw[i];
                    if(indexObj === "finished") {
                        if(i !== indexRaw.length - 1) {
                            throw new Error(`Index file is corrupted. Has finished flag at position other than end.`);
                        }
                        isLive = false;
                    } else {
                        index.push(indexObj);
                    }
                }
            }
            for(let nal of index) {
                if(!("width" in nal)) {
                    throw new Error(`Outdated NAL format`);
                }
                if(!("addSeqNum" in nal)) {
                    throw new Error(`Outdated NAL format`);
                }
                nal.time = RoundRecordTime(nal.time);
            }
            
            // Reading the entire nal file defeats the purpose of even having the index file, so
            //  we'll do soft corruption detection.
            // So only check the last nal.
            
            let lastNal = index.last();
            let predictedEnd = lastNal.pos + lastNal.len;
            if(predictedEnd !== nalStats.size) {
                throw new Error(`Index and nal file don't specify the same size. The index thinks the nal file is ${predictedEnd} long, but the nal file is really ${nalStats.size}`);
            }

            let fd = await openReadPromise(nalFilePath);
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

            
            let nalInfos = index;
            sort(nalInfos, x => x.time);
            
            return { index: nalInfos, isLive };
        } catch(e) {
            console.error(`Failed to read index file even though the nal file exists. We are going to try to generate the index from the nal file. File ${nalFilePath}. The Error was ${e.toString()}`);
        }

        // TODO: Eh... if the nal file is corrupted we should rename the nal file. And ignore the error. But... we don't want
        //  too many nal files, so maybe always rename to the same file, so it overwrites it?

        // TODO: Oh... we need to handle files > 2GB, which is almost certain to be the case here.

        let nalInfos: NALIndexInfo[] = [];
        let absPos = 0;
        isLive = await readNalLoop(nalFilePath, nalHolder => {
            let { nal, sps, pps, len, ... indexInfo } = nalHolder;
            nalInfos.push({ ...indexInfo, pos: absPos, len });
            absPos += len;
        });
        
        sort(nalInfos, x => x.time);

        await createIndexFile(indexFilePath, nalInfos);

        return { index: nalInfos, isLive };
    });
}

export function writeNALToDisk(
    fileBasePath: string,
    nalHolder: NALHolderMin,
    pos: number
): {
    fnc: () => Promise<void>;
    len: number;
} {
    let nalFullBuffer = writeNal(nalHolder);
    
    let { nal, sps, pps, ...indexObj } = nalHolder;
    let x: NALIndexInfo = { ...indexObj, len: nalFullBuffer.length, pos: pos };

    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    return {
        len: nalFullBuffer.length,
        fnc: async () => {
            await Promise.all([
                appendFilePromise(nalFilePath, nalFullBuffer),
                appendFilePromise(indexFilePath, JSON.stringify(indexObj) + "\n")
            ]);
        }
    };
}

export async function readNALsBulkFromDisk(fileBasePath: string): Promise<Buffer> {
    return readFilePromise(fileBasePath + ".nal");
}

export async function writeNALsBulkToDisk(fileBasePath: string, nalsBulk: Buffer, index: NALIndexInfo[]): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    await Promise.all([
        writeFilePromise(nalFilePath, nalsBulk),
        createIndexFile(indexFilePath, index),
    ]);
}

async function createIndexFile(indexFilePath: string, index: NALIndexInfo[]): Promise<void> {
    // Delete the index file if it exists, as it is garbage
    try {
        await unlinkFilePromise(indexFilePath);
    } catch(e) { }

    // Not sure if this chunking is required here... But it is here, and it works?
    let i = 0;
    let chunkSize = 1000;
    while(i < index.length) {
        let size = Math.min(chunkSize, index.length - i);
        let nals = index.slice(i, i + size);

        let nalInfosText = nals.map(x => JSON.stringify(x) + "\n").join("");
        await appendFilePromise(indexFilePath, nalInfosText);
        console.log(`Wrote part at ${i}, length ${size}`);

        i += size;
    }
    console.log(`Rewrote index file ${indexFilePath}`);
}

export async function finalizeNALsOnDisk(
    fileBasePath: string,
): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    await Promise.all([
        appendFilePromise(nalFilePath, Buffer.from([0])),
        appendFilePromise(indexFilePath, "finished" + "\n")
    ]);
}

export async function deleteNALs(fileBasePath: string): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    await unlinkFilePromise(indexFilePath);
    await unlinkFilePromise(nalFilePath);
}

export async function readNALs(fileBasePath: string, nalInfos: NALIndexInfo[], onCancel: Promise<void>): Promise<NALHolderMin[] | "CANCELLED"> {
    let nalFilePath = fileBasePath + ".nal";

    // Figure out the lock here with TransitionStorage
    let fd = await Promise.race([openReadPromise(nalFilePath), onCancel]);
    if(fd === undefined) {
        return "CANCELLED";
    }
    try {
        let nals: NALHolderMin[] = [];
        for(let obj of nalInfos) {
            let data = await Promise.race([readDescPromise(fd, obj.pos, obj.len), onCancel]);
            if(data === undefined) {
                return "CANCELLED";
            }
            let nal;
            try {
                nal = readNal(data);
            } catch(e) {
                throw new Error(`Error at pos ${obj.pos} in file ${nalFilePath}, ${e.stack}`);
            }
            nals.push(nal);
        }

        return nals;
    } finally {
        try {
            await closeDescPromise(fd);
        } catch(e) {
            console.log(`Error on closing file ${nalFilePath}, ignoring error. ${e}`);
        }
    }
}