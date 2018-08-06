declare var NODE_CONSTANT: boolean;

type UnwrapCtor<T> = T extends Ctor<infer A> ? A : never;
type FirstArg<T> = T extends (a: infer A, ...args: any[]) => any ? A : never;
type Ctor<T = any> = new(...args: any[]) => T;

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
        downsampleRate: number,
        ratePrevCounts: { [rate: number]: number }
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


type NALMinInfo = {
    rate: number;

    // If type is pps or sps the time has no meaning.
    time: number;
    type: NALType;
    width: number;
    height: number;

    /** sps and pps are small. Together they are maybe 40 bytes? So sending them inline with every nal is fine.
     *      They are basically always the same though, so the client should dedupe them (to reduce memory usage).
     */
    sps: Buffer;
    pps: Buffer;
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

type NALTime = {
    rate: number;
    time: number;
    type: NALType;
};

// We want this to be optimized for storing in memory, as it would be nice if we could store
//  every time of every nal for a very large history. Even at 4 numbers (32 bytes), and assuming a
//  size of 100KB per NAL, we would use up 100MB for all the index info on 62.5GB of NALs. Which
//  means we really cannot store all index info in memory.
type NALIndexInfo = NALTime & {
    // On disk we store all the NALMinInfo for every frame.
    // Start of bytes.
    pos: number;
    // Size of all bytes.
    len: number;
};

type NALHolderBase = {
    /** Raw NAL unit, no start code, no length prefix. */
    nal: Buffer;
};

type NALHolderMin = NALHolderBase & NALMinInfo;
type NALHolder = NALHolderMin & NALExtraInfo;


interface IReceiver extends
//Bidirect<IReceiver, ISender>,
ITimeServer {
    acceptNAL_VOID(info: NALHolder): void;

    cameraPing(sourceId: string): Promise<void>;
}

/** Milliseconds since epoch whatever */
type VideoTime = number | "live";

/** A range starts on the first frame after a camera connects, and ends on the last frame
 *      received from the camera (or "live").
 */
type TimeRange = { firstFrameTime: number, lastFrameTime: VideoTime };
type RecordTimeRange = { firstFrameTime: number, lastFrameTime: number };

type NALRange = { firstTime: number; lastTime: number; };
type MP4Video = {
    rate: number;
    speedMultiplier: number;
    /** All video ends right before the next keyframe, unless incomplete is true, then the video may end early. */
    incomplete: boolean;

    mp4Video: Buffer;
    frameTimes: NALTime[];
};

type NALRanges = {
    rate: number;

    /** FrameTimes may be added which overlap a segment. This happens when a segment is downloaded from S3,
     *      and we now have individual frame timings.
     * 
     * Sorted by time
     * Should not have duplicates
     * Should not be mutable, except for deletions, which only occur in the oldest frames
     */
    frameTimes: NALTime[];

    /** Segments ranges may be created which overlap existing frameTimes. This happens when
     *      previously local data gets put into a segment and written to S3.
     * 
     * Sorted by startTime.
     * Segments should not overlap each other, or ever be mutated except for deletions, which only occur in the oldest frames
    */
    segmentRanges: NALRange[];

    /** If not undefined, everything at or before this time has been deleted from the server, and no writes will ever be allow before or at this time. */
    deletionTime?: number;
};

interface IBrowserReceiver extends Controller<IBrowserReceiver> {
    acceptVideo_VOID(video: MP4Video, requestRange: NALRange): void;
    acceptNewTimeRanges_VOID(ranges: NALRanges): void;
}

interface IHost extends
//Bidirect<IHost, IBrowserReceiver>,
ITimeServer {
    //subscribeToWebcamFrameInfo(): Promise<void>;

    getRates(): Promise<number[]>;

    /** If we have data at a frame level there will be ranges of zero length.
     *      The data will be sorted by time.
     * 
     *  After calling this new time ranges will be passed back via calls to acceptNewTimeRanges_VOID.
     *      If ranges have the same startTime as a previous range, the end time may change.
    */
    syncTimeRanges(rate: number, speedMultiplier: number): Promise<NALRanges>;

    /**
     * @param startTime Video is returned starting at the first key frame before or at this startTime (or after is nothing is at or before).
     * @param lastTime All keyframes returned will be at or before this time.
     * @param startTimeExclusive If true startTime now becomes exclusive, and the video is returned starting at the first key frame AFTER startTime.
     * @param rate 
     * @param speedMultiplier 
     */
    GetVideo(startTime: number, lastTime: number, startTimeExclusive: boolean, rate: number, speedMultiplier: number): Promise<void>;

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