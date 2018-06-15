import { SerialObject, _SerialObjectOutput, P, R, SerialObjectChildBase, SerialObjectChildBaseToOutput, isSerialChoose, ChooseContext, isSerialPrimitive, SerialObjectPrimitiveToOutput, SerialPrimitiveMark, ReadContext, LengthObjectSymbol, isSerialObject, SerialObjectChild, SerialObjectChildToOutput, IsArrayInfinite, IsBoxLookup, GetBoxCount, _SerialIntermediateToFinal, SerialIntermediateChildBaseToOutput, isIntermediatePrimitive, SerialIntermediateChildToOutput, WriteContext, SerialObjectPrimitive, isSerialObjectPrimitiveLength, SerialObjectPrimitiveLength, SerialObjectPrimitiveParsing, TemplateToObject, ErasedKey, ErasedKey0, ErasedKey1, ErasedKey2, ErasedKey3 } from "./SerialTypes";
import { LargeBuffer, MaxUInt32 } from "./LargeBuffer";
import { isArray, assertNumber } from "./util/type";
import { mapObjectValues, keyBy, flatten } from "./util/misc";
import { sum } from "./util/math";
import { textFromUInt32, textToUInt32, writeUInt64BE } from "./util/serialExtension";

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

export const BoxAnyType = "any";

function cleanup(codeAfter: () => void, code: () => void) {
    try {
        code();
    } finally {
        codeAfter();
    }
}

function _parseBytes<T extends SerialObject>(buffer: LargeBuffer, rootObjectInfo: T): _SerialObjectOutput<T> {
    let isRoot = true;

    let debugPath: string[] = [];
    let pPos: P<number> = { v: 0 };
    let bitOffset = 0;

    let output: R<_SerialObjectOutput<T>> = { key: "v", parent: {v: {} as any} };
    parseObject(rootObjectInfo, output, buffer.getLength());

    if(bitOffset != 0) {
        console.warn(`Didn't read ${8 - bitOffset} bits. You should probably read all the bits, as the input buffer only contains full bytes.`);
    }

    return output.parent.v;

    function debugError(message: string) {
        return new Error(`${JSON.stringify(String(message))} in path ${debugPath.join(".")} at position ${pPos.v}`);
    }

    function parseObject(object: SerialObject, output: R<_SerialObjectOutput<SerialObject>>, end: number): void {
        /** True if our end should end our own object (so we should warn if we didn't read enough bytes). */
        let isEndSelf = false;

        if(isRoot) {
            isRoot = false;
            isEndSelf = true;
        }

        let outputObject: _SerialObjectOutput<SerialObject> = {} as any;
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
                    pPos,
                    bitOffset,
                };
                try {
                    outputValue.value = child.read(context);
                } catch(e) {
                    throw debugError(e);
                }
                bitOffset = context.bitOffset;
                if(bitOffset > 7) {
                    throw new Error(`bitOffset did not wrap properly. If it goes beyond 7, it should wrap around to 0.`);
                }
                if(bitOffset < 0) {
                    throw new Error(`bitOffset is < 0. This is clearly wrong.`);
                }

                // TODO: After we parse the value, change the last key to use the type from the box, instead of the property key.
                // TODO: Use the size info from the box info to warn when we don't completely parse the children.
                //  parseChildBase should have an output param that can set the end, which we also check when reading to see if we overrun.
                //  Also, we should pass this as a reaadonly to parseChild and parseObject.
                if(isSerialObjectPrimitiveLength(child)) {
                    let boxInfo = outputValue.value as ReturnType<typeof child.read>;
                    isEndSelf = true;
                    end = startPos + boxInfo.size;
                    setOurKey(child[LengthObjectSymbol] || "not possible");
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
                        
                        let boxType = firstChild && isSerialObjectPrimitiveLength(firstChild) && firstChild[LengthObjectSymbol] || undefined;
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
                                pPos: { ... pPos },
                                // Eh... I don't know if this will work.
                                bitOffset,
                            };
                            let header = Box(BoxAnyType).header as SerialObjectPrimitiveLength<{type: string}>;
                            let boxObj = header.read(context);
                            type = boxObj.type;

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

function _getFinalOutput<T extends _SerialObjectOutput>(output: T): _SerialIntermediateToFinal<T> {
    return getObjectOutput(output) as any as _SerialIntermediateToFinal<T>;

    function getObjectOutput(output: _SerialObjectOutput): _SerialIntermediateToFinal {
        let curOutput = {} as _SerialIntermediateToFinal;
        for(let key in output) {
            curOutput[key] = parseChild(output[key] as any);
            if(key === ErasedKey || key === ErasedKey0 || key === ErasedKey1 || key === ErasedKey2 || key === ErasedKey3) {
                let childObj = curOutput[key];
                if(!childObj || typeof childObj !== "object") {
                    throw new Error(`ErasedKey has invalid type. We were expecting an object (and not null)! Type: ${typeof childObj}`);
                }
                delete curOutput[key];
                for(let childKey in childObj) {
                    curOutput[childKey] = (childObj as any)[childKey];
                }
            }
        }    
        return curOutput;

        function parseChildBase(child: SerialObjectChildBaseToOutput): SerialIntermediateChildBaseToOutput {
            if(isIntermediatePrimitive(child)) {
                return child.value;
            } else {
                return getObjectOutput(child);
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

function _createIntermediateObject<T extends SerialObject>(template: T, data: _SerialIntermediateToFinal<_SerialObjectOutput<T>>): _SerialObjectOutput<T> {
    return getIntermediateOutput(template, data as any) as _SerialObjectOutput<T>;

    function getIntermediateOutput(template: SerialObject, data: _SerialIntermediateToFinal): _SerialObjectOutput {
        let parentData = data;
        let finalOutput = {} as _SerialObjectOutput;
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
                return getIntermediateOutput(child, data as _SerialIntermediateToFinal);
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
                    let childAsBoxes: {header: SerialObjectPrimitiveLength}[] = child as any;
                    let dataAsBoxes: _SerialIntermediateToFinal<_SerialObjectOutput<typeof BoxAny>>[] = data as any;

                    let childBoxLookup = keyBy(childAsBoxes, x => x.header[LengthObjectSymbol]);

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
export function getBufferWriteContext(buffer: Readonly<Buffer>): string {
    return (buffer as any)[WriteContextSymbol];
}
export function setBufferWriteContext(buffer: LargeBuffer, context: string): void {
    for(let buf of buffer.getInternalBufferList()) {
        (buf as any)[WriteContextSymbol] = context;
    }
}
export function copyBufferWriteContext(oldBuf: LargeBuffer, newBuf: LargeBuffer): void {
    let olds = oldBuf.getInternalBufferList();
    let news = newBuf.getInternalBufferList();

    for(let i = 0; i < news.length; i++) {
        (news[i] as any)[WriteContextSymbol] = (olds[i] as any)[WriteContextSymbol];
    }
}

function _writeIntermediate<T extends _SerialObjectOutput>(intermediate: T): LargeBuffer {
    let debugPath: string[] = [];
    function createContext(primitive: SerialObjectPrimitiveToOutput): string {
        return `${debugPath.join(".")}`;
    }

    let buffers: LargeBuffer[] = [];

    writeIntermediateObject(intermediate);

    return new LargeBuffer(flatten(buffers.map(x => x.getInternalBufferList())));

    function writeIntermediateObject(output: _SerialObjectOutput): void {
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

            if(isSerialObjectPrimitiveLength(primitive.primitive)) {
                setOurKey(primitive.primitive[LengthObjectSymbol]);
            }

            let context: WriteContext = {
                getSizeAfter,
                value: primitive.value,
            };
            didSizeAfterCall = false;
            let bufferOutput;
            try {
                if(isSerialObjectPrimitiveLength(primitive.primitive)) {
                    // Eh... cast to any here, as context won't have LengthObject, but that is fine...
                    bufferOutput = primitive.primitive.write(context as any);
                } else {
                    bufferOutput = primitive.primitive.write(context);
                }
            } catch(e) {
                console.error(output);
                throw e;
            }

            setBufferWriteContext(bufferOutput, createContext(primitive));

            let bufferIndex = buffers.length;
            buffers.push(bufferOutput);

            if(!inDelayedBufferCall && didSizeAfterCall) {
                recalculateBufferDelayed(bufferIndex, () => {
                    if(isSerialObjectPrimitiveLength(primitive.primitive)) {
                        // Eh... cast to any here, as context won't have LengthObject, but that is fine...
                        return primitive.primitive.write(context as any);
                    } else {
                        return primitive.primitive.write(context);
                    }
                });
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


export function parseObject<T extends SerialObject>(buffer: LargeBuffer, template: T): TemplateToObject<T> {
    return _getFinalOutput(_parseBytes(buffer, template));
}
export function writeObject<T extends SerialObject>(template: T, object: TemplateToObject<T>): LargeBuffer {
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

export function filterBox<T extends (BoxType<string> | string)>(inputIn?: T): FilterBox<T> {
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

// TODO: Move the special parsing logic for BoxLookup to somewhere else, as BinaryCoder doesn't really need to know about it.
export const Box: <T extends string>(type: T) => { header: SerialObjectPrimitive<{ size?: number; type: T, headerSize?: number }>; type: SerialObjectPrimitive<T>; } =
<T extends string>(typeIn: T) => ({
    header: {
        [LengthObjectSymbol]: typeIn,
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
    type: CodeOnlyValue(typeIn),
});

/** A string that exists in our code, but doesn't get written back to disk. Useful to adding values to the
 *      object data for intermediate parsing.
 */
export const CodeOnlyValue: <T>(type: T) => SerialObjectPrimitive<T> = <T>(value: T) => ({
    read({pPos, buffer}) {
        return value;
    },
    write(context) {
        return new LargeBuffer([]);
    }
});