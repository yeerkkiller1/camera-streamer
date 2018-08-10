import * as React from "react";
import { PChan, TransformChannel } from "pchannel";
import { IVideoHolder } from "./VideoHolder";


interface IProps {
    videoProps: React.VideoHTMLAttributes<HTMLVideoElement>;
    rate: number;
    speedMultiplier: number;
}
interface IState {
    videoParts: MP4Video[];
}

export class VideoHolderFake extends React.Component<IProps, IState> implements IVideoHolder {
    state: IState = {
        videoParts: []
    };
    public async AddVideo(mp4Video: MP4Video): Promise<void> {
        this.state.videoParts.push(mp4Video);
        this.setState({ videoParts: this.state.videoParts });
    }

    public SeekToTime(time: number) {
        
    }

    public GetCurrentTime(): number {
        return 0;
    }


    public render() {
        return (
            <div>
                Fake Video

                <div>
                    {
                        this.state.videoParts.map((x, i) => (
                            <div key={i}>
                                {x.frameTimes.map(x => x.time).join(", ")}
                            </div>
                        ))
                    }
                </div>
            </div>
        );
    }
}