import { SerialObjectPrimitive, ArrayInfinite, SerialObjectPrimitiveLength, LengthObjectSymbol, ChooseInfer, SerialObject, _SerialObjectOutput, TemplateToObject, ReadContext, ErasedKey, ErasedKey0, ErasedKey1, ErasedKey2, ErasedKey3, HandlesBitOffsets, ErasedKey4, ErasedKey5, ErasedKey6, ErasedKey7, ErasedKey8, ErasedKey9, ErasedKey10 } from "./SerialTypes";
import { LargeBuffer } from "./LargeBuffer";
import { RawData, UInt8, bitMapping, VoidParse, PeekPrimitive, byteToBits, bitsToByte, UInt16, UInt64, UInt32, CString, DebugString, readBit, UExpGolomb, BitPrimitive, BitPrimitiveN, IntBitN, SExpGolomb, AlignmentBits, Bit, RemainingData, RemainingDataRaw, CallOnReadPos } from "./Primitives";
import { CodeOnlyValue, parseObject, writeObject, Iterate, getBufferWriteContext, getBufferWriteContextRanges, getAllBufferWriteContextRanges, WriteContextRange, setBufferWriteContext } from "./BinaryCoder";
import { repeat, range } from "./util/misc";

/*
// C:\Users\quent\Downloads\jm19.0\JM\ldecod\src\parset.c
// c:\Users\quent\Downloads\jm19.0\JM\ldecod\inc\defines.h
//AVC Profile IDC definitions
typedef enum {
  NO_PROFILE     =  0,       //!< disable profile checking for experimental coding (enables FRExt, but disables MV)
  FREXT_CAVLC444 = 44,       //!< YUV 4:4:4/14 "CAVLC 4:4:4"
  BASELINE       = 66,       //!< YUV 4:2:0/8  "Baseline"
  MAIN           = 77,       //!< YUV 4:2:0/8  "Main"
  EXTENDED       = 88,       //!< YUV 4:2:0/8  "Extended"
  FREXT_HP       = 100,      //!< YUV 4:2:0/8  "High"
  FREXT_Hi10P    = 110,      //!< YUV 4:2:0/10 "High 10"
  FREXT_Hi422    = 122,      //!< YUV 4:2:2/10 "High 4:2:2"
  FREXT_Hi444    = 244,      //!< YUV 4:4:4/14 "High 4:4:4"
  MVC_HIGH       = 118,      //!< YUV 4:2:0/8  "Multiview High"
  STEREO_HIGH    = 128       //!< YUV 4:2:0/8  "Stereo High"
} ProfileIDC;
*/

/** Make a AVCC format buffer, from annex b. */
export function ConvertAnnexBToAVCC(buf: LargeBuffer): LargeBuffer {
    let annexB3BytesPositions: {pos: number, size: number}[] = [];

    let len = buf.getLength();
    let zeroCount = 0;

    

    // Wait! Variable length start codes!? Dammit, we need to handle this...
    for(let i = 0; i < len; i++) {
        let byte = buf.readUInt8(i);
        if((zeroCount === 3 || zeroCount === 2) && byte === 0x01) {
            annexB3BytesPositions.push({pos: i - zeroCount, size: zeroCount + 1});
        }
        
        if(byte === 0) {
            zeroCount++;
            if(zeroCount >= 4) {
                throw new Error(`Too many zero bytes encountered? These should have been escaped`);
            }
        } else {
            zeroCount = 0;
        }
    }

    let nakedNals: LargeBuffer[] = [];

    for(let i = 0; i < annexB3BytesPositions.length; i++) {
        let pos = annexB3BytesPositions[i];
        let nextStartPos = (i + 1) < annexB3BytesPositions.length ? annexB3BytesPositions[i + 1].pos : len;

        let start = pos.pos + pos.size;
        let end = nextStartPos;
        nakedNals.push(buf.slice(start, end));
    }

    let index = 0;
    let pos = 0;
    let nalsAndLengths: LargeBuffer[] = [];
    for(let nakedNal of nakedNals) {
        let size = nakedNal.getLength();
        console.log({size, pos, index});
        pos += size + 4;
        index++;

        let b1 = ~~(size / Math.pow(2, 24));
        size -= b1 * Math.pow(2, 24);
        let b2 = ~~(size / Math.pow(2, 16));
        size -= b2 * Math.pow(2, 16);
        let b3 = ~~(size / Math.pow(2, 8));
        size -= b3 * Math.pow(2, 8);
        let b4 = size;

        nalsAndLengths.push(new LargeBuffer([new Buffer([b1, b2, b3, b4])]));
        nalsAndLengths.push(nakedNal);
    }

    return new LargeBuffer(nalsAndLengths);
}

// There are NALs without start codes, as mentioned in: https://msdn.microsoft.com/en-us/library/windows/desktop/dd757808(v=vs.85).aspx,
//  So they are length prefixed with a 4 byte length. Technically the length isn't part of the NAL... but whatever...
// https://cardinalpeak.com/blog/the-h-264-sequence-parameter-set/
export function NALLength(sizeByteLength = 4): SerialObjectPrimitiveLength<{}> {
    return {
        [LengthObjectSymbol]: "NAL",
        read(context) {
            let { buffer, pPos } = context;

            let size = buffer.readUIntBE(pPos.v, sizeByteLength) + sizeByteLength;
            pPos.v += sizeByteLength;

            return { size };
        },
        write(context) {
            let contentSize = context.getSizeAfter();
            let buf = new Buffer(sizeByteLength);
            buf.writeUIntBE(contentSize, 0, sizeByteLength);
            return new LargeBuffer([ buf ]);
        }
    };
}

// A NAL start code is 0x000001 (which we don't use, we use length prefixed non start code data). But... this means
//  the raw data might have 0x000001s in it. So, the spec deals with this by saying that in any 0x000003 sequence is detected
//  the 0x03 is discarded (non recursively). So we can read data that becomes 0x000001. Unfortunately... we also need to escape
//  0x000003 sequences now.
export function EmulationPreventionWrapper<T extends SerialObject>(totalLength: number, template: T): SerialObjectPrimitive<TemplateToObject<T>> {
    return {
        read(context) {
            let { buffer, pPos } = context;

            let rawBuffer = buffer.slice(pPos.v, pPos.v + totalLength);

            let rawBytes: number[] = [];
            for(let i = 0; i < totalLength; i++) {
                rawBytes.push(rawBuffer.readUInt8(i));
            }
            
            let finalBytes: number[] = [];
            for(let i = 0; i < totalLength; i++) {
                // If we read 0x000003, skip the 3
                if(i > 2 && rawBytes[i] === 3 && rawBytes[i - 1] === 0 && rawBytes[i - 2] === 0) {
                    //console.log(`EmulationPrevention did something at byte ${i}`);
                    let nextByte = rawBytes[i + 1];
                    if(nextByte != 0 && nextByte != 1 && nextByte != 2 && nextByte != 3) {
                        throw new Error(`EmulationPreventation byte with no purpose. It was used to escape: ${nextByte}`);
                    }
                    continue;
                }
                finalBytes.push(rawBytes[i]);
            }

            // TODO: We also need to parse some end sequences. Something about cabac_zero_word, and trailing cabac_zero_words and stuff like that...

            
            //console.log(`Emulation from ${rawBytes.length} to ${finalBytes.length}`);

            pPos.v += totalLength;

            let subBuffer = new LargeBuffer([new Buffer(finalBytes)]);
            return parseObject(subBuffer, template);
        },
        write(context) {
            let templateObject: TemplateToObject<T> = context.value;

            let buf = writeObject(template, templateObject);

            // So... go through every byte, and escape them. This is going to be slow.
            //  Wow, h264 is incredibly stupid. All this work, so we can have stop codes. And then no one uses stop codes. Why?

            let realBytes: number[] = [];
            //todonext
            // How is buffer becoming not bit aligned here? We should be eating up the remaining data?
            //console.log(`Bit count ${LargeBuffer.GetBitCount(buf)}`);

            let bitPos = 0;
            let ranges: WriteContextRange[] = [];
            for(let b of buf.getInternalBufferList()) {
                let bufRanges = getAllBufferWriteContextRanges(b);
                for(let range of bufRanges) {
                    let offset = ~~(bitPos / 8);
                    range.start += offset;
                    range.end += offset;
                    ranges.push(range);
                }

                bitPos += LargeBuffer.GetBitCount(b);
            }

            let len = buf.getLength();
            for(let i = 0; i < len; i++) {
                let byte = buf.readUInt8(i);
                realBytes.push(byte);
            }

            // Make ranges an offset list, so we can easily increment every entry by 1 if you need to add an emulation prevent byte.
            type OffsetEntry = {
                offsetToLast: number;
                size: number;
                context: string;
                originalPos: number;
            };
            let offsetList: OffsetEntry[] = [];
            let lastPos = 0;
            for(let range of ranges) {
                let offset = range.start - lastPos;
                lastPos = range.start;
                offsetList.push({
                    offsetToLast: offset,
                    size: range.end - range.start,
                    context: range.context,
                    originalPos: range.start,
                });
            }

            let offsetIndex = 0;

            let finalBytes: number[] = [];
            for(let i = 0; i < realBytes.length; i++) {
                while(offsetIndex < offsetList.length && offsetList[offsetIndex].originalPos <= i) {
                    offsetIndex++;
                }

                if(i > 2 && finalBytes[finalBytes.length - 2] === 0 && finalBytes[finalBytes.length - 1] === 0 && (realBytes[i] & 0b11111100) === 0) {
                    //console.log(`EmulationPrevention activated something at byte ${i}`);
                    finalBytes.push(0x03);

                    if(offsetIndex < offsetList.length) {
                        offsetList[offsetIndex].offsetToLast++;
                    }
                }

                finalBytes.push(realBytes[i]);
            }

            let finalBuf = new LargeBuffer([new Buffer(finalBytes)]);

            let curPos = 0;
            for(let offset of offsetList) {
                curPos += offset.offsetToLast;

                let range: WriteContextRange = {
                    start: curPos,
                    // Eh... this is sort of wrong... but w/e... It is hard to handle this correctly with overlapping ranges.
                    end: offset.size,
                    context: offset.context,
                };
                setBufferWriteContext(finalBuf, range.context, range);
            }

            return finalBuf;
        }
    };
}

const RbspTrailingPrimitive: SerialObjectPrimitive<void> = {
    [HandlesBitOffsets]: true,
    read(context) {
        let stopOneBit = readBit(context);
        if(stopOneBit !== 1) {
            throw new Error(`rbsp trailing bits did not start with 1. This means the data is corrupted.`);
        }
        while(context.bitOffset !== 0) {
            let alignment_zero_bit = readBit(context);
            if(alignment_zero_bit !== 0) {
                throw new Error(`rbsp alignment bit was not 0. This means the data is corrupted.`);
            }
        }
    },
    write(context) {
        let length = 8 - context.curBitSize % 8;
        let bits = [1 as Bit].concat(range(1, length).map(x => 0 as Bit));
        return new LargeBuffer([bits]);
    }
};

const IsMoreDataLeft: SerialObjectPrimitive<boolean> = {
    [HandlesBitOffsets]: true,
    read(context) {
        if(context.pPos.v < (context.end - 1)) {
            return false;
        }

        let bitOffset = 7;
        let bits = byteToBits(context.buffer.readUInt8(context.end - 1));
        while(bits[bitOffset] === 0) {
            bitOffset--;
            if(bitOffset < 0) {
                throw new Error(`Couldn't find rbsp trailing bit after 1 byte.`);
            }
        }

        let trailingBit = bits[bitOffset];
        if(trailingBit !== 1) {
            throw new Error(`Trailing bit is not 1`);
        }

        return bitOffset === context.bitOffset;
    },
    write() {
        return new LargeBuffer([new Buffer(0)]);
    }
};

function InvariantCheck<T>(trueVariant: (context: T) => boolean): (context: T) => SerialObject {
    return function(context: T): SerialObject {
        if(!trueVariant(context)) {
            throw new Error(`Invariant failed. ${trueVariant.toString()}`);
        }
        return {};
    }
}

export const parserTest = {
    a: UExpGolomb,
    b: BitPrimitive,
    c: BitPrimitive,
    d: UExpGolomb,
    e: BitPrimitive,
    f: BitPrimitive,
};


const hrd_parameters = ChooseInfer()({
    cpb_cnt_minus1: UExpGolomb,
    bit_rate_scale: IntBitN(4),
    cpb_size_scale: IntBitN(4),
})({
    [ErasedKey]: ({cpb_cnt_minus1}) => range(0, cpb_cnt_minus1 + 1).map(() => ({
        bit_rate_value_minus1: UExpGolomb,
        cpb_size_value_minus1: UExpGolomb,
        cbr_flag: BitPrimitive,
    })),
    /*
    [ErasedKey]: ({cpb_cnt_minus1}) => range(0, cpb_cnt_minus1 + 1).map(() => ({
        bit_rate_value_minus1: UExpGolomb,
        cpb_size_value_minus1: UExpGolomb,
        cbr_flag: BitPrimitive,
    })),
    */
    initial_cpb_removal_delay_length_minus1: IntBitN(5),
    cpb_removal_delay_length_minus1: IntBitN(5),
    dpb_output_delay_length_minus1: IntBitN(5),
    time_offset_length: IntBitN(5),
})
();


// https://github.com/iizukanao/node-rtsp-rtmp-server/blob/master/h264.coffee
//  The spec does the worst possible job explaining this flag. It uses it in hundreds of places, and never explicitly defines it. wtf.
function getChromaArrayType(sps: TemplateToObject<typeof NAL_SPS>): number {
    if("chroma_format_idc" in sps) {
        if(sps.chroma_format_idc === 3 && sps.separate_colour_plane_flags === 1) {
            return 0;
        }
        return sps.chroma_format_idc;
    } else {
        return 1;
    }
}

// #region nal_unit_type = 7
export type SPS = TemplateToObject<typeof NAL_SPS>;
export const NAL_SPS = ChooseInfer()({
    profile_idc: IntBitN(8),
    constraint_set0_flag: BitPrimitive,
    constraint_set1_flag: BitPrimitive,
    constraint_set2_flag: BitPrimitive,
    constraint_set3_flag: BitPrimitive,
    constraint_set4_flag: BitPrimitive,
    constraint_set5_flag: BitPrimitive,
    reserved_zero_2bits: BitPrimitiveN(2),
})({
    reserved_zero_2bits_check: InvariantCheck(({reserved_zero_2bits}) => reserved_zero_2bits[0] === 0 && reserved_zero_2bits[1] === 0),
    level_idc: IntBitN(8),
    seq_parameter_set_id: UExpGolomb,
})({
    [ErasedKey]: (({profile_idc}) => {
        if(
            profile_idc == 100 || profile_idc == 110 ||
            profile_idc == 122 || profile_idc == 244 || profile_idc == 44 ||
            profile_idc == 83 || profile_idc == 86 || profile_idc == 118 ||
            profile_idc == 128 || profile_idc == 138 || profile_idc == 139 ||
            profile_idc == 134 || profile_idc == 135
        ) {
            return ChooseInfer()({
                chroma_format_idc: UExpGolomb,
            })({
                [ErasedKey]: ({chroma_format_idc}) => {
                    return chroma_format_idc === 3 ? { separate_colour_plane_flags: BitPrimitive } : {};
                },
                bit_depth_luma_minus8: UExpGolomb,
                bit_depth_chroma_minus8: UExpGolomb,
                qpprime_y_zero_transform_bypass_flag: BitPrimitive,
                seq_scaling_matrix_present_flag: BitPrimitive,
            })({
                seq_scaling_matrix_present_flag_check: InvariantCheck(({seq_scaling_matrix_present_flag}) => seq_scaling_matrix_present_flag === 0)
            })
            ();
        }

        return ChooseInfer()({ [ErasedKey]: () => ({}) })();
    }),

    log2_max_frame_num_minus4: UExpGolomb,
    pic_order_cnt_type: UExpGolomb,
})
({
    [ErasedKey3]: ({pic_order_cnt_type}) => {
        if(pic_order_cnt_type === 1) {
            throw new Error(`pic_order_cnt_type === 1 not handled`);
        }
        if(pic_order_cnt_type === 0) {
            return {
                log2_max_pic_order_cnt_lsb_minus4: UExpGolomb,
            };
        }
        return {};
    },
})({
    max_num_ref_frames: UExpGolomb,
    gaps_in_frame_num_value_allowed_flag: BitPrimitive,
    pic_width_in_mbs_minus1: UExpGolomb,
    pic_height_in_map_units_minus1: UExpGolomb,
    frame_mbs_only_flag: BitPrimitive,
})({
    frame_mbs_only_flag_check: InvariantCheck(({frame_mbs_only_flag}) => frame_mbs_only_flag === 1),
    direct_8x8_inference_flag: BitPrimitive,
    frame_cropping_flag: BitPrimitive,
})({
    frame_cropping_flag_check: InvariantCheck(({frame_cropping_flag}) => frame_cropping_flag === 1),
    frame_crop_left_offset: UExpGolomb,
    frame_crop_right_offset: UExpGolomb,
    frame_crop_top_offset: UExpGolomb,
    frame_crop_bottom_offset: UExpGolomb,
    vui_parameters_present_flag: BitPrimitive,
})({
    vui_parameters_present_flag: BitPrimitive
})({
    vui_parameters_check: InvariantCheck(({vui_parameters_present_flag}) => vui_parameters_present_flag === 1),
})
// vui_parameters
({
    aspect_ratio_info_present_flag: BitPrimitive,
})({
    [ErasedKey0]: ({aspect_ratio_info_present_flag}) => {
        if(!aspect_ratio_info_present_flag) return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        return ChooseInfer()({
            // Hmm... I don't know if this is being parsed correctly. 128? That seems wrong...
            //  It should really be 15.
            aspect_ratio_idc: IntBitN(8),
        })({
            aspect_ratio_idc_check: InvariantCheck(({aspect_ratio_idc}) => aspect_ratio_idc !== 255)
        })
        ();
    },
})({
    //test: BitPrimitive,
    overscan_info_present_flag: BitPrimitive,
})({
    overscan_info_present_flag_check: InvariantCheck(({overscan_info_present_flag}) => overscan_info_present_flag === 0),
    video_signal_type_present_flag: BitPrimitive,
})({
    [ErasedKey1]: ({video_signal_type_present_flag}) => {
        if(!video_signal_type_present_flag) return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        return ChooseInfer()({
            video_format: BitPrimitiveN(3),
            video_full_range_flag: BitPrimitive,
            colour_description_present_flag: BitPrimitive,
        })({
            colour_description_present_flag_check: InvariantCheck(({colour_description_present_flag}) => colour_description_present_flag === 0),
        })
        ();
    },
    chroma_loc_info_present_flag: BitPrimitive,
})({
    chroma_loc_info_present_flag_check: InvariantCheck(({chroma_loc_info_present_flag}) => chroma_loc_info_present_flag === 0),
    timing_info_present_flag: BitPrimitive,
})({
    [ErasedKey2]: ({timing_info_present_flag}) => {
        if(!timing_info_present_flag) return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        return {
            num_units_in_tick: IntBitN(32),
            time_scale: IntBitN(32), 
            fixed_frame_rate_flag: BitPrimitive,
        };
    },
    nal_hrd_parameters_present_flag: BitPrimitive,
})({
    data0: ({nal_hrd_parameters_present_flag}) => {
        if(!nal_hrd_parameters_present_flag) return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        return { hrd_parameters };
    },
    nal_hrd_parameters_present_flag_check: InvariantCheck(({nal_hrd_parameters_present_flag}) => nal_hrd_parameters_present_flag === 0),
    vcl_hrd_parameters_present_flag: BitPrimitive,
})({
    vcl_hrd_parameters_present_flag_check: InvariantCheck(({vcl_hrd_parameters_present_flag}) => vcl_hrd_parameters_present_flag === 0),
    pic_struct_present_flag: BitPrimitive,
    bitstream_restriction_flag: BitPrimitive,
})({
    bitstream_restriction_flag_check: InvariantCheck(({bitstream_restriction_flag}) => bitstream_restriction_flag === 1),
    motion_vectors_over_pic_boundaries_flag: BitPrimitive,
    max_bytes_per_pic_denom: UExpGolomb,
    max_bits_per_mb_denom: UExpGolomb,
    log2_max_mv_length_horizontal: UExpGolomb,
    log2_max_mv_length_vertical: UExpGolomb,
    max_num_reorder_frames: UExpGolomb,
    max_dec_frame_buffering: UExpGolomb,
    trailing: RbspTrailingPrimitive,
})
();
// #endregion

// #region nal_unit_type = 8
export type PPS = TemplateToObject<typeof NAL_PPS>;
export const NAL_PPS = ChooseInfer()({
    pic_parameter_set_id: UExpGolomb,
    seq_parameter_set_id: UExpGolomb,
    entropy_coding_mode_flag: BitPrimitive,
    bottom_field_pic_order_in_frame_present_flag: BitPrimitive,
    num_slice_groups_minus1: UExpGolomb,
})({
    num_slice_groups_minus1_check: InvariantCheck(({num_slice_groups_minus1}) => num_slice_groups_minus1 === 0),
    slice_group_map_type: CodeOnlyValue(-1),
    slice_group_change_rate_minus1: CodeOnlyValue(-1),
    num_ref_idx_l0_default_active_minus1: UExpGolomb,
    num_ref_idx_l1_default_active_minus1: UExpGolomb,
    weighted_pred_flag: BitPrimitive,
    weighted_bipred_idc: IntBitN(2),
    pic_init_qp_minus26: SExpGolomb,
    pic_init_qs_minus26: SExpGolomb,
    chroma_qp_index_offset: SExpGolomb,
    deblocking_filter_control_present_flag: BitPrimitive,
    constrained_intra_pred_flag: BitPrimitive,
    redundant_pic_cnt_present_flag: BitPrimitive,
    
    isDone: IsMoreDataLeft,
})({
    [ErasedKey]: ({isDone}) => {
        if(isDone) return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        return ChooseInfer()({
            transform_8x8_mode_flag: BitPrimitive,
            pic_scaling_matrix_present_flag: BitPrimitive,
        })({
            pic_scaling_matrix_present_flag_check: InvariantCheck(({pic_scaling_matrix_present_flag}) => pic_scaling_matrix_present_flag === 0),
            second_chroma_qp_index_offset: SExpGolomb,
        })
        ();
    },
    RbspTrailingPrimitive,
})
();
// #endregion


const FunnyNumberType: SerialObjectPrimitive<number> = {
    read(context) {
        let { buffer, pPos } = context;
        let value = 0;

        while(true) {
            let byte = buffer.readUInt8(pPos.v);
            pPos.v++;
            value += byte;
            if(byte !== 0xFF) break;
        }
        return value;
    },
    write(context) {
        let size = Math.ceil(context.value / 0xFF);
        let pos = 0;
        let buf = new Buffer(size);

        
        let val = context.value;
        while(val >= 0xFF) {
            val -= 0xFF;
            buf[pos++] = 0xFF;
        }
        buf[pos++] = val;

        return new LargeBuffer([buf]);
    }
};

// #region nal_unit_type = 6
const NAL_SEI = ChooseInfer()({
    payloadType: FunnyNumberType,
    payloadSize: FunnyNumberType,
})({
    payloadTypeCheck: InvariantCheck(({payloadType}) => payloadType === 5),
    uuid_iso_iec_11578_0: UInt32,
    uuid_iso_iec_11578_1: UInt32,
    uuid_iso_iec_11578_2: UInt32,
    uuid_iso_iec_11578_3: UInt32,
    data: ({payloadSize}) => DebugString(payloadSize - 16),
    trailing: RbspTrailingPrimitive,
})
();
// #endregion

type SliceTypeNum = 0|1|2|3|4|5|6|7|8|9;
type SliceTypeStr = "P"|"B"|"I"|"SP"|"SI";
function getSliceType(type: number): SliceTypeStr {
    if(type === 0) {
        return "P";
    } else if(type === 1) {
        return "B";
    } else if(type === 2) {
        return "I";
    } else if(type === 3) {
        return "SP";
    } else if(type === 4) {
        return "SI";
    } else if(type === 5) {
        return "P";
    } else if(type === 6) {
        return "B";
    } else if(type === 7) {
        return "I";
    } else if(type === 8) {
        return "SP";
    } else if(type === 9) {
        return "SI";
    } else {
        throw new Error(`Invalid slice type ${type}`);
    }
}

function IdrPicFlag(nal_unit_type: number) {
    return nal_unit_type === 5 ? 1 : 0;
}

function ref_pic_list_modification(slice_type: number) {
    return ChooseInfer()({
        [ErasedKey]: () => {
            let list = ChooseInfer()({
                ref_pic_list_modification_flag_l0: BitPrimitive,
            })({
                list: ({ref_pic_list_modification_flag_l0}) => {
                    if(ref_pic_list_modification_flag_l0) {
                        return Iterate(() => {
                            return ChooseInfer()({
                                modification_of_pic_nums_idc: UExpGolomb,
                            })({
                                [ErasedKey]: ({modification_of_pic_nums_idc}) => {
                                    if(modification_of_pic_nums_idc === 0 || modification_of_pic_nums_idc === 1) {
                                        return {
                                            abs_diff_pic_num_minus1: UExpGolomb,
                                        };
                                    } else if(modification_of_pic_nums_idc === 2) {
                                        return {
                                            long_term_pic_num: UExpGolomb,
                                        };
                                    }
                                    return {};
                                }
                            })
                            ();
                        })(
                            last => !last || last.modification_of_pic_nums_idc !== 3
                        );
                    }
                    return [];
                }
            })
            ();

            let sliceTypeStr = getSliceType(slice_type);

            if(sliceTypeStr !== "I" && sliceTypeStr !== "SI") {
                if(sliceTypeStr === "B") {
                    return {
                        list0: list,
                        list1: list,
                    };
                } else {
                    return {
                        list0: list,
                    };
                }
            }

            return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        }
    })
    ();
}

function dec_ref_pic_marking(nal_unit_type: number) {
    if(IdrPicFlag(nal_unit_type)) {
        return ChooseInfer()({
            no_output_of_prior_pics_flag: BitPrimitive,
            long_term_reference_flag: BitPrimitive,
        })
        ();
    } else {
        return ChooseInfer()({
            adaptive_ref_pic_marking_mode_flag: BitPrimitive,
        })({
            [ErasedKey]: ({adaptive_ref_pic_marking_mode_flag}) => {
                if(adaptive_ref_pic_marking_mode_flag) {
                    return Iterate(() => {
                        return ChooseInfer()({
                            memory_management_control_operation: UExpGolomb,
                        })({
                            [ErasedKey]: ({memory_management_control_operation}) => {
                                if(memory_management_control_operation === 1 || memory_management_control_operation === 3) {
                                    return {
                                        difference_of_pic_nums_minus1: UExpGolomb,
                                    };
                                }
                                return {};
                            },
                            [ErasedKey0]: ({memory_management_control_operation}) => {
                                if(memory_management_control_operation === 2) {
                                    return {
                                        long_term_pic_num: UExpGolomb,
                                    };
                                }
                                return {};
                            },
                            [ErasedKey1]: ({memory_management_control_operation}) => {
                                if(memory_management_control_operation === 3 || memory_management_control_operation === 6) {
                                    return {
                                        long_term_frame_idx: UExpGolomb,
                                    };
                                }
                                return {};
                            },
                            [ErasedKey2]: ({memory_management_control_operation}) => {
                                if(memory_management_control_operation === 4) {
                                    return {
                                        max_long_term_frame_idx_plus1: UExpGolomb,
                                    };
                                }
                                return {};
                            },
                        })
                        ();
                    })(value => !value || value.memory_management_control_operation !== 0);
                }
                return {};
            }
        })
        ();
    }
}

function pred_weight_table(nal_unit_type: number, sps: TemplateToObject<typeof NAL_SPS>, pps: TemplateToObject<typeof NAL_PPS>, nal_ref_idc: number, num_ref_idx_l0_active_minus1: number, num_ref_idx_l1_active_minus1: number|undefined, slice_type: number) {
    let chromaArrayType = getChromaArrayType(sps);
    let sliceTypeStr = getSliceType(slice_type);

    let arrayEntry = ChooseInfer()({
        luma_weight_flag: BitPrimitive,
    })({
        [ErasedKey]: ({luma_weight_flag}) => {
            if(luma_weight_flag) {
                return {
                    luma_weight: SExpGolomb,
                    luma_offset: SExpGolomb,
                }
            }
            return {};
        },
        [ErasedKey0]: () => {
            if(chromaArrayType !== 0) {
                return ChooseInfer()({
                    chroma_weight_flag: BitPrimitive,
                })({
                    [ErasedKey]: ({chroma_weight_flag}) => {
                        if(chroma_weight_flag) {
                            return {
                                chroma_weight: [SExpGolomb, SExpGolomb],
                                chroma_offset: [SExpGolomb, SExpGolomb],
                            };
                        }
                        return {};
                    }
                })
                ();
            }
            return {};
        },
    })
    ();

    return ChooseInfer()({
        luma_log2_weight_denom: UExpGolomb,
    })({
        [ErasedKey]: () => {
            if(chromaArrayType != 0) {
                return {
                    chroma_log2_weight_denom: UExpGolomb
                };
            }
            return {};
        },

        luma_chroma_values0: repeat(arrayEntry, num_ref_idx_l0_active_minus1 + 1),

        [ErasedKey1]: () => {
            if(sliceTypeStr === "B") {
                if(num_ref_idx_l1_active_minus1 === undefined) {
                    throw new Error(`num_ref_idx_l1_active_minus1 is required, but undefined`);
                }
                return {
                    luma_chroma_values1: repeat(arrayEntry, num_ref_idx_l1_active_minus1 + 1),
                };
            }
            return {};
        },
    })
    ();
}

function slice_header(nal_unit_type: number, sps: TemplateToObject<typeof NAL_SPS>, pps: TemplateToObject<typeof NAL_PPS>, nal_ref_idc: number) {
    let frame_num = IntBitN(sps.log2_max_frame_num_minus4 + 4);
    let pic_order_cnt_type_bits = 0;
    if(sps.pic_order_cnt_type === 0) {
        if(sps.log2_max_pic_order_cnt_lsb_minus4 === undefined) {
            throw new Error(`pic_order_cnt_type === 0 should mean log2_max_pic_order_cnt_lsb_minus4 is defined`);
        }
        pic_order_cnt_type_bits = sps.log2_max_pic_order_cnt_lsb_minus4 + 4;
    }
    let pic_order_cnt_lsb = IntBitN(pic_order_cnt_type_bits);

    return ChooseInfer()({
        first_mb_in_slice: UExpGolomb,
        slice_type: UExpGolomb,
    })({
        sliceTypeStr: ({slice_type}) => CodeOnlyValue(getSliceType(slice_type)),
        pic_parameter_set_id: UExpGolomb,
        frame_num,
        [ErasedKey0]: () => {
            if(!sps.frame_mbs_only_flag) {
                return ChooseInfer()({
                    field_pic_flag: BitPrimitive
                })({
                    [ErasedKey]: ({field_pic_flag}) => field_pic_flag ? { bottom_field_flag: BitPrimitive } : {}
                })
                ();
            }
            return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        },
        frame_mbs_only_flag_check: InvariantCheck(() => sps.frame_mbs_only_flag === 1),
        idr_pic_id: () => nal_unit_type === 5 ? UExpGolomb : CodeOnlyValue(0),
    })({
        [ErasedKey]: (obj) => {
            if(sps.pic_order_cnt_type === 1) {
                throw new Error(`sps.pic_order_cnt_type 1 not implemented`);
            }
            if(sps.pic_order_cnt_type === 0) {
                return ChooseInfer()({
                    log2_max_pic_order_cnt_lsb_minus4: CodeOnlyValue(sps.log2_max_pic_order_cnt_lsb_minus4),
                    pic_order_cnt_lsb,
                    [ErasedKey]: () => {
                        if(pps.bottom_field_pic_order_in_frame_present_flag && !("field_pic_flag" in obj && obj.field_pic_flag)) {
                            return {
                                delta_pic_order_cnt_bottom: SExpGolomb
                            }
                        }
                        return {};
                    }
                })
                ();
            }
            return ChooseInfer()({ pic_order_cnt_lsb })();
        },
        [ErasedKey1]: () => {
            if(pps.redundant_pic_cnt_present_flag) {
                return {
                    redundant_pic_cnt: UExpGolomb,
                };
            }
            return {};
        },
        [ErasedKey2]: ({slice_type}) => {
            if(getSliceType(slice_type) === "B") {
                return {
                    direct_spatial_mv_pred_flag: BitPrimitive,
                };
            }
            return {};
        },
        [ErasedKey3]: ({slice_type}) => {
            if(getSliceType(slice_type) === "P" || getSliceType(slice_type) === "SP" || getSliceType(slice_type) === "B") {
                return ChooseInfer()({
                    num_ref_idx_active_override_flag: BitPrimitive,
                })({
                    [ErasedKey]: ({num_ref_idx_active_override_flag}) => {
                        return Object.assign({
                            num_ref_idx_l0_active_minus1: UExpGolomb,
                        }, getSliceType(slice_type) === "B" ? {
                            num_ref_idx_l1_active_minus1: UExpGolomb,
                        } : {});
                    },
                })
                ();
            }
            return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        },
        /*
        ref_pic_list_mvc_modification_check: InvariantCheck(() => nal_unit_type !== 20 && nal_unit_type !== 21),
        [ErasedKey4]: ({slice_type}) => ({
            ref_pic_list_modification: ref_pic_list_modification(slice_type),
        }),
        */
    })({
        /*
        [ErasedKey5]: (obj) => {
            let sliceStr = getSliceType(obj.slice_type);
            if(pps.weighted_pred_flag && (sliceStr === "P" || sliceStr === "SP")
            || (pps.weighted_bipred_idc === 1 && sliceStr === "B")) {
                if(!("num_ref_idx_l0_active_minus1" in obj)) {
                    throw new Error(`num_ref_idx_l0_active_minus1 was not parsed, but is required by pred_weight_table. Something went wrong...`);
                }
                let num_ref_idx_l1_active_minus1: number|undefined = undefined;
                if(("num_ref_idx_l1_active_minus1" in obj) && obj.num_ref_idx_l1_active_minus1) {
                    num_ref_idx_l1_active_minus1 = obj.num_ref_idx_l1_active_minus1;
                }
                return {
                    pred_weight_table: pred_weight_table(nal_unit_type, sps, pps, nal_ref_idc, obj.num_ref_idx_l0_active_minus1, obj.num_ref_idx_l1_active_minus1, obj.slice_type)
                };
            }
            return {};
        },
        [ErasedKey6]: () => {
            if(nal_ref_idc !== 0) {
                return dec_ref_pic_marking(nal_unit_type);
            }
            return {};
        },
        [ErasedKey7]: ({slice_type}) => {
            let sliceStr = getSliceType(slice_type);
            if(pps.entropy_coding_mode_flag && sliceStr != "I" && sliceStr != "SI") {
                return {
                    cabac_init_idc: UExpGolomb
                };
            }
            return {};
        },
        slice_qp_delta: SExpGolomb,
        [ErasedKey8]: ({slice_type}) => {
            let sliceStr = getSliceType(slice_type);
            if(sliceStr === "SP" || sliceStr == "SI") {
                return ChooseInfer()({
                    [ErasedKey]: () => {
                        if(sliceStr === "SP") {
                            return {
                                sp_for_switch_flag: BitPrimitive
                            };
                        }
                        return {};
                    }
                })({
                    slice_qs_delta: SExpGolomb,
                })
                ();
            }
            return ChooseInfer()({ [ErasedKey]: () => ({}) })();
        },
        [ErasedKey9]: () => {
            
            if(pps.deblocking_filter_control_present_flag) {
                return ChooseInfer()({
                    disable_deblocking_filter_idc: UExpGolomb,
                })({
                    [ErasedKey]: ({disable_deblocking_filter_idc}) => {
                        if(disable_deblocking_filter_idc !== 1) {
                            return {
                                slice_alpha_c0_offset_div2: SExpGolomb,
                                slice_beta_offset_div2: SExpGolomb,
                            };
                        }
                        return {};
                    }
                })
                ();
            }
            return {};
        },
        [ErasedKey10]: () => {
            // Also check slice_group_map_type
            if(pps.num_slice_groups_minus1 > 0) {
                let PicWidthInMbs = sps.pic_width_in_mbs_minus1 + 1
                let PicHeightInMapUnits = sps.pic_height_in_map_units_minus1 + 1
                let PicSizeInMapUnits = PicWidthInMbs * PicHeightInMapUnits;
                let SliceGroupChangeRate = pps.slice_group_change_rate_minus1 + 1;
                let slice_group_change_cycle_bits = Math.ceil(Math.log2(PicSizeInMapUnits / SliceGroupChangeRate + 1));
                return {
                    slice_group_change_cycle: IntBitN(slice_group_change_cycle_bits)
                };
            }
            return {};
        }
        */
    })({
        
    })
    ();
}

function slice_data(nal_unit_type: number, sps: TemplateToObject<typeof NAL_SPS>, pps: TemplateToObject<typeof NAL_PPS>, nal_ref_idc: number) {
    return ChooseInfer()({
        align: AlignmentBits,
        remaining: RemainingDataRaw,
    })
    ();
}

// #region nal_unit_type = 1, 5
// nal_unit_type = 1, 5
function NAL_SLICE_LAYER_WITHOUT_PARTITIONING(nal_unit_type: number, sps: TemplateToObject<typeof NAL_SPS>, pps: TemplateToObject<typeof NAL_PPS>, nal_ref_idc: number) {
    return ChooseInfer()({
        slice_header: slice_header(nal_unit_type, sps, pps, nal_ref_idc),
        slice_data: slice_data(nal_unit_type, sps, pps, nal_ref_idc),
        // rbsp_slice_trailing_bits()
    })
    ();
}
// #endregion

export type NALTemplate = ReturnType<typeof NALCreate>;
export type NALType = TemplateToObject<NALTemplate>;
export function NALCreate(sizeByteLength: number, sps: TemplateToObject<typeof NAL_SPS>|undefined, pps: TemplateToObject<typeof NAL_PPS>|undefined) {
    return ChooseInfer()({
        PrintStart: CallOnReadPos(pos => console.log(`Started NAL at pos ${pos}`)),
        NALLength: NALLength(sizeByteLength)
    })({
        //data: ({NALLength}) => RawData(NALLength.size - 4)
        bitHeader0: bitMapping({
            forbidden_zero_bit: 1,
            nal_ref_idc: 2,
            nal_unit_type: 5,
        }),
    })({
        forbidden_zero_bit_check: ({bitHeader0}) => {
            if(bitHeader0.forbidden_zero_bit !== 0) {
                throw new Error(`forbidden_zero_bit is not equal to 0. The data is probably corrupt.`);
            }
            return {};
        },
        extensionFlag: ({bitHeader0}) => (
            bitHeader0.nal_unit_type === 14
            || bitHeader0.nal_unit_type === 20
            || bitHeader0.nal_unit_type === 21
            ? PeekPrimitive(UInt8)
            : VoidParse
        )
    })({
        extension: ({extensionFlag, bitHeader0}) => {
            if(extensionFlag === undefined) {
                return {
                    nalUnitHeaderBytes: CodeOnlyValue(1)
                };
            }

            if(extensionFlag & 0x80) {
                if(bitHeader0.nal_unit_type === 21) {
                    // nal_unit_header_3davc_extension
                    // nalUnitHeaderBytes = 3

                    return {
                        kind: CodeOnlyValue("3davc"),
                        nalUnitHeaderBytes: CodeOnlyValue(3),
                        data: bitMapping({
                            extensionFlagBit: 1,
                            view_idx: 8,
                            depth_flag: 1,
                            non_idr_flag: 1,
                            temporal_id: 3,
                            anchor_pic_flag: 1,
                            inter_view_flag: 1,
                        }),
                    };
                } else {
                    // nal_unit_header_svc_extension
                    // nalUnitHeaderBytes = 4

                    return {
                        kind: CodeOnlyValue("svc"),
                        nalUnitHeaderBytes: CodeOnlyValue(4),
                        data: bitMapping({
                            extensionFlagBit: 1,
                            idr_flag: 1,
                            priority_id: 6,
                            no_inter_layer_pred_flag: 1,
                            dependency_id: 3,
                            quality_id: 4,
                            temporal_id: 3,
                            use_ref_base_pic_flag: 1,
                            discardable_flag: 1,
                            output_flag: 1,
                            reserved_three_2bits: 2,
                        }),
                    };
                }
            } else {
                // nal_unit_header_mvc_extension
                // nalUnitHeaderBytes = 4

                return {
                    kind: CodeOnlyValue("mvc"),
                    nalUnitHeaderBytes: CodeOnlyValue(4),
                    data: bitMapping({
                        extensionFlagBit: 1,
                        non_idr_flag: 1,
                        priority_id: 6,
                        view_id: 10,
                        temporal_id: 3,
                        anchor_pic_flag: 1,
                        inter_view_flag: 1,
                        reserved_one_bit: 1,
                    }),
                };
            }
        },
    })({
        nalObject: ({NALLength, bitHeader0, extension}) => {
            let payloadLength = NALLength.size - extension.nalUnitHeaderBytes - sizeByteLength;
            //console.log(`Start ${bitHeader0.nal_unit_type}, length ${payloadLength}`);
            if(bitHeader0.nal_unit_type === 7) {
                return {type: CodeOnlyValue("sps" as "sps"), nal: EmulationPreventionWrapper(payloadLength, NAL_SPS)};
            } else if(bitHeader0.nal_unit_type === 8) {
                return {type: CodeOnlyValue("pps" as "pps"), nal: EmulationPreventionWrapper(payloadLength, NAL_PPS)};
            } else if(bitHeader0.nal_unit_type === 6) {
                return {type: CodeOnlyValue("sei" as "sei"), nal: EmulationPreventionWrapper(payloadLength, NAL_SEI)};
            } else if(bitHeader0.nal_unit_type === 1 || bitHeader0.nal_unit_type === 5) {
                if(sps === undefined) {
                    throw new Error(`sps is required when we encounter nal_unit_type === ${bitHeader0.nal_unit_type}`);
                }
                if(pps === undefined) {
                    throw new Error(`pps is required when we encounter nal_unit_type === ${bitHeader0.nal_unit_type}`);
                }
                return {type: CodeOnlyValue("slice" as "slice"), nal: EmulationPreventionWrapper(payloadLength, NAL_SLICE_LAYER_WITHOUT_PARTITIONING(bitHeader0.nal_unit_type, sps, pps, bitHeader0.nal_ref_idc))};
            } else {
                return {type: CodeOnlyValue("unknown" as "unknown"), nal: EmulationPreventionWrapper(payloadLength, { all: ArrayInfinite(UInt8) })};
            }
        }
    })
    ();
}

export function NALList(sizeByteLength: number, sps: TemplateToObject<typeof NAL_SPS>|undefined, pps: TemplateToObject<typeof NAL_PPS>|undefined) {
    return {
        NALs: (
            Iterate<() => NALTemplate>(
                () => NALCreate(sizeByteLength, sps, pps)
            )(
                last => {
                    if(last === undefined) return true;
                    if(last.nalObject.type === "sps") {
                        if(sps !== undefined) {
                            console.warn(`When parsing the NALList we found an SPS. However, we already had an sps. Either we found two, or we found one, and you also passed one. We will use the latest sps we find.`);
                        }
                        sps = last.nalObject.nal;
                        console.log("found sps");
                    }

                    if(last.nalObject.type === "pps") {
                        if(pps !== undefined) {
                            console.warn(`When parsing the NALList we found an PPS. However, we already had an pps. Either we found two, or we found one, and you also passed one. We will use the latest pps we find.`);
                        }
                        pps = last.nalObject.nal;
                        console.log("found pps");
                    }
                    return true;
                }
            )
        )
    };
    // return { NALs: ArrayInfinite(NALCreate(sizeByteLength, sps, pps)) };
};
//*/