import { textFromUInt32, readUInt64BE, textToUInt32, writeUInt64BE } from "./util/serialExtension";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray } from "./util/type";

const ArrayInfiniteSymbol = Symbol();
function RepeatInfinite<T extends SerialObjectChild>(value: T): T[] {
    let arr = [value];
    (arr as any)[ArrayInfiniteSymbol] = true;
    return arr;
}
function IsArrayInfinite(arr: SerialObjectChild[]): boolean {
    return ArrayInfiniteSymbol in arr;
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
interface SerialObjectPrimitive<T = Types.AnyAll> {
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
type SerialObjectChooseToOutput<T extends SerialObjectChoose<void>> = never ;//SerialObjectChildToOutput<ReturnType<T>>;

type SerialObjectPrimitiveToOutput<T extends SerialObjectPrimitive> = ReturnType<T["read"]>;

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

type ForceSerialObjectChildBase<T> = T extends SerialObjectChildBase<void> ? T : SerialObjectChildBase<void>;
type GetSerialObjectChildBaseArray<T extends SerialObjectChildBase<void>[]> = (
    ForceSerialObjectChildBase<T extends (infer U)[] ? U : never>
)

type SerialObjectChildToOutput<T extends SerialObjectChild> = (
    T extends SerialObjectChildBase<void> ? SerialObjectChildBaseToOutput<T> :
    T extends SerialObjectChildBase<void>[] ? SerialObjectChildBaseToOutput<GetSerialObjectChildBaseArray<T>>[] :
    never
);

type SerialObjectOutput<T extends SerialObject> = {
    [key in keyof T]: SerialObjectChildMap<T[key]>;
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


function isSerialPrimitive(child: SerialObjectChildBase): child is SerialObjectPrimitive {
    return child && typeof child === "object" && typeof (child as any).read === "function";
}
function isSerialChoose(child: SerialObjectChildBase): child is SerialObjectChoose<void> {
    return child && typeof child === "function";
}
function isSerialObject(child: SerialObjectChildBase): child is SerialObject {
    return !isSerialPrimitive(child) && !isSerialChoose(child);
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

const BoxSymbol = Symbol();
const Box: (type: string|null) => SerialObjectPrimitive<{ size: number, type: string }> =
    (typeIn: string|null) => ({
        [BoxSymbol]: typeIn,
        read(context) {
            let { buffer, pPos } = context;
            /*
                size is an integer that specifies the number of bytes in this box, including all its fields and contained
                    boxes; if size is 1 then the actual size is in the field largesize; if size is 0, then this box is the last
                    one in the file, and its contents extend to the end of the file (normally only used for a Media Data Box) 
            */
            let size = buffer.readUInt32BE(pPos.v); pPos.v += 4;
            let type = textFromUInt32(buffer.readUInt32BE(pPos.v)); pPos.v += 4;

            if(type === "uuid") {
                throw new Error(`Unhandled mp4 box type uuid`);
            }

            if(typeIn !== null && type !== typeIn) {
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
    boxes: RepeatInfinite(FileBox)
};


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
    parseObject(rootObjectInfo, output);
    return output.parent.v;

    function fatalError(message: string) {
        return new Error(`${message} in path ${debugPath.join(".")} at position ${pPos.v}`);
    }

    function parseObject(object: SerialObject, output: R<SerialObjectOutput<SerialObject>>): void {
        let outputObject: SerialObjectOutput<SerialObject> = {} as any;
        output.parent[output.key] = outputObject;
       
        for(let key in object) {
            debugPath.push(key);
            cleanup(() => { debugPath.pop(); }, () => {
                let child: SerialObject[""] = object[key];

                if(child === undefined) {
                    throw fatalError(`Child is undefined.`);
                }

                parseChild(child, { key, parent: outputObject });
            });
        }

        function parseChildBase(child: SerialObjectChildBase<void>, output: R<SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>>): void {
            if(isSerialChoose(child)) {
                let chooseContext: ChooseContext<void> = {
                    curObject: outputObject as any,
                    buffer: buffer,
                    pos: pPos.v,
                };
                let choosenChild = child(chooseContext);
                parseChild(choosenChild, output);
            }
            else if(isSerialPrimitive(child)) {
                // TODO: After we parse the value, change the last key to use the type from the box, instead of the property key.
                // TODO: Use the size info from the box info to warn when we don't completely parse the children.
                if(BoxSymbol in child) { }

                child

                throw new Error('');
            }
            else if(isSerialObject(child)) {
                // Eh... I don't know. We have to any cast, as the output of parseObject doesn't work with parseChildBase. But it should.
                return parseObject(child, output as any);
            }
            else {
                let childIsFinished: never = child;
                throw new Error(`Cannot handle child ${child}`);
            }    
        }

        function parseChild(child: SerialObjectChild<void>, output: R<SerialObjectChildToOutput<SerialObjectChild>>): void {
            if(isArray(child)) {
                let arr: SerialObjectChildBaseToOutput<SerialObjectChildBase<void>>[] = [];
                output.parent[output.key] = arr;

                if(IsArrayInfinite(child)) {
                    // Not really an array. Just a set of children that may exist, infinitely.
                    todonext
                    // We need to verify all children have BoxSymbol, and then use the value of that to determine which parser to use
                    //  Unless a parser has a type null. Then it matches everything (and it should be the only parser).
                } else {
                    // Fixed size arrays
                    for(let i = 0; i < child.length; i++) {
                        debugPath.push(i.toString());

                        // Any cast the arr, as it is okay to treat an array like an object in this context.
                        parseChildBase(child[i], { key: i.toString(), parent: arr as any });

                        debugPath.pop();
                    }
                }
            }
            else {
                parseChildBase(child, output);
            }
        }
    }
}