declare var NODE_CONSTANT: boolean;

type UnwrapCtor<T> = T extends Ctor<infer A> ? A : never;
type FirstArg<T> = T extends (a: infer A, ...args: any[]) => any ? A : never;
type Ctor<T = any> = new(...args: any[]) => T;

// https://stackoverflow.com/questions/50011616/typescript-change-function-type-so-that-it-returns-new-value
type ArgumentTypes<T> = T extends (... args: infer U ) => infer R ? U: never;
type ReplaceReturnType<T, TNewReturn, ThisContext = any> = (this: ThisContext, ...a: ArgumentTypes<T>) => TNewReturn;

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
        downsampleRate: number
    ): Promise<void>;
    getStreamFormats(): Promise<v4l2camera.Format[]>;
}


interface Array<T> {
    last(): T;
}

declare const enum NALType {
    //NALType_sps = 0,
    //NALType_pps = 1,
    NALType_keyframe = 2,
    NALType_interframe = 3,
}

type NALInfoTime = {
    rate: number;
    time: number;
    type: NALType;
    width: number;
    height: number;

    addSeqNum: number;
};


type NALExtraInfo = {
    recordInfo: (
        {
            // Before every I slice a sps and pps must be sent.
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
};

// We want this to be optimized for storing in memory, as it would be nice if we could store
//  every time of every nal for a very large history. Even at 4 numbers (32 bytes), and assuming a
//  size of 100KB per NAL, we would use up 100MB for all the index info on 62.5GB of NALs. Which
//  means we really cannot store all index info in memory.
type NALIndexInfo = NALInfoTime & {
    // On disk we store all the NALMinInfo for every frame.
    // Start of bytes.
    pos: number;
    // Size of all bytes.
    len: number;
};

type NALHolderMin = NALInfoTime & {
    /** Raw NAL unit, no start code, no length prefix. */
    nal: Buffer;
    /** sps and pps are small. Together they are maybe 40 bytes? So sending them inline with every nal is fine.
     *      They are basically always the same though, so the client should dedupe them (to reduce memory usage).
     */
    sps: Buffer;
    pps: Buffer;
};

type NALHolder = NALHolderMin & NALExtraInfo;


interface IReceiver extends
//Bidirect<IReceiver, ISender>,
ITimeServer {
    acceptNAL_VOID(info: NALHolder): void;
    /** Get's the next seq number that the server is aware of. This should only be called when a camera is initializing, and then the camera
     *      should increment sequence numbers for every subsequent number.
    */
    GetNextAddSeqNum(): Promise<number>;

    cameraPing(sourceId: string): Promise<void>;
}

/** Milliseconds since epoch whatever */
type VideoTime = number | "live";

/** A range starts on the first frame after a camera connects, and ends on the last frame
 *      received from the camera (or "live").
 */
type TimeRange = { firstFrameTime: number, lastFrameTime: VideoTime };
type RecordTimeRange = { firstFrameTime: number, lastFrameTime: number };

type NALRange = { firstTime: number; lastTime: number; frameCount: number; };
type MP4Video = {
    rate: number;

    width: number;
    height: number;

    /** The video ends before the next key frame. But this could be undefined if there is no keyframe after this video. */
    nextKeyFrameTime?: number;

    mp4Video: Buffer;
    frameTimes: NALInfoTime[];
};



interface IBrowserReceiver extends Controller<IBrowserReceiver> {
    acceptNewTimeRanges_VOID(rate: number, ranges: NALRange[]): void;
    onDeleteTime(rate: number, deleteTime: number): void;
    onNewRate(rate: number): void;
}

interface IHost extends
//Bidirect<IHost, IBrowserReceiver>,
ITimeServer {
    //subscribeToWebcamFrameInfo(): Promise<void>;

    SyncRates(): Promise<number[]>;

    /** If we have data at a frame level there will be ranges of zero length.
     *      The data will be sorted by time.
     * 
     *  After calling this new time ranges will be passed back via calls to acceptNewTimeRange_VOID.
     *      If ranges have the same startTime as a previous range, the end time may change.
    */
    syncTimeRanges(rate: number): Promise<NALRange[]>;

    /**
     * @param startTime Video is returned starting at the first key frame before or at this startTime (or after is nothing is at or before).
     * @param minFrames We try to return at least minFrames, but may not sometimes for performance reasons.. The frame after the last frame will be a key frame, unless forPreview is true.
     * @param nextReceivedFrameTimes (For each rate) Is the time of next frame after startTime the client has. We won't return frames after (or at) this time.
     *                                  This is assumed to be the first time of a video, and so a key frame. If it isn't this frame may be returned.
     *      - If live then we have no end (except determined by minFrames), and will block until we exceed the minFrames limit.
     * @param rate Rate of the video. The video plays at a multiple of this speed by default.
     * @param startTimeExclusive If true startTime now becomes exclusive, and the video is returned starting at the first key frame AFTER startTime.
     * @param onlyTimes If true only downloads the times for each video (so the video inside each MP4Video will be empty, and width and height will be 0).
     */
    GetVideo(
        startTime: number,
        minFrames: number,
        nextReceivedFrameTime: number|undefined|"live",
        rate: number,
        startTimeExclusive: boolean,
        onlyTimes?: boolean,
        forPreview?: boolean
    ): Promise<MP4Video | "VIDEO_EXCEEDS_NEXT_TIME" | "VIDEO_EXCEEDS_LIVE_VIDEO" | "CANCELLED">;

    CancelVideo(): Promise<void>;

    //todonext
    // streaming. Simulate playing video, but instead of playing it, show the time, length and first
    //  few bytes of the frame that is showing. Also show some of the frame buffer.
    
    getFormats(): Promise<v4l2camera.Format[]>;
    setFormat(
        fps: number,
        /** Frequency of i frames. */
        iFrameRate: number,
        bitRateMBPS: number,
        format: v4l2camera.Format,
    ): Promise<void>;
}

type VideoSegment = RecordedVideoSegment | LiveVideoSegment;

interface VideoSegmentBase {
    mp4Video: Buffer;
    baseMediaDecodeTimeInSeconds: number;
    cameraRecordTimes: number[];
}
interface RecordedVideoSegment extends VideoSegmentBase {
    type: "recorded";
    rate: number;
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