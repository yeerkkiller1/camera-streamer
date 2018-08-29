import { NALStorage } from "./LocalNALRate";

export class NALCache implements NALStorage {
    constructor(private storage: NALStorage) { }
    
    public AddNAL(val: NALHolderMin): void {
        throw new Error("Method not implemented.");
    }
    public GetNALTimes(): NALIndexInfo[] {
        throw new Error("Method not implemented.");
    }
    public ReadNALs(times: number[]): Promise<NALHolderMin[]> {
        throw new Error("Method not implemented.");
    }
    public SubscribeToNALTimes(callback: (nalTime: NALInfoTime) => void): () => void {
        throw new Error("Method not implemented.");
    }
}