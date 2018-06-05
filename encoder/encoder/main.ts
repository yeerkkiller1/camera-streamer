// take ./raw/result0.jpg, ./raw/result1.jpg, ./raw/result2.jpg, ./raw/result3.jpg, ./raw/result4.jpg
//  and put them in a mp4 video file. Like ./raw/test0.mp4 has jpegs inside of it.

import * as fs from "fs";
import { keyBy, arrayEqual, flatten, repeat, range, mapObjectValues, mapObjectValuesKeyof } from "./util/misc";
import { isArray } from "util";
import { sum } from "./util/math";

import * as Jimp from "jimp";

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


type P<T> = {v: T};
type Ctor<T> = {new(): T};

interface ParseContext {
    buffer: Buffer;
    pPos: P<number>;
    end: number;
    debugPath: string[];
    parents: BoxMetadata[];
    /** This immediatelys add the value to the child array. This is required in some cases when a child may require one of it's sibling, before all children are finished parsing. */
    addArrayValue: (value: any) => void;
}
interface WriteContext<T> {
    value: T;
    /** Gets the size (in bytes) of all properties after this property, in the current object. */
    getObjectSizeAfter?: () => number;
}

interface MP4BoxEntryInterface<T = any> {
    parse(context: ParseContext): T;
    write(context: WriteContext<T>): Buffer[];
}
type ChooseBoxEntry<T extends string> = (context: ChooseBoxContext) => MP4Box;
type MP4BoxEntryBase<T = any> = MP4BoxEntryInterface<T> | ChooseBoxEntry<any>;

interface ChooseBoxContext {
    buffer: Buffer;
    pos: number;
    end: number;
    debugPath: string[];
    parents: BoxMetadata[];
}
type ChooseBox<T extends string> = (context: ChooseBoxContext) => IBox<T>;
interface IBox<T extends string> {
    type: T;
    chooseBox?: ChooseBox<T>;
}

interface MP4Box {
    [key: string]: MP4BoxEntryBase|MP4BoxEntryBase[];
}

function boxToMP4Box(box: IBox<any>): MP4Box {
    return box as any;
}

interface BoxMetadata {
    _box: RawBox|null;
    _info: MP4Box;
    _properties: { [name: string]: Types.Primitive|Buffer|BoxMetadata[] };
    nicePath: string;
}

function Box(type: string): {  new(): IBox<typeof type> } {
    return class BoxInner implements IBox<typeof type> {
        type = type;
    };
}
function FullBox<T extends string>(type: T) {
    return class BoxInner extends Box(type) {
        version = new UInt8();
        flags = new UInt24();
    } as any as { new(): IBox<T> };
}

function FullBoxVersionSplit<T extends string>(type: string, version0: Ctor<IBox<any>>, version1: Ctor<IBox<any>>) {
    return class FullBoxSplit extends FullBox(type) {
        chooseBox = (context: ChooseBoxContext) => {
            let { buffer, pos, end, debugPath, parents } = context;

            let fullCtor = FullBox(type);
            let fullBox = parseBoxInfo([new fullCtor()], buffer, {v: pos}, debugPath, parents, undefined, false);
            if(!fullBox) {
                throw new Error(`Unexpected type`);
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
    compatible_brands = new ArrayEntry(new UInt32String());
}

class MoovBox extends Box("moov") {
    /*
    boxes = CreateObjectEntry(
        boxToMP4Box(
            new ArrayBoxNew(
                new MvhdBox(),
                new TrakBox(),
                new UdtaBox(),
                new MvexBox(),
            )
        )
    );
    */
    ///*
    boxes = new ArrayBox(
        new MvhdBox(),
        new TrakBox(),
        new UdtaBox(),
        new MvexBox(),
    );
    //*/
}

class MvexBox extends Box("mvex") {
    boxes = new ArrayBox(new TrexBox());
}
class TrexBox extends FullBox("trex") {
    track_ID = new UInt32();
    default_sample_description_index = new UInt32();
    default_sample_duration = new UInt32();
    default_sample_size = new UInt32();
    default_sample_flags = new UInt32();
}

class FreeBox extends Box("free") {
    data = new ArrayEntry(new UInt8());
}
class MdatBox extends Box("mdat") {
    data = new MdatEntry();
}
/*
const MdatBox = (
    function() {
        return {
            type: createBoxHeader(),
            data: new MdatEntry()
        };
    }
);
*/
class MdatEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext): Uint8Array[] {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;

        let buffers: Uint8Array[] = [];
        // Old versions of node have a 1GB buffer limit. And also... why make this high? This size (about 500MB) is way more than enough.
        let maxBufSize = 1 << 29;
        while(pPos.v < end) {
            let curSize = Math.min(maxBufSize, end - pPos.v);
            let buf = buffer.slice(pPos.v, pPos.v + curSize);
            buffers.push(buf);
            pPos.v += curSize;
        }
        return buffers;
    }
    write(context: WriteContext<Uint8Array[]>) {
        let bytes = context.value;
        return bytes.map(x => new Buffer(x));
    }
}

class UdtaBox extends Box("udta") {
    // "Only a copyright notice is defined in this specification.",
    //  but also, people but meta in here.
    boxes = new ArrayBox(new MetaBox);
}
class MetaBox extends FullBox("meta") {
    //todonext
    // Hmm... this handler is going to be crazy. Better just copy
    //  https://github.com/emericg/MiniVideo/blob/85bf66dc8d67e6bf3fc71c0e43e4e1495401f39e/minivideo/src/demuxer/mp4/mp4.cpp#L313
    //  and print a lot.
    // I think it switches its type depending on the data given
    // OR, just don't implement it, and see if we can remove it.
    //tests = new Print();
    remaining = new ArrayEntry(new UInt8());
}
class Print implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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

    //matrix = new ArrayEntry(new Int32(), 9);
    matrix = repeat(new Int32(), 9);
    pre_defined = new ArrayEntry(new UInt32(), 6);

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

    matrix = new ArrayEntry(new Int32(), 9);
    pre_defined = new ArrayEntry(new UInt32(), 6);

    next_track_ID = new Int32();
}
const MvhdBox = FullBoxVersionSplit("mvhd", MvhdBox0, MvhdBox1);

class TrakBox extends Box("trak") {
    boxes = new ArrayBox(new TkhdBox(), new EdtsBox(), new MdiaBox());
}

class MdiaBox extends Box("mdia") {
    boxes = new ArrayBox(new MdhdBox(), new HdlrBox(), new MinfBox());
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
    reversed = new ArrayEntry(new UInt32(), 3);

    name = new CString();
}

class MinfBox extends Box("minf") {
    boxes = new ArrayBox(new VmhdBox(), new DinfBox(), new StblBox());
}
class VmhdBox extends FullBox("vmhd") {
    graphicsmode = new UInt16();
    opcolor = new ArrayEntry(new UInt16(), 3);
}
class DinfBox extends Box("dinf") {
    boxes = new ArrayEntry(CreateObjectEntry(DrefBox()));
}

const DrefBox: () => MP4Box = () => ({
    type: FullBoxHeader("dref"),
    entry_count: new UInt32(),
    boxes: new ArrayEntry(CreateObjectEntry(Url_BoxEntry())),
});

const Url_BoxEntry = () => ({
    type: FullBoxHeader("url ")
});

/*
class Url_Box extends FullBox("url ") {
    // OH, if the flag is 1, then there are no properties. So... TODO: implement modes other than flag === 1
}
*/

class StblBox extends Box("stbl") {
    boxes = new ArrayBox(new StsdBox(), new SttsBox(), new StscBox(), new StszBox(), new StcoBox(), new StssBox(), new CttsBox());
}

/*
aligned(8) class CompositionOffsetBox extends FullBox(‘ctts’, version, 0) {
	unsigned int(32)	entry_count;
		int i;
	if (version==0) {
		for (i=0; i < entry_count; i++) {
			unsigned int(32) 	sample_count;
			unsigned int(32) 	sample_offset;
		}
	}
	else if (version == 1) {
		for (i=0; i < entry_count; i++) {
			unsigned int(32) 	sample_count;
			signed   int(32) 	sample_offset;
		}
	}
}
*/
class CttsBox extends FullBox("ctts") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let box = new (FullBox("ctts"));
        let boxWriteable = boxToMP4Box(box);

        boxWriteable.entry_count = new UInt32();

        let fullBox = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!fullBox) {
            throw new Error(`Unexpected type`);
        }

        let version = fullBox._properties["version"];
        if(typeof version !== "number") {
            throw new Error(`version not type number, it is ${version}`);
        }

        let entry_count = fullBox._properties["entry_count"];
        if(typeof entry_count !== "number") {
            throw new Error(`entry_count not type number, it is ${entry_count}`);
        }

        if(version === 0) {
            boxWriteable.offsets = new ArrayEntry(CreateObjectEntry({
                sample_count: new UInt32(),
                sample_offset: new UInt32(),
            }), entry_count);
        } else if(version === 1) {
            boxWriteable.offsets = new ArrayEntry(CreateObjectEntry({
                sample_count: new UInt32(),
                // The writer of this spec is incompetent. The only difference between the two versions is the sign of this. Why
                //  am I parsing this like this, I should really always parts Int32. If anything uses the sign bit in version === 0,
                //  then we are within 1 bit of running out of data anyway, which means it should be a 64-bit anyway! Stupid stupid stupid.
                sample_offset: new Int32(),
            }), entry_count);
        } else {
            throw new Error(`Invalid version ${version}`);
        }

        return box;
    }
}

class StssBox extends Box("stss") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let box = new (FullBox("stss"));
        let boxWriteable = boxToMP4Box(box);

        boxWriteable.entry_count = new UInt32();

        let fullBox = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!fullBox) {
            throw new Error(`Unexpected type`);
        }

        let entry_count = fullBox._properties["entry_count"];
        if(typeof entry_count !== "number") {
            throw new Error(`entry_count not type number, it is ${entry_count}`);
        }

        boxWriteable.sample_numbers = new ArrayEntry(new UInt32(), entry_count);

        return box;
    }
}

class StcoBox extends FullBox("stco") {
    obj = new StcoEntry();
}
class StcoEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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
    write(context: WriteContext<number[]>) {
        let values = context.value;
        let buffer = new Buffer(4 + values.length * 4);
        buffer.writeUInt32BE(values.length, 0);

        for(let i = 0; i < values.length; i++) {
            buffer.writeUInt32BE(values[i], 4 + i * 4);
        }

        return [buffer];
    }
}

class StszBox extends FullBox("stsz") {
    obj = new StszEntry();
}
class StszEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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
    write(context: WriteContext<number|number[]>) {
        let value = context.value;
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

class StscEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let entry_count = buffer.readInt32BE(pPos.v);
        pPos.v += 4;

        let values: StscValue[] = [];
        for(let i = 0; i < entry_count; i++) {
            let box = parseObject(new StscValueEntry(), { buffer, pPos, end, debugPath: debugPath.concat(`[${i}]`), parents, addArrayValue: null as any }, null, false);
            values.push(box as StscValue);
        }
        return values;
    }
    write(context: WriteContext<BoxMetadata[]>) {
        let boxes = context.value;
        let entryBoxes = new UInt32().write({value: boxes.length});

        let results = entryBoxes.concat(
            flatten(boxes.map(x => writeBox(x, undefined, true)))
        );

        return results;
    }
}


class SttsBox extends FullBox("stts") {
    obj = new SttsEntry();
}
interface SttsEntryValue {
    sample_count: number;
    sample_delta: number;
}
class SttsEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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

    write(context: WriteContext<SttsEntryValue[]>) {
        let values = context.value;
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
        reserved = new ArrayEntry(new UInt8(), 6);
        data_reference_index = new UInt16();
    };
}
// Visual Sequences
const VisualSampleEntry = (type: string) => class extends SampleEntry (type) {
    pre_defined = new UInt16();
    reserved1 = new UInt16();
    pre_defined1 = new ArrayEntry(new UInt32(), 3);
    width = new UInt16();
    height = new UInt16();

    horizresolution = new UInt32();
    vertresolution = new UInt32();

    reserved2 = new UInt32();

    frame_count = new UInt16();

    compressorname = new StupidString(32);
    depth = new UInt16();
    pre_defined2 = new Int16();
}

/*
	// Visual Sequences
class MPEG4BitRateBox extends Box(‘btrt’) {
	unsigned int(32) bufferSizeDB;
	unsigned int(32) maxBitrate;
	unsigned int(32) avgBitrate;
}
class MPEG4ExtensionDescriptorsBox extends Box(‘m4ds’) {
	Descriptor Descr[0 .. 255];
}
class AVCSampleEntry() extends VisualSampleEntry(type) {
															// type is ‘avc1’ or 'avc3'
	AVCConfigurationBox	config;
	MPEG4BitRateBox (); 					// optional
	MPEG4ExtensionDescriptorsBox ();	// optional
	extra_boxes				boxes;				// optional
}
class AVC2SampleEntry() extends VisualSampleEntry(type) {
															// type is ‘avc2’ or 'avc4'
	AVCConfigurationBox	avcconfig;
	MPEG4BitRateBox bitrate; 					// optional
	MPEG4ExtensionDescriptorsBox descr;	// optional
	extra_boxes				boxes;				// optional
}
*/

const AVCDecoderConfigurationRecord = () => CreateObjectEntry({
    configurationVersion: new UInt8(),
	AVCProfileIndication: new UInt8(),
	profile_compatibility: new UInt8(),
    AVCLevelIndication: new UInt8(),
    notImportant: new ArrayEntry(new UInt8()),
});

// https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute
class AVCConfigurationBox extends Box("avcC") {
    AVCConfig = new ArrayEntry(AVCDecoderConfigurationRecord(), 1);
}

class AVCSampleEntry extends VisualSampleEntry("avc1") {
    config = new ArrayBox(1, new AVCConfigurationBox());
    notImportant = new ArrayEntry(new UInt8());
	//MPEG4BitRateBox (); 					// optional
	//MPEG4ExtensionDescriptorsBox ();	// optional
	//extra_boxes				boxes;				// optional
}

/*
5.4.2.1.3	Semantics
Compressorname in the base class VisualSampleEntry indicates the name of the compressor used with the value "\012AVC Coding" being recommended; the first byte is a count of the remaining bytes, here represented by \012, which (being octal 12) is 10 (decimal), the number of bytes in the rest of the string.
config is defined in 5.3.3. If a separate parameter set stream is used, numOfSequenceParameterSets and numOfPictureParameterSets must both be zero.
Descr is a descriptor which should be placed in the ElementaryStreamDescriptor when this stream is used in an MPEG-4 systems context. This does not include SLConfigDescriptor or DecoderConfigDescriptor, but includes the other descriptors in order to be placed after the SLConfigDescriptor.
bufferSizeDB gives the size of the decoding buffer for the elementary stream in bytes.
maxBitrate gives the maximum rate in bits/second over any window of one second.
avgBitrate gives the average rate in bits/second over the entire presentation.

*/

class StsdEntry implements MP4BoxEntryInterface {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let entries: BoxMetadata[] = [];

        let entry_count = (new (IntN(4, false))).parse(parseContext);
        for(let i = 0; i < entry_count; i++) {
            let boxInfo = parseBoxInfo([new AVCSampleEntry()], buffer, pPos, debugPath, parents);
            if(!boxInfo) {
                throw new Error(`StsdEntry.parseBoxInfo didn't work?`);
            }
            entries.push(boxInfo);
        }

        return entries;
    }

    // They better not change the entry count. We only allow changing values
    write(context: WriteContext<BoxMetadata[]>) {
        let entries = context.value;
        let headerBuffers = (new (IntN(4, false))).write({ value: entries.length });
        
        let entryBuffers = flatten(entries.map((x, i) => writeBox(x, `stsd[${i}]`, true)));

        return headerBuffers.concat(entryBuffers);
    }
}


class EdtsBox extends Box("edts") {
    boxes = new ArrayBox(new ElstBox());
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
class ElstEntry implements MP4BoxEntryInterface {
    constructor() { }
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let version = buffer.readUInt8(pPos.v);
        pPos.v += 1;
        let flags = buffer.readUIntBE(pPos.v, 3);
        pPos.v += 3;

        let entries: ElstEntryArrayValue[] = [];

        let entry_count = (new (IntN(4, false))).parse(parseContext);
        for(let i = 0; i < entry_count; i++) {
            let segment_duration: number;
            let media_time: number;
            if(version === 0) {
                segment_duration = (new (IntN(4, false))).parse(parseContext);
                media_time = (new (IntN(4, true))).parse(parseContext);
            } else if(version === 1) {
                segment_duration = (new (IntN(8, false))).parse(parseContext);
                media_time = (new (IntN(8, true))).parse(parseContext);
            } else {
                throw new Error(`Unexpected version ${version}`);
            }

            let media_rate_integer = (new (IntN(2, true))).parse(parseContext);
            let media_rate_fraction = (new (IntN(2, true))).parse(parseContext);

            entries.push({ segment_duration, media_time, media_rate_integer, media_rate_fraction });
        }

        return { entries, version };
    }

    // They better not change the entry count. We only allow changing values
    write(context: WriteContext<{ version: number, flags: number, entries: ElstEntryArrayValue[] }>) {
        let obj = context.value;
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

    matrix = new ArrayEntry(new Int32(), 9);

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

    matrix = new ArrayEntry(new Int32(), 9);

    width = new UInt32();
    height = new UInt32();
}
const TkhdBox = FullBoxVersionSplit("tkhd", TkhdBox0, TkhdBox1);


class MoofBox extends Box("moof") {
    boxes = new ArrayBox(new MfhdBox(), new TrafBox());
}

class MfhdBox extends FullBox("mfhd") {
    sequence_number = new UInt32();
}

class TrafBox extends Box("traf") {
    boxes = new ArrayBox(new TfhfBox(), new TrunBox(), new TfdtBox());
}


class TfhfBox extends Box("tfhd") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let fullCtor = FullBox("tfhd");
        let fullBox = parseBoxInfo([new fullCtor()], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!fullBox) {
            throw new Error(`Unexpected type`);
        }
        let tf_flags = fullBox._properties["flags"];
        if(typeof tf_flags !== "number") {
            throw new Error(`Flag not type number, it is ${tf_flags}`);
        }

        let result: IBox<"tfhd"> = new (FullBox("tfhd"));

        let resultBox = boxToMP4Box(result);
        resultBox.track_ID = new UInt32();

        if(tf_flags & 0x000001) {
            resultBox.base_data_offset = new UInt64();
        }

        if(tf_flags & 0x000002) {
            resultBox.sample_description_index = new UInt32();
        }

        if(tf_flags & 0x000008) {
            resultBox.default_sample_duration = new UInt32();
        }

        if(tf_flags & 0x000010) {
            resultBox.default_sample_size = new UInt32();
        }

        if(tf_flags & 0x000020) {
            resultBox.default_sample_flags = new UInt32();
        }

        return result;
    }
}

class TrunBox extends Box("trun") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let box = new (FullBox("trun"));
        let boxWriteable = boxToMP4Box(box);

        boxWriteable.sample_count = new UInt32();

        let fullBox = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!fullBox) {
            throw new Error(`Unexpected type`);
        }

        let sample_count = fullBox._properties["sample_count"];
        if(typeof sample_count !== "number") {
            throw new Error(`sample_count not type number, it is ${sample_count}`);
        }

        let tf_flags = fullBox._properties["flags"];
        if(typeof tf_flags !== "number") {
            throw new Error(`Flag not type number, it is ${tf_flags}`);
        }
        
        if(tf_flags & 0x000001) {
            boxWriteable.data_offset = new Int32();
        }

        if(tf_flags & 0x000004) {
            boxWriteable.first_sample_flags = new Int32();
        }

        let trackRunBoxWriteable: MP4Box = {};
        let trackRunBox = trackRunBoxWriteable as any as IBox<any>;
        boxWriteable.trackRunBoxes = new ArrayBox(trackRunBox);

        if(tf_flags & 0x000100) {
            boxWriteable.sample_duration = new UInt32();
        }
        if(tf_flags & 0x000200) {
            boxWriteable.sample_size = new UInt32();
        }
        if(tf_flags & 0x000400) {
            boxWriteable.sample_flags = new UInt32();
        }
        if(tf_flags & 0x000800) {
            boxWriteable.sample_composition_time_offset = new UInt32();
        }

        return box;
    }
}

class TfdtBox extends FullBox("tfdt") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let box = new (FullBox("tfdt"));
        let boxWriteable = boxToMP4Box(box);

        let fullBox = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!fullBox) {
            throw new Error(`Unexpected type`);
        }

        let version = fullBox._properties["version"];
        if(typeof version !== "number") {
            throw new Error(`version not type number, it is ${version}`);
        }

        if(version === 0) {
            boxWriteable.baseMediaDecodeTime = new UInt32();
        } else if(version === 1) {
            boxWriteable.baseMediaDecodeTime = new UInt64();
        } else {
            throw new Error(`Unexpected verrsion ${version}`);
        }

        return box;
    }
}


class SidxBox extends FullBox("sidx") {
    chooseBox = (context: ChooseBoxContext) => {
        let { buffer, pos, end, debugPath, parents } = context;
        let box = new (FullBox("sidx"));
        let boxWriteable = boxToMP4Box(box);

        let boxData = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!boxData) {
            throw new Error(`Unexpected type`);
        }

        let version = boxData._properties["version"];
        if(typeof version !== "number") {
            throw new Error(`version not type number, it is ${version}`);
        }

        boxWriteable.reference_ID = new UInt32();
        boxWriteable.timescale = new UInt32();
        if(version === 0) {
            boxWriteable.earliest_presentation_time = new UInt32();
            boxWriteable.first_offset = new UInt32();
        } else {
            boxWriteable.earliest_presentation_time = new UInt64();
            boxWriteable.first_offset = new UInt64();
        }

        boxWriteable.reserved = new UInt16();
        boxWriteable.reference_count = new UInt16();

        boxData = parseBoxInfo([box], buffer, {v: pos}, debugPath, parents, undefined, false);
        if(!boxData) {
            throw new Error(`Unexpected type`);
        }

        let reference_count = boxData._properties.reference_count;
        if(typeof reference_count !== "number") {
            throw new Error(`reference_count not type number, it is ${reference_count}`);
        }

        /*
            bit (1)				reference_type;
            unsigned int(31)	referenced_size;
            unsigned int(32)	subsegment_duration;
            bit(1)				starts_with_SAP;
            unsigned int(3)	SAP_type;
            unsigned int(28)	SAP_delta_time;
        */
        let referenceEntry = CreateObjectEntry({
            a: bitMapping({
                "reference_type": 1,
                "reference_size": 31,
            }),
            subsegment_duration: new UInt32(),
            SAP: bitMapping({
                "starts_with_SAP": 1,
                "SAP_type": 3,
                "SAP_delta_time": 28,
            })
        });
        /*
        "SAP_starts_type_delta_time": 2415919104
        10010000000000000000000000000000
        */

        boxWriteable.references = new ArrayEntry(referenceEntry, reference_count);       

        return box;
    }
}

class EmsgBox extends FullBox("emsg") {
    scheme_id_uri = new CString();
    value = new CString();
    timescale = new UInt32();
    presentation_time_delta = new UInt32();
    event_duration = new UInt32();
    id = new UInt32();

    message_data = new ArrayEntry(new UInt8());
}

// #region Primitives

function CreateObjectEntry(box: MP4Box): MP4BoxEntryInterface<any> {
    return {
        parse(parseContext: ParseContext) {
            return parseObject(box, parseContext, null, false);
        },
        write(value: WriteContext<any>): Buffer[] {
            return writeBox(value.value, undefined, true);
        }
    }
}

function IntN(bytes: number, signed: boolean): { new(): MP4BoxEntryInterface<number> } {
    if(bytes > 8 || bytes <= 0) {
        throw new Error(`Invalid number of bytes ${bytes}`);
    }
    return class {
        parse(parseContext: ParseContext) {
            let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;

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
        write(context: WriteContext<number>) {
            let value = context.value;
            if(value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
                throw new Error(`Cannot write number, as it is too large. ${value}`);
            }
            if(value % 1 !== 0) {
                throw new Error(`Cannot write number, as it is a decimal. ${value}`);
            }
            let buffer = new Buffer(bytes);
            if(bytes > 6) {
                let extraBytes = bytes - 6;
                buffer.writeUIntBE(value, extraBytes, bytes - extraBytes);
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
    Ctor: { new(): MP4BoxEntryInterface<T> },
    parseMap: (value: T) => N,
    writeMap: (value: N) => T,
) {
    let entry = new Ctor();
    return class {
        parse(parseContext: ParseContext) {
            let t = entry.parse(parseContext);
            return parseMap(t);
        }
        write(value: WriteContext<N>): Buffer[] {
            let t = writeMap(value.value);
            return entry.write({value: t});
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

function bitsToByte(bits: number[]): number {
    let byte = 0;
    let mask = 1;
    for(let i = bits.length - 1; i >= 0; i--) {
        let bit = bits[i];
        let value = bit * mask;
        byte += value;
        mask = mask << 1;
    }
    return byte;
}
function byteToBits(byteIn: number, bitCount = 8): number[] {
    let byte = byteIn;
    let bits: number[] = [];
    let mask = 1 << (bitCount - 1);
    if(byte >= mask * 2) {
        throw new Error(`Tried to get ${bitCount} bits from ${byte}, but that number has more bits than requested!`);
    }
    while(mask) {
        let bit = byte & mask;
        bits.push(bit === 0 ? 0 : 1);
        mask = mask >> 1;
    }
    return bits;
}

type BitCount = number;
function bitMapping<T extends { [key: string]: BitCount }>(bitMap: T): MP4BoxEntryBase<T> {
    let totalBits = sum(Object.values(bitMap));
    if(totalBits % 8 !== 0) {
        throw new Error(`Bit map not divisible by 8. A bit mapping must align with bytes, or else we can't handle it. Mapping had ${totalBits} bits, was ${JSON.stringify(bitMap)}`);
    }
    let bytes = totalBits / 8;
    return {
        parse(parseContext: ParseContext) {
            let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
            let bits: number[] = [];
            for(let i = 0; i < bytes; i++) {
                let byte = buffer.readUInt8(pPos.v);
                for(let bit of byteToBits(byte)) {
                    bits.push(bit);
                }
                pPos.v++;
            }

            return mapObjectValuesKeyof(bitMap, (bitCount: number, key: string) => {
                let curBits = bits.slice(0, bitCount);
                bits = bits.slice(bitCount);
                return bitsToByte(curBits);
            });
        },
        write(context: WriteContext<T>) {
            let value = context.value;
            let bits: number[] = [];

            for(let key in bitMap) {
                let bitCount = bitMap[key];
                let keyValue = value[key];
                let valueBits = byteToBits(keyValue, bitCount);
                for(let bit of valueBits) {
                    bits.push(bit);
                }
            }

            let bytePos = 0;
            let buffer = new Buffer(bits.length / 8);
            while(bits.length > 0) {
                let byteBits = bits.slice(0, 8);
                bits = bits.slice(8);
                let byte = bitsToByte(byteBits);
                buffer.writeUInt8(byte, bytePos);
                bytePos++;
            }

            return [buffer];
        }
    };
}

class NumberShifted implements MP4BoxEntryInterface {
    constructor(private baseNum: MP4BoxEntryInterface<number>, private shiftDivisor: number) { }
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        return this.baseNum.parse(parseContext) / this.shiftDivisor;
    }
    write(context: WriteContext<number>) {
        let value = context.value;
        value *= this.shiftDivisor;
        value = Math.round(value);
        return this.baseNum.write({value});
    }
}

class ArrayBox implements MP4BoxEntryInterface {
    private boxes: IBox<any>[];
    private count: number|null = null;
    constructor(...boxes: IBox<any>[]);
    constructor(length: number, ...boxes: IBox<any>[]);
    constructor(...boxes: (IBox<any>|number)[]) {
        this.boxes = [];
        for(let i = 0; i < boxes.length; i++) {
            let box = boxes[i];
            if(typeof box === "number") {
                if(i > 0) {
                    throw new Error(`Invalid arguments for ArrayBox`);
                } else {
                    this.count = box;
                }
            } else {
                this.boxes.push(box);
            }
        }
    }
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let count = this.count === null ? Number.MAX_SAFE_INTEGER : this.count;

        let arr = parseBoxArray(this.boxes, buffer, debugPath, parents, pPos, end, count, addArrayValue);

        return arr;
    }
    write(context: WriteContext<BoxMetadata[]>) {
        let value = context.value;
        return flatten(value.map(v => writeBox(v, undefined, true)));
    }
} 


class ArrayEntry<T> implements MP4BoxEntryInterface<T[]> {
    constructor(private entry: MP4BoxEntryInterface<T>, private count: number|null = null) { }
    parse(parseContext: ParseContext): T[] {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let result: T[] = [];
        let countToRead = this.count === null ? Number.MAX_SAFE_INTEGER : this.count;
        while(pPos.v < end && countToRead > 0) {
            let obj = this.entry.parse(parseContext);
            result.push(obj);

            if(pPos.v > end) {
                throw new Error(`Overflowed end of box while parsing array. ${debugPath.join(".")}`);
            }
            countToRead--;
        }
        if(this.count !== null && countToRead > 0) {
            throw new Error(`Did not read full count of ${this.count}, had ${countToRead} left to read before we reached the end of the data.`);
        }
        return result;
    }

    write(context: WriteContext<T[]>): Buffer[] {
        let values = context.value;
        if(this.count !== null && values.length !== this.count) {
            throw new Error(`Invalid count, expected ${this.count}, received ${values.length}, for ${this.entry}, values ${JSON.stringify(values)}`);
        }
        return flatten(values.map(v => this.entry.write({value: v})));
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

class CString implements MP4BoxEntryInterface<string> {
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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

    write(context: WriteContext<string>) {
        let value = context.value;
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
class StupidString implements MP4BoxEntryInterface<string> {
    constructor(private bufferLength: number) { }
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
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

    write(context: WriteContext<string>) {
        let text = context.value;
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

//todonext
// Make an ArrayBox, that is a box, not an entry, and that chooses it's children with chooseBox instead.
/*
class ArrayBox implements MP4BoxEntryInterface {
    private boxes: IBox<any>[];
    private count: number|null = null;
    constructor(...boxes: IBox<any>[]);
    constructor(length: number, ...boxes: IBox<any>[]);
    constructor(...boxes: (IBox<any>|number)[]) {
        this.boxes = [];
        for(let i = 0; i < boxes.length; i++) {
            let box = boxes[i];
            if(typeof box === "number") {
                if(i > 0) {
                    throw new Error(`Invalid arguments for ArrayBox`);
                } else {
                    this.count = box;
                }
            } else {
                this.boxes.push(box);
            }
        }
    }
    parse(parseContext: ParseContext) {
        let { buffer, pPos, end, debugPath, parents, addArrayValue } = parseContext;
        let count = this.count === null ? Number.MAX_SAFE_INTEGER : this.count;

        let arr = parseBoxArray(this.boxes, buffer, debugPath, parents, pPos, end, count, addArrayValue);

        return arr;
    }
    write(context: WriteContext<BoxMetadata[]>) {
        let value = context.value;
        return flatten(value.map(v => writeBox(v, undefined, true)));
    }
} 
*/

interface IBox<T extends string> {
    type: T;
    chooseBox?: (context: ChooseBoxContext) => IBox<T>;
}

function ArrayBoxNew(...boxes: IBox<any>[]): ChooseBoxEntry<any>;
function ArrayBoxNew(length: number, ...boxes: IBox<any>[]): ChooseBoxEntry<any>;
function ArrayBoxNew (...boxesIn: (IBox<any>|number)[]): ChooseBoxEntry<any> {
    let count: number = Number.MAX_SAFE_INTEGER;
    let boxes: IBox<any>[];
    boxes = [];
    for(let i = 0; i < boxesIn.length; i++) {
        let box = boxesIn[i];
        if(typeof box === "number") {
            if(i > 0) {
                throw new Error(`Invalid arguments for ArrayBox`);
            } else {
                count = box;
            }
        } else {
            boxes.push(box);
        }
    }
    return function chooseBox(context: ChooseBoxContext): MP4Box {
        let { buffer, pos, end, debugPath, parents } = context;
        //let box: IBox<""> = { type: null as any as "" };
        let boxWriteable: MP4Box = {};

        // Read all boxes, get their types, find real boxes in lookup, and then return entries to parse those specific boxes?
        //  But... want it to be an array, so... add support for direct arrays contains entries?
        //  And also support for an entry that just reads a box (but just a single one, so it isn't an array)

        // CreateObjectEntry

        let boxLookup = keyBy(boxes, x => x.type);

        let childEntries: MP4BoxEntryBase<any>[] = [];
        
        while(pos < end) {
            let childBox = parseBoxRaw(buffer, pos);
            pos += childBox.size;

            let boxParser = boxLookup[childBox.type];
            if(!boxParser) {
                throw new Error(`Could not find handler for box ${childBox.type}. Should have been one of ${boxes.map(x => x.type).join(", ")}`);
            }

            if(boxParser.chooseBox) {
                boxParser = boxParser.chooseBox({ buffer, pos, debugPath, end, parents });
            }
            
            let box = { ... boxToMP4Box(boxParser) };
            if(box.type) {
                box.type = BoxHeader(box.type as any as string);
            }

            let childEntry = CreateObjectEntry(box);
            childEntries.push(childEntry);
        }

        boxWriteable.boxes = childEntries;

        return boxWriteable;
    };
}

function BoxHeader(typeIn: string|"any"): ChooseBoxEntry<any> {
    return (context) => {
        let { pos, buffer } = context;
        /*
            size is an integer that specifies the number of bytes in this box, including all its fields and contained
                boxes; if size is 1 then the actual size is in the field largesize; if size is 0, then this box is the last
                one in the file, and its contents extend to the end of the file (normally only used for a Media Data Box) 
        */
        let size = buffer.readUInt32BE(pos); pos += 4;
        let type = textFromUInt32(buffer.readUInt32BE(pos)); pos += 4;

        if(type === "uuid") {
            throw new Error(`Unhandled mp4 box type uuid`);
        }

        if(typeIn !== "any" && typeIn !== type) {
            throw new Error(`Wrong type at ${pos}, ${context.debugPath.join(".")}. Expected ${typeIn}, found ${type}`);
        }

        let box: MP4Box = { };
        if(size !== 1) {
            box.size = new UInt32();
            box.type = new UInt32String();
        } else {
            box.wastedSize = new UInt32();
            box.type = new UInt32String();
            box.size = new UInt64();
        }

        return box;
    };
}

function FullBoxHeader(typeIn: string|"any"): ChooseBoxEntry<any> {
    let header = BoxHeader(typeIn);
    return (context) => {
        let box = header(context);

        box.version = new UInt8();
        box.flags = new UInt24();

        return box;
    };
}


const RootBox = new ArrayBox(
    new FileBox(),
    new FreeBox(),
    new MdatBox(),
    new MoovBox(),
    new MoofBox(),
    new SidxBox(),
    new EmsgBox(),
);

//todonext
// Make boxes use regular entries, instead of custom handling. This means parseBoxInfo can't take an array,
//  and the caller will need to use chooseBox to figure out which box to parse instead, and then call parseObject

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

    return {
        start,
        size,
        type,
        headerSize,
    };
}
/*
interface ParseContext {
    buffer: Buffer;
    pPos: P<number>;
    end: number;
    debugPath: string[];
    parents: BoxMetadata[];
    addArrayValue: (value: any) => void;
}
*/
function parseBoxInfo(boxes: IBox<any>[], buffer: Buffer, pPos: P<number>, debugPath: string[], parents: BoxMetadata[], forceType = "", isBoxComplete = true): BoxMetadata|undefined {
    let boxesLookup = keyBy(boxes, x => x.type);

    let box = parseBoxRaw(buffer, pPos.v);

    let boxType = forceType || box.type;
    let curDebugPath = debugPath.concat(boxType);
    let end = box.start + box.size;
    let boxInfoClass = boxesLookup[boxType];
    if(!boxInfoClass) {
        if(boxes.length === 1) {
            boxInfoClass = boxes[0];
        } else {
            console.warn(`Unknown box type ${curDebugPath.join(".")}`);
            console.warn(`Unknown box type ${curDebugPath.join(".")}, size ${box.size} at ${pPos.v}, have boxes ${Object.values(boxesLookup).map(x => x.type).join(", ")}`);
            boxes.push({ type: box.type });
            return undefined;
        }
    }

    let boxResult = parseObject(boxToMP4Box(boxInfoClass), { buffer, pPos, end, debugPath: curDebugPath, parents, addArrayValue: null as any }, box, isBoxComplete, forceType || box.type);

    return boxResult;
}

function parseObject(boxInfoIn: {}, context: ParseContext, rawBox: RawBox|null = null, isBoxComplete = true, forcedType = ""): any {
    let { buffer, pPos, end, debugPath, parents } = context;

    let start = pPos.v;

    // Copy it, in case we mess around with the box (such as making functions the values they evaluate too).
    let boxInfo = { ... boxInfoIn as MP4Box };

    let chooseBox = boxInfo.chooseBox as any as IBox<any>["chooseBox"];
    if(chooseBox) {
        let chooseContext = { ...context, pos: context.pPos.v } as ChooseBoxContext;
        boxInfo = boxToMP4Box(chooseBox(chooseContext));
    }

    let boxResult: BoxMetadata;
    {
        let boxMetadata: BoxMetadata = {
            _box: rawBox,
            _info: boxInfo,
            _properties: null as any,
            nicePath: debugPath.join(".")
        };
        boxResult = { ...boxMetadata };
        boxResult._properties = boxResult as any;
    }

    parents.unshift(boxResult as any);
    try {
        for(let key in boxInfo) {
            let typeInfo = boxInfo[key];
            if(key === "type" && typeof typeInfo === "string") {
                // Copy the type directly
                boxResult._properties[key] = forcedType || boxInfo[key] as any as string;
                if(!boxResult._box) {
                    throw new Error(`Has type, but there is no underlying box.`);
                }
                pPos.v += boxResult._box.headerSize;
                continue;
            }

            if(!typeInfo || typeof typeInfo !== "object" && typeof typeInfo !== "function") continue;

            if(isArray(typeInfo)) {
                let outputArray: any[] = [];
                boxResult._properties[key] = outputArray;
                let typeInfoArr = typeInfo;
                for(let i = 0; i < typeInfo.length; i++) {
                    parseEntry(typeInfo[i], x => outputArray[i] = x, x => typeInfoArr[i] = x);
                }
            } else {
                parseEntry(typeInfo, x => boxResult._properties[key] = x, x => boxInfo[key] = x);
            }

            if(key === "type") {
                let typeObj = boxResult._properties[key];
                if(typeof typeObj === "object") {
                    let size = (typeObj as any).size as number;
                    end = start + size;
                    isBoxComplete = true;
                }
            }
        }
        function parseEntry(typeInfo: MP4BoxEntryBase<any>, setValue: (value: any) => void, setTypeValue: (typeInfo: MP4BoxEntryBase<any>) => void): void {
            if(typeof typeInfo === "function") {
                let chooseBox = typeInfo;
                let box = chooseBox({buffer, pos: pPos.v, end, debugPath, parents});
                typeInfo = CreateObjectEntry(box);
                setTypeValue(typeInfo);
            }
            if(!typeInfo.parse) return;

            let outputArray: any[] = [];
            let setArray = false;
            function addArrayValue(value: any): void {
                setArray = true;
                setValue(outputArray);
                outputArray.push(value);
            }

            let value = typeInfo.parse({buffer, pPos, end, debugPath, parents, addArrayValue});

            if(setArray && !arrayEqual(outputArray, value)) {
                throw new Error(`Added to array, but output was not equal to values added to array.`);
            }

            if(pPos.v > end) {
                throw new Error(`Read beyond end at ${debugPath.join(".")}. Pos ${pPos.v}, end ${end}`);
            }
            setValue(value);
        }
    } finally {
        parents.shift();
    }

    if(isBoxComplete) {
        let unaccountedSpace = end - pPos.v;
        if(unaccountedSpace > 0) {
            console.log(`Unaccounted space in ${debugPath.join(".")}, ${unaccountedSpace} bytes.`);
        }
        // Only set if box is complete.
        pPos.v = end;
    }

    return boxResult;
}
function parseBoxArray(boxes: IBox<any>[], buffer: Buffer, debugPath: string[], parents: BoxMetadata[], pPosIn: P<number>|null = null, end = buffer.length, count: number, addArrayValue: (value: any) => void) {
    let results: BoxMetadata[] = [];

    let pPos = pPosIn || { v: 0 };

    while(pPos.v < end && count > 0) {
        let result = parseBoxInfo(boxes, buffer, pPos, debugPath, parents);
        if(!result) continue;
        addArrayValue(result);
        results.push(result);
        count--;
    }

    if(pPos.v > end) {
        throw new Error(`Read beyond end in parseBoxArray at ${pPos.v}, boxes: ${boxes.map(x => `'${x.type}'`).join(", ")}, read ${results.map(x => x.nicePath).join(", ")}`);
    }

    return results;
}

function getContext(buffer: Buffer, pos: number, contextSize = 32): string {
    let beforePos = pos - contextSize;
    let beforeLength = contextSize;
    if(beforePos < 0) {
        beforeLength += beforePos;
        beforePos = 0;
    }
    let endBefore = Math.min(beforePos + contextSize, beforePos + beforeLength);
    let outputBefore = "";

    for(let i = beforePos; i < endBefore; i++) {
        let byte = buffer.readInt8(i);
        if(byte === 0) {
            outputBefore += "\\0";
        } else {
            outputBefore += String.fromCharCode(byte);
        }
    }

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
    return outputBefore + "|" + output;
}

const bufferSourceInfo = Symbol();

let maxUInt32 = Math.pow(2, 32) - 1;
function writeBox(boxResult: BoxMetadata, context = "", delayTestAdd = false): Buffer[] {
    //todonext
    // Hmmm... the Moov box size is wrong, it is 657, it should be 697

    let buffers: Buffer[] = [];
   
    for(let key in boxResult._info) {
        let entry = boxResult._info[key];

        // Skip entries used for other things (that are not MP4BoxEntries)
        if(!entry || typeof entry !== "object") {
            continue;
        }

        let value = boxResult._properties[key];
        if(isArray(entry)) {
            if(!isArray(value)) {
                throw new Error(`Entry and value don't match up. Entry is array, value is not. Entry ${entry}, value ${value}`);
            }
            for(let i = 0; i < entry.length; i++) {
                let subEntry = entry[i];
                if(typeof subEntry === "function") {
                    throw new Error(`In the write phase we found an Entry that is a function. In the parse phase this should have been called to get the actual entry.`);
                }
                let subValue = value[i];
                let subBuffers = subEntry.write({ value: subValue });
                for(let subBuffer of subBuffers) {
                    buffers.push(subBuffer);
                }
            }
        } else {
            let subBuffers = entry.write({value});
                    
            for(let subBuffer of subBuffers) {
                buffers.push(subBuffer);
            }
        }
    }

    // Do header last, as before we do the contents we can't know the size of the header
    let box = boxResult._box;
    // Otherwise it has no header, and it just an object
    if(box) {
        //if(true as boolean) throw new Error("here");
        let { type } = box;

        let size = sum(buffers.map(x => x.length)) + 8;

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

        let allBuffers = [headerBuffer].concat(buffers);
        if(sum(allBuffers.map(x => x.length)) < maxUInt32 && !allBuffers.some(x => bufferSourceInfo in x)) {
            let bigBuffer = Buffer.concat(allBuffers);
            buffers = [bigBuffer];
        } else {
            buffers = allBuffers;
        }
        setBufferContext(buffers, `${boxResult.nicePath}`);

        /*
        setBufferContext([headerBuffer], `Header Box ${boxResult.nicePath}`);
        setBufferContext(buffers, `Contents Box ${boxResult.nicePath}`);

        buffers.unshift(headerBuffer);
        */
    }

    return buffers;
}
function writeBoxArr(boxResults: BoxMetadata[]): Buffer[] {
    let buffers: Buffer[] = [];
    for(let boxResult of boxResults) {
        let buffer = writeBox(boxResult);
        testAddBuffers(buffer);
        let subBufferIndex = 0;
        for(let subBuffer of buffer) {
            buffers.push(subBuffer);
            subBufferIndex++;
        }
    }

    return buffers;
}
function setBufferContext(buffer: Buffer[], context: string) {
    for(let b of buffer) {
        if(!(bufferSourceInfo in b)) {
            (b as any)[bufferSourceInfo] = context;
        }
    }
}
let curTestBuffer: Buffer|null = null;
let curTestPos = 0;
function testBuffer(correct: Buffer, code: () => void) {
    curTestBuffer = correct;
    curTestPos = 0;
    try {
        code();
    } finally {
        curTestBuffer = null;
    }
}
const addBufferAdded = Symbol();
function testAddBuffers(buffers: Buffer[]) {
    if(curTestBuffer === null) return;
    let bufIndex = -1;
    for(let buf of buffers) {
        bufIndex++;
        let ahh = buf as any;
        if(ahh[addBufferAdded]) continue;

        ahh[addBufferAdded] = true;
        for(let i = 0; i < buf.length; i++) {
            let newByte = buf[i];
            let absPos = curTestPos;
            let context = (buf as any)[bufferSourceInfo];
            if(absPos > curTestBuffer.length) {
                throw new Error(`Wrote too many bytes at ${absPos}, local ${i} in buffer ${bufIndex}, ${context}`);
            }
            let correctByte = curTestBuffer[absPos];
            curTestPos++;
            if(absPos === 31) continue;
            if(absPos === 187) continue;
            if(absPos === 287) continue;
            if(absPos === 422) continue;
            if(absPos === 430) continue;
            if(newByte !== correctByte) {
                throw new Error(`Wrote wrong byte at ${absPos}, local ${i} in buffer ${bufIndex}, should be ${correctByte}, was ${newByte}. ${context}. \nCorrect context: '${getContext(curTestBuffer, absPos)}', \nnew context:     '${getContext(buf, i)}'`);
            }
        }
    }
}

function getAllFirstOfTypeUnsafe(boxes: BoxMetadata[], type: string): any[] {
    return getAllFirstOfType(boxes, type) as any[];
}
function getAllFirstOfType(boxes: BoxMetadata[], type: string): BoxMetadata[] {
    let results: BoxMetadata[] = [];
    iterate(boxes);
    function iterate(box: BoxMetadata|BoxMetadata[]|Types.Primitive) {
        if(!box || typeof box !== "object") return;
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
    let parseContext: ParseContext = {
        buffer,
        pPos: {v: 0},
        // Just ignore, or something...
        addArrayValue: () => { },
        debugPath: [],
        end: buffer.length,
        parents: []
    };
    return RootBox.parse(parseContext) as BoxMetadata[];
}

//todonext
// mvhd, and then change the rate and write it back to a new file
// Arrays of const count

/*
let fileName = filePath.split("/").slice(-1)[0];

let boxes = parseBoxes(buffer);
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


/*
function testWrite() {
    let newBuffer: Buffer = Buffer.concat(writeBoxArr(boxes));

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
}
*/


// Okay... now create jpegs in code, and test if that works. And that will also let us test variable width/height,
//  as vlc seems to be ignoring our width/height

// It doesn't look like vlc is using the matrixes. So... we are going to have to bake the writing into the mpegs.

async function loadFont(type: string): Promise<any> {
    return new Promise((resolve, reject) => {
        let jimpAny = Jimp as any;    
        jimpAny.loadFont(type, (err: any, font: any) => {
            if(err) {
                reject(err);
            } else {
                resolve(font);
            }
        });
    });
}

// ffmpeg -y -i large.mp4 -preset ultrafast -c h264 large.h264.mp4

// So: `ffmpeg -i 10fps.mp4 -c h264 10fps.h264.mp4`, works with our mp4s. Idk... maybe the ffmpeg created mp4s with jpegs doesn't work
//  because they are deformed in some way? Eh... no point in fixing it now, we can already create our mp4s with jpegs, so we should.

//todonext
// Okay, now for streaming videos. We can create frames, and pretend we are receiving them from a stream.
//  TODO:
//  - timestamp faster?
//  - decide how to create a rolling mp4 h264 file
//      - Option 1, use ffmpeg to create mp4 video
//          - This is easier, but requires larger chunks, so it adds more delay
//      - Option 2, create h264 frames myself
//          - Harder, but lets us stream to all playback rates in realtime (but we still need to refresh the video)

// Okay, use ffmpeg, chunks of 1 second, and then maintain the mp4 file ourself. Pack a base h264.mp4 into the code, and use that as a starting point,
//  and then use the chunks from ffmpeg as native chunks. Then we'll be set


// Oh, it's HLS video. It 'resembles dash'. Crap...

// Nah, let's use HLS video, and ffmpeg to create the frames. This will let us live stream,
//  and make creating the media easy, as ffmpeg isn't screwing up our frames anymore (at least for 10 second videos, which is the
//  maximum chunk size we should ever need).

// Chrome seems to handle large mp4 files fine.

//todonext
// Get test.html (really a .mp4) to load into a video locally (via MediaSource), and play.

//todonext
// https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-00#page-9
//  I think it's just a single playlist file, which the browser reloads (and by that, it reloads byte specified segments of it).
//  So...
//  - start requesting youtube live streams and getting their playlists
//  - figure out the payload format (it looks ilke just a mp4 box, BUT, it seems to have some weird data inside it. Is that data part of
//      the mdat? Does that mean I can't just send h264 video? Do *I* need to add that data to my h264 video frames before I send it?
//      I should probably decode the data they send me as boxes so I can view it...)

/*
fs.open("./large.mp4", "r", (err, fd) => {
    if(err) throw err;
    let output = new Buffer(10000);
    fs.read(fd, output, 0, output.length, 0, () => {
        //let buffer: Buffer = fs.readFileSync("./large.mp4");
        let boxes = parseBoxes(output);
        console.log(boxes);
    });
});
*/

// Oh, chunks are important, as they give a lookup to frames starts (they are basically just a lookup to frame starts).

function createMp4Fragment(
    data: {

    }
): Buffer[] {
    // K, we only need:
    //  moov
    //  moof
    //  mdat
    //  sidx

    //todonext
    // Let's try removing stuff from the mp4 to find what is required.

    {
        let name = "./youtube.mp4";
        let buf = fs.readFileSync(name);
        let boxes = parseBoxes(buf);
    }

    let boxes: BoxMetadata[] = [];

    /*
    _box: RawBox;
    _info: MP4Box;
    _properties: { [name: string]: Types.Primitive|Buffer|BoxMetadata[] };
    nicePath: string;

    interface MP4BoxEntryBase<T = any> {
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
    */
   
    /*
    let ftyp: BoxMetadata = {
        _box: null,
        _info: {
            type: new UInt32String()
        },
        _properties: {
            type: "ftyp"
        },
        nicePath: "ftyp"
    };
    boxes.push(ftyp);
    */

    console.log(boxes);

    return writeBoxArr(boxes);
}

process.on("unhandledRejection",  (x: any) => console.log(x));

function ensureSame(correctBuf: Buffer, newBoxes: BoxMetadata[]) {
    testBuffer(correctBuf, () => {
        let output = Buffer.concat(writeBoxArr(newBoxes));

        for(let i = 0; i < output.length; i++) {
            let a = output[i];
            let b = correctBuf[i];
            if(a !== b) {
                throw new Error(`wrong at ${i}, should be ${b}, was ${a}`);
            }
        }

        if(output.length !== correctBuf.length) {
            throw new Error(`length wrong. Should be ${correctBuf.length}, was ${output.length}`);
        }
    });
}

verify();
function verify() {
    let buf = fs.readFileSync("./youtube.mp4");
    let boxes = parseBoxes(buf);
    ensureSame(buf, boxes);
}

// ffmpeg -y -i test.mp4 -c libx264 -pix_fmt yuv420p -profile:v main -level:v 3.0 test.h264.mp4

//testRewrite();
async function testRewrite() {
    let name = "./youtube.mp4";
    let namePart = "./youtube";
    let buf = fs.readFileSync(name);
    let boxes = parseBoxes(buf);

    fs.writeFileSync(name + ".json", serializeBoxes(boxes));
    
    let newBuf = createMp4Fragment({});
    let newBoxes = parseBoxes(Buffer.concat(newBuf));

    let str = serializeBoxes(newBoxes);
    console.log(str);
    fs.writeFileSync(name + ".NEW" + ".json", str);

    let output = Buffer.concat(writeBoxArr(newBoxes));
    fs.writeFileSync(namePart + "NEW.mp4", output);

    /*
    testBuffer(buf, () => {
        let output = Buffer.concat(writeBoxArr(newBoxes));

        for(let i = 0; i < output.length; i++) {
            let a = output[i];
            let b = buf[i];
            if(a !== b) {
                throw new Error(`wrong at ${i}, should be ${b}, was ${a}`);
            }
        }

        if(output.length !== buf.length) {
            throw new Error(`length wrong. Should be ${buf.length}, was ${output.length}`);
        }
    });
    //*/

    //let avcC = getAllFirstOfTypeUnsafe(boxes, "avcC")[0];
    //avcC.AVCConfig[0].profile_compatibility = 0x40;
    //console.log(avcC.AVCConfig[0].AVCProfileIndication);


    
    //let newBuf = Buffer.concat(writeBoxArr(boxes));
    //fs.writeFileSync("./testNEW.h264.mp4", newBuf);
}



run();
async function run() {
    //await test();
    readH264();
    //await test();
}
function readH264() {
    //let name = "./testNEW.h264.mp4";
    //let name = "./test2.mp4";
    let name = "./youtube.mp4";
    let buf = fs.readFileSync(name);
    let boxes = parseBoxes(buf);
    fs.writeFileSync(name + ".json", serializeBoxes(boxes));
}

async function test() {
    let jimpAny = Jimp as any;    
    let width = 600;
    let height = 400;
    //let image = new jimpAny(width, height, 0xFF0000FF, () => {});
    
    async function getFrame(i: number): Promise<Buffer> {
        let image: any;
        image = new jimpAny(width, height, 0xFF00FFFF, () => {});
        /*
        Jimp.read(jpegs[0], (err: any, x: any) => {
            if(err) throw new Error(`Error ${err}`);
            image = x;
        });
        */
        image.resize(width, height);

        let data: Buffer = image.bitmap.data;
        let frameNumber = i;
        for(let i = 0; i < width * height; i++) {
            let k = i * 4;
            let seed = (frameNumber + 1) * i;
            data[k] = seed % 256;
            data[k + 1] = (seed * 67) % 256;
            data[k + 2] = (seed * 679) % 256;
            data[k + 3] = 255;
        }

        let imageColor = new jimpAny(width, 64, 0x000000AF, () => {});
        image.composite(imageColor, 0, 0);

        let path = "./node_modules/jimp/fonts/open-sans/open-sans-64-white/open-sans-64-white.fnt";
        let font = await loadFont(path);
        image.print(font, 0, 0, `frame ${i}`, width);

        console.log(`Created frame ${i}`);
        

        let jpegBuffer!: Buffer;
        image.quality(75).getBuffer(Jimp.MIME_JPEG, (err: any, buffer: Buffer) => {
            if(err) throw err;
            jpegBuffer = buffer;
        });

        return jpegBuffer;
    }

    let fps = 10;
    let totalFrameCount = fps * 1;
    let frames: Buffer[] = [];
    let frameCount = totalFrameCount;
    for(let i = 0; i < frameCount; i++) {
        let buf = await getFrame(i);
        frames.push(buf);
    }

    createVideoOutOfJpegs(
        {
            fileName: "test.mp4",
            framePerSecond: fps,
            width,
            height,
        },
        flatten(repeat(frames, totalFrameCount / frames.length))
    );
}

function createVideoOutOfJpegs(info: { fileName: string, framePerSecond: number, width: number, height: number }, jpegs: Buffer[]) {
    let { fileName, framePerSecond, width, height } = info;

    let boxes = parseBoxes(fs.readFileSync("./raw/test5.mp4"));

    let timeMultiplier = 2;

    // Might as well go in file order.
    
    //mdat is just the raw jpegs, side by side
    // data
    let mdat = getAllFirstOfTypeUnsafe(boxes, "mdat")[0];
    mdat.data = jpegs;


    let mvhd = getAllFirstOfTypeUnsafe(boxes, "mvhd")[0];
    // timescale. The number of increments per second. Will need to be the least common multiple of all the framerates
    let timescale = mvhd._properties.timescale = framePerSecond;
    // Technically the duration of the longest trak. But we should only have 1, so...
    let timescaleDuration = mvhd._properties.duration = jpegs.length;

    // Only 1 track
    let tkhd = getAllFirstOfTypeUnsafe(boxes, "tkhd")[0];
    tkhd._properties.duration = timescaleDuration;
    
    tkhd._properties.width = width;
    tkhd._properties.height = height;

    let elst = getAllFirstOfTypeUnsafe(boxes, "elst")[0];
    // Just one segment
    elst.entries.entries[0].segment_duration = timescaleDuration;


    let mdhd = getAllFirstOfType(boxes, "mdhd")[0];

    // mdhd has a timescale too?
    mdhd._properties.timescale = timescale;
    mdhd._properties.duration = timescaleDuration;


    let stsd = getAllFirstOfTypeUnsafe(boxes, "stsd")[0];
    stsd.obj[0].width = width;
    stsd.obj[0].height = height;


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
    
    // Okay, time for hacks. So... if mdat switches to a larger header, it's data will be offset. So... deal with that here
    // maxUInt32
    let mdatSize = 8 + sum(jpegs.map(x => x.length));
    if(mdatSize > maxUInt32) {
        console.log("wow, that's a big file you got there. I hope this works.");
        stco.obj[0] += 8;
    }


    let newBuffer = writeBoxArr(boxes);
    console.log(`Wrote to ${fileName}`)

    let stream = fs.createWriteStream(fileName);
    stream.once("open", function(fd) {
        for(let buf of newBuffer) {
            stream.write(buf);
        }
        stream.end();
    });
}


// Generic parsing, based off of pseudo language
// This is an ISOBMFF parser (https://en.wikipedia.org/wiki/ISO_base_media_file_format)
// http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
// https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
// https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-00#page-9
// https://developer.apple.com/streaming/HLS-WWDC-2017-Preliminary-Spec.pdf
// https://mpeg.chiariglione.org/standards/mpeg-4/iso-base-media-file-format/text-isoiec-14496-12-5th-edition
// https://mpeg.chiariglione.org/standards/mpeg-4/carriage-nal-unit-structured-video-iso-base-media-file-format/text-isoiec-14496-1
// https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute

// Hmm... another example of an implementation: https://github.com/madebyhiro/codem-isoboxer