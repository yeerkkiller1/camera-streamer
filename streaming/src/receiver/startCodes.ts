import { PChanReceive } from "controlFlow/pChan";
import { TransformChannelAsync, Range } from "pchannel";


export const splitByStartCodes: (startCodeData: PChanReceive<Buffer>) => PChanReceive<Buffer> = (
    TransformChannelAsync<Buffer, Buffer>(
        async ({inputChan, outputChan}) => {
            // parsing start codes like this takes about 1.5ms per frame on a 5 dollar digital ocean instance. Which... should be fast enough.

            let curBuffers: Buffer[] = [];

            function emitCurrentBuffers() {
                if(curBuffers.length === 0) return;

                outputChan.SendValue(Buffer.concat(curBuffers));
                curBuffers = [];
            }

            let zerosFromLast = 0;

            while(true) {
                let zeroBytes = 0;

                let input: Buffer;
                try {
                    input = await inputChan.GetPromise();
                } catch(e) {
                    if(inputChan.IsClosedError(e)) {
                        break;
                    }
                    throw e;
                }

                if(zerosFromLast > 0) {
                    input = Buffer.concat([new Buffer(Range(0, zerosFromLast).map(() => 0)), input]);
                }

                function addCurrent(start: number, end: number) {
                    if(start >= end) return;
                    let cur = input.slice(start, end);
                    curBuffers.push(cur);
                }

                let curStart = 0;
                // See if input contains an end, or multiple
                for(let i = 0; i < input.length; i++) {
                    let b = input[i];
                    if(b === 0) {
                        zeroBytes++;
                        // The file will escape long sequences of 0s, so this is okay, and should never result in zeroBytes > 3
                        if(zeroBytes > 3) {
                            throw new Error(`Too many zeroBytes in a row. Should never have more than 3, were ${zeroBytes}`);
                        }
                        continue;
                    }

                    if(b === 1 && (zeroBytes === 3 || zeroBytes === 2)) {
                        let curEnd = i - zeroBytes;
                        addCurrent(curStart, curEnd);
                        emitCurrentBuffers();
                        
                        curStart = i + 1;
                        zeroBytes = 0;
                    }
                }

                let end = input.length - zeroBytes;
                zerosFromLast = zeroBytes;

                addCurrent(curStart, end);
            }

            if(zerosFromLast > 0) {
                curBuffers.push(new Buffer(Range(0, zerosFromLast).map(() => 0)));
            }

            emitCurrentBuffers();
        }
    )
);