// take ./raw/result0.jpg, ./raw/result1.jpg, ./raw/result2.jpg, ./raw/result3.jpg, ./raw/result4.jpg
//  and put them in a mp4 video file. Like ./raw/test0.mp4 has jpegs inside of it.

import * as fs from "fs";

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
    let buffer = fs.readFileSync(fileName);
    for(let i = 0; i < 8; i++) {
        let byte = buffer.readUInt8(i);
        process.stdout.write(p2(byte.toString(16)) + " ");
    }
    process.stdout.write("\n");
    

    // https://github.com/emericg/MiniVideo/blob/348ec21b99f939ca6a0ed65a257042434e8b98ec/minivideo/src/import.cpp
    // https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp

    // unsigned int major_brand = read_bits(bitstr, 32);

    // MP4: 00 00 xx xx 66 74 79 70   // (size) f t y p
    // TRACE_1(IO, "* File type      : ISO BMF (MOV,MP4, ...) container detected");

    // Loop on 1st level boxes
    //  We need 8 fits for this?

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

    let pPos: P<number> = {v: 0};
    while(pPos.v < buffer.length) {
        let box = parseBox(buffer, pPos);

        console.log(`Size ${box.size}, type ${box.type}`);
        
        switch(box.type) {
            default: console.warn(`Unknown box type ${box.type}`); break;
            case "ftyp": {
                console.log(parseBoxFtyp(buffer, box));
                break;
            }
            // Ehh... free space is free, so just skip it.
            case "free": break;
        }
    }
}