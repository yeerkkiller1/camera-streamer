import * as React from "react";
import { PropsMapReduce } from "../util/PropsMapReduce";

// Polyfills.
import "../util/math";
import { binarySearchMap, binarySearchNumber, binarySearch } from "../util/algorithms";
import { formatDuration } from "../util/format";
import { getTimeSynced } from "../util/time";

import "./RangeSummarizer.less";
import { group } from "../util/math";
import { SegmentRanges } from "./rangeMapReduce";
import { RealTimeToVideoTime, RealDurationToVideoDuration } from "./TimeMap";

interface IProps {
    // TODO: Allow ranges to be mutated, by changing endTimes of the last range,
    //  OR by adding new ranges. Removing ranges will never be allowed.

    rate: number;
    speedMultiplier: number;

    // ranges are sorted be time
    receivedRanges: SegmentRanges|undefined;
    serverRanges: SegmentRanges|undefined;
    requestedRanges: SegmentRanges|undefined;

    currentPlayTime: number;

    onTimeClick: (time: number) => void;
}
interface IState {
    
}

function getOverlaps(baseRange: NALRange, ranges: SegmentRanges|undefined, toFracPos: (pos: number) => number): { startFrac: number, sizeFrac: number }[] {
    let overlapFracs: { startFrac: number, sizeFrac: number }[] = [];
    if(!ranges) {
        return overlapFracs;
    }
    let segments = ranges.segments;
    let index = binarySearchMap(segments, baseRange.firstTime, x => x.firstTime);
    if(index < 0) {
        index = ~index - 1;
        if(index < 0) {
            index = 0;
        }
    }

    while(index < segments.length && segments[index].firstTime < baseRange.lastTime) {
        let receivedStart = Math.max(segments[index].firstTime, baseRange.firstTime);
        let receivedEnd = Math.min(segments[index].lastTime, baseRange.lastTime);

        overlapFracs.push({
            startFrac: toFracPos(receivedStart),
            sizeFrac: toFracPos(receivedEnd) - toFracPos(receivedStart)
        });
        index++;
    }

    return overlapFracs;
}


export class RangeSummarizer extends React.Component<IProps, IState> {
    state: IState = {};

    private async clickTimeBar(e: React.MouseEvent<HTMLDivElement>, range: NALRange) {
        let now = getTimeSynced();

        let elem = e.currentTarget as HTMLDivElement;
        let rect = elem.getBoundingClientRect();

        let fraction = (e.clientX - rect.left) / rect.width;

        let end = range.lastTime;
        let offsetTime = (end - range.firstTime) * fraction;
        let time = range.firstTime + offsetTime;
        let timeAgo = formatDuration(now - time);

        console.log(`${timeAgo} AGO`);
        
        this.props.onTimeClick(time);
    }

    private renderSegments() {
        let { receivedRanges, serverRanges, requestedRanges } = this.props;
        if(!serverRanges) return null;

        let rate = this.props.rate;
        let mult = this.props.speedMultiplier;

        // Show loaded percent, and current frame position indicator.
        let segments = serverRanges.segments.slice().reverse();

        let now = getTimeSynced();

        let currentRealTime = this.props.currentPlayTime;

        return (
            <div>
                {
                    segments.map((range, index) => {
                        let isPlaying = false;
                        let selectedFrac = 0;
                        function toFracPos(pos: number) {
                            return (pos - range.firstTime) / (range.lastTime - range.firstTime);
                        }
                        
                        if(range.firstTime <= currentRealTime && currentRealTime <= range.lastTime) {
                            isPlaying = true;
                            selectedFrac = toFracPos(currentRealTime);
                        }

                        let receivedOverlapFracs = getOverlaps(range, receivedRanges, toFracPos);

                        let requestedOverlapFracs = getOverlaps(range, requestedRanges, toFracPos);

                        return (
                            <div
                                className={`RangeSummarizer-segment ${isPlaying && "RangeSummarizer-segment--playing" || ""}`}
                                key={index}
                                onClick={(e) => this.clickTimeBar(e, range)}
                            >
                                {range.firstTime} to {range.lastTime} ({formatDuration(range.lastTime - range.firstTime)}, {formatDuration(now - range.firstTime)} AGO
                                {
                                    rate !== 1 && (
                                    <span>
                                        , {formatDuration(RealDurationToVideoDuration(range.lastTime - range.firstTime, rate, mult))} play time
                                    </span>
                                )}
                                )

                                {requestedOverlapFracs.map((overlap, i) => (
                                    <div key={i} className="RangeSummarizer-segment-requestRange" style={{marginLeft: overlap.startFrac * 100 + "%", width: overlap.sizeFrac * 100 + "%"}}></div>
                                ))}

                                {receivedOverlapFracs.map((overlap, i) => (
                                    <div key={i} className="RangeSummarizer-segment-loadedRange" style={{marginLeft: overlap.startFrac * 100 + "%", width: overlap.sizeFrac * 100 + "%"}}></div>
                                ))}

                                {isPlaying &&<div className="RangeSummarizer-segment-playMarker" style={{marginLeft: selectedFrac * 100 + "%"}}></div>}
                            </div>
                        );
                    })
                }
            </div>
        );
    }

    public render() {
        let { props, state } = this;

        return (
            <div className="RangeSummarizer">
                {this.renderSegments()}
            </div>
        );
    }
}