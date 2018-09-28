import { RoundRecordTime } from "./TimeMap";
import { sort } from "../util/algorithms";

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
export async function readNalLoop(storage: StorageBase, nalFilePath: string, onNal: (nal: NALHolderMin & {len: number}) => Promise<void>|void): Promise<IsLive> {
    let remainingBuf: Buffer|undefined;

    // Changed to not be a loop, and to just read everything at once. Because... chunks don't resize, so they will be small,
    //  and have to be kept in memory when we read them from remote systems, so keeping them in memory when we read them from
    //  the local disk isn't a problem.
    
    let buf = await storage.GetFileContents(nalFilePath);
    let absPos = 0;
    try {
        while(absPos < buf.length && hasCompleteNal(buf, absPos)) {
            if(buf[absPos] !== 0) {
                return false;
            }
            let nal = readNal(buf, false, absPos);
            await onNal(nal);
            absPos += nal.len;
        }
    } catch(e) {
        throw new Error(`Error at absPos: ${absPos}, ${e.message}`);
    }

    if(absPos < buf.length) {
        remainingBuf = buf.slice(absPos);
        console.log(`Creating remainingBuf size ${remainingBuf.length}, pos ${absPos}`);
    }

    if(remainingBuf !== undefined) {
        if(remainingBuf.length === 1 && remainingBuf[0] === 0) {
            return false;
        }

        console.log(remainingBuf);
        throw new Error(`Last nal is truncated or corrupted? For file: ${nalFilePath}, extra ${remainingBuf.length} bytes`);
    }

    return true;
}

export async function loadIndexFromDisk(storage: StorageBase, nalFilePath: string, indexFilePath: string): Promise<{
    index: NALIndexInfo[];
    isLive: boolean;
} | undefined> {
    //return await profile(`Init ${nalFilePath}`, async () => {
        let nalExists = await storage.Exists(nalFilePath);
        let indexExists = await storage.Exists(indexFilePath);
        if(!nalExists) {
            if(indexExists) {
                console.warn(`Found index file but no nal file. Index: ${indexFilePath}, nal: ${nalFilePath}`);
            }

            return;
        }

        let isLive = true;

        try {
            let index: NALIndexInfo[] = [];
            {
                let indexContents = await storage.GetFileContents(indexFilePath);
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
            if(!isLive) {
                predictedEnd += 1;
            }
            let size = await storage.GetFileSize(nalFilePath);
            if(predictedEnd !== size) {
                throw new Error(`Index and nal file don't specify the same size. The index thinks the nal file is ${predictedEnd} long, but the nal file is really ${size}`);
            }
            
            let nalInfos = index;
            sort(nalInfos, x => x.time);
            
            return { index: nalInfos, isLive };
        } catch(e) {
            console.error(`Failed to read index file even though the nal file exists. We are going to try to generate the index from the nal file. File ${nalFilePath}. The Error was ${e.toString()}`);
        }

        // TODO: Eh... if the nal file is corrupted we should rename the nal file. And ignore the error. But... we don't want
        //  too many nal files, so maybe always rename to the same file, so it overwrites it?

        let nalInfos: NALIndexInfo[] = [];
        let absPos = 0;
        isLive = await readNalLoop(storage, nalFilePath, nalHolder => {
            let { nal, sps, pps, len, ... indexInfo } = nalHolder;
            nalInfos.push({ ...indexInfo, pos: absPos, len });
            absPos += len;
        });
        
        sort(nalInfos, x => x.time);

        await writeIndexFile(storage, indexFilePath, nalInfos, isLive);

        return { index: nalInfos, isLive };
    //});
}

export function writeNALToDisk(
    storage: StorageBaseAppendable, 
    fileBasePath: string,
    nalHolder: NALHolderMin,
    pos: number,
): {
    fnc: () => Promise<void>;
    len: number;
} {
    let nalFullBuffer = writeNal(nalHolder);
    let nalIndexObj: NALIndexInfo = {
        pos: pos,
        len: nalFullBuffer.length,
        rate: nalHolder.rate,
        time: nalHolder.time,
        type: nalHolder.type,
        width: nalHolder.width,
        height: nalHolder.height,
        addSeqNum: nalHolder.addSeqNum,
    };

    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    return {
        len: nalFullBuffer.length,
        fnc: async () => {
            await Promise.all([
                storage.AppendData(nalFilePath, nalFullBuffer),
                storage.AppendData(indexFilePath, JSON.stringify(nalIndexObj) + "\n")
            ]);
        }
    };
}

export async function readNALsBulkFromDisk(storage: StorageBase, fileBasePath: string): Promise<Buffer> {
    return storage.GetFileContents(fileBasePath + ".nal");
}

export async function writeNALsBulkToDisk(storage: StorageBase, fileBasePath: string, nalsBulk: Buffer, index: NALIndexInfo[], isLive: boolean): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    index = index.map(x => ({
        pos: x.pos,
        len: x.len,
        rate: x.rate,
        time: x.time,
        type: x.type,
        width: x.width,
        height: x.height,
        addSeqNum: x.addSeqNum,
    }))

    
    await Promise.all([
        storage.SetFileContents(nalFilePath, nalsBulk),
        writeIndexFile(storage, indexFilePath, index, isLive),
    ]);
}

async function writeIndexFile(storage: StorageBase, indexFilePath: string, index: NALIndexInfo[], isLive: boolean): Promise<void> {
    // Delete the index file if it exists, as it is garbage
    try {
        await storage.DeleteFile(indexFilePath);
    } catch(e) { }

    let indexFile = "";

    // Not sure if this chunking is required here... But it is here, and it works?
    let i = 0;
    let chunkSize = 1000;
    while(i < index.length) {
        let size = Math.min(chunkSize, index.length - i);
        let nals = index.slice(i, i + size);
        let nalInfosText = nals.map(x => JSON.stringify(x) + "\n").join("");
        indexFile += nalInfosText;
        i += size;
    }

    if(!isLive) {
        indexFile += JSON.stringify("finished") + "\n";
    }
    await storage.SetFileContents(indexFilePath, indexFile);
}

export async function finalizeNALsOnDisk(
    storage: StorageBaseAppendable, 
    fileBasePath: string,
): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    await Promise.all([
        storage.AppendData(nalFilePath, Buffer.from([0])),
        storage.AppendData(indexFilePath, JSON.stringify("finished") + "\n")
    ]);
}

export async function deleteNALs(storage: StorageBase, fileBasePath: string): Promise<void> {
    let nalFilePath = fileBasePath + ".nal";
    let indexFilePath = fileBasePath + ".index";

    await storage.DeleteFile(indexFilePath);
    await storage.DeleteFile(nalFilePath);
}

export async function readNALs(storage: StorageBase, fileBasePath: string, nalInfos: NALIndexInfo[], onCancel: Promise<void>): Promise<NALHolderMin[] | "CANCELLED"> {
    let nalFilePath = fileBasePath + ".nal";

    // Eh... remote reads don't allow partial chunk reading anyway, so this should be fine.
    let contents = await Promise.race([storage.GetFileContents(nalFilePath), onCancel]);
    if(contents === undefined) {
        return "CANCELLED";
    }
    let nals: NALHolderMin[] = [];
    for(let obj of nalInfos) {
        let data = contents.slice(obj.pos, obj.pos + obj.len);
        let nal;
        try {
            nal = readNal(data);
        } catch(e) {
            throw new Error(`Error at pos ${obj.pos} in file ${nalFilePath}, ${e.stack}`);
        }
        nals.push(nal);
    }

    return nals;
}