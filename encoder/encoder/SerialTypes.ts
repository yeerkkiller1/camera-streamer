//*
import { LargeBuffer } from "./LargeBuffer";
import { isArray } from "./util/type";
import { Utf8AsciiLatin1Encoding } from "crypto";

const TestSymbol = Symbol();

const BoxLookupSymbol = Symbol();
type S = SerialObject;
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S, T8 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7, v8: T8, count?: number): (T1|T2|T3|T4|T5|T6|T7|T8)[];
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S, T7 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, v7: T7, count?: number): (T1|T2|T3|T4|T5|T6|T7)[];
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S, T6 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, v6: T6, count?: number): (T1|T2|T3|T4|T5|T6)[];
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S, T5 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, v5: T5, count?: number): (T1|T2|T3|T4|T5)[];
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S, T4 extends S>(v1: T1, v2: T2, v3: T3, v4: T4, count?: number): (T1|T2|T3|T4)[];
export function BoxLookup<T1 extends S, T2 extends S, T3 extends S>(v1: T1, v2: T2, v3: T3, count?: number): (T1|T2|T3)[];
export function BoxLookup<T1 extends S, T2 extends S>(v1: T1, v2: T2, count?: number): (T1|T2)[];
export function BoxLookup<T1 extends S>(v1: T1, count?: number): T1[];
export function BoxLookup(count?: number): never[];
export function BoxLookup(...arr: any[]): any[] {
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
export function IsBoxLookup(arr: SerialObjectChild[]): boolean {
    return BoxLookupSymbol in arr;
}
export function GetBoxCount(arr: SerialObjectChild[]): number|undefined {
    return (arr as any)[BoxLookupSymbol];
}

const ArrayInfiniteSymbol = Symbol();
export function ArrayInfinite<T extends SerialObjectChildBase>(element: T): T[] {
    let arr = [element];
    (arr as any)[ArrayInfiniteSymbol] = ArrayInfiniteSymbol;
    return arr;
}
export function IsArrayInfinite(arr: SerialObjectChild[]): boolean {
    return ArrayInfiniteSymbol in arr;
}


export type P<T> = { v: T };
export type R<T> = { key: string; parent: { [key: string]: T } };

export interface SerialObject<CurObject = any> {
    [key: string]: (
        SerialObjectChild<CurObject>
        // Undefined, as apparent if we have a function that sometimes returns a parameter, it is inferred to be
        //  in the returned object, but as optional and undefined. So adding undefined here makes chooseBox infinitely
        //  more useful (as it means it doesn't have to specify it's return type every time we have a chooseBox).
        | undefined
    );
}
export type SerialObjectTerminal<CurObject = any> = SerialObjectPrimitive | SerialObjectChoose<CurObject>;
export type SerialObjectChildBase<CurObject = any> = SerialObject<CurObject> | SerialObjectTerminal<CurObject>;
export type SerialObjectChild<CurObject = any> = SerialObjectChildBase<CurObject> | SerialObjectChildBase<CurObject>[];

export interface ReadContext {
    buffer: LargeBuffer;
    // We expect this to wrap around when it hits 8 to 0. If you increment it, and it doesn't wrap around, we may throw.
    //        Also, this is from lowest bit to highest bit (as that is how memory is usually laid out, and is how
    //            the h264 spec lays out it's memory). (Little endian)
    bitOffset: number;
    pPos: P<number>;
    end: number;
    endBits: number;
    debugKey: string;
}
export interface WriteContext<T = Types.AnyAll> {
    curBitSize: number;
    value: T;
    // Gets the size (in bytes) in the current object after our key. Also prevents our value or key from being in the curObject for the siblings after us.
    //  Ugh... really just for the box headers. Very unfortunate. I think the more correct way to do this would be to allow rearranging the
    //  children depending on if it is read/write. On read we put them at the beginning, on write we call them at the end, and then
    //  move their result to the beginning (giving them the data from the previous entries, which is okay). But for what we need now...
    //  this should be sufficient.
    getSizeAfter(): number;
}

export const HandlesBitOffsets = Symbol();

export const SerialPrimitiveName = Symbol();
export type SerialPrimitiveName = typeof SerialPrimitiveName;

export const LengthObjectSymbol = Symbol();
export type LengthObject = { size: number };
export type SerialObjectPrimitive<T = Types.AnyAll> = {
    [HandlesBitOffsets]?: true;
    [SerialPrimitiveName]?: string;
    read(context: ReadContext): T;
    write(context: WriteContext<T>): LargeBuffer;
};

export type SerialObjectPrimitiveParsing<T = Types.AnyAll> = SerialObjectPrimitive<T> | SerialObjectPrimitiveLength<T>;
export interface SerialObjectPrimitiveLength<T = Types.AnyAll, ObjType = string> extends SerialObjectPrimitive<T> {
    [LengthObjectSymbol]: ObjType;
    read(context: ReadContext): T & LengthObject;
}
export function isSerialObjectPrimitiveLength<T>(obj: SerialObjectPrimitiveParsing<T>): obj is SerialObjectPrimitiveLength<T> {
    return LengthObjectSymbol in obj;
}

export type ChooseContext<CurObject> = CurObject;


export const ChooseLoop = Symbol();
type ChooseLoop = typeof ChooseLoop;
export const ChooseLoopEnd = Symbol();
type ChooseLoopEnd = typeof ChooseLoopEnd;

export type SerialObjectChoose<CurObject = any> = (
    (
        context: ChooseContext<CurObject>,
        // The data result from the last iteration. undefined on the first iteration.
        prevFinalResult?: any //TemplateToObject // Setting this to TemplateToObject CRASHES THE COMPILER! So don't do that...
    ) => SerialObjectChild<CurObject> | ChooseLoopEnd
);
// We can't do this, as it makes typescript think this type is recursive. But this is what should trigger a loop
//& { [ChooseLoop]?: true };

// #region ChooseInfer types

type ChooseInferArray<R> = (
    R extends SerialObject[] ? _SerialObjectOutput<R[0]> :
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
    ReturnType<T> extends SerialObject ? _SerialObjectOutput<ReturnType<T>> :
    never
    //{ error: "SerialObjectChooseToOutput has limited inferring capabilities, and could not infer the output of a choose function. See the definition of SerialObjectChooseToOutput" }
);

export const SerialPrimitiveMark = Symbol();
export type SerialPrimitiveMark = typeof SerialPrimitiveMark;

export type SerialObjectPrimitiveToOutput<T extends SerialObjectPrimitive = SerialObjectPrimitive> = {
    primitive: T;
    value: ReturnType<T["read"]>;
    [SerialPrimitiveMark]: true;
    [SerialPrimitiveName]: string;
};
export function isIntermediatePrimitive<T extends SerialObjectPrimitive>(obj: SerialObjectChildBaseToOutput<any>): obj is SerialObjectPrimitiveToOutput<T> {
    return SerialPrimitiveMark in obj;
}
//*/

export type SerializeTerminalToOutput<T extends SerialObjectTerminal> = (
    T extends SerialObjectChoose ? SerialObjectChooseToOutput<T> :
    T extends SerialObjectPrimitive ? SerialObjectPrimitiveToOutput<T> :
    never
);

export type SerialObjectChildMap<T extends SerialObject[""]> = (
    T extends undefined ? undefined :
    T extends SerialObjectChild ? SerialObjectChildToOutput<T> : never
);

export type SerialObjectChildBaseToOutput<T extends SerialObjectChildBase = SerialObjectChildBase> = (
    T extends SerialObjectTerminal ? SerializeTerminalToOutput<T> :
    T extends SerialObject ? { [key in keyof T]: SerialObjectChildMap<T[key]> } :
    never
);

type ForceExtendsType<T, K> = T extends K ? T : K;
export type GetSerialObjectChildBaseArray<T extends SerialObjectChildBase[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildBase>
);

export type SerialObjectChildToOutput<T extends SerialObjectChild = SerialObjectChild> = (
    // Array first is important, to prevent any arrays with extra type values ([] & {}) from being recognized as objects, as they definitely aren't.
    T extends SerialObjectChildBase[] ? SerialObjectChildBaseToOutput<GetSerialObjectChildBaseArray<T>>[] :
    T extends SerialObjectChildBase ? SerialObjectChildBaseToOutput<T> :
    never
);

export type _SerialObjectOutput<T extends SerialObject = SerialObject> = {
    [key in keyof T]: SerialObjectChildMap<T[key]>;
};
export type TemplateToObject<T extends SerialObject = SerialObject> = _SerialIntermediateToFinal<_SerialObjectOutput<T>>;



export type SerializeIntermediateTerminalToOutput<T extends SerializeTerminalToOutput<SerialObjectTerminal>> = (
    T["value"]
);

export type SerialIntermediateChildBaseToOutput<T extends SerialObjectChildBaseToOutput = SerialObjectChildBaseToOutput> = (
    T extends SerializeTerminalToOutput<SerialObjectTerminal> ? SerializeIntermediateTerminalToOutput<T> :
    T extends _SerialObjectOutput<SerialObject> ? _SerialIntermediateToFinal<T> :
    never
);

export type GetSerialIntermediateChildBaseArray<T extends SerialObjectChildToOutput<SerialObjectChild>[]> = (
    ForceExtendsType<T extends (infer U)[] ? U : never, SerialObjectChildToOutput<SerialObjectChild>>
);
export type SerialIntermediateChildToOutput<T extends (SerialObjectChildToOutput<SerialObjectChild> | undefined) = SerialObjectChildToOutput> = (
    T extends undefined ? undefined :
    T extends SerialObjectChildBaseToOutput[] ? SerialIntermediateChildBaseToOutput<GetSerialIntermediateChildBaseArray<T>>[] :
    T extends SerialObjectChildBaseToOutput ? SerialIntermediateChildBaseToOutput<T> :
    never
);


type RemoveKey<T, K> = T extends K ? never : T;

// If this is a key, we erase it, take the result (which better be an object), and write it onto the parent (when iterating
//  over the child key, so it will wipe out anything before it, and be wiped out by anything after it).
//  (as a string, so I don't have to go change all my iterators)
export const ErasedKey = "_ErasedKeySpecial" as "_ErasedKeySpecial";
export const ErasedKey0 = "_ErasedKeySpecial0" as "_ErasedKeySpecial0";
export const ErasedKey1 = "_ErasedKeySpecial1" as "_ErasedKeySpecial1";
export const ErasedKey2 = "_ErasedKeySpecial2" as "_ErasedKeySpecial2";
export const ErasedKey3 = "_ErasedKeySpecial3" as "_ErasedKeySpecial3";
export const ErasedKey4 = "_ErasedKeySpecial4" as "_ErasedKeySpecial4";
export const ErasedKey5 = "_ErasedKeySpecial5" as "_ErasedKeySpecial5";
export const ErasedKey6 = "_ErasedKeySpecial6" as "_ErasedKeySpecial6";
export const ErasedKey7 = "_ErasedKeySpecial7" as "_ErasedKeySpecial7";
export const ErasedKey8 = "_ErasedKeySpecial8" as "_ErasedKeySpecial8";
export const ErasedKey9 = "_ErasedKeySpecial9" as "_ErasedKeySpecial9";
export const ErasedKey10 = "_ErasedKeySpecial10" as "_ErasedKeySpecial10";

type EraseKey<T extends { [key: string]: any } & { [ErasedKey]?: any, [ErasedKey0]?: any, [ErasedKey1]?: any, [ErasedKey2]?: any, [ErasedKey3]?: any; [ErasedKey4]?: any; [ErasedKey5]?: any; [ErasedKey6]?: any; [ErasedKey7]?: any; [ErasedKey8]?: any; [ErasedKey9]?: any; [ErasedKey10]?: any; }> = (
    { [key in RemoveKey<keyof T, typeof ErasedKey | typeof ErasedKey0 | typeof ErasedKey1 | typeof ErasedKey2 | typeof ErasedKey3 | typeof ErasedKey4 | typeof ErasedKey5 | typeof ErasedKey6 | typeof ErasedKey7 | typeof ErasedKey8 | typeof ErasedKey9 | typeof ErasedKey10>]: T[key] }
    & (typeof ErasedKey extends keyof T ? T[typeof ErasedKey] : {})
    & (typeof ErasedKey0 extends keyof T ? T[typeof ErasedKey0] : {})
    & (typeof ErasedKey1 extends keyof T ? T[typeof ErasedKey1] : {})
    & (typeof ErasedKey2 extends keyof T ? T[typeof ErasedKey2] : {})
    & (typeof ErasedKey3 extends keyof T ? T[typeof ErasedKey3] : {})
    & (typeof ErasedKey4 extends keyof T ? T[typeof ErasedKey4] : {})
    & (typeof ErasedKey5 extends keyof T ? T[typeof ErasedKey5] : {})
    & (typeof ErasedKey6 extends keyof T ? T[typeof ErasedKey6] : {})
    & (typeof ErasedKey7 extends keyof T ? T[typeof ErasedKey7] : {})
    & (typeof ErasedKey8 extends keyof T ? T[typeof ErasedKey8] : {})
    & (typeof ErasedKey9 extends keyof T ? T[typeof ErasedKey9] : {})
    & (typeof ErasedKey10 extends keyof T ? T[typeof ErasedKey10] : {})
);

type ApplyEraseKeyChild<T extends SerialIntermediateChildToOutput> = (
    T extends (infer U)[] ? U[] :
    T extends _SerialObjectOutput ? ApplyEraseKey<T> :
    T
);
type ApplyEraseKeyInner<T extends _SerialIntermediateToFinal> = {
    [key in keyof T]: ApplyEraseKeyChild<T[key]>
};
type ApplyEraseKey<T extends _SerialIntermediateToFinal> = (
    EraseKey<ApplyEraseKeyInner<T>>
);


export type _SerialIntermediateToFinal_Inner<T extends _SerialObjectOutput<SerialObject>> = {
    [key in keyof T]: SerialIntermediateChildToOutput<T[key]>;
};
export type _SerialIntermediateToFinal<T extends _SerialObjectOutput = _SerialObjectOutput> = (
    ApplyEraseKey<_SerialIntermediateToFinal_Inner<T>>
);


// #endregion


export interface MultiStageContinue<CurSerialObject extends SerialObject, CurSerialOutput> {
    (): CurSerialObject;
    <NextSerialObject extends SerialObject<CurSerialOutput>>(
        next: NextSerialObject
    ): MultiStageContinue<
    CurSerialObject & NextSerialObject,
    CurSerialOutput & _SerialIntermediateToFinal<_SerialObjectOutput<NextSerialObject>>
    >;
}


export function ChooseInfer(): MultiStageContinue<{}, {}> {
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

export function isSerialPrimitive(child: SerialObject[""]): child is SerialObjectPrimitive {
    return child !== undefined && !isArray(child) && typeof child === "object" && typeof (child as any).read === "function";
}
export function isSerialChoose(child: SerialObject[""]): child is SerialObjectChoose {
    return child !== undefined && !isArray(child) && typeof child === "function";
}
export function isSerialObject(child: SerialObject[""]): child is SerialObject {
    return child !== undefined && !isArray(child) && !isSerialPrimitive(child) && !isSerialChoose(child);
}
