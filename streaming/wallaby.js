module.exports = function (wallaby) {
    return {
        files: [
            //{ pattern: "**/*.d.ts", ignore: true, instrument: false },
            "src/**/*.tsx",
            "src/**/*.ts",
            "loaders/**/*.tsx",
            "loaders/**/*.ts",
            { pattern: "**/*.test.ts", ignore: true },
            { pattern: "**/*.d.ts", ignore: true },
        ],
        tests: [
            "src/**/*.test.ts",
        ],
        
        env: {
            type: "node",
            kind: "electron",
        },

        // https://wallabyjs.com/docs/integration/overview.html#supported-testing-frameworks
        testFramework: "jasmine",

        hints: {
            ignoreCoverage: /(ignore|exclude) coverage/
        },

        setup: function() {
            let global = Function('return this')();
            global.TEST = true;
            global.NODE = true;

            global.PROMISE_defaultTimeout = 100;
        },
    };
};