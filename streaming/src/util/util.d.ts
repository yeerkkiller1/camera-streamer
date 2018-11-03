interface DebugCallFrame {
    functionName: string;
    scriptId: string;
    url: string;

    // Errors are 1 based, but these objects are 0 based. And I don't think we can change this,
    //  as it comes from code that is likely going to be reused by other programs (maybe anything that
    //  asks for line information from the debugger? or at least stack traces?).
    lineNumber: number;
    columnNumber: number;
}

interface DebugAwaitObj {
    seqNum: number;
    generatorId: number;
    inspectorObject: {
        callFrames: DebugCallFrame[]
    }
}

declare function DebugAwait(): DebugAwaitObj[];