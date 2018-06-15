import { SerialObjectPrimitive, ArrayInfinite, SerialObjectPrimitiveLength, LengthObjectSymbol, ChooseInfer, SerialObject, _SerialObjectOutput, TemplateToObject, ReadContext, ErasedKey, ErasedKey0, ErasedKey1 } from "./SerialTypes";
import { LargeBuffer } from "./LargeBuffer";
import { RawData, UInt8, bitMapping, VoidParse, PeekPrimitive, byteToBits, bitsToByte, UInt16 } from "./Primitives";
import { CodeOnlyValue, parseObject } from "./BinaryCoder";
import { repeat, range } from "./util/misc";

// There are NALs without start codes, as mentioned in: https://msdn.microsoft.com/en-us/library/windows/desktop/dd757808(v=vs.85).aspx,
//  So they are length prefixed with a 4 byte length. Technically the length isn't part of the NAL... but whatever...
// https://cardinalpeak.com/blog/the-h-264-sequence-parameter-set/
export const NALLength: SerialObjectPrimitiveLength<{}> = {
    [LengthObjectSymbol]: "NAL",
    read(context) {
        let { buffer, pPos } = context;

        let size = buffer.readUIntBE(pPos.v, 4) + 4;
        pPos.v += 4;

        return { size };
    },
    write(context) {
        let contentSize = context.getSizeAfter();
        let buf = new Buffer(4);
        buf.writeUInt32BE(contentSize, 0);
        return new LargeBuffer([ buf ]);
    }
};

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
                    console.log(`EmulationPrevention did something`);
                    continue;
                }
                finalBytes.push(rawBytes[i]);
            }

            pPos.v += totalLength;

            let subBuffer = new LargeBuffer([new Buffer(finalBytes)]);
            return parseObject(subBuffer, template);
        },
        write(context) {
            throw new Error(`EmulationPreventBytes write not implemented yet.`);
        }
    };
}

// Big endian endian
function readBit(context: ReadContext): 0|1 {
    let { buffer, pPos, bitOffset } = context;
    let byte = buffer.readUInt8(pPos.v);
    let bits = byteToBits(byte);
    let bit = bits[context.bitOffset];

    context.bitOffset++;
    if(context.bitOffset === 8) {
        context.bitOffset = 0;
        context.pPos.v++;
    }

    return bit;
}

const UExpGolomb: SerialObjectPrimitive<number> = {
    read(context) {
        let magnitude = 0;
        while(true) {
            let bit = readBit(context);
            if(bit === 1) break;
            magnitude++;
        }

        let sumOffset = (1 << magnitude) - 1;
        let bits = range(0, magnitude).map(x => readBit(context));
        let val = bitsToByte(bits) + sumOffset;
        return val;
    },
    write() {
        throw new Error(`UExpGolumb.write not implemented yet`);
    }
};

const BitPrimitive: SerialObjectPrimitive<0|1> = {
    read(context) {
        return readBit(context);
    },
    write() {
        throw new Error(`BitPrimitive.write not implemented yet`);
    }
};
function BitPrimitiveN(N: number): SerialObjectPrimitive<(0|1)[]> {
    return {
        read(context) {
            return range(0, N).map(() => readBit(context));
        },
        write() {
            throw new Error(`BitPrimitiveN.write not implemented yet`);
        }
    };
}

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

/** nal_unit_type = 7 */
export const NAL_SPS = ChooseInfer()({
    profile_idc: UInt8,
    constraints: bitMapping({
        constraint_set0_flag: 1,
        constraint_set1_flag: 1,
        constraint_set2_flag: 1,
        constraint_set3_flag: 1,
        constraint_set4_flag: 1,
        constraint_set5_flag: 1,
        reserved_zero_2bits: 2
    }),
    level_idc: UInt8,
    seq_parameter_set_id: UExpGolomb,
})({
    profile_idc_check: InvariantCheck(({profile_idc}) => {
        return !(
            profile_idc == 100 || profile_idc == 110 ||
            profile_idc == 122 || profile_idc == 244 || profile_idc == 44 ||
            profile_idc == 83 || profile_idc == 86 || profile_idc == 118 ||
            profile_idc == 128 || profile_idc == 138 || profile_idc == 139 ||
            profile_idc == 134 || profile_idc == 135
        );
    }),

    log2_max_frame_num_minus4: UExpGolomb,
    pic_order_cnt_type: UExpGolomb,
})({
    [ErasedKey]: ({pic_order_cnt_type}) => {
        if(pic_order_cnt_type === 0) {
            return {
                log2_max_pic_order_cnt_lsb_minus4: UExpGolomb,
            };
        } else {
            throw new Error(`Unhandled pic_order_cnt_type ${pic_order_cnt_type}`);
        }
    }
})({
    max_num_ref_frames: UExpGolomb,
    gaps_in_frame_num_value_allowed_flag: BitPrimitive,
    pic_width_in_mbs_minus1: UExpGolomb,
    pic_height_in_map_units_minus1: UExpGolomb,
    frame_mbs_only_flag: BitPrimitive,
})({
    // My endianness was wrong, everything makes more sense, I need to change my defaults of what I was parsing.
    [ErasedKey0]: ({frame_mbs_only_flag}) => {
        if(frame_mbs_only_flag) {
            throw new Error(`Unhandled frame_mbs_only_flag ${frame_mbs_only_flag}`);
        }
        return {
            mb_adaptive_frame_field_flag: BitPrimitive,
        };
    },
    direct_8x8_inference_flag: BitPrimitive,
    frame_cropping_flag: BitPrimitive,
})({
    frame_cropping_flag_check: InvariantCheck(({frame_cropping_flag}) => frame_cropping_flag === 0),
    vui_parameters_present_flag: BitPrimitive
})({
    vui_parameters_check: InvariantCheck(({vui_parameters_present_flag}) => vui_parameters_present_flag === 1),
})
// vui_parameters
({
    aspect_ratio_info_present_flag: BitPrimitive,
})({
    aspect_ratio_info_present_flag_check: InvariantCheck(({aspect_ratio_info_present_flag}) => aspect_ratio_info_present_flag === 0),
    overscan_info_present_flag: BitPrimitive,
})({
    overscan_info_present_flag_check: InvariantCheck(({overscan_info_present_flag}) => overscan_info_present_flag === 0),
    video_signal_type_present_flag: BitPrimitive,
})({
    video_signal_type_present_flag_check: InvariantCheck(({video_signal_type_present_flag}) => video_signal_type_present_flag === 1),
    video_format: BitPrimitiveN(3),
    video_full_range_flag: BitPrimitive,
    colour_description_present_flag: BitPrimitive,
})({
    colour_description_present_flag_check: InvariantCheck(({colour_description_present_flag}) => colour_description_present_flag === 0),
    chroma_loc_info_present_flag: BitPrimitive,
})({
    chroma_loc_info_present_flag_check: InvariantCheck(({chroma_loc_info_present_flag}) => chroma_loc_info_present_flag === 1),
    chroma_sample_loc_type_top_field: UExpGolomb,
    chroma_sample_loc_type_bottom_field: UExpGolomb,

    timing_info_present_flag: BitPrimitive,
})({
    timing_info_present_flag_check: InvariantCheck(({timing_info_present_flag}) => timing_info_present_flag === 0),
    nal_hrd_parameters_present_flag: BitPrimitive,
})({
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
})({
    idk0: BitPrimitive,
    idk1: BitPrimitive,
    idk2: BitPrimitive,
    idk3: BitPrimitive,

    idk00: BitPrimitive,
    idk01: BitPrimitive,
    idk02: BitPrimitive,
    idk03: BitPrimitive,
    idk04: BitPrimitive,
    idk05: BitPrimitive,
    idk06: BitPrimitive,
    idk07: BitPrimitive,

    idk10: BitPrimitive,
    idk11: BitPrimitive,
    idk12: BitPrimitive,
    idk13: BitPrimitive,
    idk14: BitPrimitive,
    idk15: BitPrimitive,
    idk16: BitPrimitive,
    idk17: BitPrimitive,

    idk20: BitPrimitive,
    idk21: BitPrimitive,
    idk22: BitPrimitive,
    idk23: BitPrimitive,
    idk24: BitPrimitive,
    idk25: BitPrimitive,
    idk26: BitPrimitive,
    idk27: BitPrimitive,
})
// rbsp_trailing_bits
();

//rbsp_trailing_bits( ) { C Descriptor
//rbsp_stop_one_bit /* equal to 1 */ All f(1)
//while( !byte_aligned( ) )
//rbsp_alignment_zero_bit /* equal to 0 */ All f(1)
//}

export const NAL = ChooseInfer()({
    NALLength
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
    }
})({
    nalParsed: ({NALLength, bitHeader0, extension}) => {
        let payloadLength = NALLength.size - extension.nalUnitHeaderBytes - 4;
        console.log(`Start ${bitHeader0.nal_unit_type}`);
        if(bitHeader0.nal_unit_type === 7) {
            return EmulationPreventionWrapper(payloadLength, NAL_SPS);
        } else {
            return EmulationPreventionWrapper(payloadLength, { all: ArrayInfinite(UInt8) });
        }
        // Hmm... this isn't very write friendly.
        //data: ({NALLength, bitHeader0, extension}) => EmulationPreventionBytes(NALLength.size - extension.nalUnitHeaderBytes - 4)
    }
})
();

export const NALList = {
    NALs: ArrayInfinite(NAL)
};