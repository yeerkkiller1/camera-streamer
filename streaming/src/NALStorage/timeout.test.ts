import { SetTimeoutAsync } from "pchannel";

describe("timeout tests", function(this: any) {
    it("doesn't time out when we change the timeout time", async () => {
        await SetTimeoutAsync(1000 * 10);
    }, 15000);
});