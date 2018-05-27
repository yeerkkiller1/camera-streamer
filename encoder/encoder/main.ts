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

for(let fileName of ["./raw/test1.mp4", "./raw/test5.mp4"]) {
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

        type Box = {
            start: number;
            contentStart: number;

            size: number;
            type: string;
        }
        function parseBox(buffer: Buffer, pPos: P<number>): Box {
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

        type FTyp = {
            major_brand: string;
            minor_version: number;
            compatible_brands: string[];
        };
        function parseBoxFtyp(buffer: Buffer, box: Box): FTyp {
            let pos = box.contentStart;
            let major_brand = textFromUInt32(buffer.readInt32BE(pos)); pos += 4;
            let minor_version = buffer.readInt32BE(pos); pos += 4;
            let compatible_brands: string[] = [];
            let end = box.start + box.size;
            while(pos < end) {
                compatible_brands.push(textFromUInt32(buffer.readInt32BE(pos))); pos += 4;
            }
            return {
                major_brand,
                minor_version,
                compatible_brands
            };
        }

        type Elst = ReturnType<typeof parseElst>;
        function parseElst(buffer: Buffer, box: Box) {
            let pos = box.contentStart;
            let version = buffer.readInt8(pos); pos += 1;
            let flags = buffer.readIntBE(pos, 3); pos += 3;

            let entry_count = buffer.readUInt32BE(pos); pos += 4;
            type EntryType = {
                segment_duration: number;
                media_time: number;
                media_rate_integer: number;
                media_rate_fraction: number;
            };
            let entries: EntryType[] = [];
            for(let i = 0; i < entry_count; i++) {
                let segment_duration;
                let media_time;
                if (version==1) {
                    segment_duration = readUInt64BE(buffer, pos); pos += 8;
                    // Screw it, I no longer care about negative media_times (this should be reading a signed 64 bit int, but I don't care)
                    media_time = readUInt64BE(buffer, pos); pos += 8;
                } else { // version==0
                    segment_duration = buffer.readUInt32BE(pos); pos += 4;
                    media_time = buffer.readInt32BE(pos); pos += 4;
                }
                let media_rate_integer = buffer.readInt16BE(pos); pos += 2;
                let media_rate_fraction = buffer.readInt16BE(pos); pos += 2;
                entries.push({
                    segment_duration,
                    media_time,
                    media_rate_integer,
                    media_rate_fraction,
                });
            }
            return entries;
        }


        type EdtsBoxTypes = Elst;
        type Edts = ReturnType<typeof parseEdts>;
        function parseEdts(buffer: Buffer, box: Box) {
            let pPos = {v: box.contentStart };
            let end = box.start + box.size;
            let subBoxes: EdtsBoxTypes[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "elst") {
                    subBoxes.push(parseElst(buffer, subBox));
                } else {
                    console.warn(`Unknown trak sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }

        type Tkhd = ReturnType<typeof parseTkhd>;
        function parseTkhd(buffer: Buffer, box: Box) {
            let pos = box.contentStart;
            let version = buffer.readInt8(pos); pos += 1;
            let flags = buffer.readIntBE(pos, 3); pos += 3;

            let creation_time: number;
            let modification_time: number;
            let track_ID: number;
            let duration: number;

            if(version === 1) {
                creation_time = readUInt64BE(buffer, pos); pos += 8;
                modification_time = readUInt64BE(buffer, pos); pos += 8;
                track_ID = buffer.readInt32BE(pos); pos += 4;
                let reserved = buffer.readUInt32BE(pos); pos += 4;
                duration = readUInt64BE(buffer, pos); pos += 8;
            } else if(version === 0) {
                creation_time = buffer.readUInt32BE(pos); pos += 4;
                modification_time = buffer.readUInt32BE(pos); pos += 4;
                track_ID = buffer.readUInt32BE(pos); pos += 4;
                let reserved = buffer.readUInt32BE(pos); pos += 4;
                duration = buffer.readUInt32BE(pos); pos += 4;
            } else {
                throw new Error(`Unexpected version ${version}`);
            }

            let reserved0 = buffer.readUInt32BE(pos); pos += 4;
            let reserved1 = buffer.readUInt32BE(pos); pos += 4;

            let layer = buffer.readInt16BE(pos); pos += 2;
            let alternate_group = buffer.readInt16BE(pos); pos += 2;
            let volume = buffer.readInt16BE(pos) / 0x0100; pos += 2;

            let reserved = buffer.readUInt16BE(pos); pos += 2;        

            let matrix: number[] = [];
            for(let i = 0 ; i < 9; i++) {
                matrix.push(buffer.readInt32BE(pos)); pos += 4;
            }
            
            let width = buffer.readInt32BE(pos); pos += 4;
            let height = buffer.readInt32BE(pos); pos += 4;

            return {
                creation_time,
                modification_time,
                track_ID,
                duration,
                layer,
                alternate_group,
                volume,
                matrix,
                width,
                height
            };
        }
        
        // mdhd
        // hdlr
        // minf
        type MdiaBoxTypes = Elst;
        type Mdia = ReturnType<typeof parseEdts>;
        function parseMdia(buffer: Buffer, box: Box) {
            let pPos = {v: box.contentStart };
            let end = box.start + box.size;
            let subBoxes: MdiaBoxTypes[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "") {
                    
                } else {
                    console.warn(`Unknown mdia sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }


        // tref
        type Trak = ReturnType<typeof parseTrak>;
        type TrackBoxTypes = Box | Tkhd | Edts | Mdia;
        function parseTrak(buffer: Buffer, box: Box): TrackBoxTypes[] {
            let pPos = {v: box.contentStart };
            let end = box.start + box.size;
            let subBoxes: TrackBoxTypes[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "tkhd") {
                    subBoxes.push(parseTkhd(buffer, subBox));
                } else if(subBox.type === "edts") {
                    subBoxes.push(parseEdts(buffer, subBox));
                } else if(subBox.type === "mdia") {
                    subBoxes.push(parseMdia(buffer, subBox));
                } else {
                    console.warn(`Unknown trak sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }

        type Mvhd = ReturnType<typeof parseBoxMvhd>;
        function parseBoxMvhd(buffer: Buffer, box: Box) {
            let pos = box.contentStart;
            let version = buffer.readInt8(pos); pos += 1;
            let flags = buffer.readIntBE(pos, 3); pos += 3;

            let creation_time: number;
            let modification_time: number;
            let timescale: number;
            let duration: number;

            if(version === 1) {
                creation_time = readUInt64BE(buffer, pos); pos += 8;
                modification_time = readUInt64BE(buffer, pos); pos += 8;
                timescale = buffer.readInt32BE(pos); pos += 4;
                duration = readUInt64BE(buffer, pos); pos += 8;
            } else if(version === 0) {
                creation_time = buffer.readUInt32BE(pos); pos += 4;
                modification_time = buffer.readUInt32BE(pos); pos += 4;
                timescale = buffer.readUInt32BE(pos); pos += 4;
                duration = buffer.readUInt32BE(pos); pos += 4;
            } else {
                throw new Error(`Unexpected version ${version}`);
            }

            let rate = buffer.readInt32BE(pos) / 0x00010000; pos += 4;
            let volume = buffer.readInt16BE(pos) / 0x0100; pos += 2;
            let reserved = buffer.readInt16BE(pos); pos += 2;
            let reserved0 = buffer.readUInt32BE(pos); pos += 4;
            let reserved1 = buffer.readUInt32BE(pos); pos += 4;

            let matrix: number[] = [];
            for(let i = 0 ; i < 9; i++) {
                matrix.push(buffer.readInt32BE(pos)); pos += 4;
            }
            
            for(let i = 0; i < 6; i++) {
                buffer.readUInt32BE(pos); pos += 4;
            }

            let next_track_ID = buffer.readUInt32BE(pos); pos += 4;

            return {
                creation_time,
                modification_time,
                timescale,
                duration,
                rate,
                volume,
                matrix,
                next_track_ID
            };
        }

        type UdtaBox = Box;
        type UdtaMeta = ReturnType<typeof parseUdtaMeta>;
        // Hmm... the spec says udta only has a copyright notice defined as a child. But people are writing the meta which is supposed to be
        //  inside a moov, trak or file in here. So... oh well..
        function parseUdtaMeta(buffer: Buffer, box: Box) {
            let pos = box.contentStart;
            let version = buffer.readInt8(pos); pos += 1;
            let flags = buffer.readIntBE(pos, 3); pos += 3;

            let pPos = {v: pos };
            let end = box.start + box.size;
            let subBoxes: UdtaBox[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "") {
                } else {
                    console.warn(`Unknown udta.meta sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }


        type Udta = ReturnType<typeof parseUdta>;
        type UdtaTypes = UdtaMeta;
        function parseUdta(buffer: Buffer, box: Box): UdtaTypes[] {
            let pPos = {v: box.contentStart };
            let end = box.start + box.size;
            let subBoxes: UdtaTypes[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "meta") {
                    subBoxes.push(parseUdtaMeta(buffer, subBox));
                } else {
                    console.warn(`Unknown udta sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }
        
        // TODO:
        // udta
        // mvex
        // ipmc
        type MoovBoxTypes = Mvhd | Trak | Udta;
        function parseBoxMoov(buffer: Buffer, box: Box): MoovBoxTypes[] {
            let pPos = {v: box.contentStart };
            let end = box.start + box.size;
            let subBoxes: MoovBoxTypes[] = [];
            while(pPos.v < end) {
                let subBox = parseBox(buffer, pPos);
                if(subBox.type === "mvhd") {
                    subBoxes.push(parseBoxMvhd(buffer, subBox));
                } else if(subBox.type === "trak") {
                    subBoxes.push(parseTrak(buffer, subBox));
                } else if(subBox.type === "udta") {
                    subBoxes.push(parseUdta(buffer, subBox));
                } else {
                    console.warn(`Unknown moov sub box ${subBox.type}, size ${subBox.size}`);
                }
            }
            return subBoxes;
        }

        ///*
        let pPos: P<number> = {v: 0};
        while(pPos.v < buffer.length) {
            let box = parseBox(buffer, pPos);

            console.log(`${box.type}, size ${box.size}`);
            
            switch(box.type) {
                default: console.warn(`Unknown box type ${box.type}`); break;
                case "ftyp": {
                    console.log(parseBoxFtyp(buffer, box));
                    break;
                }
                case "moov": {
                    let moov = parseBoxMoov(buffer, box);
                    console.log(JSON.stringify(moov, null, " "));
                    break;
                }
                case "mdat": break;
                // Ehh... free space is free, so just skip it.
                case "free": break;
            }
        }
        //*/
    }

    {
        type P<T> = {v: T};
        type Ctor<T> = {new(): T};

        interface MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>, end: number, debugPath: string[]): any;
        }

        interface IBox<T extends string> {
            type: T;
            chooseBox?: (buffer: Buffer, pos: number, end: number, debugPath: string[]) => IBox<T>;
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
        

        interface MP4Box {
            [key: string]: MP4BoxEntryBase;
        }

        class FileTypeBox extends Box("ftyp") {
            major_brand = new UInt32String();
            minor_version = new UInt32();
            compatible_brands = new ToEndEntry(new UInt32String());
        }
        class MoovTypeBox extends Box("moov") {
            boxes = new BoxEntryToEnd(new TrakTypeBox());
        }
        class TrakTypeBox extends Box("trak") {
            boxes = new BoxEntryToEnd(new TkhdTypeBox());
        }
        class TkhdTypeBox0 extends FullBox("tkhd") {
            creation_time = new UInt32();
            modification_time = new UInt32();
            track_ID = new UInt32();
            reserved = new UInt32();
            duration = new UInt32();
            // ...
        }
        class TkhdTypeBox1 extends FullBox("tkhd") {
            creation_time = new UInt64();
            modification_time = new UInt64();
            // ...
        }
        const TkhdTypeBox = FullBoxVersionSplit("tkhd", TkhdTypeBox0, TkhdTypeBox1);



        class UInt8 implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>): number {
                let num = buffer.readInt8(pPos.v);
                pPos.v += 1;
                return num;
            }
        }
        class UInt24 implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>): number {
                let num = buffer.readIntBE(pPos.v, 3);
                pPos.v += 3;
                return num;
            }
        }
        class UInt32 implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>): number {
                let num = buffer.readUInt32BE(pPos.v);
                pPos.v += 4;
                return num;
            }
        }
        class UInt64 implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>): number {
                let num = readUInt64BE(buffer, pPos.v);
                pPos.v += 8;
                return num;
            }
        }
        class UInt32String implements MP4BoxEntryBase {
            parse(buffer: Buffer, pPos: P<number>): string {
                let num = buffer.readUInt32BE(pPos.v);
                pPos.v += 4;
                return textFromUInt32(num);
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
        }


        //todonext
        // Arrays of const count

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
                console.warn(`Unknown box type ${curDebugPath.join(".")}`);
                boxes.push({ type: box.type });
                return;
            }
            if(boxInfoClass.chooseBox) {
                boxInfoClass = boxInfoClass.chooseBox(buffer, box.start, end, debugPath) as any;
            }
            let boxInfo = boxInfoClass as any as MP4Box;
            let boxPos = { v: box.contentStart };
            let boxResult: { [key: string]: {} } = {};
            boxResult["START"] = box.start;
            boxResult["SIZE"] = box.size;
            for(let key in boxInfo) {
                if(key === "type") {
                    boxResult[key] = boxInfo[key];
                    continue;
                }
                let typeInfo = boxInfo[key];
                
                let value = typeInfo.parse(buffer, boxPos, end, curDebugPath);
                boxResult[key] = value;
            }

            if(isBoxComplete) {
                let unaccountedSpace = end - boxPos.v;
                if(unaccountedSpace > 0) {
                    console.log(`Unaccounted space in ${curDebugPath.join(".")}, ${unaccountedSpace} bytes`);
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

        let boxes = new BoxEntryToEnd(
            new FileTypeBox(),
            new MoovTypeBox(),
        ).parse(buffer, {v: 0}, buffer.length, [])

        console.log(JSON.stringify(boxes, null, "  "));
    }

    // Generic parsing, based off of pseudo language
    // http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
    // https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
}