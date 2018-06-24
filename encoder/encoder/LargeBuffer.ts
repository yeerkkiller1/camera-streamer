import  * as fs from "fs";
import { Buffer } from "buffer";

import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { range, flatten } from "./util/misc";
import { byteToBits, bitsToByte, Bit } from "./Primitives";
import { isArray } from "./util/type";
import { createWriteStream } from "fs";
import { copyBufferWriteContext, getBufferWriteContext, WriteContextRange, getBufferWriteContextRanges, setBufferWriteContext } from "./BinaryCoder";


export const MaxUInt32 = Math.pow(2, 32) - 1;

let id = 0;

export class LargeBuffer {
    UID = (id++).toString();
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

    /** Must be positive */
    private bitStartOffset = 0;
    /** Must be negative */
    private bitEndOffset = 0;
    private buffers: Buffer[];

    private creator = new Error().stack;
    constructor(buffers: (Buffer|(Bit[])|LargeBuffer)[]) {
        // buffers -> this.buffers
        this.buffers = [];

        // Okay... if there are BitBuffers, or LargeBuffers with bitOffsets, then we convert everything to bits,
        //  and then create Buffers, and have a bitOffset (which may be 0).

        let outputBuffers: Buffer[] = [];

        if(buffers.some(x => isArray(x) || x instanceof LargeBuffer && (x.bitStartOffset !== 0 || x.bitEndOffset !== 0))) {
            // Bit offset, convert everything to bits.
            let bitCount = buffers.reduce((prev, x) => prev + LargeBuffer.GetBitCount(x), 0);

            //console.log(`Combining bits. ${bitCount} bits in total. If that number is really high, it means you have a large file that is offset by a bit amount, OR, some parsing code didn't properly create a new LargeBuffer to reduce bit align data before it was combined with another large buffer. (It also means this will take FOREVER).`);
            let finalRanges: WriteContextRange[] = [];

            let finalBits: Bit[] = [];
            for(let i = 0; i < buffers.length; i++) {
                let curBuf = buffers[i];

                let expectedSize = LargeBuffer.GetBitCount(curBuf);
                let curBitsObj = LargeBuffer.ToBits(curBuf);

                let offset = ~~(finalBits.length / 8);
                let ranges = curBitsObj.ranges;

                for(let range of ranges) {
                    range.start += offset;
                    range.end += offset;
                    finalRanges.push(range);
                }

                let curBits = curBitsObj.bits;
                if(curBits.length !== expectedSize) {
                    throw new Error(`Buffer combined incorrectly. Should have been ${expectedSize} bits, was ${curBits.length} bits`);
                }
                for(let bit of curBits) {
                    finalBits.push(bit);
                }
            }

            
            
            

            //console.log(`Combining buffers summing to ${finalBits} (${finalBits.length}) to bits, ${this.UID}`);

            let extraBits = finalBits.length % 8;
            if(extraBits !== 0) {
                let dummyBits = 8 - extraBits;
                this.bitEndOffset = -dummyBits;
                //console.log({bitEndOffset: this.bitEndOffset});
                for(let i = 0; i < dummyBits; i++) {
                    finalBits.push(0);
                }
            }

            // Now make the bits into bytes.
            let bytes: number[] = [];
            let totalBytes = finalBits.length / 8;
            if(~~totalBytes !== totalBytes) {
                throw new Error(`impossible`);
            }
            for(let i = 0; i < totalBytes; i++) {
                let bits = finalBits.slice(i * 8, i * 8 + 8);
                let byte = bitsToByte(bits);
                bytes.push(byte);
            }

            // Now bytes into buffers.
            let bytePos = 0;
            while(bytePos < bytes.length) {
                let curByteCount = Math.min(MaxUInt32, bytes.length - bytePos);
                let curBytes = bytes.slice(bytePos, bytePos + curByteCount);
                let curBuffer = new Buffer(curBytes);


                outputBuffers.push(curBuffer);

                bytePos += curByteCount;
            }
            this.buffers = outputBuffers;

            //console.log("finalRanges", finalRanges);
            for(let range of finalRanges) {
                setBufferWriteContext(this, range.context, range);
            }

        } else {
            // Nothing funny, just combine them regularly
            for(let buf of buffers) {
                if(isArray(buf)) {
                    throw new Error(`impossible`);
                }
                if(buf instanceof Buffer) {
                    outputBuffers.push(buf);
                    continue;
                }
                if(buf instanceof LargeBuffer) {
                    if(buf.bitStartOffset !== 0) {
                        throw new Error(`impossible`);
                    }
                    if(buf.bitEndOffset !== 0) {
                        throw new Error(`impossible`);
                    }
                    for(let b of buf.buffers) {
                        outputBuffers.push(b);
                    }
                    continue;
                }

                let no: never = buf;
                throw new Error(`Buffer type not handled`);
            }
            this.buffers = outputBuffers;
        }

        this.bufferStarts = [];
        let pos = 0;
        for(let i = 0; i < this.buffers.length; i++) {
            this.bufferStarts.push(pos);
            pos += this.buffers[i].length;
        }
        this.bufferStarts.push(pos);
    }

    private static ToBits(buffer: Buffer|(Bit[])|LargeBuffer): {bits: Bit[], ranges: WriteContextRange[]} {
        if(isArray(buffer)) {
            return {bits: buffer, ranges: []};
        }
        if(buffer instanceof Buffer) {
            console.log("ToBit removing context", getBufferWriteContext(buffer));
            return {bits: flatten(Array.from(buffer).map(x => byteToBits(x))), ranges: []};
        }
        if(buffer instanceof LargeBuffer) {
            let buffers = buffer.buffers;

            //todonext
            // Preserve the context!

            let ranges: WriteContextRange[] = [];

            let bitPos = 0;
            for(let b of buffers) {
                let offset = ~~(bitPos / 8);
                let bitSize = LargeBuffer.GetBitCount(b);
                bitPos += bitSize;

                for(let range of getBufferWriteContextRanges(b)) {
                    let newRange = {...range};
                    newRange.start += offset;
                    newRange.end += offset;
                    ranges.push(newRange);
                }
            }

            let bits: Bit[] = flatten(flatten(buffers.map(x => Array.from(x).map(x => byteToBits(x)))));

            if(buffer.bitStartOffset !== 0) {
                if(buffer.bitStartOffset < 0) {
                    throw new Error(`bitStartOffset is negative, it should not be. ${buffer.bitStartOffset}`);
                }
                bits = bits.slice(buffer.bitStartOffset);
            }

            if(buffer.bitEndOffset !== 0) {
                if(buffer.bitEndOffset > 0) {
                    throw new Error(`bitEndOffset is positive, it should not be. ${buffer.bitEndOffset}`);
                }
                bits = bits.slice(0, buffer.bitEndOffset);
            }
            return {bits, ranges};
        }

        let no: never = buffer;
        throw new Error(`Buffer type not handled`);
    }

    public static GetBitCount(x: Buffer|(Bit[])|LargeBuffer): number {
        return (
            (x instanceof Buffer) ? x.length * 8 :
            (x instanceof LargeBuffer) ? (x.buffers.reduce((prev, x) => prev + x.length * 8, 0) - x.bitStartOffset + x.bitEndOffset) :
            x.length
        );
    }

    private verifyByteAligned() {
        if(this.bitStartOffset !== 0 || this.bitEndOffset !== 0) {
            console.log(this.creator);
            throw new Error(`Buffer still had a bit offset, and so most operations are invalid on it. It can be combined with another BitBuffer in the constructor to make it valid. Buffer had ${LargeBuffer.GetBitCount(this)} bits, UID ${this.UID}`);
        }
    }
    public WriteToFile(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.verifyByteAligned();

                let stream = createWriteStream(path);
                stream.once("open", (fd) => {
                    try {
                        for(let buf of this.buffers) {
                            stream.write(buf);
                        }
                        stream.end();
                        // Don't call close
                        // (https://github.com/nodejs/node/issues/5631)
                    } catch(e) {
                        reject(e);
                    }
                });
                stream.once("close", () => {
                    resolve();
                });
            } catch(e) {
                reject(e);
            }
        });
    }

    private getBuffer(pos: number): {
        // Gets the position within the buffer of the position requested
        bufferPos: number;
        buffer: Buffer;
    } {
        this.verifyByteAligned();

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
        this.verifyByteAligned();

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
        this.verifyByteAligned();

        return this.bufferStarts[this.bufferStarts.length - 1];
    }

    public readIntBE: typeof Buffer.prototype.readIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readIntBE(0, byteLength);
    };

    public readUIntBE: typeof Buffer.prototype.readUIntBE = (offset, byteLength) => {
        return this.getSmallBuffer(offset, byteLength).readUIntBE(0, byteLength);
    };

    public readUInt8: typeof Buffer.prototype.readUInt8 = (offset) => {
        let bufInfo = this.getBuffer(offset);
        return bufInfo.buffer.readUInt8(bufInfo.bufferPos);
    };

    public readUInt32BE: typeof Buffer.prototype.readUInt32BE = (offset) => {
        return this.getSmallBuffer(offset, 4).readUInt32BE(0);
    };

    public readUInt64BE(offset: number) {
        let buf = this.getSmallBuffer(offset, 8);
        return readUInt64BE(buf, 0);
    }

    public setUInt8(pos: number, byte: number): void {
        let bufInfo = this.getBuffer(pos);
        bufInfo.buffer.writeUInt8(byte, bufInfo.bufferPos);
    }

    public slice(start: number, end: number): LargeBuffer {
        this.verifyByteAligned();

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