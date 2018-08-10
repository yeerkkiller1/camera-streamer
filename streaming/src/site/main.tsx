import { g, PChan, TransformChannel, TransformChannelAsync, SetTimeoutAsync } from "pchannel";
g.NODE =  false;

import * as React from "react";
import * as ReactDOM from "react-dom";


// For polyfills
import "../util/math";
import { binarySearchMapped, binarySearchMap, insertIntoListMap, findAtOrBefore, findAfter, findAtOrBeforeIndex, findClosest, findClosestIndex } from "../util/algorithms";
import { formatDuration } from "../util/format";
import { RangeSummarizer } from "../NALStorage/RangeSummarizer";
import { VideoHolder, IVideoHolder } from "./VideoHolder";
import { VideoHolderFake } from "./VideoHolderFake";
import { PollLoop } from "./PollLoop";
import { RealTimeToVideoTime, VideoDurationToRealDuration } from "../NALStorage/TimeMap";
import { SegmentRanges, reduceRanges } from "../NALStorage/rangeMapReduce";
import { UnionUndefined } from "../util/misc";
import { VideoPlayer } from "./VideoPlayer";

import "./main.less";

let VideoHolderClass = VideoHolder;
//let VideoHolderClass = VideoHolderFake;

function getBitRateMBPS(fps: number, format: v4l2camera.Format) {
    let { height } = format;
    // https://support.google.com/youtube/answer/1722171?hl=en (youtube recommend upload bitrates)
    let lowFps = fps <= 30;
    let bitRateMBPS: number;
    if(height <= 360) {
        bitRateMBPS = lowFps ? 1 : 1.5;
    } else if(height <= 480) {
        bitRateMBPS = lowFps ? 2.5 : 4;
    } else if(height <= 720) {
        bitRateMBPS = lowFps ? 5 : 7.5;
    } else if(height <= 1080) {
        bitRateMBPS = lowFps ? 8 : 12;
    } else if(height <= 1440) {
        bitRateMBPS = lowFps ? 16 : 24;
    } else if(height <= 2160) {
        bitRateMBPS = lowFps ? 40 : 60;
    } else {
        bitRateMBPS = lowFps ? 60 : 80;
    }

    return bitRateMBPS;
}




let rootElement = document.getElementById("root");
if(!rootElement) throw new Error("Missing root, at element with id=root");

render();
function render() {
    ReactDOM.render(
        <div>
            <div>
                <VideoPlayer />
            </div>
        </div>,
        rootElement
    );
}

let moduleAny = module as any;

if (moduleAny.hot) {
    moduleAny.hot.accept("./site/CameraViewer.tsx", () => {
        debugger;
        render();
    });
}