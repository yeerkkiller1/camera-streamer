import * as React from "react";
import { watch, unwatch } from "./util/pollingWatcher";
import { getProgramArguments, setProgramArgument } from "./util/args";

import "./CameraViewer.less";
import { SuperVideo } from "./SuperVideo";
import { keyByArray, keyBy } from "./util/misc";

interface Bucket {
    bucketName: string;
    firstVideoStartTimeStamp: number;
}

type BucketState = { [name: string]: Bucket };
function parseState(lines: string[]): BucketState {
    let buckets: BucketState = {};

    for(let line of lines) {
        let bucket = JSON.parse(line) as Bucket;
        buckets[bucket.bucketName] = bucket;
    }

    return buckets;
}


function parseBucketChunks(lines: string[]): BucketChunkLookup {
    let chunks: BucketChunkLookup = {};
    type ChunkEntry = {
        event: "startEncode";
        filePath: string;
    } | {
        event: "encoded";
        filePath: string;
        utcTimeStamp: number;
        speeds: number[];
        streamInfo: StreamInfo;
        formatInfo: FormatInfo;
    };
    for(let line of lines) {
        let chunk: ChunkEntry = JSON.parse(line);
        let filePath = chunk.filePath;
        let defaultChunkEntry: BucketChunk = {
            filePath,
            startCount: 0,
            encodedCount: 0
        };
        let chunkEntry = chunks[filePath] = chunks[filePath] || defaultChunkEntry;
        if(chunk.event === "startEncode") {
            chunkEntry.startCount++;
        } else if(chunk.event === "encoded") {
            chunkEntry.encodedCount++;
            chunkEntry.info = {
                timeStamp: chunk.utcTimeStamp,
                speeds: chunk.speeds,
                streamInfo: chunk.streamInfo,
                formatInfo: chunk.formatInfo,
            };
        } else {
            console.warn(`Unhandled chunk ${JSON.stringify(chunk)}`);
        }
    }
    return chunks;
}


interface State {
    buckets?: BucketState;
    selectedBucket?: Bucket;
    selectedBucketChunks?: BucketChunkLookup;
}

export class CameraViewer extends React.Component<{}, State> {
    state: State = { };

    componentDidMount() {
        watch("./processed/digest.txt", 1000 * 10, parseState, this.onNewBuckets);
    }
    componentWillUnmount() {
        unwatch(this.onNewBuckets);
    }
    onNewBuckets = (buckets: BucketState) => {
        let selectedBucketName = getProgramArguments()["bucket"];
        if(selectedBucketName in buckets) {
            let selectedBucket = buckets[selectedBucketName];
            this.navigate(selectedBucket);
        }
        this.setState({ buckets });
    };

    navigate = (bucket: Bucket) => {
        setProgramArgument("bucket", bucket.bucketName);
        let selectedBucket = this.state.selectedBucket;
        if(selectedBucket) {
            unwatch(parseBucketChunks);
        }
        this.setState({ selectedBucket: bucket });
        let path = `./processed/${bucket.bucketName}/digest.txt`;
        watch(path, 1000 * 10, parseBucketChunks, selectedBucketChunks => {
            this.setState({ selectedBucketChunks });
        });
    };

    renderChunks(bucket: Bucket, chunks: BucketChunkLookup) {
        let speeds: number[] = [1];
        for(let key in chunks) {
            let chunk = chunks[key];
            if(chunk.info) {
                speeds = chunk.info.speeds;
            }
        }
        let videos = keyBy(speeds.map(speed => ({speed, path: `./processed/${bucket.bucketName}/x${speed}.mp4`})), x => x.speed + "");
        return (
            <div>
                <SuperVideo videos={videos} originalVideos={chunks} />

                {bucket.bucketName}
                {Object.values(chunks).map(chunk => (
                    <div key={chunk.filePath}>
                        Source: {chunk.filePath}
                    </div>
                ))}
            </div>
        );
    }

    render() {
        let state = this.state;
        let buckets = state.buckets;
        if(!buckets) {
            return (
                <div>
                    Loading (or threw an error in the console)
                </div>
            );
        }
        return (
            <div className="CameraViewer">
                {Object.values(buckets).map(bucket => (
                    <div key={bucket.bucketName}>
                        <button onClick={() => this.navigate(bucket)}>Navigate</button> {bucket.bucketName} started on {new Date(bucket.firstVideoStartTimeStamp) + ""}
                    </div>
                ))}
                { state.selectedBucket &&
                    <div>
                        Selected: {state.selectedBucket.bucketName}
                    </div>
                }
                { state.selectedBucket && state.selectedBucketChunks && this.renderChunks(state.selectedBucket, state.selectedBucketChunks) }
            </div>
        );
    }
}