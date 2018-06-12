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
import { writeFileSync, createWriteStream, readSync } from "fs";
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


function _parseBytes<T extends SerialObject>(buffer: LargeBuffer, rootObjectInfo: T): SerialObjectOutput<T> {
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
                let chooseContext: ChooseContext<void> = _getFinalOutput(outputObject) as any as void;
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

function _getFinalOutput<T extends SerialObjectOutput>(output: T): SerialIntermediateToFinal<T> {
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

function _createIntermediateObject<T extends SerialObject>(template: T, data: SerialIntermediateToFinal<SerialObjectOutput<T>>): SerialObjectOutput<T> {
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

function _writeIntermediate<T extends SerialObjectOutput>(intermediate: T): LargeBuffer {
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


type TemplateToObject<T extends SerialObject> = SerialIntermediateToFinal<SerialObjectOutput<T>>;
function parseObject<T extends SerialObject>(buffer: LargeBuffer, template: T): TemplateToObject<T> {
    return _getFinalOutput(_parseBytes(buffer, template));
}
function writeObject<T extends SerialObject>(template: T, object: TemplateToObject<T>): LargeBuffer {
    return _writeIntermediate(_createIntermediateObject(template, object));
}

type BoxType<T> = { type: T } | { type?: T } & BoxHolderType;
type BoxHolderType = { boxes: BoxType<string>[] };

type ForceBoxHolder<T> = T extends BoxHolderType ? T : never;
// Also delays the evaluate, because for some reason when this was inline it didn't work
type PickBox<Boxes extends BoxType<string>, T extends string> = (Boxes extends BoxType<T> ? Boxes : never);
interface FilterBox<Object = void> {
    // step
    <T extends string>(type: T): FilterBox<PickBox<ForceBoxHolder<Object>["boxes"][0], T>>;

    // finish
    (): Object;
}

function filterBox<T extends (BoxType<string> | string)>(inputIn?: T): FilterBox<T> {
    // Why isn't it assignable? Odd...

    let input: BoxType<string> | string = inputIn as any;
    if(input === undefined || typeof input === "string") {
        throw new Error(`The first call to filter box must be the template holder type.`);
    }
    
    function step(next?: string): any {
        if(next === undefined) {
            return input;
        }
        if(typeof next !== "string") {
            throw new Error(`Subsequent calls to the return of filterBox must either pass nothing, or a string.`);
        }

        if(input === undefined || typeof input === "string") {
            throw new Error(`Impossible`);
        }

        if(!("boxes" in input)) {
            throw new Error(`Cannot get box type ${next} inside box, as the box doesn't have a child of type 'boxes'`);
        }

        let entries = input.boxes.filter(x => x.type === next);
        if(entries.length === 0) {
            throw new Error(`No boxes of type ${next}. Expected 1. Found ${input.boxes.map(x => x.type).join(", ")}`);
        }
        if(entries.length > 1) {
            throw new Error(`Too many boxes of type ${next}. We found ${entries.length} boxes of that type.`);
        }

        let entry = entries[0];
        return filterBox(entry);
    }
    return step;
}




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

const languageBaseBitMapping = bitMapping({
    pad: 1,
    langChar0: 5,
    langChar1: 5,
    langChar2: 5,
});
const LanguageParse: SerialObjectPrimitive<string> = {
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

const TkhdBox = ChooseInfer()({
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
    language: LanguageParse,
    pre_defined: UInt16,
})
();

const HdlrBox = {
    ... FullBox("hdlr"),

    pre_defined: UInt32,
    handler_type: UInt32String,
    reserved: repeat(UInt32, 3),

    name: CString,
};

const VmhdBox = {
    ... FullBox("vmhd"),
    graphicsmode: UInt16,
    opcolor: repeat(UInt16, 3),
};

const UrlBox = {
    ... Box("url "),
    version: UInt8,
    flags: bitMapping({
        reserved: 23,
        media_is_in_same_file: 1
    }),
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
            flags.default_sample_flags_present ? {default_sample_flags: sample_flags} : {},
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
            values.first_sample_flags && index === 0 ? {} : flags.sample_flags_present ? {sample_flags: sample_flags} : {},
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
    let finalOutput = parseObject(buf, RootBox);

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

    console.log(`Write to ${basename(path)}`);
    writeFileSync(basename(path) + ".json", prettyPrint(finalOutput));
    
    //writeFileSync(basename(path) + ".json", prettyPrint(finalOutput.boxes.filter(x => x.type === "mdat")));

    //writeFileSync(basename(path) + ".json", "test");
}

function testWriteFile(path: string) {
    testReadFile(path);

    let oldBuf = LargeBuffer.FromFile(path);

    let finalOutput = parseObject(oldBuf, RootBox)
    let newBuf = writeObject(RootBox, finalOutput);

    testWrite(oldBuf, newBuf);

    console.log(oldBuf.getLength(), newBuf.getLength());
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
        let output = parseObject(buf, RootBox);
       
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

        return writeObject(RootBox, output);
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

    function readVideoInfo(buffer: LargeBuffer) {
        let h264Object = parseObject(buffer, RootBox);
       
        let box = filterBox(h264Object);
        let mdia = box("moov")("trak")("mdia");
        let timescale: number = mdia("mdhd")().times.timescale;

        let avcConfig = mdia("minf")("stbl")("stsd")("avc1")();

        let width = avcConfig.width;
        let height = avcConfig.height;

        let avcC = filterBox({boxes: avcConfig.config})("avcC")();

        let AVCProfileIndication = avcC.AVCProfileIndication;
        let profile_compatibility = avcC.profile_compatibility;
        let AVCLevelIndication = avcC.AVCLevelIndication;

        let stts = mdia("minf")("stbl")("stts")();

        if(stts.samples.length !== 1) {
            throw new Error(`Samples of varying duration. This is unexpected.`);
        }

        let sampleInfo = stts.samples[0];

        let frameTimeInTimescale = sampleInfo.sample_delta;

        // ctts table has times
        // stsz table has sample byte sizes.

        let mdat = box("mdat")();
        let stsz = mdia("minf")("stbl")("stsz")();
        let mdats: LargeBuffer[] = [];

        let pos = 0;
        for(let sampleSize of stsz.sample_sizes) {
            mdats.push(mdat.bytes.slice(pos, pos + sampleSize));
            pos += sampleSize;
        }

        let ctts = mdia("minf")("stbl")("ctts")();
        
        let frames: { buffer: LargeBuffer; composition_offset: number; }[] = [];

        let frameIndex = 0;
        for(let cttsInfo of ctts.samples) {
            for(let i = 0; i < cttsInfo.sample_count; i++) {
                frames.push({
                    buffer: mdats[frameIndex],
                    composition_offset: cttsInfo.sample_offset,
                });
                frameIndex++;
            }
        }

        todonext
        // Why does this not play all the frames? This should play 3 frames, but it plays 1 in vlc, and in chrome it plays 1,
        //  but then flashes the second frame when we refresh.
        frames = frames.slice(0, 3);

        // Hmm... the dash generate first sample is of size 2826, while the source is of size 2786. What?

        return {
            timescale,
            width,
            height,
            AVCProfileIndication,
            profile_compatibility,
            AVCLevelIndication,
            frameTimeInTimescale,
            frames
        };
    }

    type O<T extends SerialObject> = SerialIntermediateToFinal<SerialObjectOutput<T>>;
    function createVideo2(): LargeBuffer {
        //todonext
        // - Generate file from 10fps.h264.mp4
        //      - Start by parameterizing everything until it is greatly simplified and just takes a large buffer,
        //          and bytes offsets, and sample time offsets.
        //      - Generate trun from 10fps.h264.mp4 ctts
        //      - get width/height from 10fps.h264.mp4
        //      - translate timescale from 10fps.h264.mp4 (using the correct trak timescale, not the overall media timescale)
        //      - take the mdat from 10fps.h264.mp4
        //      - Make sure when it plays, it plays every single frame in 10fps.h264.mp4 (and doesn't skip the last few frames)
        // - create a new h264 media file, and read that data in and output a file for it.


        let h264Base = LargeBuffer.FromFile("./10fps.h264.mp4");

        let h264Object = readVideoInfo(h264Base);

        let timescale = h264Object.timescale;
        let frameTimeInTimescale = h264Object.frameTimeInTimescale;
        let width = h264Object.width;
        let height = h264Object.height;
        let AVCProfileIndication = h264Object.AVCProfileIndication;
        let profile_compatibility = h264Object.profile_compatibility;
        let AVCLevelIndication = h264Object.AVCLevelIndication;

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

        let keyFrameSampleFlags: SampleFlags = {
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
        };

        let nonKeyFrameSampleFlags: SampleFlags = {
            reserved: 0,
            is_leading: 0,
            sample_depends_on: 0,
            sample_is_depended_on: 0,
            sample_has_redundancy: 0,
            sample_padding_value: 0,
            sample_is_non_sync_sample: 1,
            sample_degradation_priority: 0
        };

        let moov = createMoov({
            defaultFlags: nonKeyFrameSampleFlags
        });

        let samples: SampleInfo[] = h264Object.frames.map(x => ({
            sample_size: x.buffer.getLength(),
            sample_composition_time_offset: x.composition_offset
        }));

        let moof = createMoof({
            sequenceNumber: 1,
            baseMediaDecodeTimeInTimescale: 0,
            samples,
            forcedFirstSampleFlags: keyFrameSampleFlags,
            //defaultSampleFlags: nonKeyFrameSampleFlags
        });
        
        let mdat: O<typeof MdatBox> = {
            header: {
                size: 0,
                headerSize: 8,
                type: "mdat"
            },
            type: "mdat",
            bytes: new LargeBuffer(flatten(h264Object.frames.map(x => x.buffer.getInternalBufferList())))
        };
        
        let moofBuf = writeObject(MoofBox, moof);
        let mdatBuf = writeObject(MdatBox, mdat);

        let sidx = createSidx({
            moofSize: moofBuf.getLength(),
            mdatSize: mdatBuf.getLength(),
            subsegmentDuration: samples.length * frameTimeInTimescale
        });

        outputs.push(ftyp);
        outputs.push(moov);
        outputs.push(sidx);
        outputs.push(moofBuf);
        outputs.push(mdat);

        let buffers: Buffer[] = [];
        for(let bufOrDat of outputs) {
            let subBuffer: LargeBuffer;
            if(bufOrDat instanceof LargeBuffer) {
                subBuffer = bufOrDat;
            } else {
                // RootBox has no extra values, so it can be used directly to read a single box
                subBuffer = writeObject(RootBox, { boxes: [bufOrDat] });
            }
            for(let b of subBuffer.getInternalBufferList()) {
                buffers.push(b);
            }
        }

        let finalBuffer = new LargeBuffer(buffers);

        console.log(finalBuffer.getLength());

        return finalBuffer;

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


        type SampleFlags = O<{x: typeof sample_flags}>["x"];

        function createMoov(
            d: {defaultFlags: SampleFlags}
        ): O<typeof MoovBox> {
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
                                // Index of sample information in stsd. Could be used to change width/height?
                                default_sample_description_index: 1,
                                default_sample_duration: frameTimeInTimescale,
                                default_sample_size: 0,
                                default_sample_flags: d.defaultFlags
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
                                flags: {
                                    reserved: 0,
                                    track_size_is_aspect_ratio: 0,
                                    track_in_preview: 0,
                                    track_in_movie: 1,
                                    track_enabled: 1
                                },
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
                                reserved2: 0,
                                matrix: [65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824],
                                width: width,
                                height: height,
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
                                        language: "und",
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
                                        reserved: [0,0,0],
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
                                                                flags: {
                                                                    reserved: 0,
                                                                    media_is_in_same_file: 1
                                                                }
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
                                                                // Index into dref
                                                                data_reference_index: 1,
                                                                pre_defined: 0,
                                                                reserved1: 0,
                                                                pre_defined1: [0, 0, 0],
                                                                width: width,
                                                                height: height,
                                                                // DPI. Useless, and always constant
                                                                horizresolution: 0x00480000,
                                                                vertresolution: 0x00480000,
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
                                                                        AVCProfileIndication: AVCProfileIndication,
                                                                        profile_compatibility: profile_compatibility,
                                                                        AVCLevelIndication: AVCLevelIndication,
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

        function createSidx(d: {moofSize: number, mdatSize: number, subsegmentDuration: number}): O<typeof SidxBox> {
            // There is a sidx per moof and mdat.
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
                    // Not used, doesn't matter?
                    earliest_presentation_time: 0,
                    // Not useful, we can just use reference_offset
                    first_offset: 0
                },
                reserved: 0,
                reference_count: 1,
                ref: [
                    // Nothing in here matters except reference_offset, and MAYBE subsegment_duration, but I am not even convinced of that.
                    {
                        // The whole SAP and reference_type garbage doesn't matter. Just put 0s, which means "no information of SAPs is provided",
                        //  and use sample_is_non_sync_sample === 0 to indicate SAPs. Also, sample_is_non_sync_sample is used anyway, so these values
                        //  are overriden regardless of what we do.
                        a: {
                            reference_type: 0,
                            reference_offset: d.moofSize + d.mdatSize
                        },
                        // Looks like this isn't used. But we could calculate it correctly, instead of however it was calculated by mp4box
                        subsegment_duration: d.subsegmentDuration,
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

        type SampleInfo = {
            sample_duration?: number;
            sample_size?: number;
            sample_flags?: SampleFlags;
            sample_composition_time_offset?: number;
        }
        function createMoof(d: {
            // Order of the moof. Counting starts at 1.
            sequenceNumber: number;
            baseMediaDecodeTimeInTimescale: number;
            samples: SampleInfo[];
            forcedFirstSampleFlags?: SampleFlags;
            defaultSampleDurationInTimescale?: number;
            defaultSampleFlags?: SampleFlags;
        }): O<typeof MoofBox> {

            let sample_durations = d.samples.filter(x => x.sample_duration !== undefined).length;
            let sample_sizes = d.samples.filter(x => x.sample_size !== undefined).length;
            let sample_flagss = d.samples.filter(x => x.sample_flags !== undefined).length;
            let sample_composition_time_offsets = d.samples.filter(x => x.sample_composition_time_offset !== undefined).length;

            if(sample_durations !== 0 && sample_durations !== d.samples.length) {
                throw new Error(`Some samples have sample_duration, others don't. This is invalid, samples must be consistent.`);
            }
            if(sample_sizes !== 0 && sample_sizes !== d.samples.length) {
                throw new Error(`Some samples have sample_size, others don't. This is invalid, samples must be consistent.`);
            }
            if(sample_flagss !== 0 && sample_flagss !== d.samples.length) {
                throw new Error(`Some samples have sample_flags, others don't. This is invalid, samples must be consistent. Even if there is a forceFirstSampleFlags, either ever sample needs flags, or none should have it.`);
            }
            if(sample_composition_time_offsets !== 0 && sample_composition_time_offsets !== d.samples.length) {
                throw new Error(`Some samples have sample_composition_time_offset, others don't. This is invalid, samples must be consistent.`);
            }

            let has_sample_durations = sample_durations > 0;
            let has_sample_sizes = sample_sizes > 0;
            let has_sample_flags = sample_flagss > 0;
            let has_composition_offsets = sample_composition_time_offsets > 0;

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
                            sequence_number: d.sequenceNumber
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
                                        // Eh... there is no reason to set this, as we can set the default flags in the moov (trex) anyway.
                                        default_sample_flags_present: d.defaultSampleFlags === undefined ? 0 : 1,
                                        // I can't imagine all samples having the same size, so let's not even set this.
                                        default_sample_size_present: 0,
                                        //  Also set in trex, but we MAY have different durations for different chunks.
                                        default_sample_duration_present: d.defaultSampleDurationInTimescale === undefined ? 0 : 1,
                                        reserved1: 0,
                                        sample_description_index_present: 0,
                                        base_data_offset_present: 0
                                    },
                                    track_ID: 1,
                                    values: Object.assign({},
                                        d.defaultSampleDurationInTimescale === undefined ? {} : { default_sample_duration: d.defaultSampleDurationInTimescale },
                                        d.defaultSampleFlags === undefined ? {} : { default_sample_flags: d.defaultSampleFlags }
                                    )
                                },
                                {
                                    header: {
                                        type: "tfdt"
                                    },
                                    type: "tfdt",
                                    version: 0,
                                    flags: 0,
                                    values: {
                                        baseMediaDecodeTime: d.baseMediaDecodeTimeInTimescale
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
                                        sample_composition_time_offsets_present: has_composition_offsets ? 1 : 0,
                                        sample_flags_present: has_sample_flags ? 1 : 0,
                                        sample_size_present: has_sample_sizes ? 1 : 0,
                                        sample_duration_present: has_sample_durations ? 1 : 0,
                                        reserved1: 0,
                                        first_sample_flags_present: d.forcedFirstSampleFlags === undefined ? 0 : 1,
                                        reserved0: 0,
                                        data_offset_present: 1
                                    },
                                    sample_count: d.samples.length,
                                    values: Object.assign(
                                        {data_offset: moofSize + 8},
                                        d.forcedFirstSampleFlags === undefined ? {} : { first_sample_flags: d.forcedFirstSampleFlags}
                                    ),
                                    sample_values: d.samples
                                }
                            ]
                        }
                    ]
                };
                return moof;
            }

            let size = writeObject(MoofBox, createMoofInternal(0)).getLength();
            let moof = createMoofInternal(size);

            return moof;
        }
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