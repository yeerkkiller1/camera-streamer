declare namespace nodeLocalstorage {
    export class LocalStorage extends Storage {
        constructor(path: string);
    }
}

declare module "node-localstorage" {
    export = nodeLocalstorage;
}