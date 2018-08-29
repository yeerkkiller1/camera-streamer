import { RealTimeToVideoTime } from "../NALStorage/TimeMap";
import { Deferred, SetTimeoutAsync, PChan } from "pchannel";
import { SizedCache } from "./SizedCache";
import { CreateTempFolderPath } from "temp-folder";
import { randomUID } from "../util/rand";

let cache = new SizedCache<{time: number; rate: number}, string>(
    1024 * 1024 * 128,
    (key, value) => value.length,
    obj => JSON.stringify(obj)
);

export async function GetVideoFrames(video: MP4Video, times: number[]): Promise<string[]> {
    let cachedValues = times.map(x => cache.Get({ time: x, rate: video.rate }));
    if(!cachedValues.some(x => !x)) {
        return cachedValues.map(x => x ? x.v : "");
    }

    let frames = await GetVideoFramesInternal(video, times);
    for(let i = 0; i < frames.length; i++) {
        cache.Add({
            time: times[i],
            rate: video.rate
        }, frames[i]);
    }

    return frames;
}

//todonext
// Get the server to do this, as the client is really not able...
//  ffmpeg -i what.mp4 test%d.jpg
//  Hmm...
export async function GetVideoFramesInternal(video: MP4Video, times: number[]): Promise<string[]> {
    let profileTime = Date.now();

    let videoElement = document.createElement("video");
    videoElement.controls = true;

    //document.body.appendChild(videoElement);

    let onSeek = new PChan<void>();
    let onSourceOpen = new PChan<void>();
    let onUpdateEnd = new PChan<void>();
    {
        videoElement.onerror = (e) => {
            if(!videoElement.error) {
                onSeek.SendError(new Error(`Unknown GetVideoFrame error`));
            } else {
                onSeek.SendError(new Error(videoElement.error.message));
            }
            onSeek.Close();
        };
        videoElement.onstalled = () => {
            console.warn(`Stalled`);
            //onSeek.SendError(`Stalled, which likely means time cannot be found in video.`);
            //onSeek.Close();
            onSeek.SendValue(undefined);
        };
        videoElement.onseeked = () => {
            console.log("seek event");
            onSeek.SendValue(undefined);
        };

        var push = new MediaSource();
        videoElement.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            onSourceOpen.SendValue(undefined);
        });

        await onSourceOpen.GetPromise();

        var buf = push.addSourceBuffer('video/mp4; codecs="avc1.640028"');
        buf.addEventListener("updateend", async () => {
            onUpdateEnd.SendValue(undefined);
        });
        buf.appendBuffer(video.mp4Video);

        await onUpdateEnd.GetPromise();
    }

    let frames: string[] = [];

    for(let time of times) {
        let seekTime = RealTimeToVideoTime(time, video.rate) / 1000;
        videoElement.currentTime = seekTime;
        await onSeek.GetPromise();
        let canvas = document.createElement("canvas");
        canvas.width = video.width;
        canvas.height = video.height;
        //document.body.appendChild(canvas);
        let context = canvas.getContext("2d");
        if(!context) {
            throw new Error(`Failed to get context`);
        }
        context.drawImage(videoElement, 0, 0, video.width, video.height);
        frames.push(canvas.toDataURL());
    }
    
    profileTime = Date.now() - profileTime;
    console.log(`getFrame took ${profileTime.toFixed(1)}ms`);

    return frames;
}