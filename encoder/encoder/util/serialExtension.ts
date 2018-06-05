function p2(str: string) {
    while(str.length < 2) {
        str = "0" + str;
    }
    return str;
}
export function readUInt64BE(buffer: Buffer, pos: number) {
    let high = buffer.readUInt32BE(pos);
    let low = buffer.readUInt32BE(pos + 4);

    let result = high * 4294967296.0 + low;
    if(result > Number.MAX_SAFE_INTEGER || result < 0) {
        throw new Error(`Read int64 value outside of valid range javascript can represent. Read ${result}, it must be under ${Number.MAX_SAFE_INTEGER}. High ${high}, low ${low}`);
    }
    return result;
}
export function writeUInt64BE(buffer: Buffer, pos: number, value: number): void {
    if(value > Number.MAX_SAFE_INTEGER || value < 0) {
        throw new Error(`Write int64 value outside of valid range javascript can represent. Write ${value}, it must be under ${Number.MAX_SAFE_INTEGER}.`);
    }

    buffer.writeUInt16BE(0, 0);
    buffer.writeUIntBE(value, pos + 2, 6);
}

export function textToUInt32(text: string) {
    if(text.length !== 4) {
        throw new Error(`Expected text of length 4. Received ${text}`);
    }

    return text.charCodeAt(3) + text.charCodeAt(2) * 256 + text.charCodeAt(1) * 256 * 256 + text.charCodeAt(0) * 256 * 256 * 256;
}
export function textFromUInt32(num: number) {
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