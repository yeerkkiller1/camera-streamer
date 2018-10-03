// Unfortunately I can't figure out how to get this working with generic functions without chaining function calls.

export function fixErrorStack<
    Return extends Promise<any>, Args extends any[]
>(
    fncStackRemoveCount: number,
    fnc: (
        call: <CallReturn extends Promise<any>, CallArgs extends any[]>(selfRemoveCount: number, f: (...args: CallArgs) => CallReturn, ...args: CallArgs) => CallReturn,
        ...args: Args
    ) => Return
): (...args: Args) => Return {
    return wrappedFunction as any;
    async function wrappedFunction(this: any, ...args: Args): Promise<Return> {
        let parentStack = getStack().slice(1);

        // Ugh... apply isn't typed, but the result is undoubtably Return. And we can't call it with
        //  a regular call, or else we will lose the this context.
        let result = await fnc.call(this, call, ...args) as Return;
        return result;

        async function call<CallReturn, CallArgs extends any[]>(this: any, selfRemoveCount: number, f: (...args: CallArgs) => CallReturn, ...args: CallArgs): Promise<CallReturn> {
            let callFncStack = getStack();
            let parentCallEntry = callFncStack[1];

            try {
                return await f.call(this, ...args);
            } catch(e) {
                if(!(e instanceof Error)) {
                    console.warn(`Non-error thrown. Wrapping it in an Error object. Printing holder function, and then the function that threw the error.`);
                    console.log(fnc);
                    console.log(f);
                    e = new Error(e);
                }

                if(!(e instanceof Error)) {
                    throw new Error(`Impossible`);
                }

                // Remove ourself from the callstack.
                if(e.stack) {
                    let originalStack = e.stack.split("\n");

                    // Remove call from the callstack
                    let parentIndex = originalStack.indexOf(parentCallEntry);
                    let selfIndex = 0;
                    if(parentIndex < 0) {
                        // f.call must have thrown asynchronously, so it lost the call stack
                        // We must be on top of the callstack then
                        selfIndex = originalStack.length - 1;
                        originalStack = originalStack.concat(parentCallEntry);
                    } else {
                        // f.call must have thrown synchronously, so it has the whole stack.
                        //  We happened after the parent call, so we know where we are
                        selfIndex = parentIndex - 1;
                    }
                    //originalStack.splice(selfIndex - selfRemoveCount, 1 + selfRemoveCount + fncStackRemoveCount);

                    //originalStack.splice(1, 1);
                    e.stack = originalStack.join("\n");
                }

                e.stack = e.stack + "\n" + parentStack.join("\n");
                throw e;
            }
        }
    }
}

export function getStack(): string[] {
    let stack = new Error().stack;
    if(stack) {
        return stack.split("\n").slice(2);
    } else {
        return [];
    }
}
