import { appendFile, writeFile, readFile } from "fs";
import { TransformChannel } from "pchannel";
import { readFilePromise, writeFilePromise, appendFilePromise } from "../util/fs";

/** Most operations require resaving the entire file. Pushes can be optimized by just appending to the file though. */
export function createFSArray<T>(path: string) {
    type FSArrayActions<T> = {
        type: "init"
    } | {
        type: "push",
        arguments: { items: T[] }
    } | {
        type: "saveAll"
    } | {
        type: "block"
    };
    
    class FSArray<T> extends Array<T> {
        private applyAction = TransformChannel<FSArrayActions<T>, void>(async input => {
            switch(input.type) {
                default: throw new Error(`Impossible, received invalid type ${(input as any).type}`);
                case "init": {
                    let contents: string;
                    try {
                        contents = (await readFilePromise(this.path)).toString();
                    } catch(e) {
                        // Guess the file didn't exist, so nothing to load.
                        return;
                    }
                    let parts = contents.split("\n").slice(0, -1);
                    for(let part of parts) {
                        let item: T = JSON.parse(part);
                        super.push(item);
                    }
                    break;
                }
                case "saveAll": {
                    // Rewrite entire file
                    let contents = Array.from(this).map(x => JSON.stringify(x) + "\n").join("");
                    await writeFilePromise(this.path, contents);
                    break;
                }
                case "push": {
                    let newItems = Object.values(input.arguments.items);
                    for(let item of newItems) {
                        await appendFilePromise(this.path, JSON.stringify(item) + "\n");
                    }
                    super.push(...newItems);
                    break;
                }
                case "block": {
                    break;
                }
            }
        });
        constructor(private path: string) {
            super();
    
            this.applyAction({ type: "init" });
        }
        
        public push(...items: T[]): number {
            this.applyAction({ type: "push", arguments: { items } });
            return super.push(...items);
        }
    
        public splice(start: number, deleteCount: number, ...items: T[]): T[] {
            this.applyAction({ type: "saveAll" });
            return super.splice(start, deleteCount, ...items);
        }
    
        public shift(): T|undefined {
            this.applyAction({ type: "saveAll" });
            return super.shift();
        }
    
        public pop(): T|undefined {
            this.applyAction({ type: "saveAll" });
            return super.pop();
        }
    
        public reverse(): T[] {
            this.applyAction({ type: "saveAll" });
            return super.reverse();
        }
    
        public sort(compare?: (a: T, b: T) => number): this {
            this.applyAction({ type: "saveAll" });
            return super.sort(compare);
        }
    
        public unshift(... items: T[]): number {
            this.applyAction({ type: "saveAll" });
            return super.unshift(...items);
        }
    
        public save(): void {
            this.applyAction({ type: "saveAll" });
        }
    
        public async block() {
            return this.applyAction({ type: "block" });
        }
    }

    let obj = new FSArray<T>(path);

    return new Proxy(obj, {
        set(obj, prop, value) {
            let result = Reflect.set(obj, prop, value);
            obj.save();
            return result;
        }
    });
}