import { SetTimeoutAsync } from "pchannel";

describe("Promise", () => {
    it("catches leaking promises", async () => {
        class PromiseOverride<T> extends Promise<T> {
            constructor(...args: [any]) {
                super(...args);
                console.log("promise ctor");

                super.then(
                    () => { console.log("resolved"); },
                    () => { console.log("rejected"); }
                )
            }
        }
        let BasePromise = Promise;
        Promise = PromiseOverride;
        try {
            let what = (async () => {

            })();
            console.log(what);
            //await test();
        } finally {
            Promise = BasePromise;
        }
        async function test() {
            (async () => {
                //await SetTimeoutAsync(100);
                //throw new Error("test");
            })();
        }
    });
});