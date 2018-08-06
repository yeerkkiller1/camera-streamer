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