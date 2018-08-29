import * as React from "react";
import { PChan, TransformChannel } from "pchannel";
import { RealTimeToVideoTime, VideoTimeToRealTime } from "../NALStorage/TimeMap";

interface IProps {
    videoProps: React.VideoHTMLAttributes<HTMLVideoElement>;
    rate: number;
    playRate: number;
}
interface IState {
    
}

export interface IVideoHolder extends React.Component<IProps, IState> {
    AddVideo(mp4Video: MP4Video): Promise<void>;
    /** Time in ms, like all times. */
    SeekToTime(time: number): void;
    GetCurrentTime(): number;
}

export class VideoHolder extends React.Component<IProps, IState> implements IVideoHolder {
    private vidBuffer: SourceBuffer|undefined;
    private videoElement: HTMLVideoElement|null|undefined;

    private updateEndQueue: PChan<void>|undefined;

    public shouldComponentUpdate(nextProps: IProps, nextState: IState): boolean {
        if(this.props.rate !== nextProps.rate) {
            throw new Error(`VideoHolders should not change rate`);
        }

        if(this.videoElement) {
            this.videoElement.playbackRate = nextProps.playRate;
        }

        return true;
    }

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
        console.log(`Seek ${time}`);
        if(this.videoElement) {
            let newTime = RealTimeToVideoTime(time, this.props.rate) / 1000;
            this.videoElement.currentTime = newTime;
        }
    }

    public GetCurrentTime(): number {
        return this.videoElement && VideoTimeToRealTime(this.videoElement.currentTime * 1000, this.props.rate) || 0;
    }

    public element: HTMLVideoElement|null|undefined;
    private initVideo(vid: HTMLVideoElement|null) {
        this.element = vid;
        if(!vid) return;
        if(this.videoElement === vid) return;

        vid.playbackRate = this.props.playRate;

        console.log("New video element");
        this.videoElement = vid;      

        var push = new MediaSource();
        vid.src = URL.createObjectURL(push);
        push.addEventListener("sourceopen", async () => {
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