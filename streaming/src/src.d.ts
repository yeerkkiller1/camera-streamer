declare var NODE_CONSTANT: boolean;

interface ISender extends Controller<ISender> {
    setStreamFormat(
        /** This overrides the fps given in format at the javascript level. So the camera still plays at the 
         *      fps in format, but we only emit frames at the rate of fps.
         */
        fps: number,
        format: v4l2camera.Format
    ): void;
    getStreamFormats(): Promise<v4l2camera.Format[]>;
}

interface NALHolder {
    /** Raw NAL unit, no start code, no length prefix. */
    nal: Buffer;
    type: (
        {
            type: "slice";
            frameTime: number;
        }
        | { type: "pps"|"sps" }
    );
    senderConfig: {
        fps: number;
        format: v4l2camera.Format;
    };
}
interface IReceiver extends Bidirect<IReceiver, ISender> {
    
    acceptNAL(info: NALHolder): void;

    cameraPing(): void;
}


interface IHost extends Bidirect<IHost, IBrowserReceiver> {
    //subscribeToWebcamFrameInfo(): Promise<void>;

    subscribeToCamera(): Promise<void>;
}
interface WebcamFrameInfo {
    webcamSourceTime: number;
    serverReceivedTime: number;
}
interface VideoSegment {
    mp4Video: Buffer;
    startTime: number;
    durationSeconds: number;
}
interface IBrowserReceiver extends Controller<IBrowserReceiver> {
    //acceptWebcamFrameInfo_VOID(info: WebcamFrameInfo): void;
    acceptVideoSegment_VOID(info: VideoSegment): void;
}



interface IEncodeCamera extends Bidirect<IEncodeCamera, IEncoder> {

}

interface IEncoder {

}