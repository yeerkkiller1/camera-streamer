import { Box, CodeOnlyValue, BoxAnyType } from "./BinaryCoder";
import { UInt32String, UInt32, UInt64, NumberShifted, Int32, Int16, UInt16, UInt8, bitMapping, CString, LanguageParse, RawData, Int64, BitPrimitiveN, IntBitN, BitPrimitive, DebugString, DebugStringRemaining, UInt24 } from "./Primitives";
import { ArrayInfinite, ChooseInfer, BoxLookup, ErasedKey } from "./SerialTypes";
import { repeat, range } from "./util/misc";
import { throwValue, assertNumber } from "./util/type";
import { EmulationPreventionWrapper, NAL_SPS, NALCreate } from "./NAL";

export function FullBox<T extends string>(type: T) {
    return {
        ... Box(type),
        version: UInt8,
        flags: UInt24,
    };
}


export const AnyBox = ChooseInfer()({
    ... Box(BoxAnyType),
})({
    remainingBytes: (obj) => RawData(assertNumber(obj.header.size) - assertNumber(obj.header.headerSize))
})
();

// All the boxes have to be SerialObjects... but... we want to keep the underlying types too, so SerialObjectOutput works.
export const FtypBox = {
    ... Box("ftyp"),
    major_brand: UInt32String,
    minor_version: UInt32,
    compatible_brands: ArrayInfinite(UInt32String),
};

export const StypBox = {
    ... Box("styp"),
    major_brand: UInt32String,
    minor_version: UInt32,
    compatible_brands: ArrayInfinite(UInt32String),
};

export const MvhdBoxTest = ChooseInfer()({header: FullBox("ftyp")})();

export const MvhdBox = ChooseInfer()({ ...FullBox("mvhd") })({
    times: ({version}) => {
        if(version === 0) {
            return {
                creation_time: UInt32,
                modification_time: UInt32,
                timescale: UInt32,
                duration: UInt32,
            };
        } else if(version === 1) {
            return {
                creation_time: UInt64,
                modification_time: UInt64,
                timescale: UInt32,
                duration: UInt64,
            };
        } else {
            throw new Error(`Invalid version ${version}`);
        }
    }
})({
    rate: NumberShifted(Int32, 0x00010000),
    volume: NumberShifted(Int16, 0x0100),

    reserved: UInt16,
    reserved0: UInt32,
    reserved1: UInt32,

    matrix: repeat(Int32, 9),
    pre_defined: repeat(Int32, 6),

    next_track_ID: Int32,
})();

export const TkhdBox = ChooseInfer()({
    ...FullBox("tkhd"),
    version: UInt8,
    flags: bitMapping({
        reserved: 20,
        track_size_is_aspect_ratio: 1,
        track_in_preview: 1,
        track_in_movie: 1,
        track_enabled: 1,
    }),
})({
    times: ({version}) => {
        if(version === 0) {
            return {
                creation_time: UInt32,
                modification_time: UInt32,
                track_ID: UInt32,
                reserved: UInt32,
                duration: UInt32,
            };
        } else if(version === 1) {
            return {
                creation_time: UInt64,
                modification_time: UInt64,
                track_ID: UInt32,
                reserved: UInt32,
                duration: UInt64,
            };
        } else {
            throw new Error(`Invalid version ${version}`)
        }
    }
})({
    reserved0: UInt32,
    reserved1: UInt32,

    layer: Int16,
    alternate_group: Int16,
    volume: Int16,
    reserved2: UInt16,

    matrix: repeat(Int32, 9),

    width: NumberShifted(UInt32, 1 << 16),
    height: NumberShifted(UInt32, 1 << 16),
})
();

export const ElstBox = ChooseInfer()({
    ... FullBox("elst"),
    entry_count: UInt32,
})({
    entries: ({entry_count, version}) => {
        if(version === 0) {
            return repeat({
                segment_duration: UInt32,
                media_time: Int32,
                media_rate_integer: Int16,
                media_rate_fraction: Int16
            }, entry_count);
        } else if(version === 1) {
            return repeat({
                segment_duration: UInt64,
                media_time: Int64,
                media_rate_integer: Int16,
                media_rate_fraction: Int16
            }, entry_count);
        } else {
            throw new Error(`Invalid version ${version}`);
        }
    }
})
();

export const EdtsBox = {
    ... Box("edts"),
    boxes: BoxLookup(ElstBox),
};

export const MdhdBox = ChooseInfer()({
    ... FullBox("mdhd")
})({
    [ErasedKey]: ({version}) => (
        version === 0 ? {
            creation_time: UInt32,
            modification_time: UInt32,
            timescale: UInt32,
            duration: UInt32,
        } :
        version === 1 ? {
            creation_time: UInt64,
            modification_time: UInt64,
            timescale: UInt32,
            duration: UInt64,
        } :
        throwValue(`Invalid version ${version}`)
    )
})({
    language: LanguageParse,
    pre_defined: UInt16,
})
();

export const HdlrBox = {
    ... FullBox("hdlr"),

    pre_defined: UInt32,
    handler_type: UInt32String,
    reserved: repeat(UInt32, 3),

    name: CString,
};

export const VmhdBox = {
    ... FullBox("vmhd"),
    graphicsmode: UInt16,
    opcolor: repeat(UInt16, 3),
};

export const UrlBox = {
    ... Box("url "),
    version: UInt8,
    flags: bitMapping({
        reserved: 23,
        media_is_in_same_file: 1
    }),
};
export const DrefBox = {
    ... FullBox("dref"),
    entry_count: UInt32,
    boxes: BoxLookup(
        UrlBox
    ),
};

export const DinfBox = {
    ... Box("dinf"),
    boxes: BoxLookup(
        DrefBox
    ),
};

export const EsdsBox = {
    ... Box("esds"),
    iHaveNoIdeaAndReallyDontCare: ArrayInfinite(UInt8),
};

export const Mp4vBox = {
    ... Box("mp4v"),
    reserved: repeat(UInt8, 6),
    data_reference_index: UInt16,

    pre_defined: UInt16,
    reserved1: UInt16,
    pre_defined1: repeat(UInt32, 3),
    width: UInt16,
    height: UInt16,

    horizresolution: UInt32,
    vertresolution: UInt32,

    reserved2: UInt32,

    frame_count: UInt16,

    compressorname: repeat(UInt8, 32),
    depth: UInt16,
    pre_defined2: Int16,

    config: [EsdsBox],

    notImportant: ArrayInfinite(UInt8),
};



// https://github.com/videolan/vlc/blob/master/modules/packetizer/h264_nal.c
export const AvcCBox = ChooseInfer()({
    ... Box("avcC"),
})({
    configurationVersion: UInt8,
	AVCProfileIndication: UInt8,
	profile_compatibility: UInt8,
    AVCLevelIndication: UInt8,
})({
    reserved0: BitPrimitiveN(6),
    lengthSizeMinusOne: IntBitN(2),
})({

    reserved1: BitPrimitiveN(3),
    numOfSequenceParameterSets: IntBitN(5),
})({
    sequenceParameterSets: ({numOfSequenceParameterSets, lengthSizeMinusOne}) => {
        //console.log({lengthSizeMinusOne});
        // Hmm... but we have a nal length prefix of size 2. Always? I am not sure what lengthSizeMinusOne
        //  is even used for, but it appears to be wrong?
        lengthSizeMinusOne = 2 - 1;
        return repeat({sps: NALCreate(2, undefined, undefined)}, numOfSequenceParameterSets);
    },
    [ErasedKey]: CodeOnlyValue({test: 5}),
})({
    numOfPictureParameterSets: IntBitN(8),
})({
    pictureParameterSets: ({numOfPictureParameterSets}) => {
        return repeat({pps: NALCreate(2, undefined, undefined)}, numOfPictureParameterSets);
    }
})({
    remainingBytes: ArrayInfinite(UInt8)
})
();

export const PaspBox = {
    ... Box("pasp"),
    hSpacing: UInt32,
    vSpacing: UInt32,
};

export const Avc1Box = {
    ... Box("avc1"),
    reserved: repeat(UInt8, 6),
    data_reference_index: UInt16,

    pre_defined: UInt16,
    reserved1: UInt16,
    pre_defined1: repeat(UInt32, 3),
    width: UInt16,
    height: UInt16,

    horizresolution: UInt32,
    vertresolution: UInt32,

    reserved2: UInt32,

    frame_count: UInt16,

    compressorname: repeat(UInt8, 32),
    depth: UInt16,
    pre_defined2: Int16,

    boxes: BoxLookup(AvcCBox, PaspBox),

    //extension: [MPEG4ExtensionDescriptorsBox],

    
    //notImportant: ArrayInfinite(UInt8),

    //output: DebugStringRemaining
};

export const StsdBox = ChooseInfer()({
    ... FullBox("stsd"),
    entry_count: UInt32,
})({
    boxes: ({entry_count}) => BoxLookup(
        Mp4vBox,
        Avc1Box,
        entry_count
    ),
})
();

export const SttsBox = ChooseInfer()({
    ... FullBox("stts"),
    entry_count: UInt32,
})({
    samples: ({entry_count}) => repeat(
        {
            sample_count: UInt32,
            sample_delta: UInt32,
        },
        entry_count
    ),
})
();

export const StscBox = ChooseInfer()({
    ... FullBox("stsc"),
    entry_count: UInt32,
})({
    entries: ({entry_count}) => repeat(
        {
            first_chunk: UInt32,
            samples_per_chunk: UInt32,
            sample_description_index: UInt32,
        },
        entry_count
    )
})
();

export const StszBox = ChooseInfer()({
    ... FullBox("stsz"),
    sample_size: UInt32,
    sample_count: UInt32,
})({
    sample_sizes: ({sample_size, sample_count}) => {
        if(sample_size !== 0) return [];

        return repeat(UInt32, sample_count);
    }
})
();

export const StcoBox = ChooseInfer()({
    ... FullBox("stco"),
    entry_count: UInt32,
})({
    chunk_offsets: ({entry_count}) => repeat(UInt32, entry_count)
})
();

export const StssBox = ChooseInfer()({
    ... FullBox("stss"),
    entry_count: UInt32
})({
    samples: ({entry_count}) => repeat(UInt32, entry_count)
})
();

export const CttsBox = ChooseInfer()({
    ... FullBox("ctts"),
    entry_count: UInt32
})({
    samples: ({entry_count}) => repeat({sample_count: UInt32, sample_offset: UInt32}, entry_count)
})
();


export const StblBox = {
    ... Box("stbl"),
    boxes: BoxLookup(
        StsdBox,
        SttsBox,
        StscBox,
        StszBox,
        StcoBox,
        StssBox,
        CttsBox
    ),
};

export const MinfBox = {
    ... Box("minf"),
    boxes: BoxLookup(
        VmhdBox,
        DinfBox,
        StblBox
    ),
};

export const MdiaBox = {
    ... Box("mdia"),
    boxes: BoxLookup(
        MdhdBox,
        HdlrBox,
        MinfBox
    ),
};

export const TrakBox = {
    ... Box("trak"),
    boxes: BoxLookup(
        TkhdBox,
        EdtsBox,
        MdiaBox
    ),
};

export const UdtaBox = ChooseInfer()({
    ... Box("udta"),
})({
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

export const sample_flags = bitMapping({
    reserved: 4,
    is_leading: 2,
    sample_depends_on: 2,
    sample_is_depended_on: 2,
    sample_has_redundancy: 2,
    sample_padding_value: 3,
    sample_is_non_sync_sample: 1,
    sample_degradation_priority: 16
});

export const TrexBox = {
    ... FullBox("trex"),
    track_ID: UInt32,
    default_sample_description_index: UInt32,
    default_sample_duration: UInt32,
    default_sample_size: UInt32,
    default_sample_flags: sample_flags,
};
export const MehdBox = ChooseInfer()({
    ... FullBox("mehd")
})({
    time: ({version}) => (
        version === 0 ? {
            fragment_duration: UInt32
        } :
        version === 1 ? {
            fragment_duration: UInt64
        } :
        throwValue(`Invalid version ${version}`)
    )
})
();
export const TrepBox = {
    ... FullBox("trep"),
    track_id: UInt32,
    boxes: BoxLookup(),
};
export const MvexBox = {
    ... Box("mvex"),
    boxes: BoxLookup(
        TrexBox,
        MehdBox,
        TrepBox,
    ),
};

export const MoovBox = {
    ... Box("moov"),
    boxes: BoxLookup(
        MvhdBox,
        TrakBox,
        UdtaBox,
        MvexBox
    ),
};

export const MdatBox = ChooseInfer()({
    ... Box("mdat"),
})({
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

export const FreeBox = ChooseInfer()({
    ... Box("free"),
})({
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

export const EmsgBox = ChooseInfer()({
    ... FullBox("emsg"),

    scheme_id_uri: CString,
    value: CString,
    timescale: UInt32,
    presentation_time_delta: UInt32,
    event_duration: UInt32,
    id: UInt32,

    //message_data: ArrayInfinite(UInt8),
})({
    message_data: (obj) => {
        let lenLeft = (
            assertNumber(obj.header.size)
            - assertNumber(obj.header.headerSize)
            - obj.scheme_id_uri.length - 1
            - obj.value.length - 1
            - 4 - 4 - 4 - 4 - 4
        );
        return DebugString(lenLeft);
    }
})
();

// From the ISO/IEC 14496-12:2015 version of the spec, as the ISO/IEC 14496-12:2008 one is outdated.
export const SidxReference = {
    a: bitMapping({
        reference_type: 1,
        reference_offset: 31,
    }),
    subsegment_duration: UInt32,
    SAP: bitMapping({
        starts_with_SAP: 1,
        SAP_type: 3,
        SAP_delta_time: 28,
    }),
};

export const SidxBox = ChooseInfer()({
    ... FullBox("sidx"),

    reference_ID: UInt32,
    timescale: UInt32,
})({
    times: ({version}) => (
        version === 0 ? {
            earliest_presentation_time: UInt32,
            first_offset: UInt32,
        } :
        version === 1 ? {
            earliest_presentation_time: UInt64,
            first_offset: UInt64,
        } :
        throwValue(`Invalid version ${version}`)
    ),
    reserved: UInt16,
    reference_count: UInt16,
})({
    ref: ({reference_count}) => (
        repeat(SidxReference, reference_count)
    ),
})
();

export const MfhdBox = {
    ... FullBox("mfhd"),
    sequence_number: UInt32,
};

export const TfhdBox = ChooseInfer()({
    ... Box("tfhd"),
    version: UInt8,
    flags: bitMapping({
        reserved3: 6,
        default_base_is_moof: 1,
        duration_is_empty: 1,
        reserved2: 10,
        default_sample_flags_present: 1,
        default_sample_size_present: 1,
        default_sample_duration_present: 1,
        reserved1: 1,
        sample_description_index_present: 1,
        base_data_offset_present: 1,
    }),
    track_ID: UInt32,
})({
    values: ({flags}) => (
        Object.assign({},
            flags.base_data_offset_present ? {base_data_offset: UInt64} : {},
            flags.sample_description_index_present ? {sample_description_index: UInt32} : {},
            flags.default_sample_duration_present ? {default_sample_duration: UInt32} : {},
            flags.default_sample_size_present ? {default_sample_size: UInt32} : {},
            flags.default_sample_flags_present ? {default_sample_flags: sample_flags} : {},
        )
    ),
})
();

export const TrunBox = ChooseInfer()({
    ... Box("trun"),
    version: UInt8,
    flags: bitMapping({
        reserved2: 12,
        sample_composition_time_offsets_present: 1,
        sample_flags_present: 1,
        sample_size_present: 1,
        sample_duration_present: 1,
        reserved1: 5,
        first_sample_flags_present: 1,
        reserved0: 1,
        data_offset_present: 1,
    }),
    sample_count: UInt32
})({
    values: ({flags}) => (
        Object.assign({},
            flags.data_offset_present ? {data_offset: UInt32} : {},
            flags.first_sample_flags_present ? {first_sample_flags: sample_flags} : {},
        )
    ),
})({
    sample_values: ({sample_count, flags, values}) => (
        range(0, sample_count).map(index => Object.assign({},
            flags.sample_duration_present ? {sample_duration: UInt32} : {},
            flags.sample_size_present ? {sample_size: UInt32} : {},
            values.first_sample_flags && index === 0 ? {} : flags.sample_flags_present ? {sample_flags: sample_flags} : {},
            flags.sample_composition_time_offsets_present ? {sample_composition_time_offset: UInt32} : {},
        )
    ))
})
();

export const TfdtBox = ChooseInfer()({
    ... FullBox("tfdt"),
})({
    values: ({version}) => (
        version === 0 ? {
            baseMediaDecodeTime: UInt32
        } :
        version === 1 ? {
            baseMediaDecodeTime: UInt64
        } :
        throwValue(`Invalid version ${version}`)
    )
})
();

export const TrafBox = {
    ... Box("traf"),
    boxes: BoxLookup(
        TfhdBox,
        TrunBox,
        TfdtBox,
    ),
};

export const MoofBox = {
    ... Box("moof"),
    boxes: BoxLookup(
        MfhdBox,
        TrafBox,
    ),
};

//todonext
// Create "catchall" box, so we can debug from the top-down, by making sure it works with the catchall box (which also parses to a type of any),
//  and then drill down until we find the problem.

export const RootBox = {
    boxes: BoxLookup(
        FtypBox,
        StypBox,
        MoovBox,
        MdatBox,
        FreeBox,
        EmsgBox,
        SidxBox,
        MoofBox
    ),
};



// https://www.itscj.ipsj.or.jp/sc29/open/29view/29n14632t.doc
/*
aligned(8) class AVCDecoderConfigurationRecord {
	unsigned int(8) configurationVersion = 1;
	unsigned int(8) AVCProfileIndication;
	unsigned int(8) profile_compatibility;
	unsigned int(8) AVCLevelIndication; 
	bit(6) reserved = ‘111111’b;
	unsigned int(2) lengthSizeMinusOne; 
	bit(3) reserved = ‘111’b;
	unsigned int(5) numOfSequenceParameterSets;
	for (i=0; i< numOfSequenceParameterSets;  i++) {
		unsigned int(16) sequenceParameterSetLength ;
		bit(8*sequenceParameterSetLength) sequenceParameterSetNALUnit;
	}
	unsigned int(8) numOfPictureParameterSets;
	for (i=0; i< numOfPictureParameterSets;  i++) {
		unsigned int(16) pictureParameterSetLength;
		bit(8*pictureParameterSetLength) pictureParameterSetNALUnit;
	}
	if( profile_idc  ==  100  ||  profile_idc  ==  110  ||
	    profile_idc  ==  122  ||  profile_idc  ==  144 )
	{
		bit(6) reserved = ‘111111’b;
		unsigned int(2) chroma_format;
		bit(5) reserved = ‘11111’b;
		unsigned int(3) bit_depth_luma_minus8;
		bit(5) reserved = ‘11111’b;
		unsigned int(3) bit_depth_chroma_minus8;
		unsigned int(8) numOfSequenceParameterSetExt;
		for (i=0; i< numOfSequenceParameterSetExt; i++) {
			unsigned int(16) sequenceParameterSetExtLength;
			bit(8*sequenceParameterSetExtLength) sequenceParameterSetExtNALUnit;
		}
    }
}
*/