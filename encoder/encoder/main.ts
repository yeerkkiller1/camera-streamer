// take ./raw/result0.jpg, ./raw/result1.jpg, ./raw/result2.jpg, ./raw/result3.jpg, ./raw/result4.jpg
//  and put them in a mp4 video file. Like ./raw/test0.mp4 has jpegs inside of it.

import * as fs from "fs";
import { keyBy, arrayEqual, flatten, repeat } from "./util/misc";
import { isArray } from "util";
import { sum } from "./util/math";

function p2(str: string) {
    while(str.length < 2) {
        str = "0" + str;
    }
    return str;
}
function readUInt64BE(buffer: Buffer, pos: number) {
    let high = buffer.readUInt32BE(pos);
    let low = buffer.readUInt32BE(pos + 4);

    let result = high * 4294967296.0 + low;
    if(result > Number.MAX_SAFE_INTEGER || result < 0) {
        throw new Error(`Read int64 value outside of valid range javascript can represent. Read ${result}, it must be under ${Number.MAX_SAFE_INTEGER}. High ${high}, low ${low}`);
    }
    return result;
}
function writeUInt64BE(buffer: Buffer, pos: number, value: number): void {
    if(value > Number.MAX_SAFE_INTEGER || value < 0) {
        throw new Error(`Write int64 value outside of valid range javascript can represent. Write ${value}, it must be under ${Number.MAX_SAFE_INTEGER}.`);
    }

    buffer.writeUInt16BE(0, 0);
    buffer.writeUIntBE(value, pos + 2, 6);
}

function textToUInt32(text: string) {
    if(text.length !== 4) {
        throw new Error(`Expected text of length 4. Received ${text}`);
    }

    return text.charCodeAt(3) + text.charCodeAt(2) * 256 + text.charCodeAt(1) * 256 * 256 + text.charCodeAt(0) * 256 * 256 * 256;
}
function textFromUInt32(num: number) {
    num = num | 0;

    let a = num % 256;
    num -= a;
    num /= 256;
    let b = num % 256;
    num -= b;
    num /= 256;
    let c = num % 256;
    num -= c;
    num /= 256;
    let d = num % 256;
    num -= d;
    num /= 256;

    return String.fromCharCode(d) + String.fromCharCode(c) + String.fromCharCode(b) + String.fromCharCode(a);
}

for(let filePath of [
    //"./raw/test1.mp4",
    "./raw/test5.mp4"
]) {
    console.log(filePath);
    let buffer = fs.readFileSync(filePath);
    

    // https://github.com/emericg/MiniVideo/blob/348ec21b99f939ca6a0ed65a257042434e8b98ec/minivideo/src/import.cpp
    // https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
   
    // https://github.com/emericg/MiniVideo/blob/85bf66dc8d67e6bf3fc71c0e43e4e1495401f39e/minivideo/src/demuxer/mp4/mp4_box.cpp
    // http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf

    /* Box:
    aligned(8) class Box (unsigned int(32) boxtype, optional unsigned int(8)[16] extended_type) {
        unsigned int(32) size;
        unsigned int(32) type = boxtype;
        if (size==1) {
            unsigned int(64) largesize;
        } else if (size==0) {
            // box extends to end of file
        }
        if (boxtype==‘uuid’) {
            unsigned int(8)[16] usertype = extended_type;
        }
    } 
    */

    {
        type P<T> = {v: T};
        type Ctor<T> = {new(): T};

        interface MP4BoxEntryBase<T = any> {
            // I need to write output array elements as soon as I real them, so create a function that lets us do this.
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): T;
            write(value: T): Buffer[];
        }

        interface IBox<T extends string> {
            type: T;
            chooseBox?: (buffer: Buffer, pos: number, end: number, debugPath: string[], parents: BoxMetadata[]) => IBox<T>;
        }

        interface MP4Box {
            [key: string]: MP4BoxEntryBase;
        }

        interface BoxMetadata {
            _box: RawBox;
            _info: MP4Box;
            _property_offsets: { [propName: string]: number };
            _properties: { [name: string]: Types.Primitive|Buffer|BoxMetadata[] };
            nicePath: string;
        }

        function Box(type: string): {  new(): IBox<typeof type> } {
            return class BoxInner implements IBox<typeof type> {
                type = type;
            };
        }
        function FullBox(type: string) {
            return class BoxInner extends Box(type) {
                version = new UInt8();
                flags = new UInt24();
            };
        }

        function FullBoxVersionSplit<T extends string>(type: string, version0: Ctor<IBox<any>>, version1: Ctor<IBox<any>>) {
            return class FullBoxSplit extends FullBox(type) {
                chooseBox = (buffer: Buffer, pos: number, end: number, debugPath: string[], parents: BoxMetadata[]) => {
                    let fullCtor = FullBox(type);
                    let fullBox = parseBoxInfo([new fullCtor()], buffer, {v: pos}, debugPath, parents, undefined, false);
                    if(!fullBox) {
                        throw new Error(`Unexpected type ${type}`);
                    }
                    let version = fullBox._properties["version"];
                    if(typeof version !== "number") {
                        throw new Error(`Version not type number, it is ${version}`);
                    }
                    if(version === 1) {
                        return new version1();
                    } else if(version === 0) {
                        return new version0();
                    } else {
                        throw new Error(`Unexpected version ${version} at ${pos}`);
                    }
                };
            }
        }
        

        class FileBox extends Box("ftyp") {
            major_brand = new UInt32String();
            minor_version = new UInt32();
            compatible_brands = new ArrayToEnd(new UInt32String());
        }
        class MoovBox extends Box("moov") {
            boxes = new BoxEntryToEnd(
                new MvhdBox(),
                new TrakBox(),
                new UdtaBox(),
            );
        }
        class FreeBox extends Box("free") {
            data = new ArrayToEnd(new UInt8());
        }
        class MdatBox extends Box("mdat") {
            data = new MdatEntry();
        }
        class MdatEntry implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): Uint8Array {
                let bytes = buffer.slice(pPos.v, end);
                pPos.v = end;
                return bytes;
            }
            write(bytes: Uint8Array): Buffer[] {
                return [new Buffer(bytes)];
            }
        }

        class UdtaBox extends Box("udta") {
            // "Only a copyright notice is defined in this specification.",
            //  but also, people but meta in here.
            boxes = new BoxEntryToEnd(new MetaBox);
        }
        class MetaBox extends FullBox("meta") {
            //todonext
            // Hmm... this handler is going to be crazy. Better just copy
            //  https://github.com/emericg/MiniVideo/blob/85bf66dc8d67e6bf3fc71c0e43e4e1495401f39e/minivideo/src/demuxer/mp4/mp4.cpp#L313
            //  and print a lot.
            // I think it switches its type depending on the data given
            // OR, just don't implement it, and see if we can remove it.
            //tests = new Print();
            remaining = new ArrayToEnd(new UInt8());
        }
        class Print implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]) {
                for(let i = pPos.v; i < end; i++) {
                    let ch = buffer.readInt8(i);
                    process.stdout.write(String.fromCharCode(ch));
                }
                process.stdout.write("\n");
                pPos.v = end;
            }
            write(): Buffer[] {
                throw new Error(`Print.write is not implemented`);
            }
        }

        class MvhdBox0 extends FullBox("mvhd") {
            creation_time = new UInt32();
            modification_time = new UInt32();
            timescale = new UInt32();
            duration = new UInt32();

            rate = new NumberShifted(new Int32(), 0x00010000);
            volume = new NumberShifted(new Int16(), 0x0100);

            reserved = new UInt16();
            reserved0 = new UInt32();
            reserved1 = new UInt32();

            matrix = new NArray(new Int32(), 9);
            pre_defined = new NArray(new UInt32(), 6);

            next_track_ID = new Int32();
        }
        class MvhdBox1 extends FullBox("mvhd") {
            creation_time = new UInt64();
            modification_time = new UInt64();
            timescale = new UInt32();
            duration = new UInt64();

            rate = new NumberShifted(new Int32(), 0x00010000);
            volume = new NumberShifted(new Int16(), 0x0100);

            reserved = new UInt16();
            reserved0 = new UInt32();
            reserved1 = new UInt32();

            matrix = new NArray(new Int32(), 9);
            pre_defined = new NArray(new UInt32(), 6);

            next_track_ID = new Int32();
        }
        const MvhdBox = FullBoxVersionSplit("mvhd", MvhdBox0, MvhdBox1);

        class TrakBox extends Box("trak") {
            boxes = new BoxEntryToEnd(new TkhdBox(), new EdtsBox(), new MdiaBox());
        }

        class MdiaBox extends Box("mdia") {
            boxes = new BoxEntryToEnd(new MdhdBox(), new HdlrBox(), new MinfBox());
        }

        class MdhdBox0 extends FullBox("mdhd") {
            creation_time = new UInt32();
            modification_time = new UInt32();
            timescale = new UInt32();
            duration = new UInt32();

            padPlusLanguage = new UInt16();
            pre_defined = new UInt16();
        }
        class MdhdBox1 extends FullBox("mdhd") {
            creation_time = new UInt64();
            modification_time = new UInt64();
            timescale = new UInt32();
            duration = new UInt64();

            padPlusLanguage = new UInt16();
            pre_defined = new UInt16();
        }
        const MdhdBox = FullBoxVersionSplit("mdhd", MdhdBox0, MdhdBox1);

        class HdlrBox extends FullBox("hdlr") {
            pre_defined = new UInt32();
            handler_type  = new UInt32String();
            reversed = new NArray(new UInt32(), 3);

            name = new CString();
        }

        class MinfBox extends Box("minf") {
            boxes = new BoxEntryToEnd(new VmhdBox(), new DinfBox(), new StblBox());
        }
        class VmhdBox extends FullBox("vmhd") {
            graphicsmode = new UInt16();
            opcolor = new NArray(new UInt16(), 3);
        }
        class DinfBox extends Box("dinf") {
            boxes = new BoxEntryToEnd(new DrefBox());
        }

        class DrefBox extends FullBox("dref") {
            entry_count = new UInt32();
            boxes = new BoxEntryToEnd(new Url_Box());
        }

        class Url_Box extends FullBox("url ") {
            // OH, if the flag is 1, then there are no properties. So... TODO: implement modes other than flag === 1
        }

        class StblBox extends Box("stbl") {
            boxes = new BoxEntryToEnd(new StsdBox(), new SttsBox(), new StscBox(), new StszBox(), new Stco());
        }

        class Stco extends FullBox("stco") {
            obj = new StcoEntry();
        }
        class StcoEntry implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): number[] {
                let entry_count = buffer.readInt32BE(pPos.v);
                pPos.v += 4;

                let chunk_offsets: number[] = [];
                for(let i = 0; i < entry_count; i++) {
                    let chunk_offset = buffer.readUInt32BE(pPos.v);
                    pPos.v += 4;
                    chunk_offsets.push(chunk_offset);
                }
                return chunk_offsets;
            }
            write(values: number[]): Buffer[] {
                let buffer = new Buffer(4 + values.length * 4);
                buffer.writeUInt32BE(values.length, 0);

                for(let i = 0; i < values.length; i++) {
                    buffer.writeUInt32BE(values[0], 4 + i * 4);
                }

                return [buffer];
            }
        }

        class StszBox extends FullBox("stsz") {
            obj = new StszEntry();
        }
        class StszEntry implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): number|number[] {
                let sample_size = buffer.readUInt32BE(pPos.v);
                pPos.v += 4;
                let sample_count = buffer.readUInt32BE(pPos.v);
                pPos.v += 4;
                if(sample_size !== 0) {
                    return sample_size;
                }

                let sample_sizes: number[] = [];
                for(let i = 0; i < sample_count; i++) {
                    let sample_size = buffer.readUInt32BE(pPos.v);
                    pPos.v += 4;
                    sample_sizes.push(sample_size);
                }
                return sample_sizes;
            }
            write(value: number|number[]): Buffer[] {
                if(typeof value === "number") {
                    let buffer = new Buffer(8);
                    buffer.writeUInt32BE(value, 0);
                    buffer.writeUInt32BE(0, 4);
                    return [buffer];
                } else {
                    let buffer = new Buffer(8 + value.length * 4);
                    buffer.writeUInt32BE(0, 0);
                    buffer.writeUInt32BE(value.length, 4);

                    for(let i = 0; i < value.length; i++) {
                        buffer.writeUInt32BE(value[i], 8 + i * 4);
                    }
                    return [buffer];
                }
            }
        }

        class StscBox extends FullBox("stsc") {
            obj = new StscEntry();
        }
        interface StscValue {
            first_chunk: number;
            samples_per_chunk: number;
            sample_description_index: number;
        }
        class StscValueEntry {
            first_chunk = new UInt32();
            samples_per_chunk = new UInt32();
            sample_description_index = new UInt32();
        }

        class StscEntry implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void) {
                let entry_count = buffer.readInt32BE(pPos.v);
                pPos.v += 4;

                let values: StscValue[] = [];
                for(let i = 0; i < entry_count; i++) {
                    let box = parseObject(new StscValueEntry(), buffer, pPos, end, debugPath.concat(`[${i}]`), parents, null, false);
                    values.push(box as StscValue);
                }
                return values;
            }
            write(boxes: BoxMetadata[]): Buffer[] {
                let entryBoxes = new UInt32().write(boxes.length);
                return (
                    entryBoxes.concat(
                        flatten(boxes.map(x => writeBox(x, undefined, true)))
                    )
                );
            }
        }


        class SttsBox extends FullBox("stts") {
            obj = new SttsEntry();
        }
        interface SttsEntryValue {
            sample_count: number;
            sample_delta: number;
        }
        class SttsEntry implements MP4BoxEntryBase {
            parse(
                buffer: Buffer,
                pPos: P<number>,
                end: number,
                debugPath: string[],
                parents: BoxMetadata[],
                addArrayValue: (value: any) => void
            ): SttsEntryValue[] {
                let entry_count = buffer.readInt32BE(pPos.v);
                pPos.v += 4;

                let values: SttsEntryValue[] = [];
                for(let i = 0; i < entry_count; i++) {
                    let sample_count = buffer.readUInt32BE(pPos.v);
                    pPos.v += 4;
                    let sample_delta = buffer.readUInt32BE(pPos.v);
                    pPos.v += 4;

                    values.push({ sample_count, sample_delta });
                }
                return values;
            }

            write(values: SttsEntryValue[]): Buffer[] {
                let buffer = new Buffer(4 + values.length * 8);
                let pos = 0;
                buffer.writeInt32BE(values.length, 0);
                pos += 4;

                for(let i = 0; i < values.length; i++) {
                    buffer.writeUInt32BE(values[i].sample_count, pos);
                    pos += 4;
                    buffer.writeUInt32BE(values[i].sample_delta, pos);
                    pos += 4;
                }

                return [buffer];
            }
        }

        class StsdBox extends FullBox("stsd") {
            obj = new StsdEntry();
        }

        function SampleEntry(type: string) {
            return class SampleEntry extends Box(type) {
                reserved = new NArray(new UInt8(), 6);
                data_reference_index = new UInt16();
            };
        }
        class HintSampleEntry extends SampleEntry ("hint") {
            data = new ArrayToEnd(new UInt8());
        }
        // Visual Sequences
        class VisualSampleEntry extends SampleEntry ("vide") {
            pre_defined = new UInt16();
            reserved1 = new UInt16();
            pre_defined1 = new NArray(new UInt32(), 3);
            width = new UInt16();
            height = new UInt16();

            horizresolution = new UInt32();
            vertresolution = new UInt32();

            reserved2 = new UInt32();

            frame_count = new UInt16();

            compressorname = new StupidString(32);
            depth = new UInt16();
            pre_defined2 = new Int16();

            remaining = new ArrayToEnd(new UInt8());
        }
        // Audio Sequences
        class AudioSampleEntry extends SampleEntry ("soun") {
            /*
            const unsigned int(32)[2] reserved = 0;
            template unsigned int(16) channelcount = 2;
            template unsigned int(16) samplesize = 16;
            unsigned int(16) pre_defined = 0;
            const unsigned int(16) reserved = 0 ;
            template unsigned int(32) samplerate = {timescale of media}<<16;
            */
        } 

        class StsdEntry implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void) {
                let entries: BoxMetadata[] = [];

                let mdiaParent = getAllFirstOfType(parents, "mdia")[0];
                let boxes = mdiaParent._properties.boxes;
                if(!isArray(boxes)) {
                    throw new Error(`Invalid mdia.boxes, expected array, received ${boxes}`);
                }
                let hdlr = boxes.filter(x => x._box.type === "hdlr")[0];
                let handler_type = hdlr._properties.handler_type;
                if(typeof handler_type !== "string") {
                    throw new Error(`Invalid handler_type. Expected string, was ${handler_type}`);
                }

                let handlers: {[key: string]: IBox<any> } = {
                    "hint": new HintSampleEntry(),
                    "vide": new VisualSampleEntry(),
                    "soun": new AudioSampleEntry(),
                };

                let handler = handlers[handler_type];

                // Odd... we have an array of boxes, but the spec gives us an entry_count? If we have it, we should use it.
                //  But still... why?
                let entry_count = (new (IntN(4, false))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                for(let i = 0; i < entry_count; i++) {
                    let boxInfo = parseBoxInfo([handler], buffer, pPos, debugPath, parents, handler.type);
                    if(!boxInfo) {
                        throw new Error(`StsdEntry, parseBoxInfo didn't work?`);
                    }
                    entries.push(boxInfo);
                }

                return entries;
            }

            // They better not change the entry count. We only allow changing values
            write(entries: BoxMetadata[]): Buffer[] {
                let headerBuffers = (new (IntN(4, false))).write(entries.length);
                for(let buffer of headerBuffers) {
                    testAddBuffer(buffer, `Stsd, header`);
                }
                
                let entryBuffers = flatten(entries.map((x, i) => writeBox(x, `stsd[${i}]`)));

                return headerBuffers.concat(entryBuffers);
            }
        }
        

        class EdtsBox extends Box("edts") {
            boxes = new BoxEntryToEnd(new ElstBox());
        }
        class ElstBox extends Box("elst") {
            entries = new ElstEntry();
        }
        interface ElstEntryArrayValue {
            segment_duration: number;
            media_time: number;
            media_rate_integer: number;
            media_rate_fraction: number;
        };
        class ElstEntry implements MP4BoxEntryBase {
            constructor() { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void) {
                let version = buffer.readUInt8(pPos.v);
                pPos.v += 1;
                let flags = buffer.readUIntBE(pPos.v, 3);
                pPos.v += 3;

                let entries: ElstEntryArrayValue[] = [];

                let entry_count = (new (IntN(4, false))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                for(let i = 0; i < entry_count; i++) {
                    let segment_duration: number;
                    let media_time: number;
                    if(version === 0) {
                        segment_duration = (new (IntN(4, false))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                        media_time = (new (IntN(4, true))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    } else if(version === 1) {
                        segment_duration = (new (IntN(8, false))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                        media_time = (new (IntN(8, true))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    } else {
                        throw new Error(`Unexpected version ${version}`);
                    }

                    let media_rate_integer = (new (IntN(2, true))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    let media_rate_fraction = (new (IntN(2, true))).parse(buffer, pPos, end, debugPath, parents, addArrayValue);

                    entries.push({ segment_duration, media_time, media_rate_integer, media_rate_fraction });
                }

                return { entries, version };
            }

            // They better not change the entry count. We only allow changing values
            write(obj: { version: number, flags: number, entries: ElstEntryArrayValue[] }): Buffer[] {
                let { version, flags, entries } = obj;

                let entryByteSize = (version === 0 ? 8 : 16) + 4;
                let buffer = new Buffer(8 + entryByteSize * entries.length);

                let pos = 0;

                buffer.writeUInt8(version, pos);
                pos += 1;
                buffer.writeUIntBE(flags, pos, 3);
                pos += 3;

                // entry_count
                buffer.writeUInt32BE(entries.length, pos);
                pos += 4;


                for(let i = 0; i < entries.length; i++) {
                    let entry = entries[i];
                    if(version === 0) {
                        buffer.writeUInt32BE(entry.segment_duration, pos);
                        pos += 4;
                        buffer.writeInt32BE(entry.media_time, pos);
                        pos += 4;
                    } else if(version === 1) {
                        buffer.writeUInt16BE(0, 0);
                        pos += 2;
                        buffer.writeUIntBE(entry.segment_duration, pos, 6);
                        pos += 6;

                        buffer.writeUInt16BE(0, 0);
                        pos += 2;
                        buffer.writeUIntBE(entry.media_time, pos, 6);
                        pos += 6;
                    } else {
                        throw new Error(`Unexpected version ${version}`);
                    }

                    buffer.writeUInt16BE(entry.media_rate_integer, pos);
                    pos += 2;

                    buffer.writeUInt16BE(entry.media_rate_fraction, pos);
                    pos += 2;
                }

                return [buffer];
            }
        }


        class TkhdBox0 extends FullBox("tkhd") {
            creation_time = new UInt32();
            modification_time = new UInt32();
            track_ID = new UInt32();
            reserved = new UInt32();
            duration = new UInt32();

            reserved0 = new UInt32();
            reserved1 = new UInt32();

            layer = new Int16();
            alternate_group = new Int16();
            volume = new Int16();
            reversed2 = new UInt16();

            matrix = new NArray(new Int32(), 9);

            width = new NumberShifted(new UInt32(), 1 << 16);
            height = new NumberShifted(new UInt32(), 1 << 16);
        }
        class TkhdBox1 extends FullBox("tkhd") {
            creation_time = new UInt64();
            modification_time = new UInt64();
            track_ID = new UInt32();
            reserved = new UInt32();
            duration = new UInt64();

            reserved0 = new UInt32();
            reserved1 = new UInt32();

            layer = new Int16();
            alternate_group = new Int16();
            volume = new Int16();
            reversed2 = new UInt16();

            matrix = new NArray(new Int32(), 9);

            width = new UInt32();
            height = new UInt32();
        }
        const TkhdBox = FullBoxVersionSplit("tkhd", TkhdBox0, TkhdBox1);

        // #region Primitives

        function IntN(bytes: number, signed: boolean): { new(): MP4BoxEntryBase<number> } {
            if(bytes > 8 || bytes <= 0) {
                throw new Error(`Invalid number of bytes ${bytes}`);
            }
            return class {
                parse(buffer: Buffer, pPos: P<number>): number {
                    let num: number;
                    if(bytes > 6) {
                        let extraBytes = bytes - 6;
                        if(signed) {
                            let first2Bytes = buffer.readIntBE(pPos.v, extraBytes);
                            if(first2Bytes < 0) {
                                throw new Error(`Signed > 6 bytes negative not implemented yet`);
                            }
                        }
                        let first2Bytes = buffer.readUIntBE(pPos.v, extraBytes);
                        if(first2Bytes != 0) {
                            throw new Error(`64 bit integer with bits in first 2 bytes. This means it cannot be a javascript number, and this is not supported yet.`);
                        }
                        num = buffer.readUIntBE(pPos.v + extraBytes, bytes - extraBytes);
                    } else {
                        if(signed) {
                            num = buffer.readIntBE(pPos.v, bytes);
                        } else {
                            num = buffer.readUIntBE(pPos.v, bytes);
                        }
                    }
                    pPos.v += bytes;
                    return num;
                }
                write(value: number): Buffer[] {
                    if(value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
                        throw new Error(`Cannot write number, as it is too large. ${value}`);
                    }
                    if(value % 1 !== 0) {
                        throw new Error(`Cannot write number, as it is a decimal. ${value}`);
                    }
                    let buffer = new Buffer(bytes);
                    if(bytes > 6) {
                        let extraBytes = bytes - 6;
                        buffer.writeUIntBE(value, extraBytes, bytes);
                    } else {
                        if(signed) {
                            buffer.writeIntBE(value, 0, bytes);
                        } else {
                            buffer.writeUIntBE(value, 0, bytes);
                        }
                    }

                    return [buffer];
                }
            };
        }

        function MapBoxEntryBase<T, N>(
            Ctor: { new(): MP4BoxEntryBase<T> },
            parseMap: (value: T) => N,
            writeMap: (value: N) => T,
        ) {
            let entry = new Ctor();
            return class {
                parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): N {
                    let t = entry.parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    return parseMap(t);
                }
                write(value: N): Buffer[] {
                    let t = writeMap(value);
                    return entry.write(t);
                }
            };
        }

        const UInt8 = IntN(1, false);
        const UInt16 = IntN(2, false);
        const UInt24 = IntN(3, false);
        const UInt32 = IntN(4, false);
        const UInt64 = IntN(8, false);

        const Int16 = IntN(2, true);
        const Int32 = IntN(4, true);

        const UInt32String = MapBoxEntryBase(
            UInt32,
            textFromUInt32,
            textToUInt32
        );

        class NumberShifted implements MP4BoxEntryBase {
            constructor(private baseNum: MP4BoxEntryBase<number>, private shiftDivisor: number) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): number {
                return this.baseNum.parse(buffer, pPos, end, debugPath, parents, addArrayValue) / this.shiftDivisor;
            }
            write(value: number): Buffer[] {
                value *= this.shiftDivisor;
                value = Math.round(value);
                return this.baseNum.write(value);
            }
        }

        class BoxEntryToEnd implements MP4BoxEntryBase {
            private boxes: IBox<any>[];
            constructor(...boxes: IBox<any>[]) {
                this.boxes = boxes;
            }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): any[] {
                let arr = parseBoxArray(this.boxes, buffer, debugPath, parents, pPos.v, end, addArrayValue);

                pPos.v = end;

                return arr;
            }
            write(value: BoxMetadata[]): Buffer[] {
                return flatten(value.map(v => writeBox(v)));
            }
        }

        class ArrayToEnd implements MP4BoxEntryBase {
            constructor(private entry: MP4BoxEntryBase) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): any[] {
                let result: any[] = [];
                while(pPos.v < end) {
                    let obj = this.entry.parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    result.push(obj);
                }
                return result;
            }

            write(value: any[]): Buffer[] {
                return flatten(value.map(v => this.entry.write(v)));
            }
        }

        class NArray implements MP4BoxEntryBase {
            constructor(private entry: MP4BoxEntryBase, private count: number) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], addArrayValue: (value: any) => void): any[] {
                let result: any[] = [];
                for(let i = 0; i < this.count; i++) {
                    let obj = this.entry.parse(buffer, pPos, end, debugPath, parents, addArrayValue);
                    result.push(obj);
                    if(pPos.v > end) {
                        throw new Error(`Overflowed end of box while parsing array. ${debugPath.join(".")}`);
                    }
                }
                return result;
            }

            write(values: any[]): Buffer[] {
                return flatten(values.map(v => this.entry.write(v)));
            }
        }

        function decodeUTF8BytesToString(bytes: number[]): string {
            let encodedString = "";
            for(let i = 0; i < bytes.length; i++) {
                let b = bytes[i];
                encodedString += "%" + b.toString(16);
            }
            return decodeURIComponent(encodedString);
        }
        function encodeAsUTF8Bytes(str: string): number[] {
            let utf8: number[] = [];
            for (let i = 0; i < str.length; i++) {
                let charcode = str.charCodeAt(i);
                if (charcode < 0x80) utf8.push(charcode);
                else if (charcode < 0x800) {
                    utf8.push(0xc0 | (charcode >> 6), 
                                0x80 | (charcode & 0x3f));
                }
                else if (charcode < 0xd800 || charcode >= 0xe000) {
                    utf8.push(0xe0 | (charcode >> 12), 
                                0x80 | ((charcode>>6) & 0x3f), 
                                0x80 | (charcode & 0x3f));
                }
                // surrogate pair
                else {
                    i++;
                    // UTF-16 encodes 0x10000-0x10FFFF by
                    // subtracting 0x10000 and splitting the
                    // 20 bits of 0x0-0xFFFFF into two halves
                    charcode = 0x10000 + (((charcode & 0x3ff)<<10)
                                | (str.charCodeAt(i) & 0x3ff))
                    utf8.push(0xf0 | (charcode >>18), 
                                0x80 | ((charcode>>12) & 0x3f), 
                                0x80 | ((charcode>>6) & 0x3f), 
                                0x80 | (charcode & 0x3f));
                }
            }
            return utf8;
        }

        class CString implements MP4BoxEntryBase<string> {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): string {
                let bytes: number[] = [];
                while(true) {
                    if(pPos.v >= end) {
                        throw new Error(`Overflowed end of box while parsing array. ${debugPath.join(".")}`);
                    }
                    let b = buffer.readInt8(pPos.v);
                    pPos.v++;
                    if(b === 0) break;
                    bytes.push(b);
                }

                return decodeUTF8BytesToString(bytes);
            }

            write(value: string): Buffer[] {
                let unicodeBytes = encodeAsUTF8Bytes(value);

                let output = new Buffer(unicodeBytes.length + 1);
                for(let i = 0; i < unicodeBytes.length; i++) {
                    let byte = unicodeBytes[i];
                    output.writeUInt8(byte, i);
                }
                
                return [output];
            }
        }

        /* It's a c string, but length prefixed, and also fixed buffer size. WTF. Make up your fucking mind. */
        class StupidString implements MP4BoxEntryBase<string> {
            constructor(private bufferLength: number) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): string {
                let bytes: number[] = [];
                for(let i = 0; i < 32; i++) {
                    if(pPos.v >= end) {
                        throw new Error(`Overflowed end of box while parsing StupidString. ${debugPath.join(".")}`);
                    }
                    buffer.readInt8(pPos.v);
                    pPos.v += 1;
                }

                let length = bytes[0];
                if(length > 31) {
                    throw new Error(`String too long in StupidString. ${debugPath.join(".")}`);
                }

                let stringBytes = bytes.slice(1).slice(length);
                // Hmm... they didn't say if it is a unicode string... But screw it, I don't care, this saves work.

                return decodeUTF8BytesToString(stringBytes);
            }

            write(text: string): Buffer[] {
                let bytes = encodeAsUTF8Bytes(text);

                if(bytes.length > 31) {
                    throw new Error(`String too long in StupidString. ${text}`);
                }

                let buffer = new Buffer(32);

                for(let i = 0; i < bytes.length; i++) {
                    let ch = bytes[i];
                    buffer.writeInt8(ch, i);
                }
                buffer.writeInt8(0, bytes.length);

                return [buffer];
            }
        }

        // #endregion

        const RootBox = new BoxEntryToEnd(
            new FileBox(),
            new FreeBox(),
            new MdatBox(),
            new MoovBox(),
        );

        type RawBox = ReturnType<typeof parseBoxRaw>;
        function parseBoxRaw(buffer: Buffer, pos: number) {
            let start = pos;
            /*
                size is an integer that specifies the number of bytes in this box, including all its fields and contained
                    boxes; if size is 1 then the actual size is in the field largesize; if size is 0, then this box is the last
                    one in the file, and its contents extend to the end of the file (normally only used for a Media Data Box) 
            */
            let size = buffer.readUInt32BE(pos); pos += 4;
            let type = textFromUInt32(buffer.readUInt32BE(pos)); pos += 4;
    
            let headerSize = 8;

            if(size === 1) {
                size = readUInt64BE(buffer, pos); pos += 8;
                headerSize = 16;
            } else if(size === 0) {
                size = buffer.length;
            }
    
            if(type === "uuid") {
                throw new Error(`Unhandled mp4 box type uuid`);
            }
            
            let contentStart = pos;
    
            return {
                start,
                contentStart,
                size,
                type,
                headerSize,
            };
        }
        function parseBoxInfo(boxes: IBox<any>[], buffer: Buffer, pPos: P<number>, debugPath: string[], parents: BoxMetadata[], forceType = "", isBoxComplete = true): BoxMetadata|undefined {
            let boxesLookup = keyBy(boxes, x => x.type);
            
            let box = parseBoxRaw(buffer, pPos.v);

            let boxType = forceType || box.type;
            let curDebugPath = debugPath.concat(boxType);
            let end = box.start + box.size;
            let boxInfoClass = boxesLookup[boxType];
            if(!boxInfoClass) {
                console.warn(`Unknown box type ${curDebugPath.join(".")}, size ${box.size} at ${pPos.v}, have boxes ${Object.values(boxesLookup).map(x => x.type).join(", ")}`);
                boxes.push({ type: box.type });
                return undefined;
            }
            if(boxInfoClass.chooseBox) {
                boxInfoClass = boxInfoClass.chooseBox(buffer, box.start, end, debugPath, parents) as any;
            }

            let boxResult = parseObject(boxInfoClass as any as MP4Box, buffer, pPos, end, curDebugPath, parents, box, isBoxComplete);

            return boxResult;
        }

        function parseObject(boxInfoIn: {}, buffer: Buffer, pPos: P<number>, end: number, debugPath: string[], parents: BoxMetadata[], rawBox: RawBox|null = null, isBoxComplete = true): any {
            let property_offsets: { [propName: string]: number } = {};

            let boxInfo = boxInfoIn as MP4Box;

            let boxResult: BoxMetadata;
            {
                let boxMetadata: BoxMetadata = {
                    _box: rawBox as any,
                    _info: boxInfo,
                    _property_offsets: property_offsets,
                    _properties: null as any,
                    nicePath: debugPath.join("."),
                };
                boxResult = { ...boxMetadata };
                boxResult._properties = boxResult as any;
            }

            parents.unshift(boxResult as any);
            try {
                for(let key in boxInfo) {
                    if(key === "type") {
                        // Copy the type directly
                        boxResult._properties[key] = boxInfo[key] as any as string;
                        pPos.v += boxResult._box.headerSize;
                        continue;
                    }
                    let typeInfo = boxInfo[key];
                    
                    property_offsets[key] = pPos.v;

                    let outputArray: any[] = [];
                    let setArray = false;
                    function addArrayValue(value: any): void {
                        setArray = true;
                        boxResult._properties[key] = outputArray;
                        outputArray.push(value);
                    }

                    let value = typeInfo.parse(buffer, pPos, end, debugPath, parents, addArrayValue);

                    if(setArray && !arrayEqual(outputArray, value)) {
                        throw new Error(`Added to array, but output was not equal to values added to array.`);
                    }

                    if(pPos.v > end) {
                        throw new Error(`Read beyond end at ${debugPath.join(".")}. Pos ${pPos.v}, end ${end}`);
                    }
                    boxResult._properties[key] = value;
                }
            } finally {
                parents.shift();
            }

            if(isBoxComplete) {
                let unaccountedSpace = end - pPos.v;
                if(unaccountedSpace > 0) {
                    console.log(`Unaccounted space in ${debugPath.join(".")}, ${unaccountedSpace} bytes.`);
                }
            }

            pPos.v = end;

            return boxResult;
        }
        function parseBoxArray(boxes: IBox<any>[], buffer: Buffer, debugPath: string[], parents: BoxMetadata[], pos = 0, end = buffer.length, addArrayValue: (value: any) => void) {
            let results: BoxMetadata[] = [];

            let pPos = { v: pos };
            while(pPos.v < end) {
                let result = parseBoxInfo(boxes, buffer, pPos, debugPath, parents);
                if(!result) continue;
                addArrayValue(result);
                results.push(result);
            }
            return results;
        }

        function writePrimitiveToVariable(buffer: Buffer, boxResult: BoxMetadata, propName: string, newValue: any) {
            let pos = boxResult._property_offsets[propName];
            let boxEntry = boxResult._info[propName];
            (boxResult as any)[propName] = newValue;
            let newBuffer = boxEntry.write(newValue);

            let box = boxResult._box;

            if(newBuffer.length !== box.size) {
                throw new Error(`Inline write to ${propName} changed size from ${box.size} to ${newBuffer.length}`);
            }

            let start = boxResult._box.start;
            let size = boxResult._box.size;
            let end = start + size;
            for(let i = 0; i < size; i++) {
                let ch = buffer.readUInt8(i);
                buffer.writeUInt8(ch, start + i);
            }
        }

        
        function getContext(buffer: Buffer, pos: number, contextSize = 24): string {
            let end = Math.min(pos + contextSize, buffer.length);
            let output = "";

            for(let i = pos; i < end; i++) {
                let byte = buffer.readInt8(i);
                if(byte === 0) {
                    output += "\\0";
                } else {
                    output += String.fromCharCode(byte);
                }
            }
            return output;
        }

        let curTestPos = 0;
        let curCorrectBuffer: Buffer|null = null;
        // Set up global state to compare any buffers we add immediately to the correct buffer. This let's us get context for errors.
        function setupTestBuffer(correctBuffer: Buffer, code: () => void) {
            curCorrectBuffer = correctBuffer;
            curTestPos = 0;
            try {
                code();
            } finally {
                curCorrectBuffer = null;
            }
        }
        function testAddBuffer(buffer: Buffer, context: string) {
            /*
            if(curCorrectBuffer === null) return;
            if((buffer as any)["added"]) return;
            (buffer as any)["added"] = true;
            for(let i = 0; i < buffer.length; i++) {
                let newCh = buffer.readUInt8(i);
                let corCh = curCorrectBuffer.readUInt8(curTestPos++);
                if(newCh !== corCh) {
                    curTestPos--;
                    throw Error(`(${context}) Incorrect character at position ${curTestPos}, (local ${i}). Should be ${corCh}, was ${newCh}. Correct context: '${getContext(curCorrectBuffer, curTestPos)}', wrote: '${getContext(buffer, i)}'`);
                }
            }
            */
        }

        function writeBox(boxResult: BoxMetadata, context = "", delayTestAdd = false): Buffer[] {
            let buffers: Buffer[] = [];

            for(let key in boxResult._info) {
                if(key === "type") continue;
                let entry = boxResult._info[key];
                // Skip entries used for other things (that are not MP4BoxEntries)
                if(typeof entry !== "object") {
                    continue;
                }
                let value = boxResult._properties[key];
                let buffer = entry.write(value);
                for(let subBuffer of buffer) {
                    if(!delayTestAdd) {
                        testAddBuffer(subBuffer, `Box: ${boxResult._box && boxResult._box.type}, key ${key}, path ${boxResult.nicePath}`);
                    }
                    buffers.push(subBuffer);
                }
            }

            // Do header last, as before we do the contents we can't know the size of the header
            let box = boxResult._box;
            // Otherwise it has no header, and it just an object
            if(box) {
                let { type } = box;

                let size = sum(buffers.map(x => x.length)) + 8;

                let maxUInt32 = Math.pow(2, 32) - 1;
                let headerSize = size > maxUInt32 ? 16 : 8;

                let headerBuffer = new Buffer(headerSize);
                if(headerSize === 8) {
                    headerBuffer.writeUInt32BE(size, 0);
                    headerBuffer.writeUInt32BE(textToUInt32(type), 4);
                } else if(headerSize === 16) {
                    size += 8;
                    headerBuffer.writeUInt32BE(1, 0);
                    headerBuffer.writeUInt32BE(textToUInt32(type), 4);
                    writeUInt64BE(headerBuffer, 8, size);
                } else {
                    throw new Error(`Invalid headerSize ${headerSize}`);
                }

                if(!delayTestAdd) {
                    testAddBuffer(headerBuffer, `${context}, Box: ${boxResult._box && boxResult._box.type}, header, path ${boxResult.nicePath}`);
                }

                buffers.unshift(headerBuffer);
            }

            return buffers;
        }
        function writeBoxArr(boxResults: BoxMetadata[]): Buffer {
            let buffers: Buffer[] = [];
            for(let boxResult of boxResults) {
                let buffer = writeBox(boxResult);
                let subBufferIndex = 0;
                for(let subBuffer of buffer) {
                    testAddBuffer(subBuffer, `Box: ${boxResult._box && boxResult._box.type}, sub buffer ${subBufferIndex}`);
                    buffers.push(subBuffer);
                    subBufferIndex++;
                }
            }

            console.log(`Buffer count ${buffers.length}`)
            return Buffer.concat(buffers);
        }

        function getAllFirstOfTypeUnsafe(boxes: BoxMetadata[], type: string): any[] {
            return getAllFirstOfType(boxes, type) as any[];
        }
        function getAllFirstOfType(boxes: BoxMetadata[], type: string): BoxMetadata[] {
            let results: BoxMetadata[] = [];
            iterate(boxes);
            function iterate(box: BoxMetadata|BoxMetadata[]|Types.Primitive) {
                if(!box) return;
                if(typeof box !== "object") return;
                if(isArray(box)) {
                    for(let childBox of box) {
                        iterate(childBox);
                    }
                    return;
                }
                if(!box._box) {
                    return;
                }
                if(box._box.type === type) {
                    results.push(box);
                    return;
                }
                let boxObj: { [key: string]: BoxMetadata } = box as any;
                for(let key in boxObj) {
                    if(key.startsWith("_")) continue;
                    iterate(boxObj[key]);
                }
            }
            return results;
        }

        function parseBoxes(buffer: Buffer): BoxMetadata[] {
            return RootBox.parse(buffer, {v: 0}, buffer.length, [], [], () => {}) as BoxMetadata[];
        }

        //todonext
        // mvhd, and then change the rate and write it back to a new file
        // Arrays of const count

        let fileName = filePath.split("/").slice(-1)[0];
        
        let boxes = parseBoxes(buffer);

        ///*
        let dataFileOffset: number = getAllFirstOfTypeUnsafe(boxes, "stco")[0].obj[0];
        let sampleSizes: number[] = getAllFirstOfTypeUnsafe(boxes, "stsz")[0].obj;

        let jpegs: Buffer[] = [];
        let curOffset = dataFileOffset;
        for(let i = 0; i < sampleSizes.length; i++) {
            let size = sampleSizes[i];
            let start = curOffset;
            curOffset += size;
            let end = curOffset;
            let jpegBuffer = buffer.slice(start, end);
            jpegs.push(jpegBuffer);
        }
        
        //fs.writeFileSync("test.jpeg", jpegBuffer);
        //*/

        // So... we need
        // To create:
        // mdat
        //  - just jpegs side by side
        // mvhd
        //  - timescale, duration, other stuff which is constant
        // trak
        //  - duration, width, height, other constants
        // edts
        //  - duration, constants which players ignore
        // mdia
        //      mdhd
        //          - timescale, duration, constants
        //      hdlr
        //          - constants
        //      stuff...

    
        



        /*
        let timeMultiplier = 2;

        let stts = getAllFirstOfType(boxes, "stts")[0];
        (stts._properties.obj as any)[0].sample_delta = 512 * timeMultiplier;
        writePrimitiveToVariable(newBuffer, stts, "obj", stts._properties.obj);

        writePrimitiveToVariable(newBuffer, getAllFirstOfTypeUnsafe(boxes, "mvhd")[0], "duration", 3320 * timeMultiplier);
        writePrimitiveToVariable(newBuffer, getAllFirstOfTypeUnsafe(boxes, "tkhd")[0], "duration", 3320 * timeMultiplier);

        //console.log(getAllFirstOfTypeUnsafe(boxes, "mvhd")[0].duration);
        //console.log(getAllFirstOfTypeUnsafe(boxes, "tkhd")[0].duration);
        //console.log(getAllFirstOfTypeUnsafe(boxes, "mhdh")[0].duration);

        fs.writeFileSync(fileName + ".new.mp4", newBuffer);
        */

        
        function serializeBoxes(boxes: BoxMetadata[]) {
            return JSON.stringify(boxes, (k, v) => {
                if(k.startsWith("_")) return undefined;
                if(isArray(v) && v.length > 10) {
                    return v.slice(0, 10).concat("...");
                }
                return v;
            }, " ");
        }
        

        fs.writeFileSync(fileName + ".json",  serializeBoxes(boxes));
        

        let newBuffer!: Buffer;
        setupTestBuffer(buffer, () => {
            newBuffer = writeBoxArr(boxes);
        });

        let minLength = Math.min(buffer.length, newBuffer.length);
        for(let i = 0; i < minLength; i++) {
            let chSource = buffer.readUInt8(i);
            let chNew = newBuffer.readUInt8(i);

            if(chSource !== chNew) {
                throw new Error(`Byte is wrong at index ${i}, should be ${chSource}, was ${chNew}, correct context '${getContext(buffer, i)}', received '${getContext(newBuffer, i)}'`);
            }
        }
        if(buffer.length !== newBuffer.length) {
            throw new Error(`newBuffer wrong size. Should be ${buffer.length}, was ${newBuffer.length}`);
        }


        createVideoOutOfJpegs(flatten(repeat(jpegs.slice(50, 60), 10)), 10);
        function createVideoOutOfJpegs(jpegs: Buffer[], framePerSecond: number) {
            let timeMultiplier = 2;

            // Might as well go in file order.
            
            //mdat is just the raw jpegs, side by side
            let rawData = Buffer.concat(jpegs);
            // data
            getAllFirstOfType(boxes, "mdat")[0]._properties["data"] = Buffer.concat(jpegs);


            let mvhd = getAllFirstOfType(boxes, "mvhd")[0];
            // timescale. The number of increments per second. Will need to be the least common multiple of all the framerates
            let timescale = mvhd._properties["timescale"] = framePerSecond;
            // Technically the duration of the longest trak. But we should only have 1, so...
            let timescaleDuration = mvhd._properties["duration"] = jpegs.length;

            // Only 1 track
            let tkhd = getAllFirstOfType(boxes, "tkhd")[0];
            tkhd._properties["duration"] = timescaleDuration;

            // TODO: Oh, pass in width/height of jpegs, and put that here.

            let elst = getAllFirstOfTypeUnsafe(boxes, "elst")[0];
            // Just one segment
            elst.entries.entries[0].segment_duration = timescaleDuration;


            let mdhd = getAllFirstOfType(boxes, "mdhd")[0];

            // mdhd has a timescale too?
            mdhd._properties.timescale = timescale;
            mdhd._properties.duration = timescaleDuration;

            let stts = getAllFirstOfTypeUnsafe(boxes, "stts")[0];
            stts.obj[0].sample_delta = 1;
            stts.obj[0].sample_count = jpegs.length;

            let stsc = getAllFirstOfTypeUnsafe(boxes, "stsc")[0];
            stsc.obj[0].samples_per_chunk = jpegs.length;

            let stsz = getAllFirstOfTypeUnsafe(boxes, "stsz")[0];
            stsz.obj = jpegs.map(x => x.length);

            // Position of mdat in file as a whole. So... anything before mdat has to have a constant size, or else this will be wrong,
            //  or I will need to start calculating it.
            let stco = getAllFirstOfTypeUnsafe(boxes, "stco")[0];

            let newBuffer = writeBoxArr(boxes);
            fs.writeFileSync(fileName + ".new2.mp4", newBuffer);

            fs.writeFileSync(fileName + ".new2.mp4" + ".json",  serializeBoxes(boxes));

            let newBoxes = parseBoxes(newBuffer);
            fs.writeFileSync(fileName + ".new3.mp4" + ".json",  serializeBoxes(newBoxes));
        }


        //let newBuffer = new Buffer(buffer);

        

        //let elst = boxes[3].boxes[1].boxes[1].boxes[0];
        //elst.entries.entries[0].media_rate_integer = 10;
        //writePrimitiveToVariable(buffer, elst, "entries", elst.entries);
        //console.log(elst.entries.entries);
        
        //let box = (boxes as any)[1].boxes[0];
        //writePrimitiveToVariable(buffer, box, "duration", 1000);
        //console.log(box);

        /*
        let boxes2 = new BoxEntryToEnd(
            new FileBox(),
        ).parse(newBuffer, {v: 0}, newBuffer.length, []);
        let b2 = (boxes as any);
        console.log(b2[3].boxes[1].boxes[1].boxes[0].entries.entries);
        //*/

        //fs.writeFileSync("test.mp4", newBuffer);
    }

    // Generic parsing, based off of pseudo language
    // http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
    // https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
}