var x264 = require("x264-npm");

test();
async function test() {
    try {
        var result = await x264("--help");
        console.log(result);
    } catch(e) {
        console.log(e);
    }
}