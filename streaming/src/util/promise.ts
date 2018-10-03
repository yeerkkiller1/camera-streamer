import { fixErrorStack } from "./stack";

let newPromiseStacks: string[][] = [];
export function setNewPromiseStack<T>(stack: string[], code: () => T): T {
    newPromiseStacks.push(stack);
    try {
        return code();
    } finally {
        newPromiseStacks.pop();
    }
}

/** Don't do new Promise<...>. Call this function, so error callstacks are preserved. */
export function newPromise<T>(
    code: (
        resolve: void extends T ? (value?: T | PromiseLike<T>) => void : (value: T | PromiseLike<T>) => void,
        reject: (err: any) => void
    ) => void
): Promise<T> {
    let rejected = false;
    let error = new Error();
    if(error.stack) {
        let stack = error.stack.split("\n").slice(2);
        stack = stack.concat(newPromiseStacks.reduce((x, y) => y.concat(x), []));
        error.stack = stack.join("\n");
    }

    return new Promise<T>((resolve, reject) => {
        function correctedReject(err: any) {
            // Only set the error.message for the first error, as subsequent errors should be ignored
            //  (and probably will be by the promise), and we don't want to corrupt the error object
            //  message (as there is only 1 error object) with different errors than the real (first) error.
            if(!rejected) {
                rejected = true;
                error.message = String(err);
                error.stack = error.message + "\n" + error.stack;
            }
            reject(error);
        }
        try {
            // as any, because my type is better than the native promise types (you shouldn't be able to resolve Promise<number> without a value!)
            code(resolve as any, correctedReject);
        } catch(e) {
            correctedReject(e);
        }
    });
}