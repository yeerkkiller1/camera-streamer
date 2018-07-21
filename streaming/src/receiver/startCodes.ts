import { PChanReceive } from "controlFlow/pChan";
import { TransformChannelAsync, Range } from "pchannel";

// Okay, so because the concept of "start codes" is such a shitty idea, here is something that has to happen.
// IF you send a large piece of data, that happens to end in a 0, we cannot send this zero until we get another piece of
//  data. If you close the stream we can (and should) send it, but if you just pause, or don't know the connection is ended...
//  we will hang, waiting for more data. Ugh... So if a few trailing bytes appear to lag, that's why.

/** Emits raw nals, without start codes or start lengths. */
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
                    //console.log(`Zeros from last ${zerosFromLast}`);
                    input = Buffer.concat([new Buffer(Range(0, zerosFromLast).map(() => 0)), input]);
                }

                function addCurrent(start: number, end: number) {
                    if(start >= end) {
                        //console.log(`Ignoring empty add`);
                        return;
                    }
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
                            let message = `Too many zeroBytes in a row. Should never have more than 3, were ${zeroBytes}`;
                            throw new Error(message);
                        }
                        continue;
                    }

                    if(b === 1 && (zeroBytes === 3 || zeroBytes === 2)) {
                        let curEnd = i - zeroBytes;
                        addCurrent(curStart, curEnd);
                        emitCurrentBuffers();
                        
                        curStart = i + 1;
                    }
                    zeroBytes = 0;
                }

                let end = input.length - zeroBytes;
                zerosFromLast = zeroBytes;

                //console.log(`Adding from ${curStart} to ${end}`);
                addCurrent(curStart, end);
            }

            if(zerosFromLast > 0) {
                curBuffers.push(new Buffer(Range(0, zerosFromLast).map(() => 0)));
            }

            emitCurrentBuffers();
        }
    )
);