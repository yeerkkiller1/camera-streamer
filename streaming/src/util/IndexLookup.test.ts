import { ThrowIfNotImplementsData, ThrowsAsync, PChanFromArray, PChanFromGenerator } from "pchannel";
import { IndexLookup } from "./IndexLookup";

xdescribe("IndexLookup", () => {
    describe("basic", () => {
        it("speedTest", async () => {
            let time = Date.now();

            let index = new IndexLookup<number>(x => x);
            let count = 1000;

            for(let i = 0; i < count; i++) {
                index.PushValue(count - i);
            }

            let countLeft = count;
            for(let i = 0; i < count; i++) {
                let x = ~~(Math.random() * countLeft);
                index.RemoveIndex(x);
                countLeft--;
            }

            time = Date.now() - time;
            console.log(count, time + "ms");
        });

        it("speedTest 2", async () => {
            let time = Date.now();

            let index = new IndexLookup<number>(x => x);
            let count = 500;

            for(let i = 0; i < count; i++) {
                index.PushValue(count - i);
            }

            let countLeft = count;
            for(let i = 0; i < count; i++) {
                let x = ~~(Math.random() * countLeft);
                index.RemoveIndex(x);
                countLeft--;
            }

            time = Date.now() - time;
            console.log(count, time + "ms");
        });
    });
});
