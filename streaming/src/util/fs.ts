import { appendFile, writeFile, readFile, open, read, close, exists, stat, write, unlink, mkdir } from "fs";
import * as fs from "fs";
import { newPromise } from "./promise";




export function unlinkFilePromise(filePath: string) {
    return newPromise<void>((resolve, reject) => {
        unlink(filePath, err => {
            err ? reject(err) : resolve();
        });
    });
}

export function appendFilePromise(filePath: string, text: string|Buffer) {
    return newPromise<void>((resolve, reject) => {
        appendFile(filePath, text, err => {
            if(err) {
                let folder = filePath.split("/").slice(0, -1).join("/");
                if(!fs.existsSync(folder)) {
                    console.log("Missing folder");
                }
            }
            err ? reject(err) : resolve();
        });
    });
}

export function writeFilePromise(filePath: string, text: string|Buffer) {
    return newPromise<void>((resolve, reject) => {
        writeFile(filePath, text, err => {
            if(err) {
                let folder = filePath.split("/").slice(0, -1).join("/");
                if(!fs.existsSync(folder)) {
                    console.log(`Missing folder ${folder}`);
                }
                let folder2 = filePath.split("/").slice(0, -2).join("/");
                if(!fs.existsSync(folder2)) {
                    console.log(`Missing parent folder ${folder2}`);
                }
                let folder3 = filePath.split("/").slice(0, -3).join("/");
                if(!fs.existsSync(folder3)) {
                    console.log(`Missing parent parent folder ${folder3}`);
                }
            }
            err ? reject(err) : resolve();
        });
    });
}

export function readFilePromise(filePath: string) {
    return newPromise<Buffer>((resolve, reject) => {
        readFile(filePath, (err, data) => {
            err ? reject(err) : resolve(data);
        });
    });
}

export function existsFilePromise(filePath: string) {
    return newPromise<boolean>((resolve, reject) => {
        exists(filePath, (exists) => {
            resolve(exists);
        });
    });
}

export function mkdirPromise(filePath: string) {
    return newPromise<void>((resolve, reject) => {
        mkdir(filePath, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

export function statFilePromise(filePath: string) {
    return newPromise<fs.Stats>((resolve, reject) => {
        stat(filePath, (err, stats) => {
            err ? reject(err) : resolve(stats);
        });
    });
}

type FileDescriptor = number;
export function openReadPromise(filePath: string) {
    return newPromise<FileDescriptor>((resolve, reject) => {
        open(filePath, "r", (err, fd) => {
            err ? reject(err) : resolve(fd);
        });
    });
}
export function openWritePromise(filePath: string) {
    return newPromise<FileDescriptor>((resolve, reject) => {
        open(filePath, "w+", (err, fd) => {
            err ? reject(err) : resolve(fd);
        });
    });
}

export function closeDescPromise(fileDesc: FileDescriptor) {
    return newPromise<void>((resolve, reject) => {
        close(fileDesc, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

export function readDescPromise(fileDesc: FileDescriptor, start: number, size: number) {
    return newPromise<Buffer>((resolve, reject) => {
        let data = Buffer.alloc(size);
        read(fileDesc, data, 0, size, start, (err, bytes, buffer) => {
            if(bytes !== size) {
                console.error(`Read tried to read ${size}, but instead read ${bytes}`);
            }
            err ? reject(err) : resolve(buffer);
        });
    });
}

export function writeDescPromise(fileDesc: FileDescriptor, buffer: Buffer) {
    return newPromise<void>((resolve, reject) => {
        write(fileDesc, buffer, 0, buffer.length, (err, bytes, buffer) => {
            if(bytes !== buffer.length) {
                console.error(`Write tried to write ${buffer.length}, but instead wrote ${bytes}`);
            }
            err ? reject(err) : resolve();
        });
    });
}


export function readdirPromise(path: string) {
    return newPromise<string[]>((resolve, reject) => {
        fs.readdir(path, (err, files) => {
            err ? reject(err) : resolve(files);
        });
    });
}