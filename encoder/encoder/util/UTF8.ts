export function decodeUTF8BytesToString(bytes: number[]): string {
    let encodedString = "";
    for(let i = 0; i < bytes.length; i++) {
        let b = bytes[i];
        encodedString += "%" + b.toString(16);
    }
    return decodeURIComponent(encodedString);
}
export function encodeAsUTF8Bytes(str: string): number[] {
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

export function debugString(bytes: number[]): string {
    let str = "";
    for(let i = 0; i < bytes.length; i++) {
        let byte = bytes[i];
        if(byte === 0) {
            str += "Ө";// "\\0";
        } else if(byte === 13) {
            str += "П";
        } else if(byte === 10) {
            str += "ϵ";
        } else {
            str += String.fromCharCode(byte);
        }
    }
    return str;
}

export function debugStringToRawBytes(str: string): number[] {
    let bytes: number[] = [];
    for(let i = 0; i < str.length; i++) {
        let ch = str[i];
        let byte = ch.charCodeAt(0);
        if(ch === "Ө") {
            byte = 0;
        } else if(ch === "П") {
            byte = 13;
        } else if(ch === "ϵ") {
            byte = 10;
        }
        bytes[i] = byte;
    }
    return bytes;
}