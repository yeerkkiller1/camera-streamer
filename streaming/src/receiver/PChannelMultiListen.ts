import { PChanSend } from "controlFlow/pChan";
import { Deferred } from "pchannel";

export class PChannelMultiListen<T> implements PChanSend<T> {
    callbacks: ((value: T) => void)[] = [];

    /** Returns a close callback. And if callback throughs, we close the connection. */
    public Subscribe(callback: (value: T) => void): () => void {
        this.callbacks.push(callback);
        return () => {
            this.removeCallback(callback);
        };
    }

    private removeCallback(callback: (value: T) => void) {
        let index = this.callbacks.indexOf(callback);
        if(index < 0) {
            console.warn(`Could not callback on PChannelMultiListen. Maybe we are searching for it incorrectly?, in which case we will leak memory here, and probably throw lots of errors.`);
        } else {
            this.callbacks.splice(index, 1);
        }
    }

    private closeDeferred = new Deferred<void>();
    OnClosed: Promise<void> = this.closeDeferred.Promise();
    IsClosed(): boolean { return !!this.closeDeferred.Value; }

    SendValue(value: T): void {
        let callbacks = this.callbacks.slice();
        for(let callback of callbacks) {
            try {
                callback(value);    
            } catch(e) {
                console.error(`Error on calling callback. Assuming requested no longer wants data, and are removing it from callback list. Error ${e.stack}`);
                this.removeCallback(callback);
            }
        }
    }
    SendError(err: any): void {
        console.error(`Error on PChannelMultiListen. There isn't really anything to do with this (the clients don't want it), so just swallowing it?`, err);
    }
    
    Close(): void {
        this.closeDeferred.Resolve(undefined);
    }
    IsClosedError(err: any): boolean {
        return false;
    }
}