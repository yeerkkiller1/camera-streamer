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