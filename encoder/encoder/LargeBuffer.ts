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

    private getBuffer(pos: number): {
        // Gets the position within the buffer of the position requested
        bufferPos: number;
        buffer: Buffer;
    } {
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

    public getLength() {
        return this.bufferStarts[this.bufferStarts.length - 1];
    }

    public readIntBE: typeof Buffer.prototype.readIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readIntBE(0, byteLength);
    };

    public readUIntBE: typeof Buffer.prototype.readUIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readUIntBE(0, byteLength);
    };

    public readUInt8: typeof Buffer.prototype.readUInt8 = (offset) => {
        return this.getSmallBuffer(offset, 1).readUInt8(0);
    };

    public readUInt32BE: typeof Buffer.prototype.readUInt32BE = (offset) => {
        return this.getSmallBuffer(offset, 4).readUInt32BE(0);
    };

    public readUInt64BE(offset: number) {
        let buf = this.getSmallBuffer(offset, 8);
        return readUInt64BE(buf, 0);
    }

    public slice(start: number, end: number): LargeBuffer {
        let subBuffers: Buffer[] = [];
        let pos = start;
        while (pos < end) {
            let bufObj = this.getBuffer(pos);
            let bufEnd = bufObj.buffer.length - bufObj.bufferPos + pos;

            if(bufObj.bufferPos !== 0 || bufEnd >= end) {
                // If the buffer goes before or after our range, slice it
                let ourEndInBuffer = Math.min(bufObj.buffer.length, bufObj.buffer.length - (bufEnd - end));
                subBuffers.push(bufObj.buffer.slice(bufObj.bufferPos, ourEndInBuffer));
            } else {
                // Just add it raw
                subBuffers.push(bufObj.buffer);
            }

            pos = bufEnd;
        }

        return new LargeBuffer(subBuffers);
    }

    public getInternalBuffer(pos: number): Readonly<Buffer> {
        return this.getBuffer(pos).buffer;
    }
    // Eh... please don't mutate this list. I would make it readonly... but my flatten is dumb and doesn't understand that.
    public getInternalBufferList(): Buffer[] {
        return this.buffers;
    }
}