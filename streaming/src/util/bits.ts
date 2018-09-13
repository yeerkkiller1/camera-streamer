// Everything works on 53 bit integers
type Bit = 0|1;

export function getBits(value: number): Bit[] {
    if(!Number.isInteger(value)) {
        throw new Error(`Value must be an integer ${value}`);
    }

    let bits: Bit[] = [];
    let mask = 1;
    for(let i = 0; i < 53; i++) {
        let bit: Bit = (value & mask) !== 0 ? 1 : 0;
        bits.push(bit);
        mask *= 2;
    }
    return bits;
}

export function getNumber(bits: Bit[]): number {
    let value = 0;
    let mask = 1;
    for(let i = 0; i < 53; i++) {
        if(bits[i]) {
            value += mask;
        }
        mask *= 2;
    }
    return value;
}