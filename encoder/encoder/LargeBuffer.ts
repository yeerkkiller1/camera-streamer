import  * as fs from "fs";
import { Buffer } from "buffer";

import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";


export const MaxUInt32 = Math.pow(2, 32) - 1;

export class LargeBuffer {
    static FromFile(path: string): LargeBuffer {
        // Try a single Buffer
        try {
            let buf = fs.readFileSync(path);
            return new LargeBuffer([buf]);
        } catch(e) {
            if(!(e instanceof RangeError)) {
                throw e;
            }
        }

        // It's preferable to not use statSync, as it is not safe as the file may change after we open it.
        //  But if it's a very large file... screw it.

        let stats = fs.statSync(path);

        let readPos = 0;
        let fsHandler = fs.openSync(path, "r");

        let buffers: Buffer[] = [];

        while(readPos < stats.size) {
            let currentReadSize = Math.min(MaxUInt32, stats.size - readPos);
            let buf = new Buffer(currentReadSize);
            fs.readSync(fsHandler, buf, 0, currentReadSize, readPos);
            readPos += currentReadSize;

            buffers.push(buf);
        }

        return new LargeBuffer(buffers);
    }

    private bufferStarts: number[];
    constructor(private buffers: Buffer[]) {
        this.bufferStarts = [];
        let pos = 0;
        for(let i = 0; i < buffers.length; i++) {
            this.bufferStarts.push(pos);
            pos += buffers[i].length;
        }
        this.bufferStarts.push(pos);
    }

    private getBuffer(pos: number): { bufferPos: number; buffer: Buffer; } {
        // Eh... we shouldn't need a binary search here. Although... maybe...
        let after = this.bufferStarts.findIndex(end => end > pos);
        if(after < 0) {
            throw new Error(`Tried to read beyond end of buffers. Pos ${pos}`);
        }
        let bufferIndex = after - 1;
        let bufferStart = this.bufferStarts[bufferIndex];
        let buffer = this.buffers[bufferIndex];

        return {
            bufferPos: pos - bufferStart,
            buffer
        };
    }

    private getSmallBuffer(pos: number, length: number): Buffer {
        let buf = new Buffer(length);
        for(let i = 0; i < length; i++) {
            let absolutePos = pos + i;
            let bufInfo = this.getBuffer(absolutePos);
            let byte = bufInfo.buffer.readUInt8(bufInfo.bufferPos);
            buf[i] = byte;
        }
        return buf;
    }

    public readIntBE: typeof Buffer.prototype.readIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readIntBE(0, byteLength);
    };

    public readUIntBE: typeof Buffer.prototype.readUIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readUIntBE(0, byteLength);
    };

    public readUInt32BE: typeof Buffer.prototype.readUInt32BE = (offset) => {
        return this.getSmallBuffer(offset, 4).readUInt32BE(0);
    };

    public readUInt64BE(offset: number) {
        let buf = this.getSmallBuffer(offset, 8);
        return readUInt64BE(buf, 0);
    }
}