import { ThrowIfNotImplementsData, ThrowsAsync, PChanFromArray, PChanFromGenerator } from "pchannel";
import { splitByStartCodes } from "./startCodes";

describe("startCodes", () => {
    describe("errors", () => {
        it("throws on too many zeroBytes", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([0, 0, 0, 0])
            ));

            await ThrowsAsync(async () => {
                await chan.GetPromise();
            });
        });

        it("throws on input error", async () => {
            let chan = splitByStartCodes(PChanFromGenerator(function *() {
                yield new Buffer([1, 2, 3, 4]);
                throw new Error("input error");
            }));

            await ThrowsAsync(async () => {
                await chan.GetPromise();
            });
        });
    });

    describe("cases", () => {
        it("works for simple case", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1, 2, 3, 4]),
                new Buffer([0, 0, 0, 1]),
                new Buffer([5, 5, 5, 5, 5]),
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 3, 4]);
            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [5, 5, 5, 5, 5]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });

        it("works for sequential start codes", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1, 2, 3, 4]),
                new Buffer([0, 0, 0, 1]),
                new Buffer([0, 0, 0, 1]),
                new Buffer([5, 5, 5, 5, 5]),
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 3, 4]);
            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [5, 5, 5, 5, 5]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });

        it("works for start code split across buffers", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1, 2, 3, 4]),
                new Buffer([0, 0]),
                new Buffer([0, 1]),
                new Buffer([5, 5, 5, 5, 5]),
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 3, 4]);
            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [5, 5, 5, 5, 5]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });

        it("works for data heavily split", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1]),
                new Buffer([2]),
                new Buffer([3]),
                new Buffer([4]),
                new Buffer([0]),
                new Buffer([0]),
                new Buffer([0]),
                new Buffer([1]),
                new Buffer([5]),
                new Buffer([5]),
                new Buffer([5]),
                new Buffer([5]),
                new Buffer([5]),
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 3, 4]);
            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [5, 5, 5, 5, 5]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });

        it("works for non split data", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1, 2, 3, 4, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5, 5, 5])
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 3, 4]);
            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [5, 5, 5, 5, 5]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });

        it("can end with 0s", async () => {
            let chan = splitByStartCodes(PChanFromArray(
                new Buffer([1, 2, 0, 0])
            ));

            ThrowIfNotImplementsData(Array.from(await chan.GetPromise()).map(x => x), [1, 2, 0, 0]);
            ThrowIfNotImplementsData(chan.IsClosed(), true);
        });
    });
});