import { runAllPossibilities } from "./testHelpers";
import { ThrowIfNotImplementsData } from "pchannel";


describe("runAllPossibilities", () => {
    it("works", async () => {
        let sum1 = 0;
        let sum2 = 0;
        await runAllPossibilities(async (choose) => {
            let choice1 = choose(3);
            let choice2 = choose(4);
            sum1 += choice1;
            sum2 += choice2;
        });
        ThrowIfNotImplementsData({ sum1, sum2 }, { sum1: 12, sum2: 18 });
    });
});