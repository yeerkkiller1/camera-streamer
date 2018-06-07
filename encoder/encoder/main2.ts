import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray } from "./util/type";
import { keyBy, mapObjectValues } from "./util/misc";

const BoxLookupSymbol = Symbol();
type S = SerialObjectChild;
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S, T8 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7, v8: T8): (T1|T2|T3|T4|T5|T6|T7|T8)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7): (T1|T2|T3|T4|T5|T6|T7)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6): (T1|T2|T3|T4|T5|T6)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5): (T1|T2|T3|T4|T5)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S>(v1: T1, v2: T2, v3: T3, v4: T4): (T1|T2|T3|T4)[];
function BoxLookup<T1 extends S, T2 extends S, T3 extends S>(v1: T1, v2: T2, v3: T3): (T1|T2|T3)[];
function BoxLookup<T1 extends S, T2 extends S>(v1: T1, v2: T2): (T1|T2)[];
function BoxLookup<T1 extends S>(v1: T1): T1[];
function BoxLookup(...arr: any[]): any[] {
    (arr as any)[BoxLookupSymbol] = true;
    return arr;
}
function IsBoxLookup(arr: SerialObjectChild[]): boolean {
    return BoxLookupSymbol in arr;
}

type P<T> = { v: T };
type R<T> = { key: string; parent: { [key: string]: T } };

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

interface ReadContext {
    buffer: LargeBuffer;
    pPos: P<number>;
}
interface WriteContext<T> {
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

interface ChooseContext<CurObject> {
    // Has the values parsed in the keys before us. Use ChooseInfer to populate this properly.
    curObject: CurObject;

    buffer: LargeBuffer;
    pos: number;
}
type SerialObjectChoose<CurObject> = (context: ChooseContext<CurObject>) => SerialObjectChild<CurObject>;

// #region ChooseInfer types

// Eh... the choose function causes problem. It says it is recursive. I could probably fix this with manual recursion (just spitting out the
//  recursive path a lot of times, and then ending the final entry with never), but... let's try without that, and maybe I'll think of a way
//  to get this to work without that.
type SerialObjectChooseToOutput<T extends SerialObjectChoose<void>> = never;//SerialObjectChildToOutput<ReturnType<T>>;

const SerialPrimitiveMark = Symbol();
type SerialPrimitiveMark = typeof SerialPrimitiveMark;

type SerialObjectPrimitiveToOutput<T extends SerialObjectPrimitive> = {
    primitive: T;
    value: ReturnType<T["read"]>;
    mark: SerialPrimitiveMark;
};
function isIntermediatePrimitive<T extends SerialObjectPrimitive>(obj: SerialObjectChildBaseToOutput<any>): obj is SerialObjectPrimitiveToOutput<T> {
    return SerialPrimitiveMark in obj;
}

type SerializeTerminalToOutput<T extends SerialObjectTerminal> = (
    T extends SerialObjectChoose<void> ? SerialObjectChooseToOutput<T> :
    T extends SerialObjectPrimitive ? SerialObjectPrimitiveToOutput<T> :
    never
);

type SerialObjectChildMap<T extends SerialObject[""]> = (
    T extends SerialObjectChild ? SerialObjectChildToOutput<T> : never
);

type SerialObjectChildBaseToOutput<T extends SerialObjectChildBase<void>> = (
    T extends SerialObjectTerminal<void> ? SerializeTerminalToOutput<T> :
    T extends SerialObject ? { [key in keyof T]: SerialObjectChildMap<T[key]> } :
    never
);

type ForceExtendsType<T, K> = T extends K ? T : K;
type GetSerialObjectChildBaseArray<T extends SerialObjectChildBase<void>[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildBase<void>>
);

type SerialObjectChildToOutput<T extends SerialObjectChild> = (
    T extends SerialObjectChildBase<void> ? SerialObjectChildBaseToOutput<T> :
    T extends SerialObjectChildBase<void>[] ? SerialObjectChildBaseToOutput<GetSerialObjectChildBaseArray<T>>[] :
    never
);

type SerialObjectOutput<T extends SerialObject> = {
    [key in keyof T]: SerialObjectChildMap<T[key]>;
};



type SerializeIntermediateTerminalToOutput<T extends SerializeTerminalToOutput<SerialObjectTerminal>> = (
    T["value"]
);

type SerialIntermediateChildBaseToOutput<T extends SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>> = (
    T extends SerializeTerminalToOutput<SerialObjectTerminal> ? SerializeIntermediateTerminalToOutput<T> :
    T extends SerialObjectOutput<SerialObject> ? { [key in keyof T]: SerialIntermediateChildToOutput<T[key]> } :
    never
);

type GetSerialIntermediateChildBaseArray<T extends SerialObjectChildToOutput<SerialObjectChild>[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildToOutput<SerialObjectChild>>
);
type SerialIntermediateChildToOutput<T extends SerialObjectChildToOutput<SerialObjectChild>> = (
    T extends SerialObjectChildBaseToOutput<SerialObjectChildBase<void>> ? SerialIntermediateChildBaseToOutput<T> :
    T extends SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>[] ? SerialIntermediateChildBaseToOutput<GetSerialIntermediateChildBaseArray<T>>[] :
    never
);
type SerialIntermediateToFinal<T extends SerialObjectOutput<SerialObject>> = {
    [key in keyof T]: SerialIntermediateChildToOutput<T[key]>;
};

// #endregion

interface MultiStageContinue<CurSerialObject extends SerialObject> {
    (): SerialObjectOutput<CurSerialObject>;
    <NextSerialObject extends SerialObject<SerialObjectOutput<CurSerialObject>>>(
        next: NextSerialObject
    ): MultiStageContinue<CurSerialObject & NextSerialObject>;
}

/**
    ChooseInfer()
    ({ x: UInt32 })
    ({ y: UInt32String })
    ({
        k: (t) => {
            t.curObject.x;
            t.curObject.y;
            return null as any;
        }
    });
*/
function ChooseInfer(): MultiStageContinue<{}> {
    function multiStageContinue(): SerialObject;
    function multiStageContinue(next: SerialObject): MultiStageContinue<any>;
    function multiStageContinue(next?: SerialObject): MultiStageContinue<any>|SerialObject {
        return null as any;
    }

    return multiStageContinue;
}


function isSerialPrimitive(child: SerialObject[""]): child is SerialObjectPrimitive {
    return child !== undefined && !isArray(child) && typeof child === "object" && typeof (child as any).read === "function";
}
function isSerialChoose(child: SerialObject[""]): child is SerialObjectChoose<void> {
    return child !== undefined && !isArray(child) && typeof child === "function";
}
function isSerialObject(child: SerialObject[""]): child is SerialObject {
    return child !== undefined && !isArray(child) && !isSerialPrimitive(child) && !isSerialChoose(child);
}


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

const UInt32String: SerialObjectPrimitive<string> = {
    read: (context) => textFromUInt32(UInt32.read(context)),
    write: (context) => UInt32.write({ ...context, value: textToUInt32(context.value)}),  
};

const BoxAnyType = "any";
const Box: <T extends string>(type: T) => SerialObjectPrimitive<{ size: number, type: T }> =
    <T extends string>(typeIn: T): SerialObjectPrimitive<{ size: number, type: T }> => ({
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
                    type
                }
            } else {
                size = buffer.readUInt64BE(pPos.v); pPos.v += 8;
                return {
                    size,
                    type
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
    }
);


// All the boxes have to be SerialObjects... but... we want to keep the underlying types too, so SerialObjectOutput works.

const FileBox = {
    header: Box("ftyp")
};
const RootBox = {
    boxes: BoxLookup(FileBox)
};

{
    function typeTest() {
        type y = SerialObjectOutput<typeof RootBox>;

        let y!: y;
        y.boxes[0].header.primitive.read

        type x = SerialIntermediateToFinal<y>;

        let k!: x;
        k.boxes[0].header.size;
        k.boxes[0].header.type;
    }
}

/*
y.boxes
y = {
    boxes: [{ header: {primitive: Box("ftyp"), value: {type: "ftyp", size: 0}}, test: { primitive: UInt32, value: 5 } }]
};
*/

testYoutube();

function testYoutube() {
    let buf = LargeBuffer.FromFile("./youtube.mp4");
    let output = parseBytes(buf, RootBox);
    console.log(output);
}

function cleanup(codeAfter: () => void, code: () => void) {
    try {
        code();
    } finally {
        codeAfter();
    }
}

function getFinalOutput<T extends SerialObjectOutput<SerialObject>>(output: T): SerialIntermediateToFinal<T> {
    return getFinalObjectOutput(output) as SerialIntermediateToFinal<T>;

    function getFinalObjectOutput(output: SerialObjectOutput<SerialObject>): SerialIntermediateToFinal<SerialObjectOutput<SerialObject>> {
        let finalOutput = {} as SerialIntermediateToFinal<SerialObjectOutput<SerialObject>>;
        for(let key in output) {
            let child = output[key] as SerialObjectOutput<SerialObject>[""];
            
            finalOutput[key] = parseChild(child);
        }    
        return finalOutput;

        function parseChildBase(child: SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>): SerialIntermediateChildBaseToOutput<SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>> {
            if(isIntermediatePrimitive(child)) {
                return child.value;
            } else {
                return getFinalOutput(child);
            }
        }
        function parseChild(child: SerialObjectChildToOutput<SerialObjectChild>) {
            if(isArray(child)) {
                let arr: SerialIntermediateChildBaseToOutput<SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>>[] = [];
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
    let debugPath: string[] = [];
    let pPos: P<number> = { v: 0 };

    let output: R<SerialObjectOutput<T>> = { key: "v", parent: {v: null as any} };
    parseObject(rootObjectInfo, output, buffer.getLength());
    return output.parent.v;

    function debugError(message: string) {
        return new Error(`${JSON.stringify(String(message))} in path ${debugPath.join(".")} at position ${pPos.v}`);
    }

    function parseObject(object: SerialObject, output: R<SerialObjectOutput<SerialObject>>, end: number): void {
        /** True if our end should end our own object (so we should warn if we didn't read enough bytes). */
        let isEndSelf = true;
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
            cleanup(() => { debugPath.pop(); }, () => {
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
        }

        function parseChildBase(child: SerialObjectChildBase<void>, output: R<SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>>): void {
            if(isSerialChoose(child)) {
                let chooseContext: ChooseContext<void> = {
                    // Hmm... this isn't efficient... but we should have that many chooses, right? Or at least, not chooses too close to the root,
                    //  so hopefully this doesn't become exponential.
                    curObject: getFinalOutput(outputObject) as any,
                    buffer: buffer,
                    pos: pPos.v,
                };
                let choosenChild = child(chooseContext);
                parseChild(choosenChild, output);
            }
            else if(isSerialPrimitive(child)) {
                let outputValue: SerialObjectPrimitiveToOutput<typeof child> = {
                    primitive: child,
                    value: null as any,
                    mark: SerialPrimitiveMark
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
                    end = boxInfo.size;

                    setOurKey(boxInfo.type);
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

                if(IsBoxLookup(child)) {
                    if(!isEndSelf) {
                        throw debugError(`Key says to read until end of box, but we found no box header. So... this won't work, we don't know where to stop reading.`);
                    }
                    if(!isLastKey) {
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

                    let index = 0;
                    while(pPos.v < end) {
                        let type: string;
                        {
                            // All boxes should have their box type as their first child. So we can parse the box type easily, without calling anything on the children.
                            let context: ReadContext = {
                                buffer,
                                // Copy pPos, as this read is just to get the box, and shouldn't advance the position.
                                pPos: { ... pPos }
                            };
                            let boxObj = Box(BoxAnyType).read(context);
                            type = boxObj.type as string;
                        }

                        if(!(type in boxLookup) && BoxAnyType in boxLookup) {
                            type = BoxAnyType;
                        }

                        if(!(type in boxLookup)) {
                            throw debugError(`Unexpected box type ${type}. Expected one of ${Object.keys(boxLookup).join(", ")}`);
                        }

                        let box = boxLookup[type];
                        parseChildBase(box, { key: index as any as string, parent: arr as any });
                        index++;
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