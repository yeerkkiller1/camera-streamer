// Generic parsing, based off of pseudo language
// This is an ISOBMFF parser (https://en.wikipedia.org/wiki/ISO_base_media_file_format)
//  MOST UP TO DATE STANDARD: https://www.iso.org/standard/68960.html
// http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
// https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
// https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-00#page-9
// https://developer.apple.com/streaming/HLS-WWDC-2017-Preliminary-Spec.pdf
// https://mpeg.chiariglione.org/standards/mpeg-4/iso-base-media-file-format/text-isoiec-14496-12-5th-edition
// https://mpeg.chiariglione.org/standards/mpeg-4/carriage-nal-unit-structured-video-iso-base-media-file-format/text-isoiec-14496-1
// https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute

// https://github.com/cisco/openh264/blob/722f1d16d6361ef46d12a1eb39e3cefa4c5b15bd/codec/common/inc/wels_common_defs.h#L84

// Hmm... another example of an implementation: https://github.com/madebyhiro/codem-isoboxer

// https://github.com/aizvorski/h264bitstream

// https://msdn.microsoft.com/en-us/library/windows/desktop/dd757808(v=vs.85).aspx !!
//  No start codes, as it is avc1. This microsoft document is amazing, and explains everything. Although I don't know how to know the bytes in
//  the length prefix of a NAL, but assuming 4 is probably fine.


import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray, throwValue, assertNumber } from "./util/type";
import { keyBy, mapObjectValues, repeat, flatten, filterObjectValues, mapObjectValuesKeyof, range } from "./util/misc";
import { writeFileSync, createWriteStream, readSync, fstat, readFileSync, writeSync } from "fs";
import { basename } from "path";
import { decodeUTF8BytesToString, encodeAsUTF8Bytes, debugString } from "./util/UTF8";
import { sum, max, min } from "./util/math";

import * as Jimp from "jimp";
import { parseObject, filterBox, writeObject, getBufferWriteContext } from "./BinaryCoder";
import { RootBox, MoofBox, MdatBox, FtypBox, MoovBox, sample_flags, SidxBox } from "./BoxObjects";
import { SerialObject, _SerialObjectOutput, _SerialIntermediateToFinal, TemplateToObject } from "./SerialTypes";
import { NALList, parserTest, NALType, SPS, PPS } from "./NAL";
import { byteToBits, bitsToByte } from "./Primitives";


function testReadFile(path: string) {
    let buf = LargeBuffer.FromFile(path);
    testRead(path, buf);
}
function prettyPrint(obj: any): string {
    let uniqueId = 0;
    let largeBufferId: { [id: number]: LargeBuffer } = {};
    function cleanOutput(key: string, value: any) {
        //if(key === "size") return undefined;
        //if(key === "headerSize") return undefined;
        if(value && value instanceof LargeBuffer) {
            let id = uniqueId++;
            largeBufferId[id] = value;
            //return `unique${id}`;
            return `Buffer(${value.getLength()})`;
        }
        return value;
    }
    let output = JSON.stringify(obj, cleanOutput, "    ");
    for(let id in largeBufferId) {
        let text = `"unique${id}"`;
        let buffer = largeBufferId[id];
        let nums: number[] = [];
        for(let b of buffer.getInternalBufferList()) {
            for(let i = 0; i < b.length; i++) {
                nums.push(b[i]);
            }
        }
        output = output.replace(text, `new LargeBuffer([new Buffer([${nums.join(",")}])])`);
    }
    return output;
}
function testRead(path: string, buf: LargeBuffer) {
    let finalOutput = parseObject(buf, RootBox);

    console.log(`Write to ${basename(path)}.json`);
    writeFileSync(basename(path) + ".json", prettyPrint(finalOutput));
    
    //writeFileSync(basename(path) + ".json", prettyPrint(finalOutput.boxes.filter(x => x.type === "mdat")));

    //writeFileSync(basename(path) + ".json", "test");
}

function testWriteFile(path: string) {
    testReadFile(path);

    let oldBuf = LargeBuffer.FromFile(path);

    let finalOutput = parseObject(oldBuf, RootBox)
    let newBuf = writeObject(RootBox, finalOutput);

    testWrite(oldBuf, newBuf);

    console.log(oldBuf.getLength(), newBuf.getLength());
}
function testWrite(oldBuf: LargeBuffer, newBuf: LargeBuffer) {
    // Compare newBuffers with output, using getBufferWriteContext to get the context of each buffer
    let bufLen = oldBuf.getLength();
    let rewriteLen = newBuf.getLength();
    let end = Math.min(bufLen, rewriteLen);

    let curErrors = 0;

    let pos = 0;
    for(let i = 0; i < end; i++) {
        let oldByte = oldBuf.readUInt8(i);
        let newByte = newBuf.readUInt8(i);

        if(oldByte !== newByte) {
            let newBuffer = newBuf.getInternalBuffer(i);
            let newContext = getBufferWriteContext(newBuffer, i);

            console.error(`Byte is wrong at position ${i}. Should be ${oldByte}, was ${newByte}. Write context ${newContext}.\nOld context ${getContext(oldBuf, i)}\nNew context ${getContext(newBuf, i)}`);
            console.error(`Byte is wrong at position ${i}. Should be ${oldByte}, was ${newByte}. Write context ${newContext}.\nOld context ${getContext(oldBuf, i, 10, true)}\nNew context ${getContext(newBuf, i, 10, true)}`);
            curErrors++;
            if(curErrors > 10) {
                throw new Error(`Too many errors (${curErrors})`);
            }
        }
    }

    if(bufLen !== rewriteLen) {
        throw new Error(`Length of buffer changed. Should be ${bufLen}, was ${rewriteLen}`);
    }

    function getContext(buffer: LargeBuffer, pos: number, contextSize = 32, bits = false): string {
        let beforePos = pos - contextSize;
        let beforeLength = contextSize;
        if(beforePos < 0) {
            beforeLength += beforePos;
            beforePos = 0;
        }

        let endBefore = Math.min(beforePos + contextSize, beforePos + beforeLength);

        function str(b: LargeBuffer, pos: number, before: number) {
            if(bits) {
                return range(pos, before).map(i =>
                    byteToBits(buffer.readUInt8(i)).join("")
                ).join(",");
            } else {
                return debugString(range(pos, before).map(i => buffer.readUInt8(i)));
            }
        }

        let outputBefore = str(buffer, beforePos, endBefore);
    
        let end = Math.min(pos + contextSize, buffer.getLength());
        let output = str(buffer, pos, end);

        return "\"" + outputBefore + "|" + output + "\"";
    }
}

async function testRewriteMjpeg() {
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

    let jimpAny = Jimp as any;    
    let width = 600;
    let height = 400;
    //let image = new jimpAny(width, height, 0xFF0000FF, () => {});
    
    //Jimp.read(jpegs[0], (err: any, x: any) => {
    //    if(err) throw new Error(`Error ${err}`);
    //    image = x;
    //});
    async function getFrame(i: number): Promise<Buffer> {
        let image: any;
        image = new jimpAny(width, height, 0xFF00FFFF, () => {});
        
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
        image.print(font, 0, 0, `frame ${i} NEW`, width);

        console.log(`Created frame ${i}`);
        
        let jpegBuffer!: Buffer;
        image.quality(75).getBuffer(Jimp.MIME_JPEG, (err: any, buffer: Buffer) => {
            if(err) throw err;
            jpegBuffer = buffer;
        });

        return jpegBuffer;
    }

    let fps = 10;
    let totalFrameCount = fps * 10;
    let frames: Buffer[] = [];
    let frameCount = totalFrameCount;
    for(let i = 0; i < frameCount; i++) {
        let buf = await getFrame(i);
        frames.push(buf);
    }

    let newBuffer = createVideoOutOfJpegs(
        {
            framePerSecond: fps,
            width,
            height,
        },
        flatten(repeat(frames, totalFrameCount / frames.length))
    );

    let outputFileName = "./testNEW.mp4";
    testRead(outputFileName, newBuffer);

    let stream = createWriteStream(outputFileName);
    stream.once("open", function(fd) {
        let newBuffers = newBuffer.getInternalBufferList();
        for(let buf of newBuffers) {
            stream.write(buf);
        }
        stream.end();
    });

    function createVideoOutOfJpegs(info: { framePerSecond: number, width: number, height: number }, jpegs: Buffer[]): LargeBuffer {
        let { framePerSecond, width, height } = info;
    
        let templateMp4 = "./raw/test5.mp4";

        let buf = LargeBuffer.FromFile(templateMp4);
        let output = parseObject(buf, RootBox);
       
        let timeMultiplier = 2;
    
        // Might as well go in file order.

        // console.log(filterBox(FileBox, RootBox.boxes, output.boxes));
        
        //mdat is just the raw jpegs, side by side
        // data
        let mdat = output.boxes.filter(x => x.type === "mdat")[0];
        if(mdat.type !== "mdat") throw new Error("Impossible");
        mdat.bytes = new LargeBuffer(jpegs);
    
        let moov = output.boxes.filter(x => x.type === "moov")[0];
        if(moov.type !== "moov") throw new Error("Impossible");

        let mvhd = moov.boxes.filter(x => x.type === "mvhd")[0];
        if(mvhd.type !== "mvhd") throw new Error("Impossible");

        // timescale. The number of increments per second. Will need to be the least common multiple of all the framerates
        let timescale = mvhd.times.timescale = framePerSecond;
        // Technically the duration of the longest trak. But we should only have 1, so...
        let timescaleDuration = mvhd.times.duration = jpegs.length;


        let trak = moov.boxes.filter(x => x.type === "trak")[0];
        if(trak.type !== "trak") throw new Error("Impossible");

        // Only 1 track
        let tkhd = trak.boxes.filter(x => x.type === "tkhd")[0];
        if(tkhd.type !== "tkhd") throw new Error("Impossible");

        tkhd.times.duration = timescaleDuration;
        tkhd.width = width;
        tkhd.height = height;

        let edts = trak.boxes.filter(x => x.type === "edts")[0];
        if(edts.type !== "edts") throw new Error("Impossible");

        let elst = edts.boxes.filter(x => x.type === "elst")[0];
        if(elst.type !== "elst") throw new Error("Impossible");
        // Just one segment
        elst.entries[0].segment_duration = timescaleDuration;

        let mdia = trak.boxes.filter(x => x.type === "mdia")[0];
        if(mdia.type !== "mdia") throw new Error("Impossible");

        let mdhd = mdia.boxes.filter(x => x.type === "mdhd")[0];
        if(mdhd.type !== "mdhd") throw new Error("Impossible");

        // mdhd has a timescale too?
        mdhd.timescale = timescale;
        mdhd.duration = timescaleDuration;

        let minf = mdia.boxes.filter(x => x.type === "minf")[0];
        if(minf.type !== "minf") throw new Error("Impossible");

        let stbl = minf.boxes.filter(x => x.type === "stbl")[0];
        if(stbl.type !== "stbl") throw new Error("Impossible");

        let stsd = stbl.boxes.filter(x => x.type === "stsd")[0];
        if(stsd.type !== "stsd") throw new Error("Impossible");

        let stsdBox = stsd.boxes[0];
        if(stsdBox.type !== "mp4v") {
            throw new Error(`Unexpect stsd type ${stsdBox.type}`);
        }

        stsdBox.width = width;
        stsdBox.height = height;


        let stts = stbl.boxes.filter(x => x.type === "stts")[0];
        if(stts.type !== "stts") throw new Error("Impossible");
        {
            let obj = stts.samples[0];
            obj.sample_delta = 1;
            obj.sample_count = jpegs.length;
        }

        let stsc = stbl.boxes.filter(x => x.type === "stsc")[0];
        if(stsc.type !== "stsc") throw new Error("Impossible");
        {
            let obj = stsc.entries[0];
            obj.samples_per_chunk = jpegs.length;
        }

        let stsz = stbl.boxes.filter(x => x.type === "stsz")[0];
        if(stsz.type !== "stsz") throw new Error("Impossible");
        {
            stsz.sample_count = jpegs.length;
            stsz.sample_sizes = jpegs.map(x => x.length)
        }

        let stco = stbl.boxes.filter(x => x.type === "stco")[0];
        if(stco.type !== "stco") throw new Error("Impossible");
        {
            // Position of mdat in file as a whole. So... anything before mdat has to have a constant size, or else this will be wrong,
            //  or I will need to start calculating it.
            
            // Okay, time for hacks. So... if mdat switches to a larger header, it's data will be offset. So... deal with that here
            // maxUInt32
            let mdatSize = 8 + sum(jpegs.map(x => x.length));
            if(mdatSize > MaxUInt32) {
                console.log("wow, that's a big file you got there. I hope this works.");
                stco.chunk_offsets[0] += 8;
            }
        }

        return writeObject(RootBox, output);
    }
}

function getSamples(NALs: NALType[], sps: SPS, pps: PPS, frameTimeInTimescale: number) {
    let baseCount = 0;
    let maxFrameOrderIndex = max(NALs.map(x => x.nalObject.type === "slice" ? x.nalObject.nal.slice_header.pic_order_cnt_lsb : 0));

    return NALs
        .filter(x => x.nalObject.type === "slice")
        .map((input, i) => {
            let obj = input.nalObject;
            if(obj.type !== "slice") throw new Error("impossible");
            let buffer = writeObject(NALList(4, sps, pps), { NALs: [input] });
            let header = obj.nal.slice_header;

            let picOrder = header.pic_order_cnt_lsb;

            let fullPicOrder = picOrder + baseCount;

            let calcIndex = fullPicOrder / 2 + 2;

            let comp_off = (calcIndex - i) * frameTimeInTimescale;

            if(picOrder === maxFrameOrderIndex) {
                baseCount += maxFrameOrderIndex + 2;
            }

            return {
                buffer: buffer,
                // Hmm... maybe calculate this, and also try to speed up the video, or slow it down, and make sure time information
                //  in the NALs is ignore, and doesn't break the video.
                composition_offset: comp_off // frames[i].composition_offset,
            };
        })
    ;
}

async function testRewriteMp4Fragment() {
    let templateMp4 = "./10fps.dash.mp4";
    let outputFileName = templateMp4 + ".test.mp4";

    
    testReadFile(templateMp4);

    let newBuf = createVideo2();

    newBuf.WriteToFile(outputFileName);

    testReadFile(outputFileName);
    
    //testWrite(oldBuf, newBuf);

    function readVideoInfo(buffer: LargeBuffer) {
        // TODO: stss has the sync samples, so we should use that, instead of assuming the first sample is a sync sample.

        let h264Object = parseObject(buffer, RootBox);
       
        let box = filterBox(h264Object);
        let mdia = box("moov")("trak")("mdia");
        let timescale: number = mdia("mdhd")().timescale;

        let avcConfig = mdia("minf")("stbl")("stsd")("avc1")();

        let width = avcConfig.width;
        let height = avcConfig.height;

        let avcC = filterBox(avcConfig)("avcC")();

        let AVCProfileIndication = avcC.AVCProfileIndication;
        let profile_compatibility = avcC.profile_compatibility;
        let AVCLevelIndication = avcC.AVCLevelIndication;

        let stts = mdia("minf")("stbl")("stts")();

        let mdat = box("mdat")();
        let mdats: LargeBuffer[] = [];
        let frameTimeInTimescale: number;
        let frames: { buffer: LargeBuffer; composition_offset: number; }[] = [];

        // If the length is 0, check for a moof.traf.trun
        if(stts.samples.length === 0) {
            let samples = box("moof")("traf")("trun")().sample_values;

            frameTimeInTimescale = box("moov")("mvex")("trex")().default_sample_duration;
            
            let pos = 0;
            for(let sample of samples) {
                if(!("sample_size" in sample)) {
                    throw new Error(`No sample_size in trun.sample_values sample. It may be in one of the defaults, but handling for that is not present yet.`);
                }
                if(!("sample_composition_time_offset" in sample)) {
                    throw new Error(`No sample_composition_time_offset in trun.sample_values sample. It may be in one of the defaults, but handling for that is not present yet.`);
                }
                let sampleSize = sample.sample_size;
                let dat = mdat.bytes.slice(pos, pos + sampleSize);
                pos += sampleSize;

                frames.push({
                    buffer: dat,
                    composition_offset: sample.sample_composition_time_offset,
                });
            }
        }
        else if(stts.samples.length === 1) {
            let sampleInfo = stts.samples[0];

            frameTimeInTimescale = sampleInfo.sample_delta;
            //frameTimeInTimescale = timescale / 5;

            // ctts table has times
            // stsz table has sample byte sizes.

            let stsz = mdia("minf")("stbl")("stsz")();

            let pos = 0;
            for(let sampleSize of stsz.sample_sizes) {
                mdats.push(mdat.bytes.slice(pos, pos + sampleSize));
                pos += sampleSize;
            }

            let ctts = mdia("minf")("stbl")("ctts")();
        
            let frameIndex = 0;
            for(let cttsInfo of ctts.samples) {
                for(let i = 0; i < cttsInfo.sample_count; i++) {
                    frames.push({
                        buffer: mdats[frameIndex],
                        composition_offset: cttsInfo.sample_offset,
                    });
                    frameIndex++;
                }
            }
        } else {
            console.log(stts.samples);
            throw new Error(`Samples of varying duration. This is unexpected.`);
        }


        
        //timescale = 5994;
        //frameTimeInTimescale = 100;
        /*
        frames = range(0, 10).map(index => ({
            buffer: new LargeBuffer([readFileSync(`C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame${index}.h264`)]),
            composition_offset: 0
        }));
        */

        return {
            timescale,
            width,
            height,
            AVCProfileIndication,
            profile_compatibility,
            AVCLevelIndication,
            frameTimeInTimescale,
            frames
        };
    }

    function createVideo2(): LargeBuffer {

        let h264Base = LargeBuffer.FromFile(templateMp4);

        let h264Object = readVideoInfo(h264Base);

        let timescale = h264Object.timescale;
        let frameTimeInTimescale = h264Object.frameTimeInTimescale;
        let width = h264Object.width;
        let height = h264Object.height;
        let AVCProfileIndication = h264Object.AVCProfileIndication;
        let profile_compatibility = h264Object.profile_compatibility;
        let AVCLevelIndication = h264Object.AVCLevelIndication;

        // For 10fps.h264.mp4, why is there a pause at the beginning? There isn't in the source.
        // VLC adds random pauses, because it sucks.

        // Why does changing the timescale break everything! This should be fine!
        // clockTimestamp = ( ( hH * 60 + mM ) * 60 + sS ) * time_scale + nFrames * ( num_units_in_tick * ( 1 + nuit_field_based_flag ) ) + tOffset
        // Oh... SEI gives timing information. But... there must be timing information in the frames still, as removing the SEI and changing
        //  the timescale still breaks things.
        // VLC just sucks.


        //timescale = 10;
        //frameTimeInTimescale = 1;

        let ftyp: O<typeof FtypBox> = {
            header: {
                type: "ftyp"
            },
            type: "ftyp",
            major_brand: "iso5",
            minor_version: 1,
            compatible_brands: [
                "avc1",
                "iso5",
                "dash"
            ]
        };

        
        let sps: SPS = {
            "profile_idc": 244,
            "constraint_set0_flag": 0,
            "constraint_set1_flag": 0,
            "constraint_set2_flag": 0,
            "constraint_set3_flag": 0,
            "constraint_set4_flag": 0,
            "constraint_set5_flag": 0,
            "reserved_zero_2bits": [
                0,
                0
            ],
            "reserved_zero_2bits_check": {},
            "level_idc": 22,
            "seq_parameter_set_id": 0,
            "chroma_format_idc": 3,
            "separate_colour_plane_flags": 0,
            "bit_depth_luma_minus8": 0,
            "bit_depth_chroma_minus8": 0,
            "qpprime_y_zero_transform_bypass_flag": 0,
            "seq_scaling_matrix_present_flag": 0,
            "seq_scaling_matrix_present_flag_check": {},
            "log2_max_frame_num_minus4": 0,
            "pic_order_cnt_type": 0,
            "pic_order_cnt_type_check": {},
            "log2_max_pic_order_cnt_lsb_minus4": 2,
            "max_num_ref_frames": 4,
            "gaps_in_frame_num_value_allowed_flag": 0,
            "pic_width_in_mbs_minus1": 37,
            "pic_height_in_map_units_minus1": 24,
            "frame_mbs_only_flag": 1,
            "frame_mbs_only_flag_check": {},
            "direct_8x8_inference_flag": 1,
            "frame_cropping_flag": 1,
            "frame_cropping_flag_check": {},
            "frame_crop_left_offset": 0,
            "frame_crop_right_offset": 8,
            "frame_crop_top_offset": 0,
            "frame_crop_bottom_offset": 0,
            "vui_parameters_present_flag": 1,
            "vui_parameters_check": {},
            "aspect_ratio_info_present_flag": 1,
            "aspect_ratio_idc": 1,
            "aspect_ratio_idc_check": {},
            "overscan_info_present_flag": 0,
            "overscan_info_present_flag_check": {},
            "video_signal_type_present_flag": 1,
            "video_format": [
                1,
                0,
                1
            ],
            "video_full_range_flag": 1,
            "colour_description_present_flag": 0,
            "colour_description_present_flag_check": {},
            "chroma_loc_info_present_flag": 0,
            "chroma_loc_info_present_flag_check": {},
            "timing_info_present_flag": 1,
            "num_units_in_tick": frameTimeInTimescale,
            "time_scale": timescale * 2,
            "fixed_frame_rate_flag": 0,
            "nal_hrd_parameters_present_flag": 0,
            "data0": {},
            "nal_hrd_parameters_present_flag_check": {},
            "vcl_hrd_parameters_present_flag": 0,
            "vcl_hrd_parameters_present_flag_check": {},
            "pic_struct_present_flag": 0,
            "bitstream_restriction_flag": 1,
            "bitstream_restriction_flag_check": {},
            "motion_vectors_over_pic_boundaries_flag": 1,
            "max_bytes_per_pic_denom": 0,
            "max_bits_per_mb_denom": 0,
            "log2_max_mv_length_horizontal": 10,
            "log2_max_mv_length_vertical": 10,
            "max_num_reorder_frames": 2,
            "max_dec_frame_buffering": 4,
            trailing: undefined
        };
        let pps: PPS = {
            "pic_parameter_set_id": 0,
            "seq_parameter_set_id": 0,
            "entropy_coding_mode_flag": 1,
            "bottom_field_pic_order_in_frame_present_flag": 0,
            "num_slice_groups_minus1": 0,
            "num_slice_groups_minus1_check": {},
            "slice_group_map_type": -1,
            "slice_group_change_rate_minus1": -1,
            "num_ref_idx_l0_default_active_minus1": 2,
            "num_ref_idx_l1_default_active_minus1": 0,
            "weighted_pred_flag": 1,
            "weighted_bipred_idc": 2,
            "pic_init_qp_minus26": -3,
            "pic_init_qs_minus26": 0,
            "chroma_qp_index_offset": 4,
            "deblocking_filter_control_present_flag": 1,
            "constrained_intra_pred_flag": 0,
            "redundant_pic_cnt_present_flag": 0,
            "isDone": true,
            RbspTrailingPrimitive: undefined
        };

        let frames = h264Object.frames;


        /*
        let frameObjs = parseObject(new LargeBuffer(frames.map(x => x.buffer)), NALList(4, sps, pps)).NALs;
        // Remove the SEI
        let SEI = frameObjs[0];
        frameObjs = frameObjs.slice(1);

        let baseCount = 0;
        let maxFrameOrderIndex = max(frameObjs.map(x => x.nalObject.type === "slice" ? x.nalObject.nal.slice_header.pic_order_cnt_lsb : 0));

        frames = getSamples(frameObjs, sps, pps, frameTimeInTimescale);

        let minOffset = min(frames.map(x => x.composition_offset));
        frames.forEach((frame, i) => {
            frame.composition_offset -= minOffset;
        });

        frames[0].buffer = new LargeBuffer([frames[0].buffer, writeObject(NALList(4, sps, pps), { NALs: [SEI] })])
        */

        // 

        //let newBytes = writeObject(NALList(4, sps, pps), { NALs: frameObjs });


        let samples: SampleInfo[] = frames.map(x => ({
            sample_size: x.buffer.getLength(),
            sample_composition_time_offset: x.composition_offset
        }));

        let moov = createMoov({
            defaultFlags: nonKeyFrameSampleFlags,
            timescale: timescale,
            durationInTimescale: 0, //samples.length * frameTimeInTimescale,
            frameTimeInTimescale: frameTimeInTimescale,
            width: h264Object.width,
            height: h264Object.height,
            AVCProfileIndication: h264Object.AVCProfileIndication,
            profile_compatibility: h264Object.profile_compatibility,
            AVCLevelIndication: h264Object.AVCLevelIndication,
            sps,
            pps,
        });

        let moof = createMoof({
            sequenceNumber: 1,
            baseMediaDecodeTimeInTimescale: 0,
            samples,
            forcedFirstSampleFlags: keyFrameSampleFlags,
            //defaultSampleFlags: nonKeyFrameSampleFlags
        });
        
        let mdat: O<typeof MdatBox> = {
            header: {
                size: 0,
                headerSize: 8,
                type: "mdat"
            },
            type: "mdat",
            bytes: new LargeBuffer(frames.map(x => x.buffer))
        };



        //let frames = h264Object.frames;
        //console.log(frames.length);

        // Parse the mdat section ourself, and see if we get NALs that line up with the sample_sizes
        //let frameObjs = parseObject(mdat.bytes, NALList(4, sps, pps)).NALs;
        //let newBytes = writeObject(NALList(4, sps, pps), { NALs: frameObjs });
        //testWrite(mdat.bytes, newBytes);

        


        
        let moofBuf = writeObject(MoofBox, moof);
        let mdatBuf = writeObject(MdatBox, mdat);

        let sidx = createSidx({
            moofSize: moofBuf.getLength(),
            mdatSize: mdatBuf.getLength(),
            subsegmentDuration: samples.length * frameTimeInTimescale,
            timescale: timescale,
        });

        let outputs: (O<typeof RootBox>["boxes"][0])[] = [];
        outputs.push(ftyp);
        outputs.push(moov);
        outputs.push(sidx);
        outputs.push(moof);
        outputs.push(mdat);

        let finalBuffer = writeObject(RootBox, { boxes: outputs });

        console.log(finalBuffer.getLength());

        return finalBuffer;
    }
}

const keyFrameSampleFlags: SampleFlags = {
    reserved: 0,
    is_leading: 0,
    sample_depends_on: 0,
    sample_is_depended_on: 0,
    sample_has_redundancy: 0,
    sample_padding_value: 0,
    // This resets the default in trex which sets sample_is_non_sync_sample to 1.
    //  So this essentially says this is a sync sample, AKA, a key frame (reading this
    //  frames syncs the video, so we can just read forward from any sync frame).
    sample_is_non_sync_sample: 0,
    sample_degradation_priority: 0
};

const nonKeyFrameSampleFlags: SampleFlags = {
    reserved: 0,
    is_leading: 0,
    sample_depends_on: 0,
    sample_is_depended_on: 0,
    sample_has_redundancy: 0,
    sample_padding_value: 0,
    sample_is_non_sync_sample: 1,
    sample_degradation_priority: 0
};

type O<T extends SerialObject> = TemplateToObject<T>;
type SampleFlags = O<{x: typeof sample_flags}>["x"];

function createMoov(
    d: {
        defaultFlags: SampleFlags;
        timescale: number;
        durationInTimescale: number;
        frameTimeInTimescale: number;
        width: number;
        height: number;
        AVCProfileIndication: number;
        profile_compatibility: number;
        AVCLevelIndication: number;
        sps: SPS,
        pps: PPS,
    }
): O<typeof MoovBox> {
    return {
        header: {
            type: "moov"
        },
        type: "moov",
        boxes: [
            {
                header: {
                    type: "mvhd"
                },
                type: "mvhd",
                version: 0,
                flags: 0,
                times: {
                    creation_time: 0,
                    modification_time: 0,
                    timescale: d.timescale,
                    duration: d.durationInTimescale
                },
                rate: 1,
                volume: 1,
                reserved: 0,
                reserved0: 0,
                reserved1: 0,
                matrix: [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824],
                pre_defined: [0, 0, 0, 0, 0, 0],
                next_track_ID: 2
            },
            {
                header: {
                    type: "mvex"
                },
                type: "mvex",
                boxes: [
                    {
                        header: {
                            type: "trex"
                        },
                        type: "trex",
                        version: 0,
                        flags: 0,
                        track_ID: 1,
                        // Index of sample information in stsd. Could be used to change width/height?
                        default_sample_description_index: 1,
                        default_sample_duration: d.frameTimeInTimescale,
                        default_sample_size: 0,
                        default_sample_flags: d.defaultFlags
                    }
                ]
            },
            {
                header: {
                    type: "trak"
                },
                type: "trak",
                boxes: [
                    {
                        header: {
                            type: "tkhd"
                        },
                        type: "tkhd",
                        version: 0,
                        flags: {
                            reserved: 0,
                            track_size_is_aspect_ratio: 0,
                            track_in_preview: 0,
                            track_in_movie: 1,
                            track_enabled: 1
                        },
                        times: {
                            creation_time: 0,
                            modification_time: 0,
                            track_ID: 1,
                            reserved: 0,
                            duration: 0
                        },
                        reserved0: 0,
                        reserved1: 0,
                        layer: 0,
                        alternate_group: 0,
                        volume: 0,
                        reserved2: 0,
                        matrix: [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824],
                        width: d.width,
                        height: d.height,
                    },
                    {
                        header: {
                            type: "mdia"
                        },
                        type: "mdia",
                        boxes: [
                            {
                                header: {
                                    type: "mdhd"
                                },
                                type: "mdhd",
                                version: 0,
                                flags: 0,
                                creation_time: 0,
                                modification_time: 0,
                                timescale: d.timescale,
                                duration: 0,
                                language: "und",
                                pre_defined: 0
                            },
                            {
                                header: {
                                    type: "hdlr"
                                },
                                type: "hdlr",
                                version: 0,
                                flags: 0,
                                pre_defined: 0,
                                handler_type: "vide",
                                reserved: [0,0,0],
                                name: "VideoHandler"
                            },
                            {
                                header: {
                                    type: "minf"
                                },
                                type: "minf",
                                boxes: [
                                    {
                                        header: {
                                            type: "vmhd"
                                        },
                                        type: "vmhd",
                                        version: 0,
                                        flags: 1,
                                        graphicsmode: 0,
                                        opcolor: [0, 0, 0]
                                    },
                                    {
                                        header: {
                                            type: "dinf"
                                        },
                                        type: "dinf",
                                        boxes: [
                                            {
                                                header: {
                                                    type: "dref"
                                                },
                                                type: "dref",
                                                version: 0,
                                                flags: 0,
                                                entry_count: 1,
                                                boxes: [
                                                    {
                                                        header: {
                                                            type: "url "
                                                        },
                                                        type: "url ",
                                                        version: 0,
                                                        flags: {
                                                            reserved: 0,
                                                            media_is_in_same_file: 1
                                                        }
                                                    }
                                                ]
                                            }
                                        ]
                                    },
                                    {
                                        header: {
                                            type: "stbl"
                                        },
                                        type: "stbl",
                                        boxes: [
                                            {
                                                header: {
                                                    type: "stsd"
                                                },
                                                type: "stsd",
                                                version: 0,
                                                flags: 0,
                                                entry_count: 1,
                                                boxes: [
                                                    {
                                                        "header": {
                                                            "size": 153,
                                                            "type": "avc1",
                                                            "headerSize": 8
                                                        },
                                                        "type": "avc1",
                                                        "reserved": [
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0
                                                        ],
                                                        "data_reference_index": 1,
                                                        "pre_defined": 0,
                                                        "reserved1": 0,
                                                        "pre_defined1": [
                                                            0,
                                                            0,
                                                            0
                                                        ],
                                                        width: d.width,
                                                        height: d.height,
                                                        // DPI. Useless, and always constant
                                                        horizresolution: 0x00480000,
                                                        vertresolution: 0x00480000,
                                                        "reserved2": 0,
                                                        "frame_count": 1,
                                                        "compressorname": [
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0,
                                                            0
                                                        ],
                                                        "depth": 24,
                                                        "pre_defined2": -1,
                                                        "boxes": [
                                                            {
                                                                "header": {
                                                                    "size": 51,
                                                                    "type": "avcC",
                                                                    "headerSize": 8
                                                                },
                                                                "type": "avcC",
                                                                "configurationVersion": 1,
                                                                AVCProfileIndication: d.AVCProfileIndication,
                                                                profile_compatibility: d.profile_compatibility,
                                                                AVCLevelIndication: d.AVCLevelIndication,
                                                                "reserved0": [
                                                                    1,
                                                                    1,
                                                                    1,
                                                                    1,
                                                                    1,
                                                                    1
                                                                ],
                                                                "lengthSizeMinusOne": 3,
                                                                "reserved1": [
                                                                    1,
                                                                    1,
                                                                    1
                                                                ],
                                                                "numOfSequenceParameterSets": 1,
                                                                "sequenceParameterSets": [
                                                                    {
                                                                        "sps": {
                                                                            "NALLength": {
                                                                                "size": 29
                                                                            },
                                                                            "bitHeader0": {
                                                                                "forbidden_zero_bit": 0,
                                                                                "nal_ref_idc": 3,
                                                                                "nal_unit_type": 7
                                                                            },
                                                                            "forbidden_zero_bit_check": {},
                                                                            "extension": {
                                                                                "nalUnitHeaderBytes": 1
                                                                            },
                                                                            "nalObject": {
                                                                                "type": "sps",
                                                                                "nal": d.sps
                                                                            }
                                                                        }
                                                                    }
                                                                ],
                                                                "test": 5,
                                                                "numOfPictureParameterSets": 1,
                                                                "pictureParameterSets": [
                                                                    {
                                                                        "pps": {
                                                                            "NALLength": {
                                                                                "size": 7
                                                                            },
                                                                            "bitHeader0": {
                                                                                "forbidden_zero_bit": 0,
                                                                                "nal_ref_idc": 3,
                                                                                "nal_unit_type": 8
                                                                            },
                                                                            "forbidden_zero_bit_check": {},
                                                                            "extension": {
                                                                                "nalUnitHeaderBytes": 1
                                                                            },
                                                                            "nalObject": {
                                                                                "type": "pps",
                                                                                "nal": d.pps
                                                                            }
                                                                        }
                                                                    }
                                                                ],
                                                                "remainingBytes": []
                                                            },
                                                            {
                                                                "header": {
                                                                    "size": 16,
                                                                    "type": "pasp",
                                                                    "headerSize": 8
                                                                },
                                                                "type": "pasp",
                                                                "hSpacing": 1,
                                                                "vSpacing": 1
                                                            }
                                                        ]
                                                    }
                                                ]
                                            },
                                            {
                                                header: {
                                                    type: "stts"
                                                },
                                                type: "stts",
                                                version: 0,
                                                flags: 0,
                                                entry_count: 0,
                                                samples: []
                                            },
                                            {
                                                header: {
                                                    type: "stsc"
                                                },
                                                type: "stsc",
                                                version: 0,
                                                flags: 0,
                                                entry_count: 0,
                                                entries: []
                                            },
                                            {
                                                header: {
                                                    type: "stsz"
                                                },
                                                type: "stsz",
                                                version: 0,
                                                flags: 0,
                                                sample_size: 0,
                                                sample_count: 0,
                                                sample_sizes: []
                                            },
                                            {
                                                header: {
                                                    type: "stco"
                                                },
                                                type: "stco",
                                                version: 0,
                                                flags: 0,
                                                entry_count: 0,
                                                chunk_offsets: []
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]
    };
}

function createSidx(
    d: {
        moofSize: number;
        mdatSize: number;
        subsegmentDuration: number;
        timescale: number;
    }
): O<typeof SidxBox> {
    // There is a sidx per moof and mdat.
    return {
        header: {
            type: "sidx"
        },
        type: "sidx",
        version: 0,
        flags: 0,
        reference_ID: 1,
        timescale: d.timescale,
        times: {
            // Not used, doesn't matter?
            earliest_presentation_time: 0,
            // Not useful, we can just use reference_offset
            first_offset: 0
        },
        reserved: 0,
        reference_count: 1,
        ref: [
            // Nothing in here matters except reference_offset, and MAYBE subsegment_duration, but I am not even convinced of that.
            {
                // The whole SAP and reference_type garbage doesn't matter. Just put 0s, which means "no information of SAPs is provided",
                //  and use sample_is_non_sync_sample === 0 to indicate SAPs. Also, sample_is_non_sync_sample is used anyway, so these values
                //  are overriden regardless of what we do.
                a: {
                    reference_type: 0,
                    reference_offset: d.moofSize + d.mdatSize
                },
                // Looks like this isn't used. But we could calculate it correctly, instead of however it was calculated by mp4box
                subsegment_duration: d.subsegmentDuration,
                SAP: {
                    starts_with_SAP: 0,
                    // a SAP of type 1 or type 2 is indicated as a sync sample, or by "sample_is_non_sync_sample" equal to 0 in the movie fragments.
                    //  So... we have sample_is_non_sync_sample === 0 in the movie fragments, so this can be 0 here.
                    SAP_type: 0,
                    SAP_delta_time: 0
                }
            }
        ]
    };
}

type SampleInfo = {
    sample_duration?: number;
    sample_size?: number;
    sample_flags?: SampleFlags;
    sample_composition_time_offset?: number;
}
function createMoof(
    d: {
        // Order of the moof. Counting starts at 1.
        sequenceNumber: number;
        baseMediaDecodeTimeInTimescale: number;
        samples: SampleInfo[];
        forcedFirstSampleFlags?: SampleFlags;
        defaultSampleDurationInTimescale?: number;
        defaultSampleFlags?: SampleFlags;
    }
): O<typeof MoofBox> {

    let sample_durations = d.samples.filter(x => x.sample_duration !== undefined).length;
    let sample_sizes = d.samples.filter(x => x.sample_size !== undefined).length;
    let sample_flagss = d.samples.filter(x => x.sample_flags !== undefined).length;
    let sample_composition_time_offsets = d.samples.filter(x => x.sample_composition_time_offset !== undefined).length;

    if(sample_durations !== 0 && sample_durations !== d.samples.length) {
        throw new Error(`Some samples have sample_duration, others don't. This is invalid, samples must be consistent.`);
    }
    if(sample_sizes !== 0 && sample_sizes !== d.samples.length) {
        throw new Error(`Some samples have sample_size, others don't. This is invalid, samples must be consistent.`);
    }
    if(sample_flagss !== 0 && sample_flagss !== d.samples.length) {
        throw new Error(`Some samples have sample_flags, others don't. This is invalid, samples must be consistent. Even if there is a forceFirstSampleFlags, either ever sample needs flags, or none should have it.`);
    }
    if(sample_composition_time_offsets !== 0 && sample_composition_time_offsets !== d.samples.length) {
        throw new Error(`Some samples have sample_composition_time_offset, others don't. This is invalid, samples must be consistent.`);
    }

    let has_sample_durations = sample_durations > 0;
    let has_sample_sizes = sample_sizes > 0;
    let has_sample_flags = sample_flagss > 0;
    let has_composition_offsets = sample_composition_time_offsets > 0;

    function createMoofInternal(moofSize: number) {
        let moof: O<typeof MoofBox> = {
            header: {
                type: "moof"
            },
            type: "moof",
            boxes: [
                {
                    header: {
                        type: "mfhd"
                    },
                    type: "mfhd",
                    version: 0,
                    flags: 0,
                    sequence_number: d.sequenceNumber
                },
                {
                    header: {
                        type: "traf"
                    },
                    type: "traf",
                    boxes: [
                        {
                            header: {
                                type: "tfhd"
                            },
                            type: "tfhd",
                            version: 0,
                            flags: {
                                reserved3: 0,
                                default_base_is_moof: 1,
                                duration_is_empty: 0,
                                reserved2: 0,
                                // Eh... there is no reason to set this, as we can set the default flags in the moov (trex) anyway.
                                default_sample_flags_present: d.defaultSampleFlags === undefined ? 0 : 1,
                                // I can't imagine all samples having the same size, so let's not even set this.
                                default_sample_size_present: 0,
                                //  Also set in trex, but we MAY have different durations for different chunks.
                                default_sample_duration_present: d.defaultSampleDurationInTimescale === undefined ? 0 : 1,
                                reserved1: 0,
                                sample_description_index_present: 0,
                                base_data_offset_present: 0
                            },
                            track_ID: 1,
                            values: Object.assign({},
                                d.defaultSampleDurationInTimescale === undefined ? {} : { default_sample_duration: d.defaultSampleDurationInTimescale },
                                d.defaultSampleFlags === undefined ? {} : { default_sample_flags: d.defaultSampleFlags }
                            )
                        },
                        {
                            header: {
                                type: "tfdt"
                            },
                            type: "tfdt",
                            version: 0,
                            flags: 0,
                            values: {
                                baseMediaDecodeTime: d.baseMediaDecodeTimeInTimescale
                            }
                        },
                        {
                            header: {
                                type: "trun"
                            },
                            type: "trun",
                            version: 0,
                            flags: {
                                reserved2: 0,
                                sample_composition_time_offsets_present: has_composition_offsets ? 1 : 0,
                                sample_flags_present: has_sample_flags ? 1 : 0,
                                sample_size_present: has_sample_sizes ? 1 : 0,
                                sample_duration_present: has_sample_durations ? 1 : 0,
                                reserved1: 0,
                                first_sample_flags_present: d.forcedFirstSampleFlags === undefined ? 0 : 1,
                                reserved0: 0,
                                data_offset_present: 1
                            },
                            sample_count: d.samples.length,
                            values: Object.assign(
                                { data_offset: moofSize + 8 },
                                // Union assignment has bugs, so... this is sort of weird
                                d.forcedFirstSampleFlags === undefined ? {
                                    first_sample_flags: undefined
                                } : {
                                    first_sample_flags: d.forcedFirstSampleFlags
                                }
                            ),
                            sample_values: d.samples
                        }
                    ]
                }
            ]
        };
        return moof;
    }

    let size = writeObject(MoofBox, createMoofInternal(0)).getLength();
    let moof = createMoofInternal(size);

    return moof;
}

function getFrames(path: string): LargeBuffer[] {
    let buffer = LargeBuffer.FromFile(path);
    let h264Object = parseObject(buffer, RootBox);
       
    let box = filterBox(h264Object);
    let mdia = box("moov")("trak")("mdia");

    let stts = mdia("minf")("stbl")("stts")();

    if(stts.samples.length !== 1) {
        console.log(stts.samples);
        throw new Error(`Samples of varying duration. This is unexpected.`);
    }

    // ctts table has times
    // stsz table has sample byte sizes.

    let mdat = box("mdat")();
    let stsz = mdia("minf")("stbl")("stsz")();
    let mdats: LargeBuffer[] = [];

    let bufs: LargeBuffer[] = [];
    let pos = 0;
    for(let sampleSize of stsz.sample_sizes) {
        bufs.push(mdat.bytes.slice(pos, pos + sampleSize));
        mdats.push();
        pos += sampleSize;
    }

    return bufs;
}

process.on('uncaughtException', (x: any) => console.log(x));
async function wrapAsync(fnc: () => Promise<void>): Promise<void> {
    try {
        await fnc();
    } catch(e) {
        console.error(e);
    }
}



function printBinary(path: string) {
    let buf = LargeBuffer.FromFile(path);

    let count = Math.min(100, buf.getLength());
    for(let i = 0; i < count; i++) {
        let byte = buf.readUInt8(i);
        process.stdout.write(byteToBits(byte).join("") + " ");
    }
    process.stdout.write("\n");
}



//frameTest();
function frameTest() {
    let count = 3;

    console.log("Working video");
    


    console.log("\nOther video");
    //printBinary(`C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame0.h264`);
    //decodeH264(`C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame0.h264`);

    

    // Uh, so ignore the extra NAL unit?
    //  https://github.com/cisco/openh264/issues/2501
    //  http://aviadr1.blogspot.com/2010/05/h264-extradata-partially-explained-for.html
    // It might be that the extra NAL can just be ignored

    // Start coding NALs. The first is of type 7, and SPS. Which seems good.
    //  But, the working video the first is of type 6, and SEI. So... Hmm...
    //  And... why is the second NAL frame of type 0
    // So... start by decoding the working type? And then the not working type. And then maybe
    //  we'll just make our own NAL frame? NAL type 1 is in both and likely the frame data,
    //  and 5 is in both (just in the not working it is delayed a bit).

    for(let i = 0; i < count; i++) {
        let path = `C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame${i}.h264`;
        //decodeH264File(path);

        //process.stdout.write(i + "     ");
        //decodeH264(path);
        //printBinary(path);
    }


    //wrapAsync(testRewriteMp4Fragment);
}

function getMP4H624NALs(path: string): NALType[] {
    let mp4File = parseObject(LargeBuffer.FromFile(path), RootBox);
    let box = filterBox(mp4File);
    let mdia = box("moov")("trak")("mdia");
    let avcC = mdia("minf")("stbl")("stsd")("avc1")("avcC")();

    if(avcC.sequenceParameterSets.length !== 1) {
        throw new Error(`Multiple sequenceParameterSets`);
    }
    let nalObject = avcC.sequenceParameterSets[0].sps.nalObject;
    let spsObject = nalObject;
    if(spsObject.type !== "sps") {
        throw new Error(`sequenceParameterSet not sps`);
    }
    let sps = spsObject.nal;

    if(avcC.pictureParameterSets.length !== 1) {
        throw new Error(`Multiple pictureParameterSets`);
    }
    let nalObject0 = avcC.pictureParameterSets[0].pps.nalObject;
    let spsObject0 = nalObject0;
    if(spsObject0.type !== "pps") {
        console.log(spsObject0);
        throw new Error(`pictureParameterSets not pps`);
    }
    let pps = spsObject0.nal;

    let NALs = flatten(getFrames(path).map(frame => {
        let obj = parseObject(frame, NALList(4, sps, pps));
        return obj.NALs;
    }));

    writeFileSync(path + `.sps.nal`, prettyPrint(sps));
    writeFileSync(path + `.pps.nal`, prettyPrint(pps));

    for(let i = 0; i < Math.min(2, NALs.length); i++) {
        writeFileSync(path + `.${i}.nal`, prettyPrint(NALs[i]));
    }

    return NALs;
}

function getOpenH264NALs() {
    return getH264NALsFiles(range(0, 10).map(i => `C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame${i}.h264`));
}

function getH264NALsFiles(files: string[]): NALType[] {
    return getH264NALs(files.map(file => ({ buf: LargeBuffer.FromFile(file), path: file })));
}
function getH264NALs(bufs: { buf: LargeBuffer, path: string }[]): NALType[] {
    let nals: NALType[] = [];

    let sps: SPS|undefined = undefined;
    let pps: PPS|undefined = undefined;

    for(let frameObj of bufs) {
        let frame = frameObj.buf;
        let path = frameObj.path;
        let obj = parseObject(frame, NALList(4, sps, pps));

        // Must be a forEach loop, to disconnect the sps variable from these assignments. Otherwise typescript
        //  thinks the assignment (which insures sps is not undefined), maybe impact the output of parseObject,
        //  and so says it cannot determine the type.
        obj.NALs.forEach((nal, i) => {
            if(nal.nalObject.type === "sps") {
                sps = nal.nalObject.nal;
            }
            if(nal.nalObject.type === "pps") {
                pps = nal.nalObject.nal;
            }
            nals.push(nal);

            let outputText = JSON.stringify(nal, null, "    ");
            writeFileSync(path + `.${i}.nal`, outputText);
        });
    }
    return nals;
}


function encodeFrames(frames: LargeBuffer[]) {
    // I am going to assume there is no frame reordering.
}

function printNals(nals: NALType[]): void {
    for(let nal of nals) {
        let n = nal.nalObject;
        //if(n.type === "slice") continue;
        console.log(n.type, nal.bitHeader0.nal_unit_type);
        //console.log(n);
    }
}

function testNALs(paths: string[]) {
    let bufs = paths.map(x => ({ buf: LargeBuffer.FromFile(x), path: x }));
    let entireBuf = new LargeBuffer(bufs.map(x => x.buf));
    let nals = getH264NALs(bufs);
    let output = writeObject(NALList(4, undefined, undefined), { NALs: nals });

    testWrite(entireBuf, output);
}


async function createVideo3 (
    outputFileName: string,
    videoInfo: {

    },
    framePaths: string[],
) {

    let ftyp: O<typeof FtypBox> = {
        header: {
            type: "ftyp"
        },
        type: "ftyp",
        major_brand: "iso5",
        minor_version: 1,
        compatible_brands: [
            "avc1",
            "iso5",
            "dash"
        ]
    };

    let timescale = 1;
    let frameTimeInTimescale = 1;
    let width = 600;
	let height = 400;

    let NALs = getH264NALsFiles(framePaths);
    let spsObject = NALs.filter(x => x.nalObject.type === "sps")[0];
    if(spsObject.nalObject.type !== "sps") {
        throw new Error("impossible");
    }
    let sps = spsObject.nalObject.nal;

    let ppsObject = NALs.filter(x => x.nalObject.type === "pps")[0];
    if(ppsObject.nalObject.type !== "pps") {
        throw new Error("impossible");
    }
    let pps = ppsObject.nalObject.nal;

    for(let NAL of NALs) {
        if(NAL.nalObject.type !== "slice") continue;
        let header = NAL.nalObject.nal.slice_header;
        console.log(header.sliceTypeStr, header.pic_order_cnt_lsb);
    }

    //if(true as boolean) throw new Error("stop");

    let frames = NALs.filter(x => x.nalObject.type === "slice");
    let frameInfos = getSamples(frames, sps, pps, frameTimeInTimescale);

    let samples: SampleInfo[] = frameInfos.map(x => ({
        sample_size: x.buffer.getLength(),
        // TODO: Calculate sample_composition_time_offset from frame reorder information.
        sample_composition_time_offset: x.composition_offset,
    }));


    let moov = createMoov({
        defaultFlags: nonKeyFrameSampleFlags,
        timescale: timescale,
        durationInTimescale: samples.length * frameTimeInTimescale,
        frameTimeInTimescale: frameTimeInTimescale,
        width: width,
        height: height,
        AVCProfileIndication: sps.profile_idc,
        profile_compatibility: 0,
        AVCLevelIndication: sps.level_idc,
        sps,
        pps,
    });
    
    let moof = createMoof({
        sequenceNumber: 1,
        baseMediaDecodeTimeInTimescale: 0,
        samples,
        forcedFirstSampleFlags: keyFrameSampleFlags,
        // Set defaultFlags in moov, not moof
        //defaultSampleFlags: nonKeyFrameSampleFlags
    });
    
    let mdat: O<typeof MdatBox> = {
        header: {
            size: 0,
            headerSize: 8,
            type: "mdat"
        },
        type: "mdat",
        bytes: new LargeBuffer(frameInfos.map(x => x.buffer))
    };
    
    let moofBuf = writeObject(MoofBox, moof);
    let mdatBuf = writeObject(MdatBox, mdat);

    let sidx = createSidx({
        moofSize: moofBuf.getLength(),
        mdatSize: mdatBuf.getLength(),
        subsegmentDuration: samples.length * frameTimeInTimescale,
        timescale: timescale,
    });


    let finalBuffer = writeObject(RootBox, { boxes: [
        ftyp,
        moov,
        sidx,
        moof,
        mdat,
    ] });

    await finalBuffer.WriteToFile(outputFileName);

    /*
    outputs.push(ftyp);
    outputs.push(moov);
    outputs.push(sidx);
    outputs.push(moof);
    outputs.push(mdat);
    */
    /*
    let mp4File = parseObject(LargeBuffer.FromFile(path), RootBox);
    let box = filterBox(mp4File);
    let mdia = box("moov")("trak")("mdia");
    let avcC = mdia("minf")("stbl")("stsd")("avc1")("avcC")();

    if(avcC.sequenceParameterSets.length !== 1) {
        throw new Error(`Multiple sequenceParameterSets`);
    }
    let nalObject = avcC.sequenceParameterSets[0].sps.nalObject;
    let spsObject = nalObject;
    if(spsObject.type !== "sps") {
        throw new Error(`sequenceParameterSet not sps`);
    }
    let sps = spsObject.nal;

    if(avcC.pictureParameterSets.length !== 1) {
        throw new Error(`Multiple pictureParameterSets`);
    }

    //avcC.numOfPictureParameterSets = 0;
    //avcC.pictureParameterSets = [];

    let newFileBuffer = writeObject(RootBox, mp4File);
    */
    //writeFileSync(path + ".modified.mp4", Buffer.concat(newFileBuffer.getInternalBufferList()));
}


//wrapAsync(testRewriteMp4Fragment);

// VLC is just broken at low frame rates. Not my fault.
// Re-encode 10fps video at 1/10th the speed, and see what the sps and pps look like after that.
// ffmpeg -r 10 -y -i 10fps.h264.mp4 -vf "setpts=PTS*10" -r 1 1fps.h264.mp4
// Maybe fixed_frame_rate_flag?

//getMP4H624NALs(`10fps.h264.mp4`);
//getMP4H624NALs(`1fps.h264.mp4`);

wrapAsync(async () => {
    await createVideo3("final.mp4", { }, range(0, 1).map(i => `C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame${i}.h264`));
    testReadFile("final.mp4");
});






//testReadFile(`10fps.h264.mp4`);
//testWriteFile(`10fps.h264.mp4`);
//modifyMP4(`10fps.h264.mp4`);

//testNALs([`C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame0.h264`]);

//let nals = getOpenH264NALs(); //getMP4H624NALs(`10fps.h264.mp4`);


//printNals(getH264NALs([`C:/Users/quent/Dropbox/camera/encoder/h264/h264/frame0.h264`]));
//printNals(getOpenH264NALs());


/*
//let NALs = getMP4H624NALs(`10fps.h264.mp4`);
let NALs = getOpenH264NALs();
writeFileSync(`create0.h264.json`, JSON.stringify(NALs[0].nalObject, null, "    "));

for(let i = 0; i < NALs.length; i++) {
    let NAL = NALs[i];
    if(NAL.nalObject.type === "slice") {
        let nal = NAL.nalObject.nal;
        console.log(`Index ${i}, Type: ${nal.slice_header.sliceTypeStr} Order: ${nal.slice_header.pic_order_cnt_lsb}`);
    } else {
        console.log(`Index ${i}, ${NAL.nalObject.type}`);
    }
}
*/

// Hmm... if we re-encode 10fps.h264.mp4, but with less frames, we can verify we understand the display order correctly.

/*
testReadFile(`youtube.mp4`);
testReadFile(`youtube.h264.mp4`);
testReadFile(`youtube2.h264.mp4`);
testReadFile(`10fps.h264.mp4`);
*/


//todonext
// - Modify the frames inside test5.mp4 (the payload is just a mjpeg), so ensure we can still play it.
// - Make sure writeIntermediate works for youtube.mp4 (and add parsing for any new boxes)
// - Make sure we can put a payload from a full mp4 (test.h264.mp4) into a frament mp4 (youtube.mp4), and get a playable file.

//testYoutube();

//testReadFile("./raw/test5.mp4");

//testWriteFile("./raw/test5.mp4");
//testWriteFile("./youtube.mp4");

//testWriteFile("./youtube2.mp4");

//testReadFile("./10fps.h264.mp4");

//testReadFile("./10fps.mp4");
/*
{

    let file = LargeBuffer.FromFile("./10fps.mp4");
    let obj = parseObject(file, RootBox);
    let box = filterBox(obj);

    let mdat = box("mdat")();

    let mdia = box("moov")("trak")("mdia");
    let stsz = mdia("minf")("stbl")("stsz")();

    let frameNumber = 0;
    let pos = 0;
    for(let sampleSize of stsz.sample_sizes) {
        let jpeg = mdat.bytes.slice(pos, pos + sampleSize);
        writeFileSync(`frame${frameNumber++}.jpeg`, Buffer.concat(jpeg.getInternalBufferList()));
        pos += sampleSize;
    }
}
//*/

// 

//wrapAsync(testRewriteMjpeg);



//testRewriteMjpeg();

//console.log(MdatBox.header[BoxSymbol])


/*


//type idk = SerialObjectOutput<typeof MdatBox>;
//let idk!: idk;
//let x = idk.header.primitive[BoxSymbol];

let templateMp4 = "./raw/test5.mp4";
let buf = LargeBuffer.FromFile(templateMp4);
let output = parseBytes(buf, RootBox);


//RootBox.boxes.T1 = MdatBox

console.log(filterBox(FileBox, RootBox.boxes, output.boxes));
console.log(filterBox(FreeBox, RootBox.boxes, output.boxes));
console.log(filterBox(MdatBox, RootBox.boxes, output.boxes));
console.log(filterBox(MoovBox, RootBox.boxes, output.boxes));
//let xxx = filterBox(TkhdBox, RootBox.boxes, output.boxes);
//let y: number = x;
//let y = filterBox(TkhdBox, RootBox.boxes, output.boxes).header;





output.boxes;
//filterBox(MdatBox, RootBox.boxes, output.boxes);
*/