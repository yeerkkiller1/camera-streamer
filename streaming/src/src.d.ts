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

        sourceId: string;
    };
}
interface IReceiver extends
//Bidirect<IReceiver, ISender>,
ITimeServer {
    acceptNAL(info: NALHolder): void;

    cameraPing(sourceId: string): void;
}

/** Milliseconds since epoch whatever */
type VideoTime = number | "live";

/** A range starts on the first frame after a camera connects, and ends on the last frame
 *      received from the camera (or "live").
 */
type RecordTimeRange = { firstFrameTime: number, lastFrameTime: VideoTime };

interface IHost extends
//Bidirect<IHost, IBrowserReceiver>,
ITimeServer {
    //subscribeToWebcamFrameInfo(): Promise<void>;

    getRecordTimeRanges(info: {
        /** We return one range before this time (if possible), and then up to 100 ranges after it. */
        startTime: number;
    }): Promise<{
        ranges: RecordTimeRange[]
    }>;

    subscribeToCamera(info: {
        time: VideoTime;
        // time === "live" and rate !== 1 is invalid (what would that even mean?)
        rate: number;
    }): Promise<{
        /** May be within 16 times of the requested rate. */
        streamRate: number;
    }>;

    getFormats(): Promise<v4l2camera.Format[]>;
    setFormat(
        fps: number,
        /** Frequency of i frames. */
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format
    ): Promise<void>;
}

type VideoSegment = VideoSegmentRecorded | LiveVideoSegment;

interface VideoSegmentBase {
    mp4Video: Buffer;
    baseMediaDecodeTimeInSeconds: number;
    cameraRecordTimes: number[];
}
interface VideoSegmentRecorded extends VideoSegmentBase {
    type: "recorded";
}
interface LiveVideoSegment extends VideoSegmentBase {
    type: "live";
    mp4Video: Buffer;
    baseMediaDecodeTimeInSeconds: number;
    
    sourceInfo: {
        fps: number;
        formatId: string;
        // TODO: resolution
    };

    frameSizes: number[];
    cameraRecordTimesLists: number[][];
    cameraSendTimes: number[];
    serverReceiveTime: number[];
    serverSendTime: number;
    clientReceiveTime: number;

    cameraTimeOffset: number;

    sourceId: string;
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