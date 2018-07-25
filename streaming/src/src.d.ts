declare var NODE_CONSTANT: boolean;

interface ITimeServer {
    /** Should return Date.now(), or equivalent. Not clock. Definitely not clock. */
    getTime(): Promise<number>
}

interface ISender extends Controller<ISender> {
    setStreamFormat(
        /** This overrides the fps given in format at the javascript level. So the camera still plays at the 
         *      fps in format, but we only emit frames at the rate of fps.
         */
        fps: number,
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format,
        formatId: string,
    ): Promise<void>;
    getStreamFormats(): Promise<v4l2camera.Format[]>;
}


interface Array<T> {
    last(): T;
}

interface NALHolder {
    /** Raw NAL unit, no start code, no length prefix. */
    nal: Buffer;
    type: (
        {
            type: "slice";
            /** The last time is the time for the slice. The other times are dropped frames. */
            frameRecordTimes: number[];
            frameRecordTime: number;
        }
        | { type: "pps"|"sps" }
    );
    senderConfig: {
        fps: number;
        format: v4l2camera.Format;
        cameraSendTime: number;
        serverReceiveTime: number;
        timeOffset: number;
        formatId: string;
    };
}
interface IReceiver extends
//Bidirect<IReceiver, ISender>,
ITimeServer {
    acceptNAL(info: NALHolder): void;

    cameraPing(): void;
}


interface IHost extends
//Bidirect<IHost, IBrowserReceiver>,
ITimeServer {
    //subscribeToWebcamFrameInfo(): Promise<void>;

    subscribeToCamera(): Promise<void>;

    getFormats(): Promise<v4l2camera.Format[]>;
    setFormat(
        fps: number,
        /** Frequency of i frames. */
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format
    ): Promise<void>;
}
interface VideoSegment {
    mp4Video: Buffer;
    baseMediaDecodeTimeInSeconds: number;
    durationSeconds: number;

    sourceInfo: {
        fps: number;
        formatId: string;
        // TODO: resolution
    };

    cameraRecordTimes: number[];
    frameSizes: number[];
    cameraRecordTimesLists: number[][];
    cameraSendTimes: number[];
    serverReceiveTime: number[];
    serverSendTime: number;
    clientReceiveTime: number;

    cameraTimeOffset: number;
}
interface IBrowserReceiver extends Controller<IBrowserReceiver> {
    //acceptWebcamFrameInfo_VOID(info: WebcamFrameInfo): void;
    acceptVideoSegment_VOID(info: VideoSegment): void;
}

// There are some potential buffers that could build up:
//  camera
//      before encode buffer
//          if encoding is too slow
//      after encode buffer
//          when we start to throttle unconfirmed frames we can see this. Otherwise TCP will buffer sends, we just can't tell.
//  server
//      before mux buffer
//          shouldn't really build up
//      send buffer
//          this is async right now, but there should be a buffer for each client, which could build up if the network to any client is lagging
//  client
//      display buffer
//          builds up if the client clock is slower than the camera clock, so it thinks the frame time has not occured yet




interface IEncodeCamera extends Bidirect<IEncodeCamera, IEncoder> {

}

interface IEncoder {

}