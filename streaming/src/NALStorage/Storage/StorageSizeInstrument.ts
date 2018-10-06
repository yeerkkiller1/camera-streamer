import { sum } from "../../util/math";

export class StorageSizeInstrument implements StorageBaseBase {
    public BytesWrite = 0;
    public BytesRead = 0;
    public TotalSizeStored = 0;
    protected totalFileSizes: {
        [path: string]: number
    } = {};
    protected setTotalFileSize(path: string, value: number) {
        let prevSize = this.totalFileSizes[path] || 0;
        if(value === 0) {
            delete this.totalFileSizes[path];
        } else {
            this.totalFileSizes[path] = value;
        }
        
        this.TotalSizeStored += value - prevSize;
    }

    constructor(private storage: StorageBaseBase) { }

    public async GetDirectoryListing(path: string): Promise<string[]> {
        let files = await this.storage.GetDirectoryListing(path);
        this.BytesRead += sum(files.map(x => x.length));
        return files;
    }
    public GetFileSize(path: string): Promise<number> {
        return this.storage.GetFileSize(path);
    }
    public async GetFileContents(path: string): Promise<Buffer> {
        let contents = await this.storage.GetFileContents(path);
        this.BytesRead += contents.length;
        return contents;
    }
    public SetFileContents(path: string, data: string | Buffer): Promise<void> {
        this.BytesWrite += data.length;
        this.setTotalFileSize(path, data.length);
        return this.storage.SetFileContents(path, data);
    }
    public DeleteFile(path: string): Promise<void> {
        this.setTotalFileSize(path, 0);
        return this.storage.DeleteFile(path);
    }
    public Exists(path: string): Promise<boolean> {
        return this.storage.Exists(path);
    }
    public CreateDirectory(path: string): Promise<void> {
        return this.storage.CreateDirectory(path);
    }


}

export class StorageSizeInstrumentAppendable extends StorageSizeInstrument implements StorageBaseAppendable {
    constructor(private appendableStorage: StorageBaseAppendable) {
        super(appendableStorage);
    }

    public AppendData(path: string, data: string | Buffer): Promise<void> {
        this.BytesWrite += data.length;
        this.setTotalFileSize(path, (this.totalFileSizes[path] || 0) + data.length);
        return this.appendableStorage.AppendData(path, data);
    }
}