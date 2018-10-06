import { SmallDiskList } from "./SmallDiskList";
import { TransformChannel, Deferred, PChan } from "pchannel";
import { UnionUndefined } from "../util/misc";
import { readFileSync } from "fs";
import { appendFilePromise, unlinkFilePromise, existsFilePromise } from "../util/fs";
import { findAtOrAfterIndex, findAtOrBeforeOrAfterIndex, findAtOrBeforeOrAfter } from "../util/algorithms";

export interface LargeDiskListSummary {
    // Inclusive
    start: number;
    // Inclusive
    last: number;
}

interface LargeDiskListSummaryInternal extends LargeDiskListSummary {
    // The total number of values in all summaries, not just this summary
    totalCountAtWrite: number;
    countInSummary: number;

    localFileName: string;
    mutableLocalFileName: string;
    remoteFileName: string;

    shouldRemoteStore: boolean;
}

// REMEMBER! If we are storing a summary we need to account for the summary or the actual data not storing,
//  making them out of sync. We either need correction for this, or to write in a way that this doesn't happen,
//  or something.

//todonext
// Like SmallDiskList, except instead of GetValues it should expose a SearchValues instead of GetValues,
//  and a RangeSummary, which can be used to collapse values to create a nice summary (an array) of the values.
// Handles millions of values by only storing thousands locally. Is not suitable for billions of values, as
//  scaling begins to breakdown after millions of values (on account of GetRangeSummary returning
//  a summary for all the objects).

// I definitely need to lock down the whole class if something throws, to prevent it from getting in bad states.

// - Then we need to make our storage objects keep track of write/read byte counts, so we can make a test that
//      ensures LargeDiskList doesn't just keep everything in localStorage forever, AND ALSO to make sure
//      certain calls (Init), doesn't require remoteStorage (unless there is a data corruption issue).
// - We need a SmallDiskList.Finish function, so we can move the mutate value into the main file, and ensure everything
//      is written to disk, before we move the file.
export class LargeDiskList<T> {
    constructor(
        private localStorage: StorageBaseAppendable,
        private remoteStorage: StorageBase,
        private folderPath: string,
        private remotePath: string,
        private getSearchKey: (value: T) => number,
        //private reduceObject: (reduced: ReducedObject, value: T) => void
    ) { }

    // Hmm... number of values inside each LargeDiskListRange... should we dynamically calculate this?
    //  Ideally values_per_chunk = sqrt(total_values).
    //  That would mean a year of 2 second chunks only takes ~4000 ranges, which even at a KB each is only 4MB.
    //  If needed we could always add a linear scaling factor argument to this.


    public summaryLookup!: SmallDiskList<LargeDiskListSummaryInternal>;
    // Everything in here should already have init called on it.
    public pendingSummaries: {
        [start: number]: SmallDiskList<T>|undefined
    } = {};
    private nextRemoteStorePosition!: SmallDiskList<number>;

    public messages: string[] = [];

    public async Init() {
        this.summaryLookup = new SmallDiskList(
            this.localStorage,
            this.folderPath + "rangeOverallSummary.index",
            this.folderPath + "rangeOverallSummaryMutable.index",
        );
        await this.summaryLookup.Init();

        this.nextRemoteStorePosition = new SmallDiskList(
            this.localStorage,
            this.folderPath + "LargeDiskList_or_SmallDiskList_is_broken.index",
            this.folderPath + "remoteStoredPosition.index",
        );
        await this.nextRemoteStorePosition.Init();

        let liveSummary = this.getLiveSummary("doNotInit");
        if(liveSummary) {
            await liveSummary.Init();
            this.messages.push(`Loaded [${liveSummary.GetValues().join(", ")}]`);
        } else {
            this.messages.push(`Nothing to load ${this.summaryLookup.GetValues().length} summaries`);
        }

        this.storageTransitionLoop().then(
            () => console.error("storageTransitionLoop should not finish. This LargeDiskList is broken."),
            (e) => console.error(`storageTransitionLoop should not die. This LargeDiskList is broken. ${e}`)
        );
    }

    private getLiveSummary(newState?: "new"|"doNotInit"): SmallDiskList<T> | undefined {
        let summaryValues = this.summaryLookup.GetValues();
        if(summaryValues.length > 0) {
            let last = summaryValues.last();
            if(!last.shouldRemoteStore) {
                let diskList = this.pendingSummaries[last.start];
                if(!diskList) {
                    diskList = new SmallDiskList<T>(
                        this.localStorage,
                        last.localFileName,
                        last.mutableLocalFileName,
                    );
                    this.pendingSummaries[last.start] = diskList;

                    if(newState === "new") {
                        diskList.IsAlreadyInited();
                    } else if(newState === "doNotInit") {
                        
                    } else {
                        throw new Error(`LiveSummary should have already been initialized in the constructor Init. This will cause problems.`);
                    }
                }
                return diskList;
            }
        }

        return undefined;
    }

    private async getSmallDiskList(summary: LargeDiskListSummaryInternal) {
        let smallDiskObject = this.pendingSummaries[summary.start];
        if(!smallDiskObject) {
            smallDiskObject = new SmallDiskList(
                this.localStorage,
                summary.localFileName,
                summary.mutableLocalFileName,
            );
            // Hmm... this is unfortunate, we parse the entire file, when we might be able to just use the raw data. But
            //  we always need to read the file in, because we are sending it to a remote server... so this isn't the worst...
            await smallDiskObject.Init();
        }
        await smallDiskObject.BlockUntilInitFinished();
        await smallDiskObject.Finish();
        return smallDiskObject;
    }

    private onAdd = new Deferred<void>();
    private triggerOnAdd() {
        this.onAdd.Resolve();
        this.onAdd = new Deferred<void>();
    }
    private async storageTransitionLoop() {
        // When we move something to remote storage we have to make sure summaryLookup is saved. Otherwise we move it, crash,
        //  and then add different values to the summaryLookup and try to move a similar but slightly different summary!

        while(true) {
            let nextSummaryIndex = this.nextRemoteStorePosition.GetValues()[0] || 0;
            let storeCandidate = UnionUndefined(this.summaryLookup.GetValues()[nextSummaryIndex]);
            if(storeCandidate && storeCandidate.shouldRemoteStore) {
                //console.log("Starting transition");
                await this.summaryLookup.BlockUntilIndexSaved(nextSummaryIndex);
                //console.log("index saved transition");

                let localFileExists = await existsFilePromise(storeCandidate.localFileName);
                if(!localFileExists) {
                    console.error(`Cannot find file we intended to move to remote storage. It is possible we already moved it to remote storage, but crashed before we could record it. Assuming this is the case, and pretending as if it has been moved.`);

                    // Hmm... there is the case where the file on disk has been deleted but it is still in memory. But I shudder to think about
                    //  always providing from memory recovery for disk failures, so I'm not even going to consider implementing that here.

                    // TODO: We need to remember to make sure our searching code handles the summaryLookup have summaries that don't exist.
                } else {
                    let smallDiskObject = await this.getSmallDiskList(storeCandidate);

                    // We need to make sure the values don't exceed the summary object (which may happen if values write but the summary mutatation isn't
                    //  written before a crash), because that will completely break search behavior. If the summary object exceeds the values...
                    //  we will just have to put up with that.
                    let values = smallDiskObject.GetValues();
                    if(values.length === 0) {
                        console.warn(`Somehow there are 0 values for a summary whose value in summaryLookup says it has ${storeCandidate.countInSummary} values. We can't mutate summaryLookup so we have to pretend it has all the values.`);
                    } else {
                        let realFirstValue = this.getSearchKey(values[0]);
                        if(realFirstValue !== storeCandidate.start) {
                            console.warn(`BAD! Values are really messed up, start does not match with summaryLookup. We are throwing this data away, but leaving it in the index, because we have no index modification code. Start should be ${storeCandidate.start} but was ${realFirstValue}.`);
                            values = [];
                        } else {
                            let realLastValue = this.getSearchKey(values.last());
                            if(realLastValue !== storeCandidate.last) {
                                if(realLastValue < storeCandidate.last) {
                                    console.warn(`Has less values on disk for a summary than expected in summaryLookup. Expected ${storeCandidate.last} to be the last value, but the last was ${realLastValue}.`);
                                }
                                if(!storeCandidate.last || realLastValue) {
                                    console.warn(`BAD! We have more values than summaryLookup says we should. Ignoring extra values. Last should be ${storeCandidate.last} but was ${realLastValue}.`);
                                    let expectedLast = storeCandidate.last;
                                    values = values.filter(x => this.getSearchKey(x) <= expectedLast);
                                }
                            }
                        }
                    }

                    let valuesStringified = values.map(x => JSON.stringify(x) + "\n").join("");

                    // If we crash here:
                    //  When we restart (and add another value), we will try this again, no harm done
                    await this.remoteStorage.SetFileContents(storeCandidate.remoteFileName, valuesStringified);

                    // If we crash here:
                    //  nextRemoteStorePosition won't be updated, so we will just reupload the contents, no harm done.
                    await unlinkFilePromise(storeCandidate.localFileName);

                    delete this.pendingSummaries[storeCandidate.start];
                }

                await this.nextRemoteStorePosition.MutateLastValue(x => nextSummaryIndex + 1);
            }

            await this.onAdd.Promise();
        }
    }

    public async AddNewValue(value: T): Promise<unknown> {
        let promises: Promise<unknown>[] = [];

        let summaries = this.summaryLookup.GetValues();
        if(summaries.length > 0) {
            let pendingSummary = summaries.last();
            let curThreshold = Math.ceil(Math.sqrt(pendingSummary.totalCountAtWrite));
            if(pendingSummary.countInSummary > curThreshold) {
                let mutatePromise = this.summaryLookup.MutateLastValue(summaryValue => {
                    if(!summaryValue) {
                        throw new Error(`Impossible`);
                    }
                    summaryValue.shouldRemoteStore = true;
                    return summaryValue;
                });
                promises.push(mutatePromise);
            }
        }

        let liveSummary = this.getLiveSummary();
        if(!liveSummary) {
            let totalCountAtWrite = 0;
            let summaries = this.summaryLookup.GetValues();
            if(summaries.length > 0) {
                totalCountAtWrite = summaries.last().totalCountAtWrite;
            }

            let startKey = this.getSearchKey(value);
            let newRange: LargeDiskListSummaryInternal = {
                start: startKey,
                last: startKey,
                countInSummary: 0,
                totalCountAtWrite: totalCountAtWrite,
                shouldRemoteStore: false,
                localFileName: this.folderPath + `summary${startKey}.index`,
                mutableLocalFileName: this.folderPath + `summary${startKey}_mutable.index`,
                remoteFileName: this.remotePath + `summary${startKey}.index`,
            };

            promises.push(this.summaryLookup.AddNewValue(newRange));

            liveSummary = this.getLiveSummary("new");
            if(!liveSummary) {
                throw new Error(`Impossible, we just added the summary`);
            }
        }

        // Hmm... we will have to bite the bullet and allow extra files to be created and lost if we append to the group
        //  before we can modify the summary entry in the summaryLookup... Of course if the append to the group is lost
        //  we can detect that, and work around it.
        let summaryLookupMutatePromise = this.summaryLookup.MutateLastValue(summaryValue => {
            if(!summaryValue) {
                throw new Error(`Impossible, no last summary summaryValue`);
            }
            
            summaryValue.last = this.getSearchKey(value);
            summaryValue.countInSummary++;
            summaryValue.totalCountAtWrite++;
            //this.reduceObject(summaryValue.reduced, value);

            return summaryValue;
        });
        promises.push(summaryLookupMutatePromise);

        let addPromise = liveSummary.AddNewValue(value);
        promises.push(addPromise);

        this.triggerOnAdd();

        for(let i = 0; i < promises.length; i++) {
            await promises[i];
        }
    }


    public async MutateLastValue(code: (value: T|undefined) => T): Promise<unknown> {
        // Oh yeah. We need to only finish a summary if we already have a new value. So I have to go change AddNewValue to do this properly.
        let liveSummary = this.getLiveSummary();
        let summaries = this.summaryLookup.GetValues();
        if(!liveSummary) {
            if(summaries.length > 0) {
                throw new Error(`Impossible, we should always have a live summary if we have any summaries, as we should only finish a summary in the same call as we add a new live summary.`);
            }
            await this.AddNewValue(code(undefined));
            return;
        }

        let newLast = code(liveSummary.GetValues().last());
        let lookupPromise = this.summaryLookup.MutateLastValue(x => {
            if(!x) {
                throw new Error(`We definitely have a summary, this is impossible.`);
            }
            x.last = this.getSearchKey(newLast);
            return x;
        });

        let summaryPromise = liveSummary.MutateLastValue(() => newLast);

        return Promise.all([ lookupPromise, summaryPromise ]);
    }

    // Calls confirm with the oldest chunk, and when the confirm function finishes deletes the chunk.
    public async ExportOldest(confirm: (
        oldestChunk: T[]
    ) => Promise<void>): Promise<void> {
        let summaries = this.summaryLookup.GetValues();
        if(summaries.length === 0) {
            throw new Error(`Cannot export oldest, as there are no values.`);
        }
        
    }



    public async FindAtOrBeforeOrAfter(searchKey: number): Promise<T | undefined> {
        let values = this.summaryLookup.GetValues();

        // use summaryLookup to find where it is, and then get that remote file, and find the exact T.
        let summaryIndex = findAtOrBeforeOrAfterIndex(values, searchKey, x => x.start);

        let checkDirection = +1;

        let loops = 0;

        while(true) {
            if(loops > 10) {
                throw new Error(`Search took too long. LargeDiskList.FindAtOrBeforeOrAfter is broken`);
            }
            loops++;


            let summary = UnionUndefined(values[summaryIndex]);

            if(!summary) {
                if(checkDirection === -1) {
                    console.log(Object.keys(this.pendingSummaries));
                    console.log(values.length, summaryIndex);
                    return undefined;
                }
                checkDirection = -1;
                summaryIndex += checkDirection;
                continue;
            }

            this.messages.push(`Trying summary ${summary.start} to ${summary.last}`)

            let tValues: T[] | undefined;
            if(!summary.shouldRemoteStore || summary.start in this.pendingSummaries) {
                let diskList = this.pendingSummaries[summary.start];
                if(!diskList) {
                    diskList = new SmallDiskList(
                        this.localStorage,
                        summary.localFileName,
                        summary.mutableLocalFileName,
                    );
                    this.pendingSummaries[summary.start] = diskList;
                    // It doesn't matter if shouldRemoteStore becomes true and this gets moved to remote storage before Init comes back. We have the in memory
                    //  class, which will stay alive as long as we have this reference.
                    await diskList.Init();
                }
                await diskList.BlockUntilInitFinished();

                tValues = diskList.GetValues();                
            } else {
                // Really the ideal sequence is:
                //  - Try to read locally
                //  - Try to read remotely
                // As we don't delete it locally until we sent it remotely, so that will always work. But... usually if it is marked as shouldSendRemote
                //  it has been sent, so we do an extra remote check for efficiency sake.

                let errors: any[] = [];

                let remoteContents: Buffer|undefined;
                let localContents: T[]|undefined;

                // Download it from the remote
                try {
                    remoteContents = await this.remoteStorage.GetFileContents(summary.remoteFileName);
                } catch(e) {
                    this.messages.push(`Cannot get value from remote location`);
                    errors.push(e);
                }

                if(!remoteContents) {
                    // Download it from the local
                    try {
                        let local = await this.getSmallDiskList(summary);
                        localContents = local.GetValues();
                        this.messages.push(`Got local contents, length ${localContents.length}`)
                    } catch(e) {
                        this.messages.push(`Cannot get value from local location`);
                        errors.push(e);
                    }
                }

                if(!remoteContents && !localContents) {
                    try {
                        remoteContents = await this.remoteStorage.GetFileContents(summary.remoteFileName);
                    } catch(e) {
                        errors.push(e);
                    }
                }

                if(remoteContents) {
                    tValues = remoteContents.toString().split("\n").slice(0, -1).map(x => JSON.parse(x) as T);
                } else {
                    if(localContents) {
                        tValues = localContents;
                    }
                    else {
                        console.error(`Absolutely cannot get the contents at ${summary.start}. Errors: ${errors}.`);
                        // This could happen if we wrote to the summaryLookup before the data finished writing. Which can easily happen
                        //  because of a process termination, so we need to handle this gracefully.

                        // Eh... newer video is probably better. They play from old to new, so if we gave them older video they would
                        //  just iterate back to this chunk and infinitely loop. Unless they are playing backwards, in which case this will
                        //  infinitely loop (over the same chunk, that we send back, they play, and then they request the invalid chunk again).
                        summaryIndex += checkDirection;
                        continue;
                    }
                }
            }

            // Probably a crash occurred while writing and we had to just leave summaryLookup as it was.
            if(tValues.length === 0) {
                console.error(`No values at summary ${summary.start} to ${summary.last} (inclusive)`);
                summaryIndex += checkDirection;
                continue;
            }

            return findAtOrBeforeOrAfter(tValues, searchKey, x => this.getSearchKey(x));
        }
    }

    public GetRangeSummary(): LargeDiskListSummary[] {
        return this.summaryLookup.GetValues();
    }
}


// Hmm... so...
//  nals + nal time => nal times ranges => further broken down group of nal times ranges
//  But group of nals require a specific breakdown. That being, a group must start with a special nal (keyframe),
//      and two adjacent nals must satisify a certain condition (being close to each other in time).
//  Although... the adjacent nal restriction could be relaxed if we change muxing to just potentially mux chunks into
//      multiple videos... But this doesn't really matter, as nal times ranges require close times anyway, or else they
//      will be larger than needed ranges? But then again... maybe that's okay?

// Nal time ranges can just be handled with something a lot like SmallDiskList, except with capabilities of handling
//  lots of data. We can then make chunks ourself outside of this, and just use LargeDiskList to keep track of the chunks
//  that exist.