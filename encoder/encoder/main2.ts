// Generic parsing, based off of pseudo language
// This is an ISOBMFF parser (https://en.wikipedia.org/wiki/ISO_base_media_file_format)
//  MOST UP TO DATE STANDARD: https://www.iso.org/standard/68960.html
// http://l.web.umkc.edu/lizhu/teaching/2016sp.video-communication/ref/mp4.pdf
// https://github.com/emericg/MiniVideo/blob/master/minivideo/src/demuxer/mp4/mp4.cpp
// https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-00#page-9
// https://developer.apple.com/streaming/HLS-WWDC-2017-Preliminary-Spec.pdf
// https://mpeg.chiariglione.org/standards/mpeg-4/iso-base-media-file-format/text-isoiec-14496-12-5th-edition
// https://mpeg.chiariglione.org/standards/mpeg-4/carriage-nal-unit-structured-video-iso-base-media-file-format/text-isoiec-14496-1
// https://stackoverflow.com/questions/16363167/html5-video-tag-codecs-attribute

// Hmm... another example of an implementation: https://github.com/madebyhiro/codem-isoboxer B

import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray, throwValue, assertNumber } from "./util/type";
import { keyBy, mapObjectValues, repeat, flatten, filterObjectValues, mapObjectValuesKeyof, range } from "./util/misc";
import { writeFileSync, createWriteStream } from "fs";
import { basename } from "path";
import { decodeUTF8BytesToString, encodeAsUTF8Bytes } from "./util/UTF8";
import { sum } from "./util/math";

import * as Jimp from "jimp";

// #region Serial types
const TestSymbol = Symbol();

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
interface SerialObjectPrimitiveBoxSymbol<T, BoxType extends string> {
    [BoxSymbol]: BoxType;
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

type ChooseInferArray<R> = (
    R extends SerialObject[] ? SerialObjectOutput<R[0]> :
    R extends SerialObjectPrimitive[] ? SerialObjectPrimitiveToOutput<R[0]> :
    never
);

// Eh... the choose function causes problem. It says it is recursive. I could probably fix this with manual recursion (just spitting out the
//  recursive path a lot of times, and then ending the final entry with never), but... let's try without that, and maybe I'll think of a way
//  to get this to work without that.
//  - Actually, at least map primitives to output
//never;//SerialObjectChildToOutput<ReturnType<T>>;
type SerialObjectChooseToOutput<T extends SerialObjectChoose> = (
    ReturnType<T> extends SerialObjectPrimitive ? SerialObjectPrimitiveToOutput<ReturnType<T>> :
    // And this doesn't give an error!? I guess that sort of makes sense...
    ReturnType<T> extends SerialObjectPrimitive[] ? ChooseInferArray<ReturnType<T>>[] :
    ReturnType<T> extends SerialObject[] ? ChooseInferArray<ReturnType<T>>[] :
    ReturnType<T> extends SerialObject ? SerialObjectOutput<ReturnType<T>> :
    never
    //{ error: "SerialObjectChooseToOutput has limited inferring capabilities, and could not infer the output of a choose function. See the definition of SerialObjectChooseToOutput" }
);

const SerialPrimitiveMark = Symbol();
type SerialPrimitiveMark = typeof SerialPrimitiveMark;

type SerialObjectPrimitiveToOutput<T extends SerialObjectPrimitive = SerialObjectPrimitive> = {
    primitive: T;
    value: ReturnType<T["read"]>;
    [SerialPrimitiveMark]: true;
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
    T extends undefined ? undefined :
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
    // Array first is important, to prevent any arrays with extra type values ([] & {}) from being recognized as objects, as they definitely aren't.
    T extends SerialObjectChildBase[] ? SerialObjectChildBaseToOutput<GetSerialObjectChildBaseArray<T>>[] :
    T extends SerialObjectChildBase ? SerialObjectChildBaseToOutput<T> :
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

type GetSerialIntermediateChildBaseArray<T extends SerialObjectChildToOutput[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildToOutput>
);
type SerialIntermediateChildToOutput<T extends (SerialObjectChildToOutput | undefined) = SerialObjectChildToOutput> = (
    T extends undefined ? undefined :
    T extends SerialObjectChildBaseToOutput[] ? SerialIntermediateChildBaseToOutput<GetSerialIntermediateChildBaseArray<T>>[] :
    T extends SerialObjectChildBaseToOutput ? SerialIntermediateChildBaseToOutput<T> :
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

// #region Parse functions
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

                parseChild(child, { key, parent: outputObject as any });
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

                            boxEnd = pPos.v + assertNumber(boxObj.size);
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
            finalOutput[key] = parseChild(output[key] as any);
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

function createIntermediateObject<T extends SerialObject>(template: T, data: SerialIntermediateToFinal<SerialObjectOutput<T>>): SerialObjectOutput<T> {
    return getIntermediateOutput(template, data) as SerialObjectOutput<T>;

    function getIntermediateOutput(template: SerialObject, data: SerialIntermediateToFinal): SerialObjectOutput {
        let parentData = data;
        let finalOutput = {} as SerialObjectOutput;
        for(let key in template) {
            let child = template[key];
            let childData = data[key];
            if(!child) continue;
            finalOutput[key] = parseChild(child, childData);
        }    
        return finalOutput;

        function parseChildBase(child: SerialObjectChildBase, data: SerialIntermediateChildToOutput): SerialObjectChildToOutput {
            if(isSerialChoose(child)) {
                // Hmm... we can actually call the choose function with the output data.
                let choosenTemplate;
                try {
                    choosenTemplate = child(parentData);
                } catch(e) {
                    console.error(template, data);
                    throw e;
                }
                return parseChild(choosenTemplate, data);
            } else if(isSerialPrimitive(child)) {
                return {
                    primitive: child,
                    value: data,
                    [SerialPrimitiveMark]: true,
                };
            } else {
                return getIntermediateOutput(child, data as SerialIntermediateToFinal);
            }
        }
        function parseChild(child: SerialObjectChild, data: SerialIntermediateChildToOutput): SerialObjectChildToOutput {
            if(isArray(child)) {
                if(!isArray(data)) {
                    throw new Error(`Template is array, but data isn't. Data is ${data}`);
                }

                if(IsArrayInfinite(child)) {
                    if(child.length != 1) {
                        throw new Error(`Infinite array must have length of 1. Had length of ${child.length}. ${child}`);
                    }
                    
                    let arr: SerialObjectChildBaseToOutput[] = [];
                    for(let i = 0; i < data.length; i++) {
                        let entry = parseChildBase(child[0], data[i]);
                        if(isArray(entry)) {
                            throw new Error(`Cannot handle arrays of arrays.`);
                        }
                        arr.push(entry);
                    }
                    return arr;
                } else if(IsBoxLookup(child)) {
                    let count = GetBoxCount(child);
                    if(count !== undefined) {
                        if(data.length !== count) {
                            throw new Error(`Data length is different than expected. Was ${data.length}, expected ${count}`);
                        }
                    }

                    let BoxAny = Box(BoxAnyType);
                    let childAsBoxes: typeof BoxAny[] = child as any;
                    let dataAsBoxes: SerialIntermediateToFinal<SerialObjectOutput<typeof BoxAny>>[] = data as any;

                    let childBoxLookup = keyBy(childAsBoxes, x => x.header[BoxSymbol]);

                    let arr: SerialObjectChildBaseToOutput[] = [];
                    for(let i = 0; i < dataAsBoxes.length; i++) {
                        let datum = dataAsBoxes[i];
                        let childBoxReal = childBoxLookup[datum.header.type];
                        if(!childBoxReal) {
                            throw new Error(`Cannot find type for box ${datum.header.type}. Expected types of ${Object.keys(childBoxLookup).join(", ")}`);
                        }

                        let entry = parseChild(childBoxReal, datum);
                        if(isArray(entry)) {
                            throw new Error(`Cannot handle arrays of arrays.`);
                        }
                        arr.push(entry);
                    }
                    return arr;
                } else {
                    if(child.length !== data.length) {
                        throw new Error(`Template is length is different than data. Template is ${child.length}, data is ${data.length}`);
                    }

                    let arr: SerialObjectChildBaseToOutput[] = [];
                    for(let i = 0; i < child.length; i++) {
                        let entry = parseChildBase(child[i], data[i]);
                        if(isArray(entry)) {
                            throw new Error(`Cannot handle arrays of arrays.`);
                        }
                        arr.push(entry);
                    }
                    return arr;
                }
            } else {
                return parseChildBase(child, data);
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
            writeChild(output[key] as any);
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
            let bufferOutput;
            try {
                bufferOutput = primitive.primitive.write(context);
            } catch(e) {
                console.error(output);
                throw e;
            }

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

type B = (SerialObject & ReturnType<typeof Box>);
type O<T extends (SerialObject | undefined)> = (
    T extends SerialObject ? SerialObjectOutput<T> : never
);



// #endregion

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
const Box: <T extends string>(type: T) => { header: SerialObjectPrimitiveBoxSymbol<{ size?: number, type: T, headerSize?: number }, T>; type: SerialObjectPrimitive<T>; } =
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

function bitsToByte(bits: number[]): number {
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
function byteToBits(byteIn: number, bitCount = 8): number[] {
    let byte = byteIn;
    let bits: number[] = [];
    let mask = 1 << (bitCount - 1);
    if(byte >= mask * 2) {
        throw new Error(`Tried to get ${bitCount} bits from ${byte}, but that number has more bits than requested!`);
    }
    while(mask) {
        let bit = byte & mask;
        bits.push(bit === 0 ? 0 : 1);
        mask = mask >> 1;
    }
    return bits;
}

type BitCount = number;
/** The return type can actually be the same, as a BitCount is a number, and the results are numbers, even though the meaning of the numbers are entirely different. */
function bitMapping<T extends { [key: string]: BitCount }>(bitMap: T): SerialObjectPrimitive<T> {
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
// #endregion

// All the boxes have to be SerialObjects... but... we want to keep the underlying types too, so SerialObjectOutput works.
// #region Boxes
const FtypBox = {
    ... Box("ftyp"),
    major_brand: UInt32String,
    minor_version: UInt32,
    compatible_brands: ArrayInfinite(UInt32String),
};

const StypBox = {
    ... Box("styp"),
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
        throwValue(`Invalid version ${version}`)
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

const AvcCBox = {
    ... Box("avcC"),
    configurationVersion: UInt8,
	AVCProfileIndication: UInt8,
	profile_compatibility: UInt8,
    AVCLevelIndication: UInt8,
    notImportant: ArrayInfinite(UInt8),
};

const Avc1Box = {
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

    config: [AvcCBox],

    notImportant: ArrayInfinite(UInt8),
};

const StsdBox = ChooseInfer()({
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

const StssBox = ChooseInfer()({
    ... FullBox("stss"),
    entry_count: UInt32
})({
    samples: ({entry_count}) => repeat(UInt32, entry_count)
})
();

const CttsBox = ChooseInfer()({
    ... FullBox("ctts"),
    entry_count: UInt32
})({
    samples: ({entry_count}) => repeat({sample_count: UInt32, sample_offset: UInt32}, entry_count)
})
();


const StblBox = {
    ... Box("stbl"),
    boxes: BoxLookup(
        StsdBox,
        SttsBox,
        StscBox,
        StszBox,
        StcoBox,
        StssBox,
        CttsBox,
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
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

const sample_flags = bitMapping({
    reserved: 4,
    is_leading: 2,
    sample_depends_on: 2,
    sample_is_depended_on: 2,
    sample_has_redundancy: 2,
    sample_padding_value: 3,
    sample_is_non_sync_sample: 1,
    sample_degradation_priority: 16
});

const TrexBox = {
    ... FullBox("trex"),
    track_ID: UInt32,
    default_sample_description_index: UInt32,
    default_sample_duration: UInt32,
    default_sample_size: UInt32,
    default_sample_flags: sample_flags,
};
const MehdBox = ChooseInfer()({
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
const TrepBox = {
    ... FullBox("trep"),
    track_id: UInt32,
    boxes: BoxLookup(),
};
const MvexBox = {
    ... Box("mvex"),
    boxes: BoxLookup(
        TrexBox,
        MehdBox,
        TrepBox,
    ),
};

const MoovBox = {
    ... Box("moov"),
    boxes: BoxLookup(
        MvhdBox,
        TrakBox,
        UdtaBox,
        MvexBox,
    ),
};

const MdatBox = ChooseInfer()({
    ... Box("mdat"),
})({
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

const FreeBox = ChooseInfer()({
    ... Box("free"),
})({
    bytes: ({header}) => RawData(assertNumber(header.size) - assertNumber(header.headerSize))
})
();

const EmsgBox = {
    ... FullBox("emsg"),

    scheme_id_uri: CString,
    value: CString,
    timescale: UInt32,
    presentation_time_delta: UInt32,
    event_duration: UInt32,
    id: UInt32,

    message_data: ArrayInfinite(UInt8),
};

// From the ISO/IEC 14496-12:2015 version of the spec, as the ISO/IEC 14496-12:2008 one is outdated.
const SidxReference = {
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

const SidxBox = ChooseInfer()({
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

const MfhdBox = {
    ... FullBox("mfhd"),
    sequence_number: UInt32,
};

const TfhdBox = ChooseInfer()({
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
            flags.default_sample_flags_present ? {default_sample_flags: UInt32} : {},
        )
    ),
})
();

const TrunBox = ChooseInfer()({
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
            values.first_sample_flags && index === 0 ? {} : flags.sample_flags_present ? {sample_flags: UInt32} : {},
            flags.sample_composition_time_offsets_present ? {sample_composition_time_offset: UInt32} : {},
        )
    ))
})
();

const TfdtBox = ChooseInfer()({
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

const TrafBox = {
    ... Box("traf"),
    boxes: BoxLookup(
        TfhdBox,
        TrunBox,
        TfdtBox,
    ),
};

const MoofBox = {
    ... Box("moof"),
    boxes: BoxLookup(
        MfhdBox,
        TrafBox,
    ),
};

const RootBox = {
    boxes: BoxLookup(
        FtypBox,
        StypBox,
        MoovBox,
        MdatBox,
        FreeBox,
        EmsgBox,
        SidxBox,
        MoofBox,
    ),
};

// #endregion

function testReadFile(path: string) {
    let buf = LargeBuffer.FromFile(path);
    testRead(path, buf);
}
function testRead(path: string, buf: LargeBuffer) {
    let output = parseBytes(buf, RootBox);
    let finalOutput = getFinalOutput(output);

    function prettyPrint(obj: any): string {
        let uniqueId = 0;
        let largeBufferId: { [id: number]: LargeBuffer } = {};
        function cleanOutput(key: string, value: any) {
            //if(key === "size") return undefined;
            //if(key === "headerSize") return undefined;
            if(value && value instanceof LargeBuffer) {
                let id = uniqueId++;
                largeBufferId[id] = value;
                return `unique${id}`;
            }
            return value;
        }
        let output = JSON.stringify(obj, cleanOutput, "    ");
        for(let id in largeBufferId) {
            let text = `"unique${id}"`;
            let buffer = largeBufferId[id];
            let nums: number[] = [];
            for(let b of buffer.getInternalBufferList()) {
                for(let i = 0; i < b.length; i++) {
                    nums.push(b[i]);
                }
            }
            output = output.replace(text, `new LargeBuffer([new Buffer([${nums.join(",")}])])`);
        }
        return output;
    }

    writeFileSync(basename(path) + ".json", prettyPrint(finalOutput));
    
    //writeFileSync(basename(path) + ".json", prettyPrint(finalOutput.boxes.filter(x => x.type === "mdat")));

    //writeFileSync(basename(path) + ".json", "test");
}

function testWriteFile(path: string) {
    testReadFile(path);

    let oldBuf = LargeBuffer.FromFile(path);
    let output = parseBytes(oldBuf, RootBox);
    let newBuf = writeIntermediate(output);

    testWrite(oldBuf, newBuf);

    let finalOutput = getFinalOutput(output);
    let intermediateOutput = createIntermediateObject(RootBox, finalOutput);
    let newBuf2 = writeIntermediate(intermediateOutput);
    testWrite(oldBuf, newBuf2);

    console.log(oldBuf.getLength(), newBuf.getLength(), newBuf2.getLength());
}
function testWrite(oldBuf: LargeBuffer, newBuf: LargeBuffer) {
    // Compare newBuffers with output, using getBufferWriteContext to get the context of each buffer
    let bufLen = oldBuf.getLength();
    let rewriteLen = newBuf.getLength();
    let end = Math.min(bufLen, rewriteLen);

    let curErrors = 0;

    let pos = 0;
    for(let i = 0; i < end; i++) {
        let oldByte = oldBuf.readUInt8(i);
        let newByte = newBuf.readUInt8(i);

        if(oldByte !== newByte) {
            let newBuffer = newBuf.getInternalBuffer(i);
            let newContext = getBufferWriteContext(newBuffer);

            console.error(`Byte is wrong at position ${i}. Should be ${oldByte}, was ${newByte}. Write context ${newContext}.\nOld context ${getContext(oldBuf, i)}\nNew context ${getContext(newBuf, i)}`);
            curErrors++;
            if(curErrors > 10) {
                throw new Error(`Too many errors (${curErrors})`);
            }
        }
    }

    if(bufLen !== rewriteLen) {
        throw new Error(`Length of buffer changed. Should be ${bufLen}, was ${rewriteLen}`);
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
                outputBefore += "Ө";// "\\0";
            } else if(byte === 13) {
                outputBefore += "П";
            } else if(byte === 10) {
                outputBefore += "ϵ";
            } else {
                outputBefore += String.fromCharCode(byte);
                //outputBefore += "(" + byte.toString() + ")";
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
        return "\"" + outputBefore + "|" + output + "\"";
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

    let fps = 10;
    let totalFrameCount = fps * 10;
    let frames: Buffer[] = [];
    let frameCount = totalFrameCount;
    for(let i = 0; i < frameCount; i++) {
        let buf = await getFrame(i);
        frames.push(buf);
    }

    let newBuffer = createVideoOutOfJpegs(
        {
            framePerSecond: fps,
            width,
            height,
        },
        flatten(repeat(frames, totalFrameCount / frames.length))
    );

    let outputFileName = "./testNEW.mp4";
    testRead(outputFileName, newBuffer);

    let stream = createWriteStream(outputFileName);
    stream.once("open", function(fd) {
        let newBuffers = newBuffer.getInternalBufferList();
        for(let buf of newBuffers) {
            stream.write(buf);
        }
        stream.end();
    });

    function createVideoOutOfJpegs(info: { framePerSecond: number, width: number, height: number }, jpegs: Buffer[]): LargeBuffer {
        let { framePerSecond, width, height } = info;
    
        let templateMp4 = "./raw/test5.mp4";

        let buf = LargeBuffer.FromFile(templateMp4);
        let outputInter = parseBytes(buf, RootBox);
        let output = getFinalOutput(outputInter);
       
        let timeMultiplier = 2;
    
        // Might as well go in file order.

        // console.log(filterBox(FileBox, RootBox.boxes, output.boxes));
        
        //mdat is just the raw jpegs, side by side
        // data
        let mdat = output.boxes.filter(x => x.type === "mdat")[0];
        if(mdat.type !== "mdat") throw new Error("Impossible");
        mdat.bytes = new LargeBuffer(jpegs);
    
        let moov = output.boxes.filter(x => x.type === "moov")[0];
        if(moov.type !== "moov") throw new Error("Impossible");

        let mvhd = moov.boxes.filter(x => x.type === "mvhd")[0];
        if(mvhd.type !== "mvhd") throw new Error("Impossible");

        // timescale. The number of increments per second. Will need to be the least common multiple of all the framerates
        let timescale = mvhd.times.timescale = framePerSecond;
        // Technically the duration of the longest trak. But we should only have 1, so...
        let timescaleDuration = mvhd.times.duration = jpegs.length;


        let trak = moov.boxes.filter(x => x.type === "trak")[0];
        if(trak.type !== "trak") throw new Error("Impossible");

        // Only 1 track
        let tkhd = trak.boxes.filter(x => x.type === "tkhd")[0];
        if(tkhd.type !== "tkhd") throw new Error("Impossible");

        tkhd.times.duration = timescaleDuration;
        tkhd.width = width;
        tkhd.height = height;

        let edts = trak.boxes.filter(x => x.type === "edts")[0];
        if(edts.type !== "edts") throw new Error("Impossible");

        let elst = edts.boxes.filter(x => x.type === "elst")[0];
        if(elst.type !== "elst") throw new Error("Impossible");
        // Just one segment
        elst.entries[0].segment_duration = timescaleDuration;

        let mdia = trak.boxes.filter(x => x.type === "mdia")[0];
        if(mdia.type !== "mdia") throw new Error("Impossible");

        let mdhd = mdia.boxes.filter(x => x.type === "mdhd")[0];
        if(mdhd.type !== "mdhd") throw new Error("Impossible");

        // mdhd has a timescale too?
        mdhd.times.timescale = timescale;
        mdhd.times.duration = timescaleDuration;

        let minf = mdia.boxes.filter(x => x.type === "minf")[0];
        if(minf.type !== "minf") throw new Error("Impossible");

        let stbl = minf.boxes.filter(x => x.type === "stbl")[0];
        if(stbl.type !== "stbl") throw new Error("Impossible");

        let stsd = stbl.boxes.filter(x => x.type === "stsd")[0];
        if(stsd.type !== "stsd") throw new Error("Impossible");

        let stsdBox = stsd.boxes[0];
        if(stsdBox.type !== "mp4v") {
            throw new Error(`Unexpect stsd type ${stsdBox.type}`);
        }

        stsdBox.width = width;
        stsdBox.height = height;


        let stts = stbl.boxes.filter(x => x.type === "stts")[0];
        if(stts.type !== "stts") throw new Error("Impossible");
        {
            let obj = stts.samples[0];
            obj.sample_delta = 1;
            obj.sample_count = jpegs.length;
        }

        let stsc = stbl.boxes.filter(x => x.type === "stsc")[0];
        if(stsc.type !== "stsc") throw new Error("Impossible");
        {
            let obj = stsc.entries[0];
            obj.samples_per_chunk = jpegs.length;
        }

        let stsz = stbl.boxes.filter(x => x.type === "stsz")[0];
        if(stsz.type !== "stsz") throw new Error("Impossible");
        {
            stsz.sample_count = jpegs.length;
            stsz.sample_sizes = jpegs.map(x => x.length)
        }

        let stco = stbl.boxes.filter(x => x.type === "stco")[0];
        if(stco.type !== "stco") throw new Error("Impossible");
        {
            // Position of mdat in file as a whole. So... anything before mdat has to have a constant size, or else this will be wrong,
            //  or I will need to start calculating it.
            
            // Okay, time for hacks. So... if mdat switches to a larger header, it's data will be offset. So... deal with that here
            // maxUInt32
            let mdatSize = 8 + sum(jpegs.map(x => x.length));
            if(mdatSize > MaxUInt32) {
                console.log("wow, that's a big file you got there. I hope this works.");
                stco.chunk_offsets[0] += 8;
            }
        }

        let reIntOutput = createIntermediateObject(RootBox, output);

        return writeIntermediate(reIntOutput);
    }
}

async function testRewriteMp4Fragment() {
    let templateMp4 = "./10fps.dash.mp4";
    let outputFileName = "./youtubeOUT.mp4";

    let oldBuf = LargeBuffer.FromFile(templateMp4);
    //let newBuf = createVideoOutOfJpegs();
    let newBuf = createVideo2();


    let stream = createWriteStream(outputFileName);
    stream.once("open", function(fd) {
        let newBuffers = newBuf.getInternalBufferList();
        for(let buf of newBuffers) {
            stream.write(buf);
        }
        stream.end();
    });
    
    //testWrite(oldBuf, newBuf);

    type O<T extends SerialObject> = SerialIntermediateToFinal<SerialObjectOutput<T>>;
    function createVideo2(): LargeBuffer {
        //todonext
        // - Generate file from 10fps.h264.mp4
        //      - Generate trun from 10fps.h264.mp4 ctts
        //      - get width/height from 10fps.h264.mp4
        //      - translate timescale from 10fps.h264.mp4 (using the correct trak timescale, not the overall media timescale)
        //      - take the mdat from 10fps.h264.mp4
        //      - Make sure when it plays, it plays every single frame in 10fps.h264.mp4 (and doesn't skip the last few frames)
        // - create a new h264 media file, and read that data in and output a file for it.
        let timescale = 10240;
        let frameTimeInTimescale = timescale / 10;

        function createMoov(): O<typeof MoovBox> {
            return {
                header: {
                    type: "moov"
                },
                type: "moov",
                boxes: [
                    {
                        header: {
                            type: "mvhd"
                        },
                        type: "mvhd",
                        version: 0,
                        flags: 0,
                        times: {
                            creation_time: 0,
                            modification_time: 0,
                            timescale: timescale,
                            duration: 0
                        },
                        rate: 1,
                        volume: 1,
                        reserved: 0,
                        reserved0: 0,
                        reserved1: 0,
                        matrix: [65536, 0, 0, 0, 6, 0, 0, 0, 4],
                        pre_defined: [0, 0, 0, 0, 0, 0],
                        next_track_ID: 2
                    },
                    {
                        header: {
                            type: "mvex"
                        },
                        type: "mvex",
                        boxes: [
                            {
                                header: {
                                    type: "trex"
                                },
                                type: "trex",
                                version: 0,
                                flags: 0,
                                track_ID: 1,
                                default_sample_description_index: 1,
                                default_sample_duration: frameTimeInTimescale,
                                default_sample_size: 0,
                                default_sample_flags: {
                                    reserved: 0,
                                    is_leading: 0,
                                    sample_depends_on: 0,
                                    sample_is_depended_on: 0,
                                    sample_has_redundancy: 0,
                                    sample_padding_value: 0,
                                    sample_is_non_sync_sample: 1,
                                    sample_degradation_priority: 0
                                }
                            },
                            {
                                header: {
                                    type: "trep"
                                },
                                type: "trep",
                                version: 0,
                                flags: 0,
                                track_id: 1,
                                boxes: []
                            }
                        ]
                    },
                    {
                        header: {
                            type: "trak"
                        },
                        type: "trak",
                        boxes: [
                            {
                                header: {
                                    type: "tkhd"
                                },
                                type: "tkhd",
                                version: 0,
                                flags: 3,
                                times: {
                                    creation_time: 0,
                                    modification_time: 0,
                                    track_ID: 1,
                                    reserved: 0,
                                    duration: 0
                                },
                                reserved0: 0,
                                reserved1: 0,
                                layer: 0,
                                alternate_group: 0,
                                volume: 0,
                                reversed2: 0,
                                matrix: [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824],
                                width: 600,
                                height: 400
                            },
                            {
                                header: {
                                    type: "mdia"
                                },
                                type: "mdia",
                                boxes: [
                                    {
                                        header: {
                                            type: "mdhd"
                                        },
                                        type: "mdhd",
                                        version: 0,
                                        flags: 0,
                                        times: {
                                            creation_time: 0,
                                            modification_time: 0,
                                            timescale: timescale,
                                            duration: 0
                                        },
                                        padPlusLanguage: 21956,
                                        pre_defined: 0
                                    },
                                    {
                                        header: {
                                            type: "hdlr"
                                        },
                                        type: "hdlr",
                                        version: 0,
                                        flags: 0,
                                        pre_defined: 0,
                                        handler_type: "vide",
                                        reversed: [0,0,0],
                                        name: "VideoHandler"
                                    },
                                    {
                                        header: {
                                            type: "minf"
                                        },
                                        type: "minf",
                                        boxes: [
                                            {
                                                header: {
                                                    type: "vmhd"
                                                },
                                                type: "vmhd",
                                                version: 0,
                                                flags: 1,
                                                graphicsmode: 0,
                                                opcolor: [0, 0, 0]
                                            },
                                            {
                                                header: {
                                                    type: "dinf"
                                                },
                                                type: "dinf",
                                                boxes: [
                                                    {
                                                        header: {
                                                            type: "dref"
                                                        },
                                                        type: "dref",
                                                        version: 0,
                                                        flags: 0,
                                                        entry_count: 1,
                                                        boxes: [
                                                            {
                                                                header: {
                                                                    type: "url "
                                                                },
                                                                type: "url ",
                                                                version: 0,
                                                                flags: 1
                                                            }
                                                        ]
                                                    }
                                                ]
                                            },
                                            {
                                                header: {
                                                    type: "stbl"
                                                },
                                                type: "stbl",
                                                boxes: [
                                                    {
                                                        header: {
                                                            type: "stsd"
                                                        },
                                                        type: "stsd",
                                                        version: 0,
                                                        flags: 0,
                                                        entry_count: 1,
                                                        boxes: [
                                                            {
                                                                header: {
                                                                    type: "avc1"
                                                                },
                                                                type: "avc1",
                                                                reserved: [0, 0, 0, 0, 0, 0],
                                                                data_reference_index: 1,
                                                                pre_defined: 0,
                                                                reserved1: 0,
                                                                pre_defined1: [0, 0, 0],
                                                                width: 600,
                                                                height: 400,
                                                                horizresolution: 4718592,
                                                                vertresolution: 4718592,
                                                                reserved2: 0,
                                                                frame_count: 1,
                                                                compressorname: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                                                                depth: 24,
                                                                pre_defined2: -1,
                                                                config: [
                                                                    {
                                                                        header: {
                                                                            type: "avcC"
                                                                        },
                                                                        type: "avcC",
                                                                        configurationVersion: 1,
                                                                        AVCProfileIndication: 244,
                                                                        profile_compatibility: 0,
                                                                        AVCLevelIndication: 22,
                                                                        notImportant: [255, 225, 0, 27, 103, 244, 0, 22, 145, 155, 40, 19, 6, 124, 79, 128, 182, 64, 0, 0, 3, 0, 64, 0, 0, 5, 3, 197, 139, 101, 128, 1, 0, 5, 104, 235, 227, 196, 72, 253, 248, 248, 0]
                                                                    }
                                                                ],
                                                                notImportant: [0, 0, 0, 16, 112, 97, 115, 112, 0, 0, 0, 1, 0, 0, 0, 1]
                                                            }
                                                        ]
                                                    },
                                                    {
                                                        header: {
                                                            type: "stts"
                                                        },
                                                        type: "stts",
                                                        version: 0,
                                                        flags: 0,
                                                        entry_count: 0,
                                                        samples: []
                                                    },
                                                    {
                                                        header: {
                                                            type: "stsc"
                                                        },
                                                        type: "stsc",
                                                        version: 0,
                                                        flags: 0,
                                                        entry_count: 0,
                                                        entries: []
                                                    },
                                                    {
                                                        header: {
                                                            type: "stsz"
                                                        },
                                                        type: "stsz",
                                                        version: 0,
                                                        flags: 0,
                                                        sample_size: 0,
                                                        sample_count: 0,
                                                        sample_sizes: []
                                                    },
                                                    {
                                                        header: {
                                                            type: "stco"
                                                        },
                                                        type: "stco",
                                                        version: 0,
                                                        flags: 0,
                                                        entry_count: 0,
                                                        chunk_offsets: []
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };
        }

        function createSidx(moofSize: number, mdatSize: number): O<typeof SidxBox> {
            console.log(moofSize + mdatSize);
            return {
                header: {
                    type: "sidx"
                },
                type: "sidx",
                version: 0,
                flags: 0,
                reference_ID: 1,
                timescale: timescale,
                times: {
                    earliest_presentation_time: 0,
                    first_offset: 0
                },
                reserved: 0,
                reference_count: 1,
                ref: [
                    {
                        // The whole SAP and reference_type garbage doesn't matter. Just put 0s, which means "no information of SAPs is provided",
                        //  and use sample_is_non_sync_sample === 0 to indicate SAPs. Also, sample_is_non_sync_sample is used anyway, so these values
                        //  are overriden regardless of what we do.
                        a: {
                            reference_type: 0,
                            reference_offset: moofSize + mdatSize
                        },
                        // Looks like this isn't used. But we could calculate it correctly, instead of however it was calculated by mp4box
                        subsegment_duration: 21504,
                        SAP: {
                            starts_with_SAP: 0,
                            // a SAP of type 1 or type 2 is indicated as a sync sample, or by "sample_is_non_sync_sample" equal to 0 in the movie fragments.
                            //  So... we have sample_is_non_sync_sample === 0 in the movie fragments, so this can be 0 here.
                            SAP_type: 0,
                            SAP_delta_time: 0
                        }
                    }
                ]
            };
        }

        function createMoof(): O<typeof MoofBox> {
            function createMoofInternal(moofSize: number) {
                let moof: O<typeof MoofBox> = {
                    header: {
                        type: "moof"
                    },
                    type: "moof",
                    boxes: [
                        {
                            header: {
                                type: "mfhd"
                            },
                            type: "mfhd",
                            version: 0,
                            flags: 0,
                            sequence_number: 1
                        },
                        {
                            header: {
                                type: "traf"
                            },
                            type: "traf",
                            boxes: [
                                {
                                    header: {
                                        type: "tfhd"
                                    },
                                    type: "tfhd",
                                    version: 0,
                                    flags: {
                                        reserved3: 0,
                                        default_base_is_moof: 1,
                                        duration_is_empty: 0,
                                        reserved2: 0,
                                        default_sample_flags_present: 0,
                                        default_sample_size_present: 0,
                                        default_sample_duration_present: 0,
                                        reserved1: 0,
                                        sample_description_index_present: 0,
                                        base_data_offset_present: 0
                                    },
                                    track_ID: 1,
                                    values: {}
                                },
                                {
                                    header: {
                                        type: "tfdt"
                                    },
                                    type: "tfdt",
                                    version: 0,
                                    flags: 0,
                                    values: {
                                        baseMediaDecodeTime: 0
                                    }
                                },
                                {
                                    header: {
                                        type: "trun"
                                    },
                                    type: "trun",
                                    version: 0,
                                    flags: {
                                        reserved2: 0,
                                        sample_composition_time_offsets_present: 1,
                                        sample_flags_present: 0,
                                        sample_size_present: 1,
                                        sample_duration_present: 0,
                                        reserved1: 0,
                                        first_sample_flags_present: 1,
                                        reserved0: 0,
                                        data_offset_present: 1
                                    },
                                    sample_count: 20,
                                    values: {
                                        data_offset: moofSize + 8,
                                        first_sample_flags: {
                                            reserved: 0,
                                            is_leading: 0,
                                            sample_depends_on: 0,
                                            sample_is_depended_on: 0,
                                            sample_has_redundancy: 0,
                                            sample_padding_value: 0,
                                            // This resets the default in trex which sets sample_is_non_sync_sample to 1.
                                            //  So this essentially says this is a sync sample, AKA, a key frame (reading this
                                            //  frames syncs the video, so we can just read forward from any sync frame).
                                            sample_is_non_sync_sample: 0,
                                            sample_degradation_priority: 0
                                        }
                                    },
                                    sample_values: [
                                        {
                                            sample_size: 2826,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 328,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 337,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 271,
                                            sample_composition_time_offset: 5120
                                        },
                                        {
                                            sample_size: 241,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 222,
                                            sample_composition_time_offset: 0
                                        },
                                        {
                                            sample_size: 243,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 248,
                                            sample_composition_time_offset: 3072
                                        },
                                        {
                                            sample_size: 211,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 544,
                                            sample_composition_time_offset: 3072
                                        },
                                        {
                                            sample_size: 217,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 329,
                                            sample_composition_time_offset: 5120
                                        },
                                        {
                                            sample_size: 280,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 149,
                                            sample_composition_time_offset: 0
                                        },
                                        {
                                            sample_size: 238,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 328,
                                            sample_composition_time_offset: 2048
                                        },
                                        {
                                            sample_size: 306,
                                            sample_composition_time_offset: 4096
                                        },
                                        {
                                            sample_size: 200,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 217,
                                            sample_composition_time_offset: 1024
                                        },
                                        {
                                            sample_size: 646,
                                            sample_composition_time_offset: 4096
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                };
                return moof;
            }

            let size = writeIntermediate(createIntermediateObject(MoofBox, createMoofInternal(0))).getLength();
            let moof = createMoofInternal(size);

            return moof;
        }

        let outputs: (O<typeof RootBox>["boxes"][0] | LargeBuffer)[] = [];

        let ftyp: O<typeof FtypBox> = {
            header: {
                type: "ftyp"
            },
            type: "ftyp",
            major_brand: "iso5",
            minor_version: 1,
            compatible_brands: [
                "avc1",
                "iso5",
                "dash"
            ]
        };

        let moov = createMoov();

        let moof = createMoof();
        
        let mdat: O<typeof MdatBox> = {
            header: {
                size: 8389,
                headerSize: 8,
                type: "mdat"
            },
            type: "mdat",
            bytes: new LargeBuffer([new Buffer([0,0,0,27,103,244,0,22,145,155,40,19,6,124,79,128,182,64,0,0,3,0,64,0,0,5,3,197,139,101,128,0,0,0,5,104,235,227,196,72,0,0,2,174,6,5,255,255,170,220,69,233,189,230,217,72,183,150,44,216,32,217,35,238,239,120,50,54,52,32,45,32,99,111,114,101,32,49,53,53,32,114,50,57,48,49,32,55,100,48,102,102,50,50,32,45,32,72,46,50,54,52,47,77,80,69,71,45,52,32,65,86,67,32,99,111,100,101,99,32,45,32,67,111,112,121,108,101,102,116,32,50,48,48,51,45,50,48,49,56,32,45,32,104,116,116,112,58,47,47,119,119,119,46,118,105,100,101,111,108,97,110,46,111,114,103,47,120,50,54,52,46,104,116,109,108,32,45,32,111,112,116,105,111,110,115,58,32,99,97,98,97,99,61,49,32,114,101,102,61,51,32,100,101,98,108,111,99,107,61,49,58,48,58,48,32,97,110,97,108,121,115,101,61,48,120,49,58,48,120,49,49,49,32,109,101,61,104,101,120,32,115,117,98,109,101,61,55,32,112,115,121,61,49,32,112,115,121,95,114,100,61,49,46,48,48,58,48,46,48,48,32,109,105,120,101,100,95,114,101,102,61,49,32,109,101,95,114,97,110,103,101,61,49,54,32,99,104,114,111,109,97,95,109,101,61,49,32,116,114,101,108,108,105,115,61,49,32,56,120,56,100,99,116,61,48,32,99,113,109,61,48,32,100,101,97,100,122,111,110,101,61,50,49,44,49,49,32,102,97,115,116,95,112,115,107,105,112,61,49,32,99,104,114,111,109,97,95,113,112,95,111,102,102,115,101,116,61,52,32,116,104,114,101,97,100,115,61,49,50,32,108,111,111,107,97,104,101,97,100,95,116,104,114,101,97,100,115,61,50,32,115,108,105,99,101,100,95,116,104,114,101,97,100,115,61,48,32,110,114,61,48,32,100,101,99,105,109,97,116,101,61,49,32,105,110,116,101,114,108,97,99,101,100,61,48,32,98,108,117,114,97,121,95,99,111,109,112,97,116,61,48,32,99,111,110,115,116,114,97,105,110,101,100,95,105,110,116,114,97,61,48,32,98,102,114,97,109,101,115,61,51,32,98,95,112,121,114,97,109,105,100,61,50,32,98,95,97,100,97,112,116,61,49,32,98,95,98,105,97,115,61,48,32,100,105,114,101,99,116,61,49,32,119,101,105,103,104,116,98,61,49,32,111,112,101,110,95,103,111,112,61,48,32,119,101,105,103,104,116,112,61,50,32,107,101,121,105,110,116,61,50,53,48,32,107,101,121,105,110,116,95,109,105,110,61,49,48,32,115,99,101,110,101,99,117,116,61,52,48,32,105,110,116,114,97,95,114,101,102,114,101,115,104,61,48,32,114,99,95,108,111,111,107,97,104,101,97,100,61,52,48,32,114,99,61,99,114,102,32,109,98,116,114,101,101,61,49,32,99,114,102,61,50,51,46,48,32,113,99,111,109,112,61,48,46,54,48,32,113,112,109,105,110,61,48,32,113,112,109,97,120,61,54,57,32,113,112,115,116,101,112,61,52,32,105,112,95,114,97,116,105,111,61,49,46,52,48,32,97,113,61,49,58,49,46,48,48,0,128,0,0,8,44,101,136,132,0,191,243,8,167,248,159,153,95,180,254,95,152,89,37,247,177,234,225,92,167,240,59,1,165,171,34,149,62,26,91,57,19,250,242,103,157,28,178,137,221,121,129,227,199,47,69,240,68,85,151,250,250,254,160,231,171,6,208,30,11,69,6,197,252,33,207,144,163,152,235,6,57,213,14,203,235,184,224,17,15,255,85,191,190,111,93,188,211,213,57,212,187,125,106,173,219,148,45,58,0,210,87,138,226,247,133,45,218,8,192,164,95,89,123,162,187,169,144,5,187,231,63,94,88,182,29,136,138,151,164,80,189,188,39,230,74,114,65,150,27,14,15,104,99,96,254,46,0,0,3,0,0,3,0,0,3,0,0,3,0,4,77,24,234,196,255,236,79,106,76,253,93,97,5,145,214,15,67,141,44,8,33,159,43,118,100,34,200,184,108,142,123,201,186,166,158,111,242,230,70,23,90,154,185,170,99,233,241,165,78,100,41,12,7,41,34,227,2,31,164,80,167,144,201,166,13,90,38,145,143,1,188,72,37,87,125,165,97,10,192,195,237,2,230,8,78,44,242,124,81,215,229,76,141,147,115,108,43,11,206,198,233,86,182,224,90,4,251,183,253,206,154,135,227,31,63,104,100,172,117,68,42,244,122,238,26,47,71,202,83,53,160,67,47,230,13,65,32,87,105,47,21,72,38,26,92,109,21,1,217,160,167,235,9,240,38,252,47,155,141,23,188,21,128,45,183,136,87,102,160,227,148,3,93,224,205,181,92,35,222,149,129,254,79,109,115,140,87,78,152,242,172,223,133,129,10,243,199,22,178,72,228,60,208,184,169,149,234,195,57,87,59,28,234,181,71,244,219,160,125,85,228,208,50,103,76,129,230,202,36,135,157,5,78,44,83,255,63,232,30,49,116,123,89,202,58,51,115,135,31,201,59,3,223,86,122,236,181,27,79,225,21,231,198,63,145,252,243,197,46,20,203,223,94,97,115,225,122,205,3,226,218,233,114,4,244,21,238,105,245,199,165,61,211,202,126,240,7,112,192,48,50,206,158,202,101,219,154,70,85,255,95,42,168,52,118,222,108,81,161,164,192,176,215,254,45,124,56,42,72,112,3,63,69,53,22,255,179,222,208,88,153,141,220,3,68,173,1,191,40,224,44,215,59,182,109,252,111,104,51,219,245,128,97,85,168,35,21,51,94,226,184,207,194,187,128,108,182,211,251,113,94,191,39,223,49,133,60,101,60,133,69,11,53,25,41,137,155,201,178,246,195,27,175,10,224,91,39,93,254,159,159,123,120,93,240,32,186,170,122,111,150,181,52,101,228,118,11,98,175,141,54,88,191,162,207,17,141,162,176,27,157,105,68,221,243,232,25,192,39,206,252,132,1,52,117,233,164,135,141,200,186,222,189,122,122,28,84,212,3,77,85,130,184,181,129,253,230,131,161,8,197,5,25,18,85,104,42,109,109,130,127,139,33,248,75,104,72,142,218,35,229,42,252,231,50,162,208,59,51,205,208,162,232,78,168,93,248,61,15,225,161,131,151,223,203,14,214,191,129,109,181,5,38,152,28,59,11,121,105,100,103,196,45,73,188,186,28,232,60,185,234,38,210,236,215,191,50,101,175,1,27,190,217,56,250,243,177,1,167,235,111,117,4,54,169,160,162,112,159,195,13,210,65,252,4,173,9,90,115,233,102,227,232,40,139,250,37,250,102,131,2,149,13,139,185,29,116,69,67,161,141,161,127,50,29,5,137,191,112,7,125,24,155,33,56,240,193,128,225,91,155,126,37,108,161,9,151,73,45,194,79,70,117,84,198,253,208,233,183,196,150,22,162,247,113,9,224,52,61,145,95,76,74,115,91,149,198,242,153,95,208,255,111,42,86,79,146,117,13,52,87,75,61,167,193,141,182,128,231,72,138,183,227,84,93,33,180,100,8,217,57,122,147,201,227,161,13,231,255,174,16,162,222,247,60,1,20,210,185,242,36,243,17,197,107,184,116,100,214,190,101,162,198,221,11,141,57,120,225,227,245,25,149,29,183,59,200,232,198,182,153,162,184,232,86,74,203,191,38,54,44,51,157,232,205,58,40,84,56,13,185,98,184,219,169,190,92,204,221,229,98,83,17,49,68,108,40,158,78,7,185,255,231,245,179,171,23,171,36,53,17,142,24,172,159,188,83,5,248,26,242,184,16,157,2,200,203,48,162,159,219,157,203,92,2,154,107,182,184,47,196,0,0,3,0,0,185,175,119,24,87,104,191,219,111,14,142,139,105,90,141,32,142,245,72,4,232,142,255,255,28,39,25,234,116,154,19,211,119,61,51,207,76,115,103,48,157,229,184,177,233,202,206,207,175,214,179,172,65,26,66,211,12,9,58,121,34,248,189,50,111,222,228,200,201,139,206,31,71,8,172,113,169,10,139,52,193,157,197,220,163,250,131,70,117,167,159,113,162,62,83,228,241,19,110,65,200,105,151,94,178,149,118,252,239,131,145,158,131,18,17,27,88,123,250,185,146,43,94,199,51,48,37,48,10,128,99,136,134,109,246,30,172,158,55,203,194,243,184,177,247,100,57,244,39,254,132,139,129,35,132,10,101,178,116,78,166,209,237,231,235,251,82,163,244,212,36,169,81,240,115,195,110,84,103,143,103,34,57,109,110,56,254,225,87,93,44,107,3,93,247,230,177,115,44,244,51,53,41,32,149,22,123,49,197,1,224,230,90,58,165,132,8,238,114,2,237,234,120,17,120,38,19,187,229,108,69,5,102,31,242,181,243,250,243,68,94,109,170,121,36,104,163,50,47,81,16,129,235,4,72,65,155,38,119,234,66,184,107,107,127,132,13,166,23,248,54,44,21,148,39,96,15,201,8,71,44,200,193,203,217,215,74,56,125,19,229,255,152,55,97,98,108,223,108,170,103,26,3,79,190,170,13,204,128,18,29,177,61,195,23,94,24,162,98,110,252,69,28,1,69,243,21,108,16,202,19,240,242,170,238,204,105,158,229,58,130,113,147,213,77,200,111,193,156,41,204,7,95,11,207,148,233,234,65,214,6,180,60,214,43,154,234,235,166,232,30,137,96,245,233,0,101,204,9,229,36,169,212,192,61,137,19,211,194,33,126,240,210,30,152,70,163,224,27,153,148,116,114,5,71,47,167,101,150,214,153,212,37,76,173,190,131,16,29,79,234,246,254,133,157,139,193,108,147,60,148,59,133,21,195,23,241,201,155,51,141,74,82,164,241,217,250,94,197,8,199,187,20,38,154,190,94,26,195,117,102,55,64,144,212,27,182,231,112,129,119,205,14,1,27,33,31,179,184,49,128,141,163,39,8,0,0,26,189,174,192,134,164,188,191,81,34,210,59,1,106,236,133,7,29,182,166,45,82,61,92,110,195,207,226,67,16,55,39,13,213,194,74,169,5,204,52,155,40,85,240,168,212,19,0,161,73,116,202,224,225,84,196,57,65,0,17,155,244,223,105,142,201,181,119,150,243,40,28,103,250,148,102,77,27,249,179,208,63,9,255,103,199,97,211,158,170,43,61,183,125,27,21,218,185,53,3,46,234,138,177,17,102,115,178,63,223,49,69,250,36,89,70,80,61,220,31,44,20,229,134,219,60,212,213,33,136,130,108,255,62,42,246,248,216,3,192,221,194,37,96,105,105,169,198,98,150,155,252,254,41,197,29,24,246,48,248,142,57,187,63,145,102,1,95,69,144,103,213,174,93,136,239,19,68,143,171,10,65,20,87,75,120,236,28,172,136,50,224,89,45,75,150,171,111,27,165,186,186,94,14,170,12,102,212,138,225,202,152,131,34,91,162,96,126,208,22,38,59,152,233,52,52,91,124,111,88,250,56,167,198,34,142,254,251,184,198,41,85,114,95,204,129,201,119,153,62,65,227,147,205,19,203,160,76,193,39,228,48,45,68,148,140,94,168,109,9,17,33,37,204,148,234,86,102,128,220,141,218,84,192,237,181,152,109,224,36,118,87,141,23,153,200,222,175,80,51,21,166,197,33,161,68,198,54,86,24,249,24,66,95,95,140,123,26,103,31,104,96,37,1,88,148,80,101,236,119,214,48,191,238,193,102,13,15,171,21,114,204,7,171,123,92,199,201,106,134,110,167,241,156,229,215,88,252,193,66,141,108,227,152,142,44,114,62,13,101,31,202,199,103,92,199,92,223,96,218,217,166,135,214,38,13,203,112,211,147,247,82,177,172,43,66,31,18,215,246,17,81,86,55,135,19,55,177,192,227,240,96,44,97,134,154,52,225,135,147,156,252,5,161,82,47,160,215,145,70,208,216,195,192,115,228,186,41,123,6,152,158,65,6,254,245,255,204,177,199,45,147,206,152,177,157,199,191,163,167,125,193,236,33,242,247,254,224,66,165,23,167,84,90,156,58,222,206,52,30,185,201,115,44,95,132,189,155,169,27,115,188,215,67,50,81,54,234,33,127,174,232,145,197,196,212,238,144,131,231,46,168,186,208,68,126,176,205,31,124,184,11,1,112,96,13,251,155,35,16,56,53,135,240,41,183,31,177,252,10,107,134,241,252,10,108,118,221,36,155,76,185,193,64,96,4,96,125,36,104,208,0,67,160,3,204,129,107,112,220,80,234,161,17,129,224,68,47,140,184,37,136,191,0,0,3,0,0,3,0,0,3,0,0,3,0,0,3,0,0,3,0,7,249,0,0,1,68,65,154,33,108,75,255,86,209,67,99,45,132,104,39,249,103,110,98,0,61,190,0,97,197,79,186,21,106,215,138,59,50,37,15,182,175,214,189,119,224,145,102,81,251,125,48,90,111,176,89,140,123,5,22,102,18,158,11,108,98,231,97,83,221,18,1,80,222,182,0,0,3,0,0,3,0,15,45,84,98,19,72,65,245,123,55,94,254,85,189,6,152,22,151,122,247,208,111,195,206,147,6,202,106,210,54,93,126,4,217,221,160,114,157,243,178,8,67,180,61,31,73,37,72,209,89,89,193,248,109,192,156,210,105,115,201,190,97,145,239,35,95,229,205,237,131,44,142,110,134,136,158,4,219,93,151,36,219,237,122,228,19,234,68,73,50,47,182,171,145,85,70,75,165,65,199,32,154,176,155,206,18,2,123,208,52,7,33,198,178,221,138,84,168,184,100,243,76,70,221,230,118,144,165,68,222,251,204,208,198,209,23,115,176,88,35,109,153,3,143,231,127,227,251,51,37,178,215,119,255,118,169,150,81,234,204,170,246,205,210,97,75,81,2,40,125,28,222,111,102,209,102,62,126,242,166,240,120,210,248,147,148,45,133,54,77,226,204,89,172,183,243,88,50,230,183,114,81,128,47,128,18,36,4,6,57,249,84,65,56,225,114,228,171,231,39,223,156,245,198,16,59,234,194,78,116,25,47,241,203,70,190,237,87,55,181,201,225,0,0,3,0,4,108,0,0,1,77,65,154,66,60,33,147,41,132,191,135,166,127,184,101,242,169,130,65,38,113,161,125,94,7,39,101,248,143,193,7,184,71,167,13,199,111,111,151,103,195,252,247,36,65,101,199,175,209,138,197,187,181,17,251,87,71,7,4,112,231,121,88,236,247,200,199,121,184,149,150,250,245,200,185,179,229,243,65,105,199,113,223,46,59,137,221,231,117,130,171,3,4,197,189,76,18,64,145,101,59,233,145,22,102,211,42,199,240,171,125,168,149,63,123,252,188,181,161,97,97,214,109,167,248,185,73,214,66,171,213,230,126,221,151,15,60,71,171,113,85,97,139,208,119,42,181,175,199,250,157,51,244,190,197,104,122,18,66,172,142,71,237,133,182,71,187,168,200,97,86,2,6,1,229,30,27,37,13,143,237,119,97,60,140,86,197,34,57,28,241,99,177,217,175,174,93,211,107,105,76,46,109,244,164,1,125,205,158,246,217,241,192,27,243,253,81,18,84,55,177,94,113,78,199,23,120,75,132,235,47,154,57,56,18,15,218,103,142,44,84,110,48,176,18,158,229,45,213,36,129,190,5,64,6,1,133,204,176,20,96,73,79,91,176,197,206,47,13,94,9,102,127,10,136,105,173,219,108,166,154,64,150,91,213,227,64,20,240,79,209,136,166,163,3,33,217,144,200,247,109,177,142,88,95,239,102,253,152,48,37,8,76,140,146,122,9,83,135,69,163,159,77,89,138,184,50,178,76,96,0,0,21,177,0,0,1,11,65,154,102,73,225,15,38,83,2,95,135,155,251,1,226,126,206,125,1,227,148,226,206,75,254,118,127,190,189,80,78,46,32,75,22,177,146,33,253,183,139,31,251,184,65,190,118,176,155,27,168,120,186,192,223,92,34,31,192,11,243,198,117,112,220,73,21,120,161,133,255,87,188,98,64,211,109,212,90,77,173,0,172,93,2,71,42,235,100,151,28,152,7,232,110,138,49,85,178,170,146,45,97,28,170,17,188,217,153,12,6,106,229,43,113,28,110,115,45,95,74,237,144,16,106,169,97,233,20,128,160,142,150,236,5,123,17,146,0,144,250,198,90,70,118,138,17,76,37,67,216,228,154,5,217,233,180,49,107,226,154,87,187,192,192,175,216,48,228,29,62,186,188,48,218,167,186,139,21,227,83,203,136,132,173,245,252,238,99,84,93,117,158,4,253,97,23,128,184,58,97,223,10,193,118,224,132,58,236,71,233,43,76,134,37,82,136,202,147,8,251,185,63,215,54,92,42,224,21,53,45,64,39,18,155,204,9,250,158,114,183,226,96,17,156,36,39,180,184,246,190,215,121,40,88,127,159,170,254,142,152,245,144,0,0,37,96,0,0,0,237,65,158,132,69,17,60,119,104,114,123,183,48,106,209,167,239,110,235,167,253,54,188,76,168,247,25,2,217,39,155,166,143,145,22,106,49,201,26,26,52,182,29,128,174,112,50,246,235,67,59,36,155,71,26,113,73,73,38,148,49,101,171,199,17,32,128,120,146,182,99,134,158,46,181,71,110,255,78,66,102,82,101,104,108,32,33,74,103,100,104,247,108,11,12,128,132,62,14,217,49,195,118,106,85,186,144,17,180,73,70,154,205,23,115,108,244,119,43,161,129,10,130,13,182,250,115,81,142,66,36,33,76,76,17,140,72,138,111,152,94,35,223,154,144,185,92,166,50,93,204,15,73,37,156,158,249,226,11,38,251,129,98,239,181,137,223,189,126,182,155,177,141,227,12,202,99,22,242,22,140,95,53,131,196,187,131,28,249,210,129,70,85,48,52,235,243,159,247,0,65,44,186,86,189,117,65,148,22,12,59,77,44,16,147,190,254,104,48,6,33,67,240,162,233,185,124,78,216,13,68,43,196,74,0,0,12,9,0,0,0,218,1,158,163,116,66,95,120,11,48,158,0,81,164,153,18,12,202,112,176,143,111,186,155,175,26,21,97,159,163,72,216,11,36,115,83,189,117,91,127,167,253,160,117,166,180,19,198,65,77,9,202,36,176,9,130,225,35,237,111,191,51,125,169,176,126,178,35,86,157,26,74,30,24,198,205,7,190,103,216,196,144,0,14,195,105,129,182,64,130,36,95,196,183,238,206,181,226,212,73,217,124,191,52,209,13,225,242,87,173,182,6,192,205,126,186,81,195,163,160,188,242,6,98,73,231,101,19,108,20,81,7,149,26,242,91,77,139,115,237,116,196,69,230,89,71,220,27,221,110,36,153,125,138,175,101,13,194,175,75,196,6,228,7,212,201,228,183,25,182,88,20,184,197,220,130,56,128,244,154,100,60,163,182,54,73,112,135,138,68,20,135,39,6,19,160,93,249,56,142,83,29,94,74,72,176,238,115,11,75,68,68,15,94,192,0,0,202,129,0,0,0,239,1,158,165,106,66,95,119,239,14,187,210,235,203,243,184,26,68,56,153,229,35,35,224,93,77,74,100,204,81,244,147,133,60,100,114,181,25,168,105,217,187,75,184,102,76,77,199,7,95,206,78,95,221,124,206,250,70,0,153,31,117,249,149,131,142,132,169,4,40,219,28,26,196,94,102,22,1,205,113,253,233,183,109,195,154,28,79,175,125,119,102,240,143,209,43,210,74,64,182,221,152,34,75,119,38,13,181,253,177,148,241,191,40,183,70,175,143,116,68,39,183,202,175,214,238,170,35,188,158,145,226,6,59,172,19,130,28,221,150,48,69,233,31,172,125,249,230,194,160,132,200,9,12,66,86,41,167,69,73,211,206,101,249,124,205,203,24,89,114,44,101,196,207,4,27,169,196,21,69,40,207,177,145,45,118,217,0,135,1,121,74,7,68,219,11,212,19,109,113,17,171,30,248,30,100,9,86,154,45,127,242,239,70,183,107,14,211,245,241,168,232,224,52,50,167,222,69,131,234,62,188,73,99,236,192,0,0,170,129,0,0,0,244,65,154,168,73,168,65,104,153,76,20,242,255,135,156,43,155,65,144,77,7,194,35,140,147,243,228,173,41,36,233,231,116,56,14,190,240,26,185,226,110,24,234,157,194,243,181,36,111,241,245,102,244,185,22,119,232,138,15,211,17,85,87,28,22,80,149,172,39,84,30,34,125,231,104,19,101,80,2,3,83,119,44,191,162,205,203,55,204,135,191,247,32,46,176,109,83,246,36,249,175,23,170,71,143,200,61,230,19,79,21,48,95,157,189,79,230,207,179,36,26,233,176,106,156,97,106,138,102,107,152,103,177,64,18,224,36,167,57,27,79,114,27,87,95,102,216,11,168,172,218,8,154,19,255,230,1,155,197,59,208,42,130,12,215,62,226,0,132,192,85,147,36,133,176,154,10,37,235,86,234,64,106,161,159,55,111,206,166,167,237,62,47,36,166,195,59,108,84,149,217,95,10,190,255,200,8,7,199,60,34,122,80,105,147,48,120,30,97,169,69,103,81,235,202,81,127,234,123,250,85,200,215,100,74,137,214,83,93,173,128,0,0,53,161,0,0,0,207,1,158,199,106,66,95,120,88,203,248,58,51,196,252,138,99,184,29,117,11,190,61,193,181,162,87,144,130,36,93,137,36,146,216,12,141,135,158,179,120,159,231,112,67,242,130,18,227,159,225,205,86,84,28,115,21,27,45,22,99,199,175,83,249,38,37,71,163,87,84,39,186,138,86,35,135,61,124,243,24,230,176,103,113,127,148,28,151,54,55,86,217,73,203,28,34,235,253,105,199,176,73,96,32,86,95,22,1,101,75,39,127,146,153,176,199,71,64,40,133,161,73,79,190,244,9,83,132,88,36,253,26,171,0,222,114,159,242,213,118,29,235,177,30,254,82,225,65,112,144,156,1,245,133,246,171,185,255,12,21,174,63,196,200,247,210,52,175,199,206,37,11,106,235,133,165,7,53,181,199,232,94,7,109,5,81,157,246,65,210,154,118,253,145,161,169,13,145,33,158,52,104,192,0,0,170,128,0,0,2,28,65,154,202,73,225,10,82,101,48,82,203,255,135,170,134,144,1,237,228,229,210,126,131,190,134,108,79,212,100,119,236,19,134,193,42,160,176,44,134,6,30,63,202,116,22,161,16,148,106,208,108,68,97,246,197,23,255,127,255,19,87,163,9,252,255,74,240,219,176,135,25,109,97,225,247,31,42,91,179,181,158,186,75,214,231,190,39,15,101,220,126,181,246,200,242,119,86,172,94,218,88,147,117,137,136,232,109,196,129,153,62,112,155,114,107,121,228,226,223,244,36,15,32,199,99,179,112,250,20,195,236,158,91,146,29,135,3,245,199,27,199,111,19,198,2,67,47,101,238,210,53,239,78,146,15,23,132,33,103,44,67,218,200,124,11,6,71,151,65,233,26,99,16,78,234,167,60,126,34,200,160,164,178,78,41,249,59,233,167,39,90,174,82,198,0,142,126,60,98,7,54,51,24,107,189,20,177,244,99,227,218,230,94,185,87,100,127,90,248,46,41,230,25,115,79,141,21,178,84,180,67,145,59,110,71,142,54,124,245,167,165,100,245,11,44,206,8,202,187,201,113,67,116,125,168,54,91,183,136,110,245,213,45,228,113,227,7,169,231,65,17,224,46,126,45,35,110,134,236,200,210,165,161,159,137,223,10,183,145,125,34,78,128,181,121,245,165,225,5,114,135,6,243,110,223,130,161,35,111,89,202,62,175,93,60,27,47,127,55,103,101,63,57,54,117,149,60,166,122,183,248,182,193,62,112,16,81,81,229,34,207,104,62,27,208,89,30,98,191,180,87,144,221,95,170,122,138,113,21,21,42,48,65,117,42,28,151,114,195,113,245,104,64,85,182,184,70,105,221,102,238,204,181,24,201,199,247,25,54,238,113,16,103,65,14,254,176,133,201,226,64,197,90,46,42,178,98,183,144,148,188,164,107,174,217,229,236,21,12,226,242,237,242,158,2,136,146,172,9,195,104,223,236,45,237,137,14,72,208,65,147,143,93,15,124,166,17,243,168,123,99,215,71,214,254,235,196,186,168,26,6,148,67,65,201,246,123,131,171,182,161,235,107,103,112,107,56,105,149,106,199,237,151,52,222,59,127,95,159,255,249,46,252,175,199,130,184,129,55,201,192,79,197,194,250,101,84,233,93,30,47,29,80,177,140,28,49,169,86,102,3,123,149,156,248,21,23,66,232,44,54,99,40,214,147,160,0,0,188,128,0,0,0,213,1,158,233,106,66,95,117,90,48,73,25,149,251,233,200,246,57,219,67,247,155,67,116,167,172,54,131,66,114,235,179,163,243,32,109,127,18,56,220,162,73,158,58,230,84,33,232,40,143,201,175,157,56,90,37,74,41,92,130,168,48,101,221,129,233,57,132,69,182,97,171,181,100,163,58,24,139,171,209,127,102,15,159,229,172,126,125,237,57,222,178,88,76,60,64,224,201,37,54,133,69,84,211,180,173,73,135,15,52,254,2,49,135,10,69,64,87,212,192,46,77,97,131,21,98,254,89,252,63,114,53,81,167,192,149,214,239,221,6,245,129,5,96,8,10,225,107,201,42,255,60,210,29,116,253,34,190,29,170,2,82,191,231,150,175,237,96,253,217,254,217,142,68,195,243,91,89,56,171,209,20,81,148,107,112,54,201,55,36,189,209,231,14,100,96,155,177,238,86,183,98,221,202,231,23,177,152,154,192,0,0,50,161,0,0,1,69,65,154,238,73,225,14,137,148,192,151,255,135,76,110,119,217,130,38,2,89,60,70,176,207,125,105,153,103,202,117,152,253,109,92,124,221,247,61,255,196,9,105,61,188,156,125,1,129,148,7,23,251,99,196,98,253,25,239,12,234,27,161,143,96,211,223,189,134,175,213,193,206,9,241,81,124,44,56,240,252,244,22,253,113,216,34,159,200,3,202,125,245,250,152,86,104,255,80,130,5,99,207,51,229,51,223,165,76,224,35,29,137,215,42,81,62,67,130,42,207,99,217,164,33,156,78,88,128,104,244,237,243,123,19,215,33,135,248,202,247,1,103,232,113,178,136,151,146,170,113,156,169,111,141,190,166,63,227,139,162,169,54,207,105,57,253,26,255,134,161,159,75,211,131,79,145,227,115,110,250,238,52,201,205,205,133,126,114,179,90,6,82,57,88,149,243,52,190,132,96,82,127,69,29,214,194,60,170,222,19,1,220,40,251,209,151,171,113,1,151,101,215,221,227,134,248,79,42,19,238,15,180,227,22,60,227,5,139,253,27,7,190,194,193,158,49,141,253,216,85,20,129,97,212,169,209,6,82,29,46,63,183,186,83,54,43,155,19,248,10,211,163,16,132,185,72,73,57,133,61,141,57,9,102,167,16,62,230,226,200,127,82,179,199,40,251,13,236,240,240,7,139,89,204,69,149,38,231,33,202,177,18,115,174,209,130,242,201,119,189,128,0,0,244,128,0,0,1,20,65,159,12,69,21,60,119,93,196,17,231,10,78,187,148,5,129,162,169,215,202,48,53,182,178,35,212,101,219,150,61,0,73,162,17,144,55,132,210,31,179,216,54,21,189,185,105,70,171,127,180,128,69,55,90,29,90,156,51,194,109,80,25,10,28,122,193,211,199,194,61,121,179,121,111,0,168,182,29,112,194,204,112,97,15,155,223,84,48,135,192,244,195,186,199,133,216,56,80,142,137,121,12,208,21,211,87,80,77,118,51,226,41,142,73,26,139,15,7,104,69,199,79,2,75,101,3,45,135,163,222,83,124,162,114,49,230,72,87,193,115,179,93,175,83,6,120,178,234,238,80,72,20,227,70,39,76,160,251,71,199,173,107,68,0,166,92,144,13,19,59,149,194,210,87,194,121,96,90,106,59,6,144,186,25,183,35,157,130,193,195,65,45,224,59,102,76,203,24,64,159,115,104,225,154,234,7,28,208,106,245,159,89,181,203,239,102,110,221,16,112,195,17,12,20,119,140,140,1,114,238,76,41,142,110,208,85,60,232,64,67,252,129,9,51,250,122,74,25,120,31,103,25,100,211,110,162,155,101,136,98,197,128,252,3,47,132,89,226,195,220,140,0,0,15,72,0,0,0,145,1,159,43,116,66,95,109,122,85,199,0,191,148,204,118,179,79,149,230,0,1,253,248,168,24,17,255,78,156,109,121,102,209,69,233,20,12,27,177,255,210,203,65,72,158,144,181,96,223,62,13,153,56,23,172,201,62,13,1,20,246,186,221,83,111,44,227,185,15,80,164,47,105,247,224,20,234,205,239,196,68,54,40,44,252,186,140,96,21,172,204,241,19,23,149,250,159,201,0,84,2,188,1,239,231,255,52,75,166,131,125,142,231,157,166,224,136,184,26,193,162,225,230,86,15,112,35,239,132,250,219,239,156,103,162,228,51,43,11,0,0,3,0,222,129,0,0,0,234,1,159,45,106,66,95,109,122,85,194,107,24,56,163,65,155,220,251,176,220,178,192,226,115,161,250,242,81,96,47,182,101,103,54,158,59,46,60,66,76,24,50,86,32,214,60,167,3,209,90,181,4,35,25,21,14,40,119,228,93,176,185,30,237,123,202,140,122,197,35,49,179,117,220,37,12,252,59,93,105,88,223,188,168,190,86,90,168,218,159,113,126,66,184,229,213,252,63,5,5,226,121,9,101,100,39,145,237,139,201,239,51,1,214,10,191,63,36,128,61,190,10,23,133,247,190,179,32,161,126,211,203,254,231,225,113,230,59,47,144,16,242,65,20,164,159,104,187,237,69,52,109,19,109,41,122,232,194,72,178,143,212,149,94,99,122,112,133,83,173,54,7,99,163,38,8,151,67,156,191,104,154,0,104,117,114,108,193,145,96,167,61,111,197,181,181,31,66,116,210,158,2,85,213,87,68,127,108,136,206,96,83,94,84,146,165,213,215,42,146,64,35,149,197,63,252,10,213,159,6,0,0,5,157,0,0,1,68,65,155,47,73,168,65,104,153,76,9,127,135,60,67,4,170,178,162,29,20,124,249,109,77,193,8,125,156,119,235,250,87,46,252,144,231,109,200,80,253,180,159,71,54,105,176,224,93,32,36,45,30,198,214,59,0,101,243,67,136,108,164,5,26,170,251,232,165,56,9,78,155,15,51,13,198,128,150,181,83,138,252,241,111,123,9,202,179,27,61,194,152,1,227,251,81,96,83,217,223,153,253,195,113,2,65,32,100,202,50,125,156,202,123,178,135,187,120,133,108,210,1,16,153,21,37,140,34,224,81,138,37,119,185,183,176,193,119,44,146,212,234,179,122,174,134,116,59,227,139,40,166,84,233,143,22,10,215,34,157,150,137,52,5,149,86,94,43,86,214,4,191,154,210,148,84,152,192,17,192,58,88,58,92,10,151,147,177,12,89,182,229,223,68,22,250,63,61,98,217,14,203,50,133,47,224,160,11,179,217,183,185,22,248,204,1,80,169,248,85,47,95,179,135,71,56,205,206,178,242,2,192,199,13,252,228,207,29,254,72,3,13,27,242,27,171,112,213,2,1,181,200,101,35,170,119,106,184,156,28,138,61,142,91,191,27,48,63,79,127,253,166,214,216,194,34,26,15,75,102,152,148,211,88,108,41,193,187,52,179,57,115,161,28,45,179,167,141,131,241,104,131,160,12,96,201,49,54,44,110,117,226,79,169,132,84,106,238,0,0,3,0,224,129,0,0,1,46,65,155,82,73,225,10,82,101,48,37,255,135,56,37,191,116,9,175,136,54,13,124,239,200,25,123,113,29,153,235,167,116,79,112,10,160,24,218,196,143,28,240,24,132,79,255,254,103,102,156,170,220,54,153,97,103,112,200,225,86,174,234,8,70,119,176,3,80,58,151,253,32,221,96,238,172,63,199,169,141,150,58,210,183,235,251,194,167,245,121,78,229,103,191,205,133,173,254,27,217,103,253,166,20,241,68,189,33,13,147,33,202,140,209,169,113,134,167,43,123,26,241,59,185,105,37,194,188,183,192,108,59,178,111,182,58,193,146,201,16,157,225,164,169,91,1,148,8,149,155,201,76,169,17,31,137,170,244,201,227,172,33,49,124,54,2,212,221,214,62,149,247,251,233,255,138,14,6,68,110,220,46,100,144,60,16,149,151,67,50,34,165,180,111,203,32,81,67,249,80,234,174,35,167,90,147,111,77,122,30,152,126,143,211,236,45,3,140,171,36,209,202,184,255,27,81,28,123,142,105,98,67,54,184,86,206,141,89,65,252,79,151,130,210,255,171,95,121,171,29,188,49,191,161,2,197,134,209,12,69,228,96,90,19,47,101,81,91,121,78,110,177,79,136,152,6,43,6,200,18,35,192,61,5,156,101,108,11,192,190,30,22,75,136,239,251,134,96,0,0,52,96,0,0,0,196,65,159,112,69,52,76,33,255,94,90,19,70,53,107,238,95,197,183,66,225,238,130,18,20,229,51,40,192,159,142,44,62,225,221,163,117,177,88,63,71,1,70,239,176,128,149,54,206,157,137,31,181,179,115,97,188,72,189,67,208,4,9,97,185,239,191,43,46,66,196,15,157,118,6,92,161,152,65,14,217,130,23,103,144,101,138,165,209,228,240,35,105,99,62,106,118,213,162,195,225,241,188,201,225,22,128,251,172,25,234,18,100,28,254,140,92,91,102,124,76,154,189,3,49,108,0,116,9,157,214,88,236,7,63,160,246,78,163,68,103,142,27,5,28,38,93,9,139,4,81,187,101,146,147,166,4,148,226,120,28,63,198,62,98,210,241,198,139,38,6,154,12,161,185,32,70,205,96,123,244,1,133,239,32,23,210,35,249,252,1,65,170,128,0,1,103,0,0,0,213,1,159,145,106,66,95,108,234,249,54,216,223,88,206,210,248,236,191,147,119,87,185,225,42,7,170,42,202,172,219,239,231,16,41,200,10,237,231,96,106,101,81,141,3,237,244,142,252,241,100,137,189,158,151,86,108,232,135,54,54,239,3,104,155,188,160,73,55,107,116,194,3,196,179,130,213,16,160,204,107,17,118,6,231,64,227,187,39,172,212,31,110,91,120,107,14,173,238,97,135,201,47,195,235,152,71,6,180,220,58,236,23,153,175,141,163,149,222,207,17,46,89,6,114,156,195,48,99,42,182,249,4,95,203,206,22,199,71,253,186,90,176,87,55,59,73,102,83,12,40,48,230,223,86,39,80,231,119,222,133,118,197,126,19,47,179,40,254,66,42,17,8,144,240,8,0,29,86,119,164,249,67,144,150,160,159,151,63,143,118,201,5,255,124,175,52,92,52,78,184,50,246,154,214,119,72,225,250,0,0,3,3,231,0,0,2,130,65,155,149,73,168,65,104,153,76,9,127,135,153,9,41,248,183,46,62,185,238,253,74,23,237,209,177,139,254,35,12,185,48,45,149,13,253,152,57,228,5,227,64,160,244,134,230,27,240,4,199,99,42,161,130,185,83,179,49,12,3,96,40,158,192,150,21,155,133,190,42,36,148,241,168,24,179,137,86,23,143,217,113,132,186,148,20,57,101,221,152,6,245,222,200,28,66,32,132,194,17,16,24,43,253,25,115,238,158,179,206,146,203,245,188,194,127,11,238,137,135,24,192,0,0,3,0,0,3,0,241,81,117,243,116,139,90,95,117,158,57,210,58,194,73,236,235,53,136,197,144,0,0,130,80,110,165,181,252,218,22,232,91,224,75,254,201,25,217,9,206,236,241,160,103,146,230,191,233,66,109,226,72,223,142,53,134,46,133,16,55,167,125,59,3,23,13,149,119,30,58,145,107,129,137,150,220,187,19,176,168,247,239,126,159,179,149,19,1,139,183,233,10,235,51,128,37,36,220,75,199,191,246,252,9,91,152,134,248,234,67,65,196,48,10,1,141,183,100,205,187,218,174,97,190,186,254,124,139,131,127,147,241,199,13,181,242,124,57,72,230,142,7,143,45,111,66,68,127,144,151,177,103,222,194,105,159,4,173,236,98,138,162,12,81,14,94,235,171,236,165,184,29,240,157,103,154,46,210,149,210,250,177,45,168,145,229,53,215,47,233,180,8,118,135,51,165,178,166,188,200,9,192,121,121,52,88,19,38,245,153,56,158,198,136,41,150,6,247,166,1,220,159,85,220,250,105,149,71,83,164,247,221,24,166,60,165,162,40,159,83,11,21,210,208,97,53,90,148,67,191,238,55,187,106,120,82,40,150,114,160,45,214,177,190,49,136,45,41,180,231,39,180,99,40,147,8,81,5,53,122,248,179,144,39,85,198,214,135,186,16,64,173,134,171,162,67,207,8,183,216,47,163,12,45,0,139,54,95,129,1,200,246,180,188,27,236,125,134,49,180,18,171,146,41,180,199,150,218,148,45,5,139,155,143,84,38,197,24,37,163,107,29,176,228,119,101,83,10,232,40,60,48,222,186,184,128,132,217,205,87,81,6,226,188,108,243,175,88,50,100,57,181,29,2,136,128,21,181,28,218,188,240,86,247,201,187,106,102,99,158,155,148,22,126,113,75,44,127,125,20,230,75,166,236,203,225,9,183,172,181,222,90,42,119,108,255,15,46,208,45,150,230,136,9,54,70,222,137,116,184,238,207,213,244,193,111,110,6,82,32,141,47,16,160,175,178,234,34,192,250,86,254,35,167,60,170,228,89,91,180,191,148,108,101,178,219,24,56,236,151,121,205,154,85,242,67,200,163,145,226,79,52,45,245,64,85,96,74,138,208,67,61,114,40,0,0,3,0,0,3,0,0,162,169,150,0,0,3,0,2,62])])
        };
        
        let moofBuf = writeIntermediate(createIntermediateObject(MoofBox, moof));
        let mdatBuf = writeIntermediate(createIntermediateObject(MdatBox, mdat));

        let sidx = createSidx(moofBuf.getLength(), mdatBuf.getLength());


        outputs.push(ftyp);
        outputs.push(moov);
        outputs.push(sidx);
        outputs.push(moofBuf);
        outputs.push(mdat);

        //console.log(writeIntermediate(createIntermediateObject(MoovBox, moov)).getLength());
        //console.log(writeIntermediate(createIntermediateObject(SidxBox, sidx)).getLength());

        

        /*
        {
            header: {
                "type": "styp"
            },
            "type": "styp",
            "major_brand": "msdh",
            "minor_version": 0,
            "compatible_brands": [
                "msdh",
                "msix"
            ]
        },
        */

        let buffers: Buffer[] = [];
        for(let bufOrDat of outputs) {
            let subBuffer: LargeBuffer;
            if(bufOrDat instanceof LargeBuffer) {
                subBuffer = bufOrDat;
            } else {
                // RootBox has no extra values, so it can be used directly to read a single box
                let intOutput = createIntermediateObject(RootBox, { boxes: [bufOrDat] });
                subBuffer = writeIntermediate(intOutput);
            }
            for(let b of subBuffer.getInternalBufferList()) {
                buffers.push(b);
            }
        }

        return new LargeBuffer(buffers);
    }
}

process.on('uncaughtException', (x: any) => console.log(x));
async function wrapAsync(fnc: () => Promise<void>): Promise<void> {
    try {
        await fnc();
    } catch(e) {
        console.error(e);
    }
}

//todonext
// - Modify the frames inside test5.mp4 (the payload is just a mjpeg), so ensure we can still play it.
// - Make sure writeIntermediate works for youtube.mp4 (and add parsing for any new boxes)
// - Make sure we can put a payload from a full mp4 (test.h264.mp4) into a frament mp4 (youtube.mp4), and get a playable file.

//testYoutube();

//testReadFile("./raw/test5.mp4");

//testWriteFile("./raw/test5.mp4");
//testWriteFile("./youtube.mp4");

testReadFile("./10fps.dash.mp4");

// 

//wrapAsync(testRewriteMjpeg);
wrapAsync(testRewriteMp4Fragment);

//testRewriteMjpeg();

//console.log(MdatBox.header[BoxSymbol])


/*


//type idk = SerialObjectOutput<typeof MdatBox>;
//let idk!: idk;
//let x = idk.header.primitive[BoxSymbol];

let templateMp4 = "./raw/test5.mp4";
let buf = LargeBuffer.FromFile(templateMp4);
let output = parseBytes(buf, RootBox);


//RootBox.boxes.T1 = MdatBox

console.log(filterBox(FileBox, RootBox.boxes, output.boxes));
console.log(filterBox(FreeBox, RootBox.boxes, output.boxes));
console.log(filterBox(MdatBox, RootBox.boxes, output.boxes));
console.log(filterBox(MoovBox, RootBox.boxes, output.boxes));
//let xxx = filterBox(TkhdBox, RootBox.boxes, output.boxes);
//let y: number = x;
//let y = filterBox(TkhdBox, RootBox.boxes, output.boxes).header;





output.boxes;
//filterBox(MdatBox, RootBox.boxes, output.boxes);
*/