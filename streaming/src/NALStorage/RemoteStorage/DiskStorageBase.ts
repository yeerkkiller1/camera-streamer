import { readdirPromise, statFilePromise, readFilePromise, appendFilePromise, writeFilePromise, unlinkFilePromise, existsFilePromise, mkdirFilePromise } from "../../util/fs";

export class DiskStorageBase implements StorageBaseAppendable {
    public GetDirectoryListing(path: string): Promise<string[]> {
        return readdirPromise(path);
    }
    public async GetFileSize(filePath: string): Promise<number> {
        let stats = await statFilePromise(filePath)
        return stats.size;
    }
    public GetFileContents(filePath: string): Promise<Buffer> {
        return readFilePromise(filePath);
    }
    public AppendData(filePath: string, data: string | Buffer): Promise<void> {
        return appendFilePromise(filePath, data);
    }
    public SetFileContents(filePath: string, data: string | Buffer): Promise<void> {
        return writeFilePromise(filePath, data);
    }
    public DeleteFile(filePath: string): Promise<void> {
        return unlinkFilePromise(filePath);
    }
    public Exists(filePath: string): Promise<boolean> {
        return existsFilePromise(filePath);
    }
    public CreateDirectory(path: string): Promise<void> {
        return mkdirFilePromise(path);
    }
}