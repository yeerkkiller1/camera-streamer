import { keyBy } from "./misc";

function formatStack(stack: DebugAwaitObj["inspectorObject"]["callFrames"]): string {
    return stack.map(callFrame => `${callFrame.url}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1}`).join("\n");
}

export async function itThrowOnPendingAwaits(name: string, code: () => Promise<void>|void) {
    return it(name, () => {
        // Don't use async, so this call doesn't get picked up as an unfinished await inside throwOnTrailingAwaits
        //  (which it would, as it wouldn't be awaited before DebugAwait is synchronously called).
        return Promise.resolve(throwOnTrailingAwaits(code));
    });
}

todonext
// 1) Use custom nodejs build with pchannel async stack fixing, async error fixing and leaked async stuff
//  to debug leaky SmallDiskList.test unit tests.
// 2) Make SmallDiskList support dequeuing the oldest element
// 3) Make LargeDiskList support dequeuing the oldest chunk
// 4) Make the wrapper of LargeDiskList support dequeuing
// 5) Make the storage manager user the wrapper of LargeDiskList
// 6) Plug that into the UI
// 7) Run it, and set it up with wasabi/backblaze/whatever

export async function throwOnTrailingAwaits(code: () => Promise<void>|void) {
    let initialAwaits = keyBy(DebugAwait(), x => x.seqNum.toString());

    let errors: unknown[] = [];
    let functionError = false;
    try {
        await code();
    } catch(e) {
        if(typeof e !== "object" || !(e instanceof Error)) {
            console.error(`Someone threw an error that has a non Error type, "${String(e)}", type ${(typeof e)}.`)
        }
        functionError = true;
        errors.push(e);
    }

    let finalAwaits = keyBy(DebugAwait(), x => x.seqNum.toString());

    // Hmm... I am considering making this less strict. If we block on a line
    //  that we were blocking on before (but now aren't), it isn't REALLY a problem, it just means some
    //  management loop ran, that might always be running, and won't result in leaks.
    let extraCallFrameCounts: {
        [source: string]: {
            call: DebugAwaitObj;
            source: string;
            count: number;
        }
    } = {};
    for(let key in finalAwaits) {
        if(key in initialAwaits) continue;
        let call = finalAwaits[key];
        let source = formatStack(call.inspectorObject.callFrames);
        if(!extraCallFrameCounts[source]) {
            extraCallFrameCounts[source] = {
                call,
                source,
                count: 0,
            };
        }
        extraCallFrameCounts[source].count++;
    }

    for(let obj of Object.values(extraCallFrameCounts)) {
        let err = new Error();
        err.message = `Trailing (count ${obj.count}) await in function "${obj.call.inspectorObject.callFrames[0].functionName || `NO NAME`}"`;
        err.stack = `${obj.source}`;
        if(!obj.source.includes(`wallabyjs.wallaby-vscode`)) {
            console.error("Non project error", err.message, err.stack);
        } else {
            console.log(obj.source);
        }
        //console.log(err.message, obj.source);
        errors.push(err);
    }

    if(errors.length === 0) {
        return;
    } else if(errors.length === 1 && false) {
        throw errors[0];
    } else {
        for(let error of errors) {
            setTimeout(() => Promise.reject(error));
        }
        let count = errors.length;
        if(functionError) {
            count--;
        }
        console.log(`Multiple trailing awaits (count ${count})${!functionError ? "" : " (plus the code threw an error)"}`);
        await new Promise(() => {});
    }
}