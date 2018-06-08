// Generic parsing, based off of pseudo language
// This is an ISOBMFF parser (https://en.wikipedia.org/wiki/ISO_base_media_file_format)
// http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
// https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
// https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-00#page-9
// https://developer.apple.com/streaming/HLS-WWDC-2017-Preliminary-Spec.pdf
// https://mpeg.chiariglione.org/standards/mpeg-4/iso-base-media-file-format/text-isoiec-14496-12-5th-edition
// https://mpeg.chiariglione.org/standards/mpeg-4/carriage-nal-unit-structured-video-iso-base-media-file-format/text-isoiec-14496-1
// https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute

// Hmm... another example of an implementation: https://github.com/madebyhiro/codem-isoboxer

import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray, throwValue } from "./util/type";
import { keyBy, mapObjectValues, repeat, flatten } from "./util/misc";
import { writeFileSync } from "fs";
import { basename } from "path";
import { decodeUTF8BytesToString, encodeAsUTF8Bytes } from "./util/UTF8";
import { sum } from "./util/math";

import * as Jimp from "jimp";

// #region Serial types
const BoxLookupSymbol = Symbol();
type S = SerialObject;
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S, T8 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7, v8: T8, count?: number): (T1|T2|T3|T4|T5|T6|T7|T8)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7, count?: number): (T1|T2|T3|T4|T5|T6|T7)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, count?: number): (T1|T2|T3|T4|T5|T6)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, count?: number): (T1|T2|T3|T4|T5)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, count?: number): (T1|T2|T3|T4)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S>(v1: T1, v2: T2, v3: T3, count?: number): (T1|T2|T3)[];
function BoxLookup<T1 extends S, T2 extends S>(v1: T1, v2: T2, count?: number): (T1|T2)[];
function BoxLookup<T1 extends S>(v1: T1, count?: number): T1[];
function BoxLookup(count?: number): never[];
function BoxLookup(...arr: any[]): any[] {
    let count: number|undefined = undefined;
    if(arr.length > 0) {
        let arrCount = arr[arr.length - 1];
        if(typeof arrCount === "number") {
            count = arrCount;
            arr = arr.slice(0, -1);
        }
    }
    (arr as any)[BoxLookupSymbol] = count;
    return arr;
}
function IsBoxLookup(arr: SerialObjectChild[]): boolean {
    return BoxLookupSymbol in arr;
}
function GetBoxCount(arr: SerialObjectChild[]): number|undefined {
    return (arr as any)[BoxLookupSymbol];
}

const ArrayInfiniteSymbol = Symbol();
function ArrayInfinite<T extends SerialObjectChild>(element: T): T[] {
    let arr = [element];
    (arr as any)[ArrayInfiniteSymbol] = ArrayInfiniteSymbol;
    return arr;
}
function IsArrayInfinite(arr: SerialObjectChild[]): boolean {
    return ArrayInfiniteSymbol in arr;
}

type P<T> = { v: T };
type R<T> = { key: string; parent: { [key: string]: T } };

interface SerialObject<CurObject = any> {
    [key: string]: (
        SerialObjectChild<CurObject>
        // Undefined, as apparent if we have a function that sometimes returns a parameter, it is inferred to be
        //  in the returned object, but as optional and undefined. So adding undefined here makes chooseBox infinitely
        //  more useful (as it means it doesn't have to specify it's return type every time we have a chooseBox).
        | undefined
    );
}
type SerialObjectTerminal<CurObject = any> = SerialObjectPrimitive | SerialObjectChoose<CurObject>;
type SerialObjectChildBase<CurObject = any> = SerialObject<CurObject> | SerialObjectTerminal<CurObject>;
type SerialObjectChild<CurObject = any> = SerialObjectChildBase<CurObject> | SerialObjectChildBase<CurObject>[];

interface ReadContext {
    buffer: LargeBuffer;
    pPos: P<number>;
}
interface WriteContext<T = Types.AnyAll> {
    value: T;
    // Gets the size (in bytes) in the current object after our key. Also prevents our value or key from being in the curObject for the siblings after us.
    //  Ugh... really just for the box headers. Very unfortunate. I think the more correct way to do this would be to allow rearranging the
    //  children depending on if it is read/write. On read we put them at the beginning, on write we call them at the end, and then
    //  move their result to the beginning (giving them the data from the previous entries, which is okay). But for what we need now...
    //  this should be sufficient.
    getSizeAfter(): number;
}

const BoxSymbol = Symbol();
interface SerialObjectPrimitive<T = Types.AnyAll> {
    [BoxSymbol]?: string;
    read(context: ReadContext): T;
    write(context: WriteContext<T>): LargeBuffer;
}

type ChooseContext<CurObject> = CurObject;
/*
interface ChooseContext<CurObject> {
    // Has the values parsed in the keys before us. Use ChooseInfer to populate this properly.
    curObject: CurObject;

    buffer: LargeBuffer;
    pos: number;
}
*/
type SerialObjectChoose<CurObject = any> = (context: ChooseContext<CurObject>) => SerialObjectChild<CurObject>;

// #region ChooseInfer types

// Eh... the choose function causes problem. It says it is recursive. I could probably fix this with manual recursion (just spitting out the
//  recursive path a lot of times, and then ending the final entry with never), but... let's try without that, and maybe I'll think of a way
//  to get this to work without that.
//  - Actually, at least map primitives to output
//never;//SerialObjectChildToOutput<ReturnType<T>>;
type SerialObjectChooseToOutput<T extends SerialObjectChoose> = (
    ReturnType<T> extends SerialObjectPrimitive ? SerialObjectPrimitiveToOutput<ReturnType<T>> :
    never
);

const SerialPrimitiveMark = Symbol();
type SerialPrimitiveMark = typeof SerialPrimitiveMark;

type SerialObjectPrimitiveToOutput<T extends SerialObjectPrimitive = SerialObjectPrimitive> = {
    primitive: T;
    value: ReturnType<T["read"]>;
    [SerialPrimitiveMark]: true
};
function isIntermediatePrimitive<T extends SerialObjectPrimitive>(obj: SerialObjectChildBaseToOutput<any>): obj is SerialObjectPrimitiveToOutput<T> {
    return SerialPrimitiveMark in obj;
}

type SerializeTerminalToOutput<T extends SerialObjectTerminal> = (
    T extends SerialObjectChoose ? SerialObjectChooseToOutput<T> :
    T extends SerialObjectPrimitive ? SerialObjectPrimitiveToOutput<T> :
    never
);

type SerialObjectChildMap<T extends SerialObject[""]> = (
    T extends SerialObjectChild ? SerialObjectChildToOutput<T> : never
);

type SerialObjectChildBaseToOutput<T extends SerialObjectChildBase = SerialObjectChildBase> = (
    T extends SerialObjectTerminal ? SerializeTerminalToOutput<T> :
    T extends SerialObject ? { [key in keyof T]: SerialObjectChildMap<T[key]> } :
    never
);

type ForceExtendsType<T, K> = T extends K ? T : K;
type GetSerialObjectChildBaseArray<T extends SerialObjectChildBase[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildBase>
);

type SerialObjectChildToOutput<T extends SerialObjectChild = SerialObjectChild> = (
    T extends SerialObjectChildBase ? SerialObjectChildBaseToOutput<T> :
    T extends SerialObjectChildBase[] ? SerialObjectChildBaseToOutput<GetSerialObjectChildBaseArray<T>>[] :
    never
);

type SerialObjectOutput<T extends SerialObject<any> = SerialObject> = {
    [key in keyof T]: SerialObjectChildMap<T[key]>;
};



type SerializeIntermediateTerminalToOutput<T extends SerializeTerminalToOutput<SerialObjectTerminal>> = (
    T["value"]
);

type SerialIntermediateChildBaseToOutput<T extends SerialObjectChildBaseToOutput = SerialObjectChildBaseToOutput> = (
    T extends SerializeTerminalToOutput<SerialObjectTerminal> ? SerializeIntermediateTerminalToOutput<T> :
    T extends SerialObjectOutput<SerialObject> ? { [key in keyof T]: SerialIntermediateChildToOutput<T[key]> } :
    never
);

type GetSerialIntermediateChildBaseArray<T extends SerialObjectChildToOutput<SerialObjectChild>[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildToOutput<SerialObjectChild>>
);
type SerialIntermediateChildToOutput<T extends SerialObjectChildToOutput<SerialObjectChild>> = (
    T extends SerialObjectChildBaseToOutput ? SerialIntermediateChildBaseToOutput<T> :
    T extends SerialObjectChildBaseToOutput[] ? SerialIntermediateChildBaseToOutput<GetSerialIntermediateChildBaseArray<T>>[] :
    never
);
type SerialIntermediateToFinal<T extends SerialObjectOutput = SerialObjectOutput> = {
    [key in keyof T]: SerialIntermediateChildToOutput<T[key]>;
};

// #endregion

interface MultiStageContinue<CurSerialObject extends SerialObject, CurSerialOutput> {
    (): CurSerialObject;
    <NextSerialObject extends SerialObject<CurSerialOutput>>(
        next: NextSerialObject
    ): MultiStageContinue<CurSerialObject & NextSerialObject, CurSerialOutput & SerialIntermediateToFinal<SerialObjectOutput<NextSerialObject>>>;
}

/**
    ChooseInfer()
    ({ x: UInt32 })
    ({ y: UInt32String })
    ({
        k: (t) => {
            if(t.curObject.x === 0) {
                return { k: UInt32 };
            } else {
                return { y: UInt64 };
            }
            t.curObject.y;
            return null as any;
        }
    });
*/
function ChooseInfer(): MultiStageContinue<{}, {}> {
    let curObject = {};

    function multiStageContinue(): SerialObject;
    function multiStageContinue(next: SerialObject): MultiStageContinue<any, any>;
    function multiStageContinue(next?: SerialObject): MultiStageContinue<any, any>|SerialObject {
        if(next === undefined) {
            return curObject;
        }

        Object.assign(curObject, next);
        
        return multiStageContinue;
    }

    return multiStageContinue;
}


function isSerialPrimitive(child: SerialObject[""]): child is SerialObjectPrimitive {
    return child !== undefined && !isArray(child) && typeof child === "object" && typeof (child as any).read === "function";
}
function isSerialChoose(child: SerialObject[""]): child is SerialObjectChoose {
    return child !== undefined && !isArray(child) && typeof child === "function";
}
function isSerialObject(child: SerialObject[""]): child is SerialObject {
    return child !== undefined && !isArray(child) && !isSerialPrimitive(child) && !isSerialChoose(child);
}


function cleanup(codeAfter: () => void, code: () => void) {
    try {
        code();
    } finally {
        codeAfter();
    }
}

// #endregion

/*
interface SerialObject<CurObject = void> {
    [key: string]: (
        SerialObjectChild<CurObject>
        // Undefined, as apparent if we have a function that sometimes returns a parameter, it is inferred to be
        //  in the returned object, but as optional and undefined. So adding undefined here makes chooseBox infinitely
        //  more useful (as it means it doesn't have to specify it's return type every time we have a chooseBox).
        | undefined
    );
}
type SerialObjectTerminal<CurObject = void> = SerialObjectPrimitive | SerialObjectChoose<CurObject>;
type SerialObjectChildBase<CurObject = void> = SerialObject<CurObject> | SerialObjectTerminal<CurObject>;
type SerialObjectChild<CurObject = void> = SerialObjectChildBase<CurObject> | SerialObjectChildBase<CurObject>[];
*/

function parseBytes<T extends SerialObject>(buffer: LargeBuffer, rootObjectInfo: T): SerialObjectOutput<T> {
    let isRoot = true;

    let debugPath: string[] = [];
    let pPos: P<number> = { v: 0 };

    let output: R<SerialObjectOutput<T>> = { key: "v", parent: {v: {} as any} };
    parseObject(rootObjectInfo, output, buffer.getLength());
    return output.parent.v;

    function debugError(message: string) {
        return new Error(`${JSON.stringify(String(message))} in path ${debugPath.join(".")} at position ${pPos.v}`);
    }

    function parseObject(object: SerialObject, output: R<SerialObjectOutput<SerialObject>>, end: number): void {
        /** True if our end should end our own object (so we should warn if we didn't read enough bytes). */
        let isEndSelf = false;

        if(isRoot) {
            isRoot = false;
            isEndSelf = true;
        }

        let outputObject: SerialObjectOutput<SerialObject> = {} as any;
        output.parent[output.key] = outputObject;

        let startPos = pPos.v;

        let ourKeyIndex = debugPath.length - 1;
        function setOurKey(ourKey: string) {
            debugPath[ourKeyIndex] = ourKey;
        }
       
        let isLastKey = false;
        let lastKey: string;
        {
            let keys = Object.keys(object);
            lastKey = keys[keys.length - 1];
        }
        for(let key in object) {
            if(key === lastKey) {
                isLastKey = true;
            }
            debugPath.push(key);
            cleanup(() => debugPath.pop(), () => {
                let child: SerialObject[""] = object[key];

                if(child === undefined) {
                    throw debugError(`Child is undefined.`);
                }

                parseChild(child, { key, parent: outputObject });
            });
        }

        if(isEndSelf) {
            if(pPos.v < end) {
                console.warn(debugError(`Did not read all box bytes. Read ${pPos.v - startPos}, should have read ${end - startPos}`).message);
                pPos.v = end;
            }
            if(pPos.v > end) {
                console.warn(debugError(`Read too far. Read ${pPos.v - startPos}, should have read ${end - startPos}`).message);
            }
        }

        function parseChildBase(child: SerialObjectChildBase, output: R<SerialObjectChildBaseToOutput>): void {
            if(isSerialChoose(child)) {
                let chooseContext: ChooseContext<void> = getFinalOutput(outputObject) as any as void;
                /*
                let chooseContext: ChooseContext<void> = {
                    // Hmm... this isn't efficient... but we should have that many chooses, right? Or at least, not chooses too close to the root,
                    //  so hopefully this doesn't become exponential.
                    curObject: getFinalOutput(outputObject) as any,
                    buffer: buffer,
                    pos: pPos.v,
                };
                */
                let choosenChild = child(chooseContext);
                parseChild(choosenChild, output);
            }
            else if(isSerialPrimitive(child)) {
                let outputValue: SerialObjectPrimitiveToOutput<typeof child> = {
                    primitive: child,
                    value: {} as any,
                    [SerialPrimitiveMark]: true
                };

                let context: ReadContext = {
                    buffer,
                    pPos
                };
                try {
                    outputValue.value = child.read(context);
                } catch(e) {
                    throw debugError(e);
                }

                // TODO: After we parse the value, change the last key to use the type from the box, instead of the property key.
                // TODO: Use the size info from the box info to warn when we don't completely parse the children.
                //  parseChildBase should have an output param that can set the end, which we also check when reading to see if we overrun.
                //  Also, we should pass this as a reaadonly to parseChild and parseObject.
                if(BoxSymbol in child) {
                    let boxInfo = outputValue.value as { size: number; type: string; };
                    isEndSelf = true;
                    end = startPos + boxInfo.size;
                    setOurKey(child[BoxSymbol] || "not possible");
                }

                output.parent[output.key] = outputValue;
            }
            else if(isSerialObject(child)) {
                // Eh... I don't know. We have to any cast, as the output of parseObject doesn't work with parseChildBase. But it should.
                return parseObject(child, output as any, end);
            }
            else {
                let childIsFinished: never = child;
                throw debugError(`Cannot handle child ${child}`);
            }
        }

        function parseChild(child: SerialObjectChild<void>, output: R<SerialObjectChildToOutput<SerialObjectChild>>): void {
            if(isArray(child)) {
                let arr: SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>[] = [];
                output.parent[output.key] = arr;

                if(IsArrayInfinite(child)) {

                    if(!isEndSelf) {
                        throw debugError(`Key says to read until end of box, but we found no box header. So... this won't work, we don't know where to stop reading.`);
                    }
                    if(!isLastKey) {
                        throw debugError(`Key says to read until end of box, but we there are keys after this key, so when will we read them? Other keys: ${Object.keys(object).join(", ")}`);
                    }

                    if(child.length !== 1) {
                        throw new Error(`Can only repeat array with 1 entry, received ${child.length} entries`);
                    }

                    let element = child[0];

                    let time = +new Date();
                    let index = 0;
                    while(pPos.v < end) {
                        parseChildBase(element, { key: index as any as string, parent: arr as any });
                        index++;
                    }

                    time = +new Date() - time;
                    if(time > 100) {
                        console.warn(debugError(`Parse took ${time}ms`));
                    }
                }
                else if(IsBoxLookup(child)) {

                    let count = GetBoxCount(child);

                    if(count === undefined && !isEndSelf) {
                        throw debugError(`Key says to read until end of box, but we found no box header. So... this won't work, we don't know where to stop reading.`);
                    }
                    if(count === undefined && !isLastKey) {
                        throw debugError(`Key says to read until end of box, but we there are keys after this key, so when will we read them? Other keys: ${Object.keys(object).join(", ")}`);
                    }

                    // Not really an array. Just a set of children that may exist, infinitely.

                    // We need to verify all children have a property that is BoxSymbol, and then use the value of that to determine which parser to use
                    //  Unless a parser has a type BoxAnyType. Then it matches everything (and it should be the only parser).

                    let childObjects = child.filter(isSerialObject);
                    if(childObjects.length !== child.length) {
                        throw debugError(`Array is marked as lookup, but has some children that are not objects.`);
                    }

                    let childTypes = childObjects.map(childObject => {
                        let firstChild = Object.values(childObject)[0];
                        if(!isSerialPrimitive(firstChild)) {
                            throw debugError(`Object in BoxLookup doesn't have a box type as a first child. All objects in BoxLookup should have a box type as their first child.`);
                        }
                        
                        let boxType = firstChild && firstChild[BoxSymbol] || undefined;
                        if(boxType === undefined) {
                            console.error(firstChild);
                            throw debugError(`First child in Object in BoxLookup doesn't have a box type.`);
                        }
                        return {
                            boxType,
                            childObject
                        };
                    });

                    let boxLookup = mapObjectValues(keyBy(childTypes, x => x.boxType), x => x.childObject);

                    if(BoxAnyType in boxLookup) {
                        if(Object.keys(boxLookup).length > 1) {
                            throw debugError(`Box lookup has a box that matches any type, BUT also has boxes that match types. This won't work, which one do you want to match? Box types: ${Object.keys(boxLookup).join(", ")}`);
                        }
                    }

                    count = count !== undefined ? count : Number.MAX_SAFE_INTEGER;

                    let index = 0;
                    while(pPos.v < end && count --> 0) {
                        debugPath.push(index.toString());

                        let type: string;
                        let boxEnd: number;
                        {
                            // All boxes should have their box type as their first child. So we can parse the box type easily, without calling anything on the children.
                            let context: ReadContext = {
                                buffer,
                                // Copy pPos, as this read is just to get the box, and shouldn't advance the position.
                                pPos: { ... pPos }
                            };
                            let boxObj = Box(BoxAnyType).header.read(context);
                            type = boxObj.type as string;

                            if(boxObj.size === 0) {
                                throw debugError(`Definitely invalid box of size 0.`)
                            }

                            boxEnd = pPos.v + boxObj.size;
                        }

                        if(!(type in boxLookup) && BoxAnyType in boxLookup) {
                            type = BoxAnyType;
                        }

                        if(!(type in boxLookup)) {
                            console.warn(debugError(`Unexpected box type ${type}. Expected one of ${Object.keys(boxLookup).join(", ")}`).message);
                            // Fill the entry with something, so we don't throw later.
                            arr[index] = {};
                            pPos.v = boxEnd;
                        } else {
                            let box = boxLookup[type];
                            parseChildBase(box, { key: index as any as string, parent: arr as any });
                        }
                        index++;

                        debugPath.pop();
                    }

                } else {
                    // Fixed size arrays
                    for(let i = 0; i < child.length; i++) {
                        debugPath.push(i.toString());

                        // Any cast the arr, as it is okay to treat an array like an object in this context.
                        parseChildBase(child[i], { key: i as any as string, parent: arr as any });

                        debugPath.pop();
                    }
                }
            }
            else {
                parseChildBase(child, output as any);
            }
        }
    }
}

function getFinalOutput<T extends SerialObjectOutput>(output: T): SerialIntermediateToFinal<T> {
    return getFinalObjectOutput(output) as SerialIntermediateToFinal<T>;

    function getFinalObjectOutput(output: SerialObjectOutput): SerialIntermediateToFinal {
        let finalOutput = {} as SerialIntermediateToFinal;
        for(let key in output) {
            finalOutput[key] = parseChild(output[key]);
        }    
        return finalOutput;

        function parseChildBase(child: SerialObjectChildBaseToOutput): SerialIntermediateChildBaseToOutput {
            if(isIntermediatePrimitive(child)) {
                return child.value;
            } else {
                return getFinalObjectOutput(child);
            }
        }
        function parseChild(child: SerialObjectChildToOutput) {
            if(isArray(child)) {
                let arr: SerialIntermediateChildBaseToOutput[] = [];
                for(let i = 0; i < child.length; i++) {
                    arr.push(parseChildBase(child[i]));
                }
                return arr;
            } else {
                return parseChildBase(child);
            }
        }
    }
}

const WriteContextSymbol = Symbol();
function getBufferWriteContext(buffer: Readonly<Buffer>): string {
    return (buffer as any)[WriteContextSymbol];
}
function setBufferWriteContext(buffer: LargeBuffer, context: string): void {
    for(let buf of buffer.getInternalBufferList()) {
        (buf as any)[WriteContextSymbol] = context;
    }
}
function copyBufferWriteContext(oldBuf: LargeBuffer, newBuf: LargeBuffer): void {
    let olds = oldBuf.getInternalBufferList();
    let news = newBuf.getInternalBufferList();

    for(let i = 0; i < news.length; i++) {
        (news[i] as any)[WriteContextSymbol] = (olds[i] as any)[WriteContextSymbol];
    }
}

function writeIntermediate<T extends SerialObjectOutput>(intermediate: T): LargeBuffer {
    let debugPath: string[] = [];
    function createContext(primitive: SerialObjectPrimitiveToOutput): string {
        return `${debugPath.join(".")}`;
    }

    let buffers: LargeBuffer[] = [];

    writeIntermediateObject(intermediate);

    return new LargeBuffer(flatten(buffers.map(x => x.getInternalBufferList())));

    function writeIntermediateObject(output: SerialObjectOutput): void {
        // Okay... this is all sort of dangerous. It is true that the total size of bytes of the buffers BEFORE
        //  us may change. But inside of us should have a constant size.
        let delayedBufferCalls: {
            callback: () => LargeBuffer;
            bufferIndex: number;
        }[] = [];
        function recalculateBufferDelayed(bufferIndex: number, callback: () => LargeBuffer): void {
            delayedBufferCalls.push({
                callback,
                bufferIndex
            });
        }

        let didSizeAfterCall = false;
        let curDelayedBufferIndex: null|number = null;
        let inDelayedBufferCall = false;

        let ourKeyIndex = debugPath.length - 1;
        function setOurKey(ourKey: string) {
            debugPath[ourKeyIndex] = ourKey;
        }

        let startBufferIndex = buffers.length;
        for(let key in output) {
            debugPath.push(key);
            writeChild(output[key]);
            debugPath.pop();
        }

        function getSizeAfter(): number {
            didSizeAfterCall = true;
            if(curDelayedBufferIndex === null) return 0;
            let sizeAfter = sum(buffers.slice(curDelayedBufferIndex + 1).map(x => x.getLength()));
            return sizeAfter;
        }

        inDelayedBufferCall = true;
        // Apply delayed buffer calls in reverse
        for(let i = delayedBufferCalls.length - 1; i >= 0; i--) {
            let fncObj = delayedBufferCalls[i];
            curDelayedBufferIndex = fncObj.bufferIndex;
            cleanup(() => curDelayedBufferIndex = null, () => {
                let buf = fncObj.callback();
                copyBufferWriteContext(buffers[fncObj.bufferIndex], buf);
                buffers[fncObj.bufferIndex] = buf;
            });
        }
        return;

        function writePrimitive(primitive: SerialObjectPrimitiveToOutput): void {
            // Lot's of functionality needing in parsing can be removing when writing the data. Except of course
            //  getSizeAfter, which is strange, but very much needed to make creating boxes reasonably feasible.

            if(BoxSymbol in primitive.primitive) {
                setOurKey(primitive.primitive[BoxSymbol] || "not possible");
            }

            let context: WriteContext = {
                getSizeAfter,
                value: primitive.value,
            };
            didSizeAfterCall = false;
            let bufferOutput = primitive.primitive.write(context);

            setBufferWriteContext(bufferOutput, createContext(primitive));

            let bufferIndex = buffers.length;
            buffers.push(bufferOutput);

            if(!inDelayedBufferCall && didSizeAfterCall) {
                recalculateBufferDelayed(bufferIndex, () => primitive.primitive.write(context));
            }
        }

        function writeChildBase(child: SerialObjectChildBaseToOutput): void {
            if(isIntermediatePrimitive(child)) {
                writePrimitive(child);
            } else {
                writeIntermediateObject(child);
            }
        }
        function writeChild(child: SerialObjectChildToOutput): void {
            if(isArray(child)) {
                for(let i = 0; i < child.length; i++) {
                    debugPath.push(i.toString());
                    writeChildBase(child[i]);
                    debugPath.pop();
                }
            } else {
                writeChildBase(child);
            }
        }
    }
}

// #region Primitives
function IntN(bytes: number, signed: boolean): SerialObjectPrimitive<number> {
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

const UInt8 = IntN(1, false);
const UInt16 = IntN(2, false);
const UInt24 = IntN(3, false);
const UInt32 = IntN(4, false);
const UInt64 = IntN(8, false);

const Int16 = IntN(2, true);
const Int32 = IntN(4, true);
const Int64 = IntN(8, true);

function NumberShifted(primitive: SerialObjectPrimitive<number>, shiftAmount: number): SerialObjectPrimitive<number> {
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

const UInt32String: SerialObjectPrimitive<string> = {
    read: (context) => textFromUInt32(UInt32.read(context)),
    write: (context) => UInt32.write({ ...context, value: textToUInt32(context.value)}),  
};

function RawData(size: number): SerialObjectPrimitive<LargeBuffer> {
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

const CString: SerialObjectPrimitive<string> = {
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

/** A string that exists in our code, but doesn't get written back to disk. Useful to adding values to the
 *      object data for intermediate parsing.
 */
const CodeOnlyString: <T extends string>(type: T) => SerialObjectPrimitive<T> = <T extends string>(text: T) => ({
    read({pPos, buffer}) {
        return text;
    },
    write(context) {
        return new LargeBuffer([]);
    }
});

const BoxAnyType = "any";
const Box: <T extends string>(type: T) => { header: SerialObjectPrimitive<{ size: number, type: T, headerSize: number }>; type: SerialObjectPrimitive<T>; } =
<T extends string>(typeIn: T) => ({
    header: {
        [BoxSymbol]: typeIn,
        read(context) {
            let { buffer, pPos } = context;
            /*
                size is an integer that specifies the number of bytes in this box, including all its fields and contained
                    boxes; if size is 1 then the actual size is in the field largesize; if size is 0, then this box is the last
                    one in the file, and its contents extend to the end of the file (normally only used for a Media Data Box) 
            */
            let size = buffer.readUInt32BE(pPos.v); pPos.v += 4;
            let type = textFromUInt32(buffer.readUInt32BE(pPos.v)) as T; pPos.v += 4;

            if(type === "uuid") {
                throw new Error(`Unhandled mp4 box type uuid`);
            }

            if(typeIn !== BoxAnyType && type !== typeIn) {
                throw new Error(`Unexpected box type ${type}. Expected ${typeIn}`);
            }

            if(size !== 1) {
                return {
                    size,
                    type,
                    headerSize: 8,
                }
            } else {
                size = buffer.readUInt64BE(pPos.v); pPos.v += 8;
                return {
                    size,
                    type,
                    headerSize: 16,
                };
            }
        },
        write(context) {
            let { type } = context.value;

            let contentSize = context.getSizeAfter();
            let size = contentSize + 8;
            
            if(size <= MaxUInt32) {
                let size = contentSize + 8;
                let buffer = new Buffer(8);
                buffer.writeUInt32BE(size, 0);
                buffer.writeUInt32BE(textToUInt32(type), 4);
                return new LargeBuffer([buffer]);
            } else {
                let buffer = new Buffer(16);
                size += 8;
                buffer.writeUInt32BE(1, 0);
                buffer.writeUInt32BE(textToUInt32(type), 4);
                writeUInt64BE(buffer, 8, size);
                return new LargeBuffer([buffer]);
            }
        }
    },
    type: CodeOnlyString(typeIn),
});

function FullBox<T extends string>(type: T) {
    return {
        ... Box(type),
        version: UInt8,
        flags: UInt24,
    };
}
// #endregion

// All the boxes have to be SerialObjects... but... we want to keep the underlying types too, so SerialObjectOutput works.
// #region Boxes
const FileBox = {
    ... Box("ftyp"),
    major_brand: UInt32String,
    minor_version: UInt32,
    compatible_brands: ArrayInfinite(UInt32String),
};

const MvhdBoxTest = ChooseInfer()({header: FullBox("ftyp")})();

const MvhdBox = ChooseInfer()({ ...FullBox("mvhd") })({
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

const TkhdBox = ChooseInfer()({ ...FullBox("tkhd") })({
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
    reversed2: UInt16,

    matrix: repeat(Int32, 9),

    width: NumberShifted(UInt32, 1 << 16),
    height: NumberShifted(UInt32, 1 << 16),
})
();

const ElstBox = ChooseInfer()({
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

const EdtsBox = {
    ... Box("edts"),
    boxes: BoxLookup(ElstBox),
};

const MdhdBox = ChooseInfer()({
    ... FullBox("mdhd")
})({
    times: ({version}) => (
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
        throwValue(`Invalid versio n${version}`)
    )
})({
    padPlusLanguage: UInt16,
    pre_defined: UInt16,
})
();

const HdlrBox = {
    ... FullBox("hdlr"),

    pre_defined: UInt32,
    handler_type: UInt32String,
    reversed: repeat(UInt32, 3),

    name: CString,
};

const VmhdBox = {
    ... FullBox("vmhd"),
    graphicsmode: UInt16,
    opcolor: repeat(UInt16, 3),
};

const UrlBox = {
    ... FullBox("url ")
};
const DrefBox = {
    ... FullBox("dref"),
    entry_count: UInt32,
    boxes: BoxLookup(
        UrlBox
    ),
};

const DinfBox = {
    ... Box("dinf"),
    boxes: BoxLookup(
        DrefBox
    ),
};

const EsdsBox = {
    ... Box("esds"),
    iHaveNoIdeaAndReallyDontCare: ArrayInfinite(UInt8),
};

const Mp4vBox = {
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

const StsdBox = ChooseInfer()({
    ... FullBox("stsd"),
    entry_count: UInt32,
})({
    boxes: ({entry_count}) => BoxLookup(
        Mp4vBox,
        entry_count
    ),
})
();

const SttsBox = ChooseInfer()({
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

const StscBox = ChooseInfer()({
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

const StszBox = ChooseInfer()({
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

const StcoBox = ChooseInfer()({
    ... FullBox("stco"),
    entry_count: UInt32,
})({
    chunk_offsets: ({entry_count}) => repeat(UInt32, entry_count)
})
();

/*
const StssBox = ChooseInfer()({
    ... Box("stss"),
    entry_count: UInt32
})({
    samples: ({entry_count}) => repeat(UInt32, entry_count)
})
();
*/


const StblBox = {
    ... Box("stbl"),
    boxes: BoxLookup(
        StsdBox,
        SttsBox,
        StscBox,
        StszBox,
        StcoBox,
        // StssBox,
        // CttsBox,
    ),
};

const MinfBox = {
    ... Box("minf"),
    boxes: BoxLookup(
        VmhdBox,
        DinfBox,
        StblBox,
    ),
};

const MdiaBox = {
    ... Box("mdia"),
    boxes: BoxLookup(
        MdhdBox,
        HdlrBox,
        MinfBox,
    ),
};

const TrakBox = {
    ... Box("trak"),
    boxes: BoxLookup(
        TkhdBox,
        EdtsBox,
        MdiaBox,
    ),
};

const UdtaBox = ChooseInfer()({
    ... Box("udta"),
})({
    bytes: ({header}) => RawData(header.size - header.headerSize)
})
();

const MoovBox = {
    ... Box("moov"),
    boxes: BoxLookup(
        MvhdBox,
        TrakBox,
        UdtaBox,
        //MvexBox,
    ),
};

const MdatBox = ChooseInfer()({
    ... Box("mdat"),
})({
    bytes: ({header}) => RawData(header.size - header.headerSize)
})
();

const FreeBox = ChooseInfer()({
    ... Box("free"),
})({
    bytes: ({header}) => RawData(header.size - header.headerSize)
})
();

const RootBox = {
    boxes: BoxLookup(
        FileBox,
        MoovBox,
        MdatBox,
        FreeBox,
    )
};

// #endregion


function testReadFile(path: string) {
    let buf = LargeBuffer.FromFile(path);
    let output = parseBytes(buf, RootBox);
    let finalOutput = getFinalOutput(output);

    function cleanOutput(key: string, value: any) {
        if(value && value instanceof LargeBuffer) {
            return `LargeBuffer(${value.getLength()})`
        }
        return value;
    }

    writeFileSync(basename(path) + ".json", JSON.stringify(finalOutput, cleanOutput, "  "))
}

function testWriteFile(path: string) {
    testReadFile(path);

    let oldBuf = LargeBuffer.FromFile(path);
    let output = parseBytes(oldBuf, RootBox);
    let newBuf = writeIntermediate(output);

    // Compare newBuffers with output, using getBufferWriteContext to get the context of each buffer
    let bufLen = oldBuf.getLength();
    let rewriteLen = newBuf.getLength();
    let end = Math.min(bufLen, rewriteLen);

    let pos = 0;
    for(let i = 0; i < end; i++) {
        let oldByte = oldBuf.readUInt8(i);
        let newByte = newBuf.readUInt8(i);

        if(oldByte !== newByte) {
            let newBuffer = newBuf.getInternalBuffer(i);
            let newContext = getBufferWriteContext(newBuffer);

            throw new Error(`Bytes is wrong at position ${i}. Should be ${oldByte}, was ${newByte}. Write context ${newContext}. Old context ${getContext(oldBuf, i)}, new context ${getContext(newBuf, i)}`);
        }
    }

    if(bufLen !== rewriteLen) {
        throw new Error(`Length of buffer changed. Should be ${bufLen}, was ${rewriteLen}, path is ${path}`);
    }

    function getContext(buffer: LargeBuffer, pos: number, contextSize = 32): string {
        let beforePos = pos - contextSize;
        let beforeLength = contextSize;
        if(beforePos < 0) {
            beforeLength += beforePos;
            beforePos = 0;
        }
        let endBefore = Math.min(beforePos + contextSize, beforePos + beforeLength);
        let outputBefore = "";
    
        for(let i = beforePos; i < endBefore; i++) {
            let byte = buffer.readUInt8(i);
            if(byte === 0) {
                outputBefore += "\\0";
            } else {
                outputBefore += String.fromCharCode(byte);
            }
        }
    
        let end = Math.min(pos + contextSize, buffer.getLength());
        let output = "";
    
        for(let i = pos; i < end; i++) {
            let byte = buffer.readUInt8(i);
            if(byte === 0) {
                output += "\\0";
            } else {
                output += String.fromCharCode(byte);
            }
        }
        return outputBefore + "|" + output;
    }
}

async function testRewriteMjpeg() {
    async function loadFont(type: string): Promise<any> {
        return new Promise((resolve, reject) => {
            let jimpAny = Jimp as any;    
            jimpAny.loadFont(type, (err: any, font: any) => {
                if(err) {
                    reject(err);
                } else {
                    resolve(font);
                }
            });
        });
    }

    let jimpAny = Jimp as any;    
    let width = 600;
    let height = 400;
    //let image = new jimpAny(width, height, 0xFF0000FF, () => {});
    
    //Jimp.read(jpegs[0], (err: any, x: any) => {
    //    if(err) throw new Error(`Error ${err}`);
    //    image = x;
    //});
    async function getFrame(i: number): Promise<Buffer> {
        let image: any;
        image = new jimpAny(width, height, 0xFF00FFFF, () => {});
        
        image.resize(width, height);

        let data: Buffer = image.bitmap.data;
        let frameNumber = i;
        for(let i = 0; i < width * height; i++) {
            let k = i * 4;
            let seed = (frameNumber + 1) * i;
            data[k] = seed % 256;
            data[k + 1] = (seed * 67) % 256;
            data[k + 2] = (seed * 679) % 256;
            data[k + 3] = 255;
        }

        let imageColor = new jimpAny(width, 64, 0x000000AF, () => {});
        image.composite(imageColor, 0, 0);

        let path = "./node_modules/jimp/fonts/open-sans/open-sans-64-white/open-sans-64-white.fnt";
        let font = await loadFont(path);
        image.print(font, 0, 0, `frame ${i} NEW`, width);

        console.log(`Created frame ${i}`);
        
        let jpegBuffer!: Buffer;
        image.quality(75).getBuffer(Jimp.MIME_JPEG, (err: any, buffer: Buffer) => {
            if(err) throw err;
            jpegBuffer = buffer;
        });

        return jpegBuffer;
    }

    let fps = 1;
    let totalFrameCount = fps * 1;
    let frames: Buffer[] = [];
    let frameCount = totalFrameCount;
    for(let i = 0; i < frameCount; i++) {
        let buf = await getFrame(i);
        frames.push(buf);
    }

    createVideoOutOfJpegs(
        {
            fileName: "test.mp4",
            framePerSecond: fps,
            width,
            height,
        },
        flatten(repeat(frames, totalFrameCount / frames.length))
    );

    function createVideoOutOfJpegs(info: { fileName: string, framePerSecond: number, width: number, height: number }, jpegs: Buffer[]) {
        let { fileName, framePerSecond, width, height } = info;
    
        let templateMp4 = "./raw/test5.mp4";

        let buf = LargeBuffer.FromFile(templateMp4);
        let output = parseBytes(buf, RootBox);

        function filterBox<
            T extends string,
            Box extends (SerialObject & ReturnType<typeof Box>),
            Other extends (SerialObject & ReturnType<typeof Box>),
        >(
            type: T,
            box: Box,
            arr: ((SerialObjectOutput<Box> | SerialObjectOutput<Other>))[]
        ): SerialObjectOutput<Box>[] {
            return arr.filter((x): x is (SerialObjectOutput<Box>) => x.type.value === type);
        }

   
        let timeMultiplier = 2;
    
        // Might as well go in file order.

        
        //mdat is just the raw jpegs, side by side
        // data
        let mdat = filterBox("mdat", MdatBox, output.boxes)[0];
        mdat.bytes.value = new LargeBuffer(jpegs);
    
    
        let mvhd = getAllFirstOfTypeUnsafe(boxes, "mvhd")[0];
        // timescale. The number of increments per second. Will need to be the least common multiple of all the framerates
        let timescale = mvhd._properties.timescale = framePerSecond;
        // Technically the duration of the longest trak. But we should only have 1, so...
        let timescaleDuration = mvhd._properties.duration = jpegs.length;
    
        // Only 1 track
        let tkhd = getAllFirstOfTypeUnsafe(boxes, "tkhd")[0];
        tkhd._properties.duration = timescaleDuration;
        
        tkhd._properties.width = width;
        tkhd._properties.height = height;
    
        let elst = getAllFirstOfTypeUnsafe(boxes, "elst")[0];
        // Just one segment
        elst.entries.entries[0].segment_duration = timescaleDuration;
    
    
        let mdhd = getAllFirstOfType(boxes, "mdhd")[0];
    
        // mdhd has a timescale too?
        mdhd._properties.timescale = timescale;
        mdhd._properties.duration = timescaleDuration;
    
    
        let stsd = getAllFirstOfTypeUnsafe(boxes, "stsd")[0];
        stsd.obj[0].width = width;
        stsd.obj[0].height = height;
    
    
        let stts = getAllFirstOfTypeUnsafe(boxes, "stts")[0];
        stts.obj[0].sample_delta = 1;
        stts.obj[0].sample_count = jpegs.length;
    
        let stsc = getAllFirstOfTypeUnsafe(boxes, "stsc")[0];
        stsc.obj[0].samples_per_chunk = jpegs.length;
    
        let stsz = getAllFirstOfTypeUnsafe(boxes, "stsz")[0];
        stsz.obj = jpegs.map(x => x.length);
    
        // Position of mdat in file as a whole. So... anything before mdat has to have a constant size, or else this will be wrong,
        //  or I will need to start calculating it.
        let stco = getAllFirstOfTypeUnsafe(boxes, "stco")[0];
        
        // Okay, time for hacks. So... if mdat switches to a larger header, it's data will be offset. So... deal with that here
        // maxUInt32
        let mdatSize = 8 + sum(jpegs.map(x => x.length));
        if(mdatSize > maxUInt32) {
            console.log("wow, that's a big file you got there. I hope this works.");
            stco.obj[0] += 8;
        }
    
    
        let newBuffer = writeBoxArr(boxes);
        console.log(`Wrote to ${fileName}`)
    
        let stream = fs.createWriteStream(fileName);
        stream.once("open", function(fd) {
            for(let buf of newBuffer) {
                stream.write(buf);
            }
            stream.end();
        });
    }
}

//todonext
// - Modify the frames inside test5.mp4 (the payload is just a mjpeg), so ensure we can still play it.
// - Make sure writeIntermediate works for youtube.mp4 (and add parsing for any new boxes)
// - Make sure we can put a payload from a full mp4 (test.h264.mp4) into a frament mp4 (youtube.mp4), and get a playable file.

//testYoutube();

//testReadFile("./raw/test5.mp4");

//testWriteFile("./raw/test5.mp4");

//testFile("./youtube.mp4");

testRewriteMjpeg();