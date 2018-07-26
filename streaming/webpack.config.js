var fs = require("fs");
var webpack = require("webpack");
var UglifyJsPlugin = require("uglifyjs-webpack-plugin");
var Visualizer = require('webpack-visualizer-plugin');
var nodeExternals = require('webpack-node-externals');

module.exports = env => {
    return [getConfig(env)];
}

function getConfig (env) {
    let node = env && !!env.node || false;

    var entryPoints;
    if(!node) {
        entryPoints = {
            main: "./src/site/main.tsx",
        };
    } else {
        entryPoints = {
            sender: "./src/sender.ts",
            receiver: "./src/receiver.ts",
            senderWrap: "./src/deploy/senderWrap.ts",
        };
    }

    let obj = {
        entry: entryPoints,
        output: {
            // Eh... our html files are in the site folder, so we nest everything further in the site folder.
            filename: "./dist/[name].js",
        },

        // Enable sourcemaps for debugging webpack's output.
        devtool: "source-map",

        devServer: {
            port: 7035
        },

        resolve: {
            // Add '.ts' and '.tsx' as resolvable extensions.
            extensions: [".webpack.js", ".web.js", ".ts", ".tsx", ".js"],
        },

        resolveLoader: {
            modules: ['node_modules', './loaders'],
        },

        module: {
            rules: [
                // All files with a '.ts' or '.tsx' extension will be handled by 'ts-loader'.
                { test: /\.tsx?$/, loader: "ts-loader" },
                { test: /\.less$/, loader: "style-loader!css-loader!less-loader" },
                { enforce: 'pre', test: /\.js$/, loader: "source-map-loader" },
                { test: /\.tsx?$/, loader: `define-loader?node=${node}` },
            ],
        },

        plugins: [
            new webpack.DefinePlugin({
                NODE_CONSTANT: node,
                NODE: node
            }),
            new Visualizer()
        ]
    };

    if (node) {
        obj["target"] = "node";
        /*
        obj["externals"] = [nodeExternals({
            whitelist: ["v4l2camera"]
        })];
        */
    }
    obj["externals"] = obj["externals"] || [];
    obj["externals"].push({"v4l2camera": "require('v4l2camera')"});

    return obj;
};