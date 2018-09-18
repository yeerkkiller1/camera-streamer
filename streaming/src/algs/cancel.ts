import { PChan, Deferred, SetTimeoutAsync } from "pchannel";

const cancelError = Symbol("cancelled");

let fncId = 0;

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
                nextCallToken = ourCallToken;
                cancel();
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