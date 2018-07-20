/// <reference path="../node_modules/ws-class/dist/ws-class.d.ts" />

declare var NODE_CONSTANT: boolean;

interface ISender extends Controller<ISender> {
    setStreamFormat(
        /** This overrides the fps given in format. */
        fps: number,
        format: v4l2camera.Format
    ): void;
    getStreamFormats(): Promise<v4l2camera.Format[]>;
}
interface IReceiver extends Bidirect<IReceiver, ISender> {
    // Just used to access and then save the client property
    acceptFrame(frame: {
        buffer: Buffer;
        fps: number;
        format: v4l2camera.Format;
        /** new Date(eventTime) gives the event time. */
        eventTime: number;
    }): void;

    cameraPing(): void;
}


interface IHost extends Bidirect<IHost, IBrowserReceiver> {
    subscribeToWebcamFrameInfo(): Promise<void>;
}
interface WebcamFrameInfo {
    webcamSourceTime: number;
    serverReceivedTime: number;
}
interface IBrowserReceiver extends Controller<IBrowserReceiver> {
    acceptWebcamFrameInfo_VOID(info: WebcamFrameInfo): void;
}



interface IEncodeCamera extends Bidirect<IEncodeCamera, IEncoder> {

}

interface IEncoder {

}