import { SerialObjectPrimitive, ReadContext, WriteContext, HandlesBitOffsets, SerialObject, TemplateToObject, SerialPrimitiveName } from "./SerialTypes";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { textFromUInt32, textToUInt32 } from "./util/serialExtension";
import { decodeUTF8BytesToString, encodeAsUTF8Bytes, debugString, debugStringToRawBytes } from "./util/UTF8";
import { sum } from "./util/math";
import { mapObjectValuesKeyof, range } from "./util/misc";
//import { parseObject } from "./BinaryCoder";

export type Bit = 0 | 1;

export function IntN(bytes: number, signed: boolean): SerialObjectPrimitive<number> {
    if(bytes > 8 || bytes <= 0) {
        throw new Error(`Invalid number of bytes ${bytes}`);
    }
    return {
        read(parseContext: ReadContext) {
            let { buffer, pPos } = parseContext;

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
        },
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

            return new LargeBuffer([buffer]);
        }
    };
}

export const UInt8 = IntN(1, false);
export const UInt16 = IntN(2, false);
export const UInt24 = IntN(3, false);
export const UInt32 = IntN(4, false);
export const UInt64 = IntN(8, false);

export const Int16 = IntN(2, true);
export const Int32 = IntN(4, true);
export const Int64 = IntN(8, true);

export function NumberShifted(primitive: SerialObjectPrimitive<number>, shiftAmount: number): SerialObjectPrimitive<number> {
    return {
        read(context) {
            return primitive.read(context) / shiftAmount;
        },
        write(context) {
            let value = Math.round(context.value * shiftAmount);
            return primitive.write({ ... context, value });
        }
    };
}

export const UInt32String: SerialObjectPrimitive<string> = {
    read: (context) => textFromUInt32(UInt32.read(context)),
    write: (context) => UInt32.write({ ...context, value: textToUInt32(context.value)}),  
};

export function RawData(size: number): SerialObjectPrimitive<LargeBuffer> {
    return {
        read(context) {
            let buf = context.buffer.slice(context.pPos.v, context.pPos.v + size);
            context.pPos.v += size;
            return buf;
        },
        write(context) {
            return context.value;
        }
    };
}

export const CString: SerialObjectPrimitive<string> = {
    read({pPos, buffer}) {
        let bytes: number[] = [];
        while(true) {
            let b = buffer.readUIntBE(pPos.v, 1);
            pPos.v++;
            if(b === 0) break;
            bytes.push(b);
        }

        return decodeUTF8BytesToString(bytes);
    },
    write(context) {
        let value = context.value;
        let unicodeBytes = encodeAsUTF8Bytes(value);

        let output = new Buffer(unicodeBytes.length + 1);
        for(let i = 0; i < unicodeBytes.length; i++) {
            let byte = unicodeBytes[i];
            output.writeUInt8(byte, i);
        }

        return new LargeBuffer([output]);
    }
};

export function DebugString(length: number): SerialObjectPrimitive<string> {
    return {
        read({pPos, buffer}) {
            let bytes: number[] = [];
            for(let i = 0; i < length; i++) {
                let b = buffer.readUIntBE(pPos.v, 1);
                pPos.v++;
                bytes.push(b);
            }

            return debugString(bytes);
        },
        write(context) {
            let value = context.value;
            let bytes = debugStringToRawBytes(value);

            let output = new Buffer(bytes);

            return new LargeBuffer([output]);
        }
    };
};

export function DebugStringRemaining(): SerialObjectPrimitive<string> {
    return {
        read({pPos, buffer, end}) {
            let length = end - pPos.v;
            let bytes: number[] = [];
            for(let i = 0; i < length; i++) {
                let b = buffer.readUIntBE(pPos.v, 1);
                pPos.v++;
                bytes.push(b);
            }

            return debugString(bytes);
        },
        write(context) {
            let value = context.value;

            let output = new Buffer(value.length);
            for(let i = 0; i < output.length; i++) {
                let byte = output[i];
                output.writeUInt8(byte, i);
            }

            return new LargeBuffer([output]);
        }
    };
};

export function CallOnReadPos(read: (pos: number) => void): SerialObjectPrimitive<void> {
    return {
        read({pPos, buffer, end}) {
            read(pPos.v);
        },
        write(context) {
            return new LargeBuffer([]);
        }
    };
};


/** Big endian */
export function bitsToByte(bits: number[]): number {
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

/** Big endian */
export function byteToBits(byteIn: number, bitCount = 8): (0|1)[] {
    if(byteIn === 0 && bitCount === 0) {
        return [];
    }

    if(bitCount > 52) {
        throw new Error(`Javascript doesn't support more than 52 bit numbers. A ${bitCount} number was requested.`);
    }

    let byte = byteIn;
    let bits: (0|1)[] = [];
    let mask =  Math.pow(2, bitCount - 1);
    if(byte >= mask * 2) {
        throw new Error(`Tried to get ${bitCount} bits from ${byte}, but that number has more bits than requested!`);
    }
    while(mask) {
        let bit = byte & mask;
        bits.push(bit === 0 ? 0 : 1);
        mask = Math.floor(mask / 2);
    }
    return bits;
}

type BitCount = number;
/** The return type can actually be the same, as a BitCount is a number, and the results are numbers, even though the meaning of the numbers are entirely different.
 *      The bitMap is in big endian order.
*/
export function bitMapping<T extends { [key: string]: BitCount }>(bitMap: T): SerialObjectPrimitive<T> {
    let totalBits = sum(Object.values(bitMap));
    if(totalBits % 8 !== 0) {
        throw new Error(`Bit map not divisible by 8. A bit mapping must align with bytes, or else we can't handle it. Mapping had ${totalBits} bits, was ${JSON.stringify(bitMap)}`);
    }
    let bytes = totalBits / 8;
    return {
        read({buffer, pPos}) {
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
        write(context) {
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

            return new LargeBuffer([buffer]);
        }
    };
}

export const languageBaseBitMapping = bitMapping({
    pad: 1,
    langChar0: 5,
    langChar1: 5,
    langChar2: 5,
});
export const LanguageParse: SerialObjectPrimitive<string> = {
    read(context: ReadContext): string {
        let obj = languageBaseBitMapping.read(context);

        return (
            String.fromCharCode(0x60 + obj.langChar0)
            + String.fromCharCode(0x60 + obj.langChar1)
            + String.fromCharCode(0x60 + obj.langChar2)
        );
    },
    write(context: WriteContext<string>): LargeBuffer {
        if(context.value.length !== 3) {
            throw new Error(`Expected language to have a length of 3. Was: ${context.value}`);
        }
        return languageBaseBitMapping.write({
            ... context,
            value: {
                pad: 0,
                langChar0: context.value.charCodeAt(0) - 0x60,
                langChar1: context.value.charCodeAt(1) - 0x60,
                langChar2: context.value.charCodeAt(2) - 0x60,
            }
        })
    }
};


export const VoidParse: SerialObjectPrimitive<void> = {
    read(context: ReadContext): void { },
    write(context: WriteContext<void>): LargeBuffer {
        return new LargeBuffer([]);
    }
};

export function PeekPrimitive<T>(primitive: SerialObjectPrimitive<T>): SerialObjectPrimitive<T> {
    return {
        read(context: ReadContext): T {
            let pos = context.pPos.v;
            let result = primitive.read(context);
            context.pPos.v = pos;
            return result;
        },
        write(context: WriteContext<T>): LargeBuffer {
            return new LargeBuffer([]);
        }
    };
}


// Big endian endian
export function readBit(context: ReadContext): 0|1 {
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

export const UExpGolomb: SerialObjectPrimitive<number> = {
    [SerialPrimitiveName]: "UExpGolomb",
    [HandlesBitOffsets]: true,
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

        //console.log(`UExpGolomb Read value ${val}, magnitude ${magnitude} bits end ${bits.join("")}, key ${context.debugKey}`);

        return val;
    },
    write(context) {
        if(context.value === 0) {
            return new LargeBuffer([[1]]);
        }
        let bits: Bit[] = [];

        let magnitude = ~~(Math.log2(context.value + 1));

        for(let i = 0; i < magnitude; i++) {
            bits.push(0);
        }
        bits.push(1);

        let sumOffset = (1 << magnitude) - 1;
        let val = context.value - sumOffset;

        let valBits = byteToBits(val, magnitude);
        for(let bit of valBits) {
            bits.push(bit);
        }

        //console.log(`UExpGolomb Writing value ${context.value}, magnitude ${magnitude} bits ${bits.join("")}`);

        return new LargeBuffer([bits]);
    }
};

export const SExpGolomb: SerialObjectPrimitive<number> = {
    [HandlesBitOffsets]: true,
    read(context) {
        let base = UExpGolomb.read(context);
        if(base % 2 === 0) {
            return -base / 2;
        } else {
            return (base + 1) / 2;
        }
    },
    write(context) {
        let signedValue = context.value;
        let unsignedValue = signedValue <= 0 ? -signedValue * 2 : signedValue * 2 - 1;
        return UExpGolomb.write({
            ...context,
            value: unsignedValue
        })
    }
};

export const BitPrimitive: SerialObjectPrimitive<0|1> = {
    [HandlesBitOffsets]: true,
    read(context) {
        return readBit(context);
    },
    write(context) {
        return new LargeBuffer([[context.value]]);
    }
};
export function BitPrimitiveN(N: number): SerialObjectPrimitive<(0|1)[]> {
    return {
        [HandlesBitOffsets]: true,
        read(context) {
            return range(0, N).map(() => readBit(context));
        },
        write(context) {
            return new LargeBuffer([context.value]);
        }
    };
}

export function IntBitN(N: number): SerialObjectPrimitive<number> {
    return {
        [HandlesBitOffsets]: true,
        read(context) {
            let bits = range(0, N).map(() => readBit(context));
            return bitsToByte(bits);
        },
        write(context) {
            return new LargeBuffer([byteToBits(context.value, N)]);
        }
    };
}

export const AlignmentBits: SerialObjectPrimitive<(0|1)[]> = {
    [HandlesBitOffsets]: true,
    read(context) {
        if(context.bitOffset === 0) {
            return [];
        }
        let bits = 8 - context.bitOffset;
        return range(0, bits).map(() => readBit(context));
    },
    write(context) {
        return new LargeBuffer([context.value]);
    }
}

export function RemainingData<T>(primitive: SerialObjectPrimitive<T>): SerialObjectPrimitive<T[]> {
    return {
        [HandlesBitOffsets]: true,
        [SerialPrimitiveName]: "RemainingData",
        read(context) {
            function getBitCount() {
                return context.pPos.v * 8 + context.bitOffset;
            }
            let results: T[] = [];
            while(getBitCount() < context.endBits) {
                let result = primitive.read(context);
                results.push(result);
            }

            //console.log(`Read ${results.length} bits`)
            
            return results;
        },
        write(context) {
            let results = context.value;
            let bufs = results.map(result => primitive.write({...context, value: result}));

            let result = new LargeBuffer(bufs);

            //console.log(`Wrote ${LargeBuffer.GetBitCount(result)}`);

            return result;
        }
    };
}

export const RemainingDataRaw: SerialObjectPrimitive<LargeBuffer> = {
    [SerialPrimitiveName]: "RemainingDataRaw",
    read(context) {
        let data = context.buffer.slice(context.pPos.v, context.end);
        context.pPos.v = context.end;
        return data;
    },
    write(context) {
        return context.value;
    }
};