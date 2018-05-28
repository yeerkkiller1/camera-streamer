// take ./raw/result0.jpg, ./raw/result1.jpg, ./raw/result2.jpg, ./raw/result3.jpg, ./raw/result4.jpg
//  and put them in a mp4 video file. Like ./raw/test0.mp4 has jpegs inside of it.

import * as fs from "fs";
import { keyBy } from "./util/misc";

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

function textToUInt32(text: string) {
    if(text.length !== 4) {
        throw new Error(`Expected text of length 4. Received ${text}`);
    }

    return text.charCodeAt(0) + text.charCodeAt(1) * 256 + text.charCodeAt(2) * 256 * 256 + text.charCodeAt(3) * 256 * 256 * 256;
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

for(let fileName of [
    //"./raw/test1.mp4",
    "./raw/test5.mp4"
]) {
    console.log(fileName);
    ///*
    let buffer = fs.readFileSync(fileName);
    for(let i = 0; i < 8; i++) {
        let byte = buffer.readUInt8(i);
        process.stdout.write(p2(byte.toString(16)) + " ");
    }
    process.stdout.write("\n");
    //*/
    

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
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): T;
            write(buffer: Buffer, pos: number, value: T): void;
        }

        interface IBox<T extends string> {
            type: T;
            chooseBox?: (buffer: Buffer, pos: number, end: number, debugPath: string[]) => IBox<T>;
        }

        interface MP4Box {
            [key: string]: MP4BoxEntryBase;
        }

        interface BoxMetadata {
            START: number;
            CONTENT_START: number;
            SIZE: number;
            INFO: MP4Box;
            PROPERTY_OFFSETS: { [propName: string]: number };
        }

        function Box(type: string): { new(): IBox<typeof type> } {
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
                chooseBox = (buffer: Buffer, pos: number, end: number, debugPath: string[]) => {
                    let fullCtor = FullBox(type);
                    let fullBox = parseBoxInfo([new fullCtor()], buffer, {v: pos}, debugPath, false);
                    if(!fullBox) {
                        throw new Error(`Unexpected type ${type}`);
                    }
                    let result = fullBox as {version: number, flags: number};
                    if(result.version === 1) {
                        return new version1();
                    } else if(result.version === 0) {
                        return new version0();
                    } else {
                        throw new Error(`Unexpected version ${result.version} at ${pos}`);
                    }
                };
            }
        }
        

        class FileTypeBox extends Box("ftyp") {
            major_brand = new UInt32String();
            minor_version = new UInt32();
            compatible_brands = new ToEndEntry(new UInt32String());
        }
        class MoovTypeBox extends Box("moov") {
            boxes = new BoxEntryToEnd(new TrakTypeBox(), new MvhdTypeBox());
        }
        class FreeBox extends Box("free") {
            data = new ToEndEntry(new UInt8());
        }

        class MdatBox extends Box("mdat") {
            data = new ToEndEntry(new UInt8());
        }

        class MvhdTypeBox0 extends FullBox("mvhd") {
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
        class MvhdTypeBox1 extends FullBox("mvhd") {
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
        const MvhdTypeBox = FullBoxVersionSplit("mvhd", MvhdTypeBox0, MvhdTypeBox1);

        class TrakTypeBox extends Box("trak") {
            boxes = new BoxEntryToEnd(new TkhdTypeBox(), new EdtsBox());
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
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]) {
                let version = buffer.readUInt8(pPos.v);
                pPos.v += 1;
                let flags = buffer.readUIntBE(pPos.v, 3);
                pPos.v += 3;

                let entries: ElstEntryArrayValue[] = [];

                let entry_count = (new (IntN(4, false))).parse(buffer, pPos, end, debugPath);
                for(let i = 0; i < entry_count; i++) {
                    let segment_duration: number;
                    let media_time: number;
                    if(version === 0) {
                        segment_duration = (new (IntN(4, false))).parse(buffer, pPos, end, debugPath);
                        media_time = (new (IntN(4, true))).parse(buffer, pPos, end, debugPath);
                    } else if(version === 1) {
                        segment_duration = (new (IntN(8, false))).parse(buffer, pPos, end, debugPath);
                        media_time = (new (IntN(8, true))).parse(buffer, pPos, end, debugPath);
                    } else {
                        throw new Error(`Unexpected version ${version}`);
                    }

                    let media_rate_integer = (new (IntN(2, true))).parse(buffer, pPos, end, debugPath);
                    let media_rate_fraction = (new (IntN(2, true))).parse(buffer, pPos, end, debugPath);

                    entries.push({ segment_duration, media_time, media_rate_integer, media_rate_fraction });
                }

                return {entries, version};
            }

            // They better not change the entry count. We only allow changing values
            write(buffer: Buffer, pos: number, obj: {version: number, entries: ElstEntryArrayValue[]}) {
                // version
                pos += 1;
                // flags
                pos += 3;

                // entry_count
                pos += 4;

                let {version, entries} = obj;
                for(let i = 0; i < entries.length; i++) {
                    let entry = entries[i];
                    if(version === 0) {
                        (new (IntN(4, false))).write(buffer, pos, entry.segment_duration);
                        pos += 4;
                        (new (IntN(4, true))).write(buffer, pos, entry.media_time);
                        pos += 4;
                    } else if(version === 1) {
                        (new (IntN(8, false))).write(buffer, pos, entry.segment_duration);
                        pos += 8;
                        (new (IntN(8, true))).write(buffer, pos, entry.media_time);
                        pos += 8;
                    } else {
                        throw new Error(`Unexpected version ${version}`);
                    }

                    (new (IntN(2, true))).write(buffer, pos, entry.media_rate_integer);
                    (new (IntN(2, true))).write(buffer, pos, entry.media_rate_fraction);
                }
            }
        }


        class TkhdTypeBox0 extends FullBox("tkhd") {
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

            width = new UInt32();
            height = new UInt32();
        }
        class TkhdTypeBox1 extends FullBox("tkhd") {
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
        const TkhdTypeBox = FullBoxVersionSplit("tkhd", TkhdTypeBox0, TkhdTypeBox1);

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
                write(buffer: Buffer, pos: number, value: number): void {
                    if(value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
                        throw new Error(`Cannot write number, as it is too large. ${value}`);
                    }
                    if(value % 1 !== 0) {
                        throw new Error(`Cannot write number, as it is a decimal. ${value}`);
                    }
                    if(bytes > 6) {
                        let extraBytes = bytes - 6;
                        buffer.writeUIntBE(value, pos + extraBytes, bytes);
                    } else {
                        if(signed) {
                            buffer.writeIntBE(value, pos, bytes);
                        } else {
                            buffer.writeUIntBE(value, pos, bytes);
                        }
                    }
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
                parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): N {
                    let t = entry.parse(buffer, pPos, end, debugPath);
                    return parseMap(t);
                }
                write(buffer: Buffer, pos: number, value: N): void {
                    let t = writeMap(value);
                    entry.write(buffer, pos, t);
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
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): number {
                return this.baseNum.parse(buffer, pPos, end, debugPath) / this.shiftDivisor;
            }
            write(buffer: Buffer, pos: number, value: number) {
                value *= this.shiftDivisor;
                value = Math.round(value);
                this.baseNum.write(buffer, pos, value);
            }
        }

        class BoxEntryToEnd implements MP4BoxEntryBase {
            private boxes: IBox<any>[];
            constructor(...boxes: IBox<any>[]) {
                this.boxes = boxes;
            }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): {}[] {
                let arr = parseBoxArray(this.boxes, buffer, debugPath, pPos.v, end);

                pPos.v = end;

                return arr;
            }
            write() { throw new Error(`BoxEntryToEnd.write not implemented`); }
        }

        class ToEndEntry implements MP4BoxEntryBase {
            constructor(private entry: MP4BoxEntryBase) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): any[] {
                let result: any[] = [];
                while(pPos.v < end) {
                    let obj = this.entry.parse(buffer, pPos, end, debugPath);
                    result.push(obj);
                }
                return result;
            }

            write() { throw new Error(`ToEndEntry.write not implemented`); }
        }

        class NArray implements MP4BoxEntryBase {
            constructor(private entry: MP4BoxEntryBase, private count: number) { }
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): any[] {
                let result: any[] = [];
                for(let i = 0; i < this.count; i++) {
                    let obj = this.entry.parse(buffer, pPos, end, debugPath);
                    result.push(obj);
                    if(pPos.v >= end) {
                        throw new Error(`Overflowed end of box while parsing array. ${debugPath.join(".")}`);
                    }
                }
                return result;
            }

            write() { throw new Error(`ToEndEntry.parse not implemented`); }
        }

        // #endregion

        const RootBox = new BoxEntryToEnd(
            new FileTypeBox(),
            new MoovTypeBox(),
            new FreeBox(),
            new MdatBox(),
        );

        function parseBoxInfo(boxes: IBox<any>[], buffer: Buffer, pPos: P<number>, debugPath: string[], isBoxComplete = true) {
            let boxesLookup = keyBy(boxes, x => x.type);

            function parseBox(buffer: Buffer, pPos: P<number>) {
                let pos = pPos.v;
                let start = pos;
                /*
                    size is an integer that specifies the number of bytes in this box, including all its fields and contained
                        boxes; if size is 1 then the actual size is in the field largesize; if size is 0, then this box is the last
                        one in the file, and its contents extend to the end of the file (normally only used for a Media Data Box) 
                */
                let size = buffer.readUInt32BE(pos); pos += 4;
                let type = textFromUInt32(buffer.readUInt32BE(pos)); pos += 4;
        
                if(size === 1) {
                    size = readUInt64BE(buffer, pos); pos += 8;
                } else if(size === 0) {
                    size = buffer.length;
                }
        
                if(type === "uuid") {
                    throw new Error(`Unhandled mp4 box type uuid`);
                }
                
                let contentStart = pos;
        
                pPos.v = start + size;
        
                return {
                    start,
                    contentStart,
                    size,
                    type
                };
            }
            
            let box = parseBox(buffer, pPos);
            let curDebugPath = debugPath.concat(box.type);
            let end = box.start + box.size;
            let boxInfoClass = boxesLookup[box.type];
            if(!boxInfoClass) {
                console.warn(`Unknown box type ${curDebugPath.join(".")}, size ${box.size}`);
                boxes.push({ type: box.type });
                return;
            }
            if(boxInfoClass.chooseBox) {
                boxInfoClass = boxInfoClass.chooseBox(buffer, box.start, end, debugPath) as any;
            }
            let boxInfo = boxInfoClass as any as MP4Box;
            let boxPos = { v: box.contentStart };
            let PROPERTY_OFFSETS: { [propName: string]: number } = {};
            let boxMetadata: BoxMetadata = {
                START: box.start,
                CONTENT_START: box.contentStart,
                SIZE: box.size,
                INFO: boxInfo,
                PROPERTY_OFFSETS,
            };
            let boxResult: { [key: string]: {} } = { ...boxMetadata };
            
            for(let key in boxInfo) {
                if(key === "type") {
                    boxResult[key] = boxInfo[key];
                    continue;
                }
                let typeInfo = boxInfo[key];
                
                PROPERTY_OFFSETS[key] = boxPos.v;
                let value = typeInfo.parse(buffer, boxPos, end, curDebugPath);
                boxResult[key] = value;
            }

            if(isBoxComplete) {
                let unaccountedSpace = end - boxPos.v;
                if(unaccountedSpace > 0) {
                    console.log(`Unaccounted space in ${curDebugPath.join(".")}, ${unaccountedSpace} bytes. Total size should be ${box.size}`);
                }
            }

            return boxResult;
        }
        function parseBoxArray(boxes: IBox<any>[], buffer: Buffer, debugPath: string[], pos = 0, end = buffer.length): {}[] {
            let results: {}[] = [];

            let pPos = { v: pos };
            while(pPos.v < end) {
                let result = parseBoxInfo(boxes, buffer, pPos, debugPath);
                if(!result) continue;
                results.push(result);
            }
            return results;
        }

        function writePrimitiveToVariable(buffer: Buffer, boxResult: BoxMetadata, propName: string, newValue: Types.Primitive) {
            let pos = boxResult.PROPERTY_OFFSETS[propName];
            let boxEntry = boxResult.INFO[propName];
            (boxResult as any)[propName] = newValue;
            boxEntry.write(buffer, pos, newValue);
        }

        //todonext
        // mvhd, and then change the rate and write it back to a new file
        // Arrays of const count

        let boxes = RootBox.parse(buffer, {v: 0}, buffer.length, []) as any;

        let newBuffer = new Buffer(buffer);

        //let elst = boxes[3].boxes[1].boxes[1].boxes[0];
        //elst.entries.entries[0].media_rate_integer = 10;
        //writePrimitiveToVariable(buffer, elst, "entries", elst.entries);
        //console.log(elst.entries.entries);
        
        //let box = (boxes as any)[1].boxes[0];
        //writePrimitiveToVariable(buffer, box, "duration", 1000);
        //console.log(box);

        /*
        let boxes2 = new BoxEntryToEnd(
            new FileTypeBox(),
            new MoovTypeBox(),
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