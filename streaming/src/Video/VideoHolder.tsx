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
    RemoveVideo(mp4Video: MP4Video): Promise<void>;
    /** Time in ms, like all times. */
    SeekToTime(time: number): void;
    GetCurrentTime(): number;
    Play(): Promise<void>;
    Pause(): void;
    IsPlaying(): boolean;
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
    private vidBufferLoop = TransformChannel<{
        type: "add"|"remove";
        video: MP4Video;
    }, void>(async (input) => {
        if(!this.videoElement || !this.vidBuffer || !this.updateEndQueue) {
            console.log(`Ignoring video because vidBuffer hasn't been initialized yet.`);
            return;
        }
        if(this.vidBuffer.updating) {
            throw new Error(`appendQueue is broken, tried to add while vidBuffer is updating`);
        }
        let { video } = input;
        if(input.type === "add") {
            this.vidBuffer.appendBuffer(video.mp4Video);
        } else if(input.type === "remove") {
            // Eh... rounding is really going to be a problem here. Rounding will mean we may remove extra frames,
            //  or not remove enough.
            // TODO: We can't add and remove SourceBuffers (at least, the max limit of SourceBuffers is so low,
            //  as you are not expected to have multiple), so we need to occasionally create a whole new MediaSource
            //  to wipe out any unremoved frames (unless remove removes entire buffers? then we should move the times
            //  in a bit to make sure we don't remove any extra buffers).
            this.vidBuffer.remove(
                RealTimeToVideoTime(video.frameTimes[0].time, video.rate),
                RealTimeToVideoTime(video.frameTimes.last().time, video.rate)
            );
        } else {
            throw new Error(`Invalid input type ${input.type}`);
        }

        await this.updateEndQueue.GetPromise();
    });

    public AddVideo(mp4Video: MP4Video): Promise<void> {
        return this.vidBufferLoop({ type: "add", video: mp4Video });
    }
    public RemoveVideo(mp4Video: MP4Video): Promise<void> {
        return this.vidBufferLoop({ type: "remove", video: mp4Video });
    }

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

    public async Play(): Promise<void> {
        if(this.element) {
            await this.element.play();
        }
    }
    public Pause(): void {
        if(this.element) {
            this.element.pause();
        }
    }

    public IsPlaying(): boolean {
        if(this.element) {
            return !this.element.paused;
        }
        return false;
    }

    private element: HTMLVideoElement|null|undefined;
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
                queue.SendValue();
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