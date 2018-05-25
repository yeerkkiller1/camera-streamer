interface BucketChunkLookup {
    [filePath: string]: BucketChunk;
}
interface BucketChunk {
    filePath: string;
    startCount: number;
    encodedCount: number;
    info?: {
        timeStamp: number;
        speeds: number[];
        streamInfo: StreamInfo;
        formatInfo: FormatInfo;
    };
}

interface StreamInfo {
    width: string;
    height: string;
    nb_frames: string;
    r_frame_rate: string;
    avg_frame_rate: string;
}
interface FormatInfo {
    nb_streams: string;
}