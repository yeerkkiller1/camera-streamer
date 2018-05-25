import * as React from "react";
import { sum } from "./util/math";

interface SpeedObj {
    speed: number;
    path: string;
}
interface Props {
    originalVideos: BucketChunkLookup;
    videos: {
        [speed: number]: SpeedObj
    }
}
interface State {
    curTime: number;
    isPlaying: number;
    curSpeed: number;
}
export class SuperVideo extends React.Component<Props, State> {
    onVideo(video: HTMLVideoElement|null, speedObj: SpeedObj) {
        if(!video) return;

        video.addEventListener("loadeddata", () => {
            // Eh... okay, durations can't be trusted. Let's just use percent times?
            // So... segment times can vary.
            //  If a segment time is less than the speed up time / fps, the time duration gets increased
            //  If a segment frame count is not divisible by the speed up time, the time duration gets reduced
            // AND, we CANNOT increase the real time when switching between videos. So... how can we calculate
            //  the time to jump to when switching videos?
            
            let realTime = video.duration;

            let infos = this.getSourceInfos();
            console.log(infos)

            let finalFPS = 40;
            if(speedObj.speed === 1) {
                finalFPS = 10;
            }

            let predictedTime = sum(infos.map(info => {
                let finalFrames = Math.floor(info.frames / speedObj.speed);
                if(finalFrames === 0) {
                    finalFrames = 1;
                }
                return finalFrames;
            })) / finalFPS;

            console.log(speedObj.speed, "predicted", predictedTime, "real", realTime);

            // We need the frames (and frame rate) of each input video. Then we should be able to exactly predict the
            //  number of frames in the output,
        });
    }
    /*
    canvas: HTMLCanvasElement|null = null;
    onCanvas(canvas: HTMLCanvasElement|null) {
        if(!canvas) return;
        this.canvas = canvas;

        //this.trySomething();
    }
    */

    getSourceInfos() {
        let props = this.props;
        return Object.values(props.originalVideos).map(video => {
            let info = video.info;
            if(!info) {
                throw new Error(`No info for ${video.filePath}? Did it get added but error out at some point? Seeking may be broken.`);
            }
            if(+info.formatInfo.nb_streams !== 1) {
                throw new Error(`Incorrect number of streams. Want 1, received ${info.formatInfo.nb_streams}`);
            }

            let streamInfo = info.streamInfo;
            if(streamInfo.avg_frame_rate !== streamInfo.r_frame_rate) {
                throw new Error(`Variable framerate. Comeon... Average ${streamInfo.avg_frame_rate}, some other one ${streamInfo.r_frame_rate}`);
            }

            let frameRateStr = streamInfo.avg_frame_rate;

            if(!frameRateStr.endsWith("/1")) {
                throw new Error(`I can't parse this framerate ${frameRateStr}`);
            }

            let frameRate = +frameRateStr.slice(0, -2);

            return {
                frameRate,
                frames: +streamInfo.nb_frames,
                // Eh... fine, use the final video width/height, even though we are using JS to calculate it, it is better than the source width/height
                //width: streamInfo.width,
                //height: streamInfo.height,
            };
        });
    }

    render() {
        let props = this.props;
        return (
            <div className="SuperVideo">
            {
                
            }
            {
                Object.values(props.videos).map(speedObj => {
                    return (
                        <div key={speedObj.path}>
                            speed: {speedObj.speed}
                            <video width="100" height="100" src={speedObj.path} ref={x => this.onVideo(x, speedObj)} />
                        </div>
                    );
                })
            }
            </div>
        );
    }
}