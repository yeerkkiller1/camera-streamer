import { SetTimeoutAsync } from "pchannel";
import { keyBy } from "./misc";
import { itThrowOnPendingAwaits, throwOnTrailingAwaits } from "./promiseAssert";
import { setNewPromiseStack } from "./promise";

function e(message: string, stack: string) {
    let err = new Error();
    err.message = message;
    err.stack = stack;
    return err;
}
function reject(message: string, stack: string) {
    (async function re() {
        Promise.reject(e(message, stack));
    })();
}

//*
// file.only
fdescribe("Promise", () => {
    it("example", async () => {
        // Okay, so only the first error gets printed? But... hmm... some of the time I do see multiple errors, must be a setTimeout thing?
        // But one and two don't print stack traces.

        // Looks like the source info is taken from the top most location that is OUR code (don't know what that means).

        // So... the only way to have multiple promises register, they need to be thrown in different setTimeouts. And then they get thrown in the global file context,
        //  not associated with any test.
        // AND, only one promise rejection can occur per setTimeout (or in the synchronous scope), so if you try to reject multiple, then the subsequent ones will
        //  be ignored.

        /*
        setTimeout(() => {
            Promise.reject(e("one", `
            C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:412:41
            C:/Users/quent/.vscode/extensions/wallabyjs.wallaby-vscode-1.0.99/projects/51e962d571639f4b/instrumented/src/util/Promise.test.js:15:36
            `));
        });
        setTimeout(() => {
            Promise.reject(e("three", `
            C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:412:41
            `));
        });

        setTimeout(() => {
            Promise.reject(e("two", `at result.then (C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:866:46)`));
        });
        //*/

        //reject("two", `at result.then (C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:866:46)`);
        //Promise.reject(e("two", `at result.then (C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:866:46)`));
        //Promise.reject(e("three", `at result.then (C:/Users/quent/Dropbox/pchannel/dist/pchannel.js:866:46)`));

        //Promise.reject("uncaught promise rejection").catch(() => {});
        //await new Promise(() => {});

        //throw new Error("fail");
    });

    //todonext
    // So... I want the whole callstack for DebugAwait calls, so the source link in wallaby is somewhat useful.
    /*
    it("catches leaking promises", async () => {
        let initialAwaits = keyBy(DebugAwait(), x => x.seqNum.toString());

        let err!: Error;
        function outerSync() {
            (async function name() {
                async function innerAsyncFnc() {
                    err = new Error();
                    await SetTimeoutAsync(0);
                    console.log("here", new Error().stack);
                }
                await innerAsyncFnc();
            })();
        }
        outerSync();

        console.log(err.stack);

        let finalAwaits = keyBy(DebugAwait(), x => x.seqNum.toString());
        await SetTimeoutAsync(0);
        

    });
    //*/
});
//*/

/*
message Expected an error stack Error: Expected an error
    at result.then (C:/Users\quent\Dropbox\pchannel\dist\pchannel.js:866:46)
src/util/promiseAssert.ts:72:12
message Trailing (count 1) await in function "NO NAME" stack C:\Users\quent\Dropbox\pchannel\dist\pchannel.js:412:41
*/