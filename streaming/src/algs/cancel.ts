import { PChan, Deferred, SetTimeoutAsync } from "pchannel";
import { UnionUndefined } from "../util/misc";
import { fixErrorStack } from "../util/stack";

const cancelError = Symbol("cancelled");

let fncId = 0;

/** Creates a function that calls the underlying fnc. If there are no current calls, it calls the function.
 *      Otherwise it waits for the pending function to finish. If there is a previous call waiting, it cancels
 *      that calls, and replaces its spot as the function that is waiting to be called.
 */
export function createIgnoreDuplicateCalls<F extends (...args: any[]) => Promise<any>=any>(
    fnc: F
): ReplaceReturnType<F, ReturnType<F>|Promise<"CANCELLED">> & F {
    let nextCall = new Deferred<void>();
    let waitingCall: { args: any[]; result: Deferred<{ result: any } | "cancelled"> } | undefined;
    (async () => {
        while(true) {
            await nextCall.Promise();

            // Make a new nextCall deferred, so we catch any trailing calls.
            // Swap waitingCall with undefined, as we WILL be satisfying this call, and we don't want
            //  to let anything cancel it.
            nextCall = new Deferred<void>();
            if(waitingCall === undefined) {
                throw new Error(`No waiting call? Impossible.`);
            }
            let currentWaitingCall = waitingCall;
            waitingCall = undefined;

            // todonext
            // Preserve stack
            try {
                let result = await fnc(...currentWaitingCall.args);
                currentWaitingCall.result.Resolve({result});
            } catch(e) {
                currentWaitingCall.result.Reject(e);
            }
        }
    })();
    // TODO: This function should return ReturnType<F>, but typescript doesn't think that is a Promise, even though
    //  it has to be because of the F constraints.
    return fixErrorStack(0, async function call(callFixErrorStack, ...args: any[]) {
        if(waitingCall) {
            // So... this works, because we replace waitingCall with our Deferred, so even if nextCall
            //  is already resolved, by the time the run loop resumes it will find our waitingCall instead
            waitingCall.result.Resolve("cancelled");
        }
        waitingCall = { args, result: new Deferred() };
        let waitingCallChecked = waitingCall;

        // If nextCall is already resolved this is fine, we can resolve it multiple times.
        // If we are waiting on fnc already inside the run loop then nextCall will be for the next
        //  loop, so it will be fine.
        nextCall.Resolve();

        let resultObj = await callFixErrorStack(1, () => waitingCallChecked.result.Promise());

        if(resultObj === "cancelled") {
            return "CANCELLED";
        }
        return resultObj.result;
    }) as any;
}

export function createCancelPending<F extends (...args: any[]) => Promise<any>=any>(
    cancelPendingPromises: () => void,
    createFnc: (
        doAsyncCall: <FN extends (...args: any[]) => Promise<any>>
            (fnc: FN, ...args: ArgumentTypes<FN>) => ReturnType<FN>,
        isCancelError: (error: any) => boolean
    ) => F,
) {
    let currentCallCancel = new Deferred<void>();

    let ourFncId = fncId++;

    let inCall = false;
    let curCallToken = 0;
    let nextCallToken = 0;

    let nextNextCallToken = 0;

    function cancel() {
        cancelPendingPromises();
        currentCallCancel.Reject(cancelError);
    }
    
    const callId: ReplaceReturnType<F, ReturnType<F>|Promise<"CANCELLED">> & F = call as any;
    return Object.assign(
        callId,
        {
            isCancelError: (error: any) => error === cancelError,
            isInCall: () => inCall,
            cancel
        }
    );

    async function call(...args: any[]) {
        let ourCallToken = ++nextNextCallToken;
        let ourCallCancel: Deferred<void>;
        function doAsyncCall<F extends (...args: any[]) => Promise<any>>
        (fnc: F, ...args: ArgumentTypes<F>): ReturnType<F> {
            return Promise.race([
                ourCallCancel.Promise(),
                fnc(...args)
            ]) as any;
        }

        let fnc = createFnc(doAsyncCall, err => err === cancelError);


        if(inCall) {
            // Only call cancel for the first call that cancels it.
            if(nextCallToken === curCallToken) {
                console.log(`Cancelling previous call`);
                console.log(fnc);
                nextCallToken = ourCallToken;
                cancel();
                
                // Actually, if it is nested a few levels the exceptions it may take until the end of the current tick to bubble up.
                //  TODO: We can make infinitely nesting promises to wait until the end of this tick. But... SetTimeoutAsync is a lot easier.
                await SetTimeoutAsync(0);

                if(inCall) {
                    console.error(`Fnc did not cancel properly. Any async function in the target function should be wrapped in a doAsyncCall, and any errors that return true for isCancelError should be propogate upwards. Blocking until current function actually finishes`);
                    console.error(fnc);
                }
            } else {
                nextCallToken = ourCallToken;
            }
            try { await currentCallCancel.Promise() } catch(e) { }
            if(nextCallToken !== ourCallToken) {
                return "CANCELLED";
            }
            curCallToken = nextCallToken;
        }

        

        nextCallToken = ourCallToken;
        curCallToken = ourCallToken;
        ourCallCancel = currentCallCancel = new Deferred<void>();
        // Ignore exceptions. We only throw cancellation exceptions, and if they lose the Promise.race they are printed in the console,
        //  unless we catch them here.
        currentCallCancel.Promise().catch(() => {});

        //console.log("starting", { ourFncId, ourCallToken, curCallToken });

        let result!: ReturnType<F>;
        try {
            inCall = true;
            result = await fnc(...args);
        } catch(e) {
            if(e === cancelError) {
                //console.log("child cancelled", { ourFncId, ourCallToken, curCallToken });
                return "CANCELLED";
            }
            throw e;
        } finally {
            inCall = false;
            // Cancel all async calls after the main function ends.
            ourCallCancel.Reject(cancelError);
        }


        if(ourCallToken === ourCallToken) {
            //console.log("finished", { ourFncId, ourCallToken, curCallToken });
            return result;
        } else {
            //console.log("cancelled", { ourFncId, ourCallToken, curCallToken });
            return "CANCELLED";
        }
    };
}