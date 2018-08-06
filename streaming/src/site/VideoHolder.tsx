import * as React from "react";
import { PChan, TransformChannel } from "pchannel";
import { RealTimeToVideoTime, VideoTimeToRealTime } from "../NALStorage/TimeMap";

interface IProps {
    videoProps: React.VideoHTMLAttributes<HTMLVideoElement>;
    rate: number;
    speedMultiplier: number;
}
interface IState {

}

export interface IVideoHolder extends React.Component<IProps, IState> {
    AddVideo(mp4Video: MP4Video): void;
    /** Time in ms, like all times. */
    SeekToTime(time: number): void;
    GetCurrentTime(): number;
}

export class VideoHolder extends React.Component<IProps, IState> implements IVideoHolder {
    private vidBuffer: SourceBuffer|undefined;
    private videoElement: HTMLVideoElement|null|undefined;

    private updateEndQueue: PChan<void>|undefined;

    // TODO: If we ever call remove, we need to combine it in this loop, as both set updating to true.
    public AddVideo = TransformChannel<MP4Video, void>(async (input) => {
        if(!this.videoElement || !this.vidBuffer || !this.updateEndQueue) {
            console.log(`Ignoring video because vidBuffer hasn't been initialized yet.`);
            return;
        }
        if(this.vidBuffer.updating) {
            throw new Error(`appendQueue is broken, tried to add while vidBuffer is updating`);
        }
        this.vidBuffer.appendBuffer(input.mp4Video);

        await this.updateEndQueue.GetPromise();
    });

    public SeekToTime(time: number) {
        if(this.videoElement) {
            this.videoElement.currentTime = RealTimeToVideoTime(time, this.props.rate, this.props.speedMultiplier) / 1000;
        }
    }

    public GetCurrentTime(): number {
        return this.videoElement && VideoTimeToRealTime(this.videoElement.currentTime * 1000, this.props.rate, this.props.speedMultiplier) || 0;
    }

    private initVideo(vid: HTMLVideoElement|null) {
        if(!vid) return;
        if(this.videoElement === vid) return;

        console.log("New video element");
        this.videoElement = vid;

        // onstalled, onemptied, onended, onpause, are all useless. Watching polling currentTime is the only way to know
        //  when the video stalls.
        //const maxClientsideBuffer = 5 * 1000;

        /*
        // Max of two videos behind
        const maxClientsideBuffer = this.state.iFrameRate * (1 / this.state.requestedFPS) * 2 * 1000;
        const checkForStallOrLag = () => {
            if(this.videoElement !== vid) return;

            let seg = this.state.latestSegment;
            if(seg && seg.type === "live") {
                let firstTime = seg.cameraRecordTimes[0];
                if(vid.currentTime * 1000 + maxClientsideBuffer < firstTime) {
                    console.log(`Moving video up to current time, because client side buffer time got too high (above ${maxClientsideBuffer})`);
                    vid.currentTime = firstTime / 1000;
                }

                // We can't play in the future
                if(vid.currentTime * 1000 > seg.cameraRecordTimes.last()) {
                    console.log("Moving video back because it was playing in the future");
                    vid.currentTime = firstTime / 1000 - 0.00001;
                }
            }

            setTimeout(checkForStallOrLag, maxClientsideBuffer / 10);
        };
        checkForStallOrLag();
        */
        

        
        var push = new MediaSource();
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
            console.log("addSourceBuffer")
            var buf = push.addSourceBuffer('video/mp4; codecs="avc1.640028"');
            this.vidBuffer = buf;
            let queue = this.updateEndQueue = new PChan<void>();
            
            const callback = () => {
                if(this.updateEndQueue !== queue) {
                    buf.removeEventListener("updatend", callback);
                    return;
                }
                queue.SendValue(undefined);
            };
            this.vidBuffer.addEventListener("updateend", callback);
        });
    }

    public render() {
        return (
            <div>
                <video {...this.props.videoProps} ref={x => this.initVideo(x)}></video>
            </div>
        );
    }
}